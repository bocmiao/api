// 统计查询：后台「统计」页和公开的运行状态页的数据都从这里取。
// 调用量、耗时、错误等按时间的数字读汇总表（stats_hourly 保留 90 天 / stats_daily 永久）；
// 用户、IP、来源、地域这些维度读调用明细（request_log，默认保留 30 天），超出范围时自动截到可用的最早时间。
import { sql, STAT_COLS } from '../db.js';
import { config } from '../config.js';
import { HttpError } from './http.js';
import { today } from './limits.js';
import { flushStats, percentile, LAT_EDGES, CLIENT_NAMES } from './stats.js';
import { modules as apiModules, categories as apiCategories } from '../apis/index.js';
import { isModuleEnabled } from './modules.js';
import { healthStatus } from './health.js';

const HOUR = 3600_000;
const DAY = 86400_000;
const bjDay = (ts) => today(new Date(ts));
const bjMidnight = (ts) => Date.parse(`${bjDay(ts)}T00:00:00+08:00`);
const round = (n, d = 1) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const ratio = (a, b) => (b ? a / b : null);

// 接口地址 -> 所属模块
const routeIndex = new Map();
for (const m of apiModules) for (const r of m.routes) routeIndex.set(r.path, { module: m.name, title: m.title, category: m.category, method: r.method, summary: r.summary ?? '' });
export const routeInfo = (path) => routeIndex.get(path) ?? null;

// ---------- 时间范围 ----------
export const RANGES = { today: '今天', '24h': '最近 24 小时', '7d': '最近 7 天', '30d': '最近 30 天', '90d': '最近 90 天', custom: '自定义' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseRange(query, now = Date.now()) {
  const key = query.get('range') || '7d';
  if (!RANGES[key]) throw new HttpError(400, `range 只能是 ${Object.keys(RANGES).join(' / ')}`);
  let from;
  let to = now;
  let gran;
  if (key === 'today') { from = bjMidnight(now); gran = '5m'; }
  else if (key === '24h') { from = now - DAY; gran = '5m'; }
  else if (key === '7d') { from = bjMidnight(now) - 6 * DAY; gran = 'hour'; }
  else if (key === '30d') { from = bjMidnight(now) - 29 * DAY; gran = 'day'; }
  else if (key === '90d') { from = bjMidnight(now) - 89 * DAY; gran = 'day'; }
  else {
    const f = query.get('from');
    const t = query.get('to');
    if (!DATE_RE.test(f ?? '') || !DATE_RE.test(t ?? '')) throw new HttpError(400, '自定义范围需要 from 和 to，格式 YYYY-MM-DD');
    from = Date.parse(`${f}T00:00:00+08:00`);
    to = Math.min(Date.parse(`${t}T00:00:00+08:00`) + DAY, now);
    if (!(to > from)) throw new HttpError(400, '结束日期不能早于开始日期');
    if (to - from > 3660 * DAY) throw new HttpError(400, '时间范围最长 10 年');
    gran = to - from <= 2 * DAY ? 'hour' : 'day';
  }
  return { key, label: RANGES[key], from, to, gran, prevFrom: from - (to - from), prevTo: from };
}

// ---------- 汇总表读取 ----------
const hourlyAvailableFrom = () => Date.now() - config.statsHourlyDays * DAY;
const rawAvailableFrom = () => Date.now() - config.logRetentionDays * DAY;

// 取某段时间的汇总行；按小时表能覆盖就用小时表（精确到小时），否则用按天表
function rollupRows(from, to, path = null) {
  flushStats();
  const pathCond = path ? 'AND path = ?' : '';
  const args = path ? [path] : [];
  if (from >= hourlyAvailableFrom() - HOUR) {
    return sql(`SELECT hour AS t, path, ${STAT_COLS.join(', ')} FROM stats_hourly WHERE hour >= ? AND hour < ? ${pathCond}`)
      .all(Math.floor(from / HOUR) * HOUR, to, ...args).map((r) => ({ ...r, day: bjDay(r.t) }));
  }
  return sql(`SELECT day, path, ${STAT_COLS.join(', ')} FROM stats_daily WHERE day >= ? AND day <= ? ${pathCond}`)
    .all(bjDay(from), bjDay(to - 1), ...args).map((r) => ({ ...r, t: Date.parse(`${r.day}T00:00:00+08:00`) }));
}

const blank = () => Object.fromEntries(STAT_COLS.map((c) => [c, 0]));
export function sumRows(rows) {
  const s = blank();
  for (const r of rows) for (const c of STAT_COLS) s[c] = c === 'ms_max' ? Math.max(s[c], r[c]) : s[c] + r[c];
  return s;
}
const buckets = (s) => Array.from({ length: 10 }, (_, i) => s[`l${i}`]);

// 汇总数字 -> 展示用指标
export function metrics(s) {
  return {
    calls: s.calls,
    ok: s.ok,
    e4xx: s.e4xx,
    e5xx: s.e5xx,
    limited: s.limited,
    successRate: round(ratio(s.ok, s.calls) * 100, 2),
    errorRate: round(ratio(s.e5xx, s.calls) * 100, 2),
    avgMs: s.calls ? Math.round(s.ms_sum / s.calls) : null,
    p50: percentile(buckets(s), 0.5, s.ms_max),
    p95: percentile(buckets(s), 0.95, s.ms_max),
    maxMs: s.calls ? s.ms_max : null,
    cacheHit: round(ratio(s.cached, s.calls) * 100, 1),
    stale: s.stale,
    bytes: s.bytes,
    avgBytes: s.calls ? Math.round(s.bytes / s.calls) : null,
    anon: s.anon,
    session: s.session,
    apikey: s.apikey,
  };
}

// 调用明细的聚合列（与汇总表同名），用于 5 分钟粒度和单接口的状态码等细分
const EDGES = [-1, ...LAT_EDGES, null];
const RAW_AGG = `COUNT(*) AS calls, SUM(CASE WHEN status < 400 THEN 1 ELSE 0 END) AS ok,
  SUM(CASE WHEN status >= 400 AND status < 500 THEN 1 ELSE 0 END) AS e4xx, SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS e5xx,
  0 AS limited, SUM(CASE WHEN cached >= 1 THEN 1 ELSE 0 END) AS cached, SUM(CASE WHEN cached = 2 THEN 1 ELSE 0 END) AS stale,
  COALESCE(SUM(bytes), 0) AS bytes, SUM(ms) AS ms_sum, MAX(ms) AS ms_max,
  SUM(CASE WHEN user_id IS NULL THEN 1 ELSE 0 END) AS anon, SUM(CASE WHEN user_id IS NOT NULL AND key_id IS NULL THEN 1 ELSE 0 END) AS session,
  SUM(CASE WHEN key_id IS NOT NULL THEN 1 ELSE 0 END) AS apikey,
  ${EDGES.slice(0, 10).map((lo, i) => `SUM(CASE WHEN ms > ${lo}${EDGES[i + 1] == null ? '' : ` AND ms <= ${EDGES[i + 1]}`} THEN 1 ELSE 0 END) AS l${i}`).join(', ')}`;

// ---------- 趋势 ----------
const STEP = { '5m': 5 * 60_000, hour: HOUR };
export function series(range, path = null) {
  const pathCond = path ? 'AND path = ?' : '';
  const args = path ? [path] : [];
  let points = new Map();
  let keys = [];
  if (range.gran === '5m') {
    const step = STEP['5m'];
    const start = Math.floor(range.from / step) * step;
    for (let t = start; t < range.to; t += step) keys.push(t);
    for (const r of sql(`SELECT CAST(ts / ${step} AS INTEGER) * ${step} AS t, ${RAW_AGG} FROM request_log WHERE ts >= ? AND ts < ? ${pathCond} GROUP BY 1`)
      .all(range.from, range.to, ...args)) points.set(r.t, r);
  } else if (range.gran === 'hour') {
    const start = Math.floor(range.from / HOUR) * HOUR;
    for (let t = start; t < range.to; t += HOUR) keys.push(t);
    const rows = rollupRows(range.from, range.to, path);
    const group = new Map();
    for (const r of rows) group.set(r.t, [...(group.get(r.t) ?? []), r]);
    for (const [t, rs] of group) points.set(t, sumRows(rs));
  } else {
    for (let d = bjMidnight(range.from); d < range.to; d += DAY) keys.push(d);
    flushStats();
    const rows = sql(`SELECT day, ${STAT_COLS.join(', ')} FROM stats_daily WHERE day >= ? AND day <= ? ${pathCond}`)
      .all(bjDay(range.from), bjDay(range.to - 1), ...args);
    const group = new Map();
    for (const r of rows) {
      const t = Date.parse(`${r.day}T00:00:00+08:00`);
      group.set(t, [...(group.get(t) ?? []), r]);
    }
    for (const [t, rs] of group) points.set(t, sumRows(rs));
  }
  keys = [...new Set(keys)];
  return keys.map((t) => {
    const s = points.get(t) ?? blank();
    const m = metrics(s);
    return { t, calls: m.calls, anon: m.anon, session: m.session, apikey: m.apikey, e4xx: m.e4xx, e5xx: m.e5xx, limited: m.limited, avgMs: m.avgMs, p95: m.p95, cacheHit: m.cacheHit };
  });
}

// ---------- 独立访客 ----------
function uniques(from, to) {
  if (from >= rawAvailableFrom() - HOUR) {
    const r = sql('SELECT COUNT(DISTINCT ip) AS ips, COUNT(DISTINCT user_id) AS users FROM request_log WHERE ts >= ? AND ts < ?').get(from, to);
    return { ips: r.ips, users: r.users, exact: true };
  }
  // 超出调用明细保留范围：用每天的独立数相加（同一个 IP 在不同日子会重复计算）
  const r = sql('SELECT COALESCE(SUM(ips), 0) AS ips, COALESCE(SUM(users), 0) AS users FROM stats_day_meta WHERE day >= ? AND day <= ?').get(bjDay(from), bjDay(to - 1));
  return { ips: r.ips, users: r.users, exact: false };
}

const utcText = (ts) => new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
// 注册时间只精确到秒，结束时间取所在的那一秒（含）
const newUsers = (from, to) => sql('SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at <= ?').get(utcText(from), utcText(to)).n;

function kpi(from, to) {
  const m = metrics(sumRows(rollupRows(from, to)));
  const u = uniques(from, to);
  return { ...m, ips: u.ips, activeUsers: u.users, uniquesExact: u.exact, newUsers: newUsers(from, to) };
}

// ---------- 概览 ----------
export function overview(range) {
  const cur = kpi(range.from, range.to);
  const prev = kpi(range.prevFrom, range.prevTo);
  // 时段热力图：星期 × 小时（北京时间），范围不足 7 天时取最近 7 天
  const hmFrom = Math.min(range.from, bjMidnight(Date.now()) - 6 * DAY);
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  flushStats();
  for (const r of sql('SELECT hour, SUM(calls) AS calls FROM stats_hourly WHERE hour >= ? AND hour < ? GROUP BY hour').all(hmFrom, range.to)) {
    const d = new Date(r.hour + 8 * HOUR);
    heat[(d.getUTCDay() + 6) % 7][d.getUTCHours()] += r.calls; // 周一为 0
  }
  const byCat = new Map();
  for (const r of rollupRows(range.from, range.to)) {
    const info = routeInfo(r.path);
    const id = info?.category ?? 'other';
    byCat.set(id, (byCat.get(id) ?? 0) + r.calls);
  }
  return {
    range: publicRange(range),
    kpi: { cur, prev },
    series: series(range),
    heatmap: { from: hmFrom, to: range.to, weekdays: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'], data: heat },
    categories: apiCategories.map((c) => ({ id: c.id, title: c.title, calls: byCat.get(c.id) ?? 0 })).sort((a, b) => b.calls - a.calls),
  };
}

export const publicRange = (r) => ({ key: r.key, label: r.label, from: r.from, to: r.to, gran: r.gran, prevFrom: r.prevFrom, prevTo: r.prevTo });

// ---------- 接口明细 ----------
export function endpoints(range) {
  const rows = rollupRows(range.from, range.to);
  const prevRows = rollupRows(range.prevFrom, range.prevTo);
  const byDay = range.to - range.from > 2 * DAY;
  const sparkKeys = [];
  if (byDay) for (let d = bjMidnight(range.from); d < range.to; d += DAY) sparkKeys.push(bjDay(d));
  else for (let t = Math.floor(range.from / HOUR) * HOUR; t < range.to; t += HOUR) sparkKeys.push(t);
  const group = new Map();
  for (const r of rows) {
    const g = group.get(r.path) ?? { rows: [], spark: new Map() };
    g.rows.push(r);
    const k = byDay ? r.day : r.t;
    g.spark.set(k, (g.spark.get(k) ?? 0) + r.calls);
    group.set(r.path, g);
  }
  const prev = new Map();
  for (const r of prevRows) prev.set(r.path, (prev.get(r.path) ?? 0) + r.calls);
  const total = rows.reduce((n, r) => n + r.calls, 0);
  const items = [...group].map(([path, g]) => {
    const m = metrics(sumRows(g.rows));
    const info = routeInfo(path);
    const p = prev.get(path) ?? 0;
    return {
      path, module: info?.module ?? null, title: info?.title ?? null, summary: info?.summary ?? '', category: info?.category ?? null, method: info?.method ?? null,
      calls: m.calls, share: round(ratio(m.calls, total) * 100, 2), successRate: m.successRate, e4xx: m.e4xx, e5xx: m.e5xx, errorRate: m.errorRate,
      limited: m.limited, avgMs: m.avgMs, p95: m.p95, cacheHit: m.cacheHit, avgBytes: m.avgBytes,
      prevCalls: p, change: p ? round(((m.calls - p) / p) * 100, 1) : null,
      spark: sparkKeys.map((k) => g.spark.get(k) ?? 0),
    };
  }).sort((a, b) => b.calls - a.calls);
  return { range: publicRange(range), total, routesTotal: routeIndex.size, items };
}

// ---------- 调用明细里的维度 ----------
function rawWindow(range) {
  const from = Math.max(range.from, rawAvailableFrom());
  return { from, to: range.to, capped: from > range.from };
}
const topBy = (col, from, to, limit, extra = '', args = []) => sql(`SELECT ${col} AS k, COUNT(*) AS calls FROM request_log
  WHERE ts >= ? AND ts < ? AND ${col} IS NOT NULL ${extra} GROUP BY ${col} ORDER BY calls DESC LIMIT ?`).all(from, to, ...args, limit);

export function audience(range) {
  flushStats();
  const w = rawWindow(range);
  const { from, to } = w;
  const topUsers = sql(`SELECT l.user_id AS id, u.email, COUNT(*) AS calls, SUM(CASE WHEN l.status >= 400 THEN 1 ELSE 0 END) AS errors, MAX(l.ts) AS lastAt
    FROM request_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.ts >= ? AND l.ts < ? AND l.user_id IS NOT NULL
    GROUP BY l.user_id ORDER BY calls DESC LIMIT 20`).all(from, to);
  const topKeys = sql(`SELECT l.key_id AS id, k.name, k.prefix, u.email, COUNT(*) AS calls, MAX(l.ts) AS lastAt
    FROM request_log l LEFT JOIN api_keys k ON k.id = l.key_id LEFT JOIN users u ON u.id = l.user_id
    WHERE l.ts >= ? AND l.ts < ? AND l.key_id IS NOT NULL GROUP BY l.key_id ORDER BY calls DESC LIMIT 20`).all(from, to);
  const topIps = sql(`SELECT ip, COUNT(*) AS calls, MAX(region) AS region, MAX(isp) AS isp, COUNT(DISTINCT user_id) AS users, MAX(ts) AS lastAt
    FROM request_log WHERE ts >= ? AND ts < ? AND ip IS NOT NULL GROUP BY ip ORDER BY calls DESC LIMIT 20`).all(from, to);
  const ipTotal = sql('SELECT COUNT(DISTINCT ip) AS n FROM request_log WHERE ts >= ? AND ts < ?').get(from, to).n;
  // 新访客：在调用明细里第一次出现就在这段时间内
  const newIps = sql(`SELECT COUNT(*) AS n FROM (SELECT ip FROM request_log WHERE ip IS NOT NULL GROUP BY ip HAVING MIN(ts) >= ? AND MIN(ts) < ?)`).get(from, to).n;
  const regions = sql(`SELECT region AS k, COUNT(*) AS calls, COUNT(DISTINCT ip) AS ips FROM request_log
    WHERE ts >= ? AND ts < ? AND region IS NOT NULL GROUP BY region ORDER BY calls DESC LIMIT 40`).all(from, to);
  const unknownRegion = sql('SELECT COUNT(*) AS n FROM request_log WHERE ts >= ? AND ts < ? AND region IS NULL').get(from, to).n;
  return {
    range: publicRange(range),
    window: w,
    topUsers,
    topKeys,
    topIps,
    ips: { total: ipTotal, new: newIps, returning: ipTotal - newIps },
    referers: topBy('referer', from, to, 20).map((r) => ({ host: r.k, calls: r.calls })),
    noReferer: sql('SELECT COUNT(*) AS n FROM request_log WHERE ts >= ? AND ts < ? AND referer IS NULL').get(from, to).n,
    clients: topBy('client', from, to, 20).map((r) => ({ client: r.k, name: CLIENT_NAMES[r.k] ?? r.k, calls: r.calls })),
    regions: regions.map((r) => ({ region: r.k, calls: r.calls, ips: r.ips })),
    unknownRegion,
    isps: topBy('isp', from, to, 15).map((r) => ({ isp: r.k, calls: r.calls })),
    via: sql(`SELECT COALESCE(via, CASE WHEN key_id IS NOT NULL THEN 'apikey' WHEN user_id IS NOT NULL THEN 'session' ELSE 'anon' END) AS k, COUNT(*) AS calls
      FROM request_log WHERE ts >= ? AND ts < ? GROUP BY 1`).all(from, to).map((r) => ({ via: r.k, calls: r.calls })),
  };
}

// ---------- 用户增长 ----------
export function userGrowth(range) {
  flushStats();
  const w = rawWindow(range);
  const days = [];
  for (let d = bjMidnight(range.from); d < range.to; d += DAY) days.push(bjDay(d));
  const reg = new Map(sql(`SELECT date(created_at, '+8 hours') AS day, COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at <= ? GROUP BY 1`)
    .all(utcText(bjMidnight(range.from)), utcText(range.to)).map((r) => [r.day, r.n]));
  const dau = new Map(sql(`SELECT date(ts / 1000 + 28800, 'unixepoch') AS day, COUNT(DISTINCT user_id) AS n FROM request_log
    WHERE ts >= ? AND ts < ? AND user_id IS NOT NULL GROUP BY 1`).all(w.from, w.to).map((r) => [r.day, r.n]));
  const meta = new Map(sql('SELECT day, users FROM stats_day_meta WHERE day >= ? AND day <= ?').all(days[0] ?? '', days.at(-1) ?? '').map((r) => [r.day, r.users]));
  const now = Date.now();
  const active = (ms) => sql('SELECT COUNT(DISTINCT user_id) AS n FROM request_log WHERE ts >= ? AND user_id IS NOT NULL').get(now - ms).n;
  // 留存：注册后第 1 天（24~48 小时内）、第 7 天之后一周内仍有调用的比例
  const retention = (afterMs, spanMs) => {
    const lo = now - config.logRetentionDays * DAY;
    const cohort = sql('SELECT id, created_at FROM users WHERE created_at >= ? AND created_at < ?').all(utcText(lo), utcText(now - afterMs - spanMs));
    let kept = 0;
    for (const u of cohort) {
      const t = Date.parse(`${u.created_at.replace(' ', 'T')}Z`);
      if (sql('SELECT 1 FROM request_log WHERE user_id = ? AND ts >= ? AND ts < ? LIMIT 1').get(u.id, t + afterMs, t + afterMs + spanMs)) kept++;
    }
    return { cohort: cohort.length, retained: kept, rate: round(ratio(kept, cohort.length) * 100, 1) };
  };
  return {
    range: publicRange(range),
    totalUsers: sql('SELECT COUNT(*) AS n FROM users').get().n,
    disabledUsers: sql('SELECT COUNT(*) AS n FROM users WHERE disabled = 1').get().n,
    daily: days.map((day) => ({ day, registrations: reg.get(day) ?? 0, activeUsers: dau.get(day) ?? meta.get(day) ?? 0 })),
    dau: active(DAY),
    wau: active(7 * DAY),
    mau: active(30 * DAY),
    retention: { d1: retention(DAY, DAY), d7: retention(7 * DAY, 7 * DAY) },
  };
}

// ---------- 限流与错误 ----------
export function issues(range) {
  flushStats();
  const w = rawWindow(range);
  const lim = sql('SELECT subject, path, SUM(count) AS n FROM stats_limited WHERE day >= ? AND day <= ? GROUP BY subject, path')
    .all(bjDay(range.from), bjDay(range.to - 1));
  const subjects = new Map();
  const paths = new Map();
  for (const r of lim) {
    const s = subjects.get(r.subject) ?? { subject: r.subject, count: 0, paths: [] };
    s.count += r.n;
    s.paths.push({ path: r.path, count: r.n });
    subjects.set(r.subject, s);
    paths.set(r.path, (paths.get(r.path) ?? 0) + r.n);
  }
  const subjectList = [...subjects.values()].sort((a, b) => b.count - a.count).slice(0, 30).map((s) => {
    const i = s.subject.indexOf(':');
    const type = s.subject.slice(0, i);
    const id = s.subject.slice(i + 1);
    const label = type === 'user' ? (sql('SELECT email FROM users WHERE id = ?').get(Number(id))?.email ?? `用户 #${id}`) : id;
    const region = type === 'ip' ? sql('SELECT region FROM request_log WHERE ip = ? AND region IS NOT NULL ORDER BY ts DESC LIMIT 1').get(id)?.region ?? null : null;
    return { type, id, label, region, count: s.count, paths: s.paths.sort((a, b) => b.count - a.count).slice(0, 3) };
  });
  const errors = sql(`SELECT path, status, error, COUNT(*) AS count, MIN(ts) AS firstAt, MAX(ts) AS lastAt FROM request_log
    WHERE ts >= ? AND ts < ? AND status >= 400 GROUP BY path, status, error ORDER BY count DESC LIMIT 50`).all(w.from, w.to);
  return {
    range: publicRange(range),
    window: w,
    limited: {
      total: lim.reduce((n, r) => n + r.n, 0),
      subjects: subjectList,
      paths: [...paths].map(([path, count]) => ({ path, title: routeInfo(path)?.title ?? null, count })).sort((a, b) => b.count - a.count).slice(0, 20),
    },
    errors: errors.map((e) => ({ ...e, title: routeInfo(e.path)?.title ?? null })),
  };
}

// ---------- 单个接口 ----------
export function endpointDetail(range, path) {
  const info = routeInfo(path);
  if (!info) throw new HttpError(404, '没有这个接口');
  const cur = metrics(sumRows(rollupRows(range.from, range.to, path)));
  const prev = metrics(sumRows(rollupRows(range.prevFrom, range.prevTo, path)));
  const all = sumRows(rollupRows(range.from, range.to, path));
  const w = rawWindow(range);
  const args = [w.from, w.to, path];
  const where = 'ts >= ? AND ts < ? AND path = ?';
  return {
    range: publicRange(range),
    window: w,
    path,
    ...info,
    kpi: { cur, prev },
    series: series(range, path),
    latency: buckets(all).map((count, i) => ({ le: LAT_EDGES[i] ?? null, count })),
    statuses: sql(`SELECT status, COUNT(*) AS count FROM request_log WHERE ${where} GROUP BY status ORDER BY count DESC`).all(...args),
    errors: sql(`SELECT status, error, COUNT(*) AS count, MIN(ts) AS firstAt, MAX(ts) AS lastAt FROM request_log
      WHERE ${where} AND status >= 400 GROUP BY status, error ORDER BY count DESC LIMIT 20`).all(...args),
    topUsers: sql(`SELECT l.user_id AS id, u.email, COUNT(*) AS calls FROM request_log l LEFT JOIN users u ON u.id = l.user_id
      WHERE l.ts >= ? AND l.ts < ? AND l.path = ? AND l.user_id IS NOT NULL GROUP BY l.user_id ORDER BY calls DESC LIMIT 10`).all(...args),
    topIps: sql(`SELECT ip, MAX(region) AS region, MAX(isp) AS isp, COUNT(*) AS calls FROM request_log WHERE ${where}
      GROUP BY ip ORDER BY calls DESC LIMIT 10`).all(...args),
    referers: topBy('referer', w.from, w.to, 10, 'AND path = ?', [path]).map((r) => ({ host: r.k, calls: r.calls })),
    clients: topBy('client', w.from, w.to, 10, 'AND path = ?', [path]).map((r) => ({ client: r.k, name: CLIENT_NAMES[r.k] ?? r.k, calls: r.calls })),
    health: sql('SELECT ts, ok, status, ms, error FROM health_checks WHERE path = ? ORDER BY ts DESC LIMIT 20').all(path),
  };
}

// ---------- 运行状态（公开，只有接口层面的数字） ----------
function availability(fails, checks, e5xx, calls) {
  const total = checks + calls;
  return total ? round((1 - (fails + e5xx) / total) * 100, 2) : null;
}

export function statusData() {
  flushStats();
  const now = Date.now();
  const mods = apiModules.filter((m) => isModuleEnabled(m.name));
  const pathsOf = (m) => m.routes.map((r) => r.path);
  // 最近 24 小时：调用（汇总表）+ 检测（明细）
  const h24 = sql(`SELECT path, ${STAT_COLS.join(', ')} FROM stats_hourly WHERE hour >= ?`).all(Math.floor((now - DAY) / HOUR) * HOUR);
  const spark = sql('SELECT hour, path, calls, ms_sum FROM stats_hourly WHERE hour >= ?').all(Math.floor((now - DAY) / HOUR) * HOUR);
  const checks24 = sql('SELECT path, COUNT(*) AS checks, SUM(1 - ok) AS fails FROM health_checks WHERE ts >= ? GROUP BY path').all(now - DAY);
  const latest = sql(`SELECT h.path, h.ts, h.ok, h.ms FROM health_checks h
    JOIN (SELECT path, MAX(ts) AS ts FROM health_checks GROUP BY path) x ON x.path = h.path AND x.ts = h.ts`).all();
  const open = new Map(sql('SELECT module, started_at FROM incidents WHERE ended_at IS NULL').all().map((r) => [r.module, r.started_at]));
  // 近 90 天每天：调用与检测
  const days = [];
  for (let i = 89; i >= 0; i--) days.push(bjDay(now - i * DAY));
  const dailyCalls = sql('SELECT day, path, calls, e5xx FROM stats_daily WHERE day >= ?').all(days[0]);
  const dailyChecks = sql('SELECT day, path, checks, fails FROM health_daily WHERE day >= ?').all(days[0]);
  const idx = (rows, key) => {
    const m = new Map();
    for (const r of rows) {
      const k = key(r);
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return m;
  };
  const h24By = idx(h24, (r) => r.path);
  const sparkBy = idx(spark, (r) => r.path);
  const checks24By = new Map(checks24.map((r) => [r.path, r]));
  const latestBy = new Map(latest.map((r) => [r.path, r]));
  const dcBy = new Map(dailyCalls.map((r) => [`${r.path}|${r.day}`, r]));
  const dkBy = new Map(dailyChecks.map((r) => [`${r.path}|${r.day}`, r]));
  const hours = [];
  for (let t = Math.floor((now - DAY) / HOUR) * HOUR + HOUR; t <= now; t += HOUR) hours.push(t);

  let tot = { calls: 0, e5xx: 0, checks: 0, fails: 0 };
  const list = mods.map((m) => {
    const paths = pathsOf(m);
    const s = sumRows(paths.flatMap((p) => h24By.get(p) ?? []));
    const mt = metrics(s);
    const ck = paths.reduce((a, p) => {
      const c = checks24By.get(p);
      return c ? { checks: a.checks + c.checks, fails: a.fails + c.fails } : a;
    }, { checks: 0, fails: 0 });
    tot = { calls: tot.calls + s.calls, e5xx: tot.e5xx + s.e5xx, checks: tot.checks + ck.checks, fails: tot.fails + ck.fails };
    const last = paths.map((p) => latestBy.get(p)).filter(Boolean);
    const lastFailed = last.filter((l) => !l.ok).length;
    const lastAt = last.length ? Math.max(...last.map((l) => l.ts)) : null;
    const sp = new Map();
    for (const p of paths) for (const r of sparkBy.get(p) ?? []) {
      const v = sp.get(r.hour) ?? { calls: 0, ms: 0 };
      sp.set(r.hour, { calls: v.calls + r.calls, ms: v.ms + r.ms_sum });
    }
    const perDay = days.map((d) => {
      let calls = 0; let e5xx = 0; let checks = 0; let fails = 0;
      for (const p of paths) {
        const c = dcBy.get(`${p}|${d}`);
        if (c) { calls += c.calls; e5xx += c.e5xx; }
        const k = dkBy.get(`${p}|${d}`);
        if (k) { checks += k.checks; fails += k.fails; }
      }
      return { a: availability(fails, checks, e5xx, calls), c: calls, k: checks };
    });
    let status;
    if (m.suspended) status = 'suspended';
    // 故障：已记录的故障未结束（连续两次检测失败或调用大面积失败才会记录）；只失败一次先算部分失败，避免偶发抖动
    else if (open.has(m.name)) status = 'down';
    else if (lastFailed > 0 || (mt.calls >= 10 && mt.errorRate >= 10)) status = 'degraded';
    else if (!mt.calls && !last.length) status = 'idle';
    else status = 'ok';
    return {
      name: m.name, title: m.title, category: m.category, status,
      calls: mt.calls, errorRate: mt.errorRate ?? 0, avgMs: mt.avgMs, p95: mt.p95,
      availability: availability(ck.fails, ck.checks, s.e5xx, s.calls),
      lastCheck: lastAt ? { at: new Date(lastAt).toISOString(), ok: lastFailed === 0, failed: lastFailed, total: last.length } : null,
      incidentSince: open.has(m.name) ? new Date(open.get(m.name)).toISOString() : null,
      spark: hours.map((t) => {
        const v = sp.get(t);
        return v?.calls ? Math.round(v.ms / v.calls) : null;
      }),
      days: perDay.map((x) => x.a),
      dayCalls: perDay.map((x) => x.c + x.k),
    };
  });

  const windowAvail = (ms) => {
    const since = now - ms;
    const c = sql('SELECT COALESCE(SUM(checks), 0) AS checks, COALESCE(SUM(fails), 0) AS fails FROM health_daily WHERE day >= ?').get(bjDay(since));
    const t = ms <= config.statsHourlyDays * DAY
      ? sql('SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(e5xx), 0) AS e5xx FROM stats_hourly WHERE hour >= ?').get(Math.floor(since / HOUR) * HOUR)
      : sql('SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(e5xx), 0) AS e5xx FROM stats_daily WHERE day >= ?').get(bjDay(since));
    return availability(c.fails, c.checks, t.e5xx, t.calls);
  };
  const incidents = sql('SELECT id, module, started_at, ended_at, source, reason FROM incidents WHERE started_at >= ? ORDER BY started_at DESC LIMIT 50')
    .all(now - 30 * DAY)
    .map((i) => ({
      id: i.id,
      module: i.module,
      title: apiModules.find((m) => m.name === i.module)?.title ?? i.module,
      startedAt: new Date(i.started_at).toISOString(),
      endedAt: i.ended_at ? new Date(i.ended_at).toISOString() : null,
      minutes: Math.max(1, Math.round(((i.ended_at ?? now) - i.started_at) / 60_000)),
      source: i.source,
      reason: i.reason,
    }));
  return {
    uptime: { d1: availability(tot.fails, tot.checks, tot.e5xx, tot.calls), d7: windowAvail(7 * DAY), d30: windowAvail(30 * DAY) },
    days,
    hours,
    modules: list,
    incidents,
    checks: healthStatus(),
  };
}

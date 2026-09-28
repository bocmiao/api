// 调用统计的采集：每次调用先在内存里累加，每分钟写一次按小时 / 按天的汇总表（stats_hourly / stats_daily）。
// 统计页面只读汇总表；需要按用户、IP、来源等维度细看时才查调用明细（request_log，默认保留 30 天）。
import { db, sql, STAT_COLS } from '../db.js';
import { today } from './limits.js';
import { lookupIpOffline } from '../apis/life/offline-db.js';

// 耗时分桶上限（毫秒），最后一桶为 >5000
export const LAT_EDGES = [50, 100, 200, 300, 500, 800, 1200, 2000, 5000];
export const latBucket = (ms) => {
  const i = LAT_EDGES.findIndex((e) => ms <= e);
  return i === -1 ? LAT_EDGES.length : i;
};

// 由分桶估算百分位（桶内线性插值）；最后一桶用最大耗时作为上界
export function percentile(buckets, p, maxMs = null) {
  const total = buckets.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const target = total * p;
  let acc = 0;
  for (let i = 0; i < buckets.length; i++) {
    if (!buckets[i]) continue;
    if (acc + buckets[i] >= target) {
      const lo = i === 0 ? 0 : LAT_EDGES[i - 1];
      const hi = i < LAT_EDGES.length ? LAT_EDGES[i] : Math.max(maxMs ?? lo * 2, lo);
      return Math.round(lo + ((target - acc) / buckets[i]) * (hi - lo));
    }
    acc += buckets[i];
  }
  return maxMs;
}

// ---------- 维度 ----------
// 客户端类型：按 User-Agent 粗分
const CLIENTS = [
  ['bot', /bot|spider|crawl|slurp|bingpreview|headless/i],
  ['curl', /^curl\//i],
  ['wget', /^wget\//i],
  ['python', /python|aiohttp|httpx|scrapy/i],
  ['node', /node-fetch|undici|axios|node\.js|^node\//i],
  ['go', /^go-http-client|golang/i],
  ['java', /java|okhttp|apache-httpclient/i],
  ['php', /php|guzzle/i],
  ['postman', /postman|insomnia|apifox|apipost/i],
  ['app', /micromessenger|qq\/|dingtalk|lark|alipay|miniprogram/i],
  ['browser', /mozilla\/|opera/i],
];
export function clientOf(ua) {
  if (!ua) return 'unknown';
  return CLIENTS.find(([, re]) => re.test(ua))?.[0] ?? 'other';
}
export const CLIENT_NAMES = {
  browser: '浏览器', app: '微信 / QQ 等 App 内', curl: 'curl', wget: 'wget', python: 'Python', node: 'Node.js', go: 'Go', java: 'Java',
  php: 'PHP', postman: 'Postman 等调试工具', bot: '爬虫 / 机器人', other: '其他程序', unknown: '未知（无 User-Agent）',
};

// 来源网站：只记 Referer / Origin 的域名，不记完整网址
export function refererHost(headers = {}) {
  const raw = headers.referer || headers.origin || '';
  try {
    const u = new URL(raw);
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase().slice(0, 100) : null;
  } catch {
    return null;
  }
}

// IP 属地：离线 IP 库，结果缓存，避免重复查询
const regionCache = new Map();
export function regionOf(ip) {
  if (!ip) return { region: null, isp: null };
  let r = regionCache.get(ip);
  if (!r) {
    let info = null;
    try { info = lookupIpOffline(ip); } catch { /* IPv6 或 IP 库缺失 */ }
    r = info
      ? { region: info.country === '中国' ? (info.province || '中国') : (info.country || null), isp: info.isp || null }
      : { region: null, isp: null };
    if (regionCache.size > 20_000) regionCache.clear();
    regionCache.set(ip, r);
  }
  return r;
}

// ---------- 内存累加与写入 ----------
const pending = new Map(); // `${hour}|${day}|${path}` -> 计数
const pendingLimited = new Map(); // `${day}|${subject}|${path}` -> 次数

const blank = () => Object.fromEntries(STAT_COLS.map((c) => [c, 0]));
function slot(ts, path) {
  const hour = Math.floor(ts / 3600_000) * 3600_000;
  const day = today(new Date(ts));
  const key = `${hour}|${day}|${path}`;
  let s = pending.get(key);
  if (!s) pending.set(key, (s = blank()));
  return s;
}

// 记录一次完成的调用（成功或失败）。via：anon / session / apikey；cached：0 / 1 / 2
export function recordCall({ ts = Date.now(), path, status, ms, cached = 0, bytes = 0, via = 'anon' }) {
  const s = slot(ts, path);
  s.calls++;
  if (status < 400) s.ok++;
  else if (status >= 500) s.e5xx++;
  else s.e4xx++;
  if (cached === 1) s.cached++;
  if (cached === 2) { s.cached++; s.stale++; }
  s.bytes += bytes || 0;
  s.ms_sum += ms;
  s.ms_max = Math.max(s.ms_max, ms);
  s[via === 'apikey' ? 'apikey' : via === 'session' ? 'session' : 'anon']++;
  s[`l${latBucket(ms)}`]++;
}

// 记录一次被限流（429）的请求：只计数，不写调用明细
export function recordLimited({ ts = Date.now(), subject, path }) {
  slot(ts, path).limited++;
  const key = `${today(new Date(ts))}|${subject}|${path}`;
  pendingLimited.set(key, (pendingLimited.get(key) ?? 0) + 1);
}

const upsert = (table, keyCols) => {
  const cols = STAT_COLS;
  const set = cols.map((c) => (c === 'ms_max' ? `ms_max = MAX(ms_max, excluded.ms_max)` : `${c} = ${c} + excluded.${c}`)).join(', ');
  return `INSERT INTO ${table} (${keyCols.join(', ')}, ${cols.join(', ')}) VALUES (${[...keyCols, ...cols].map(() => '?').join(', ')})
          ON CONFLICT(${keyCols.join(', ')}) DO UPDATE SET ${set}`;
};
const UPSERT_HOURLY = upsert('stats_hourly', ['hour', 'path']);
const UPSERT_DAILY = upsert('stats_daily', ['day', 'path']);

// 把内存里的计数写进数据库（每分钟一次；进程退出前也会调用）
export function flushStats() {
  if (!pending.size && !pendingLimited.size) return;
  const rows = [...pending];
  const limited = [...pendingLimited];
  pending.clear();
  pendingLimited.clear();
  db.exec('BEGIN');
  try {
    for (const [key, s] of rows) {
      const [hour, day, path] = key.split('|');
      const vals = STAT_COLS.map((c) => s[c]);
      sql(UPSERT_HOURLY).run(Number(hour), path, ...vals);
      sql(UPSERT_DAILY).run(day, path, ...vals);
    }
    for (const [key, n] of limited) {
      const [day, subject, path] = key.split('|');
      sql(`INSERT INTO stats_limited (day, subject, path, count) VALUES (?, ?, ?, ?)
           ON CONFLICT(day, subject, path) DO UPDATE SET count = count + excluded.count`).run(day, subject, path, n);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('[stats] 写入统计失败：', err.message);
  }
}

// 已经结束的日子：把当天的独立 IP 数、活跃用户数存下来（调用明细过期后仍可查看）
export function saveDayMeta() {
  const d = today();
  const rows = sql(`SELECT date(ts / 1000 + 28800, 'unixepoch') AS day, COUNT(DISTINCT ip) AS ips, COUNT(DISTINCT user_id) AS users
                    FROM request_log WHERE ts >= ? GROUP BY 1`).all(Date.now() - 3 * 86400_000);
  for (const r of rows) {
    if (r.day === d) continue;
    sql('INSERT INTO stats_day_meta (day, ips, users) VALUES (?, ?, ?) ON CONFLICT(day) DO UPDATE SET ips = excluded.ips, users = excluded.users')
      .run(r.day, r.ips, r.users);
  }
}

export function pruneStats({ hourlyDays = 90, rawDays = 30 } = {}) {
  sql('DELETE FROM stats_hourly WHERE hour < ?').run(Date.now() - hourlyDays * 86400_000);
  sql('DELETE FROM stats_limited WHERE day < ?').run(today(new Date(Date.now() - rawDays * 86400_000)));
}

let timer = null;
export function startStats() {
  if (timer) return;
  timer = setInterval(() => { flushStats(); }, 60_000);
  timer.unref();
  setInterval(saveDayMeta, 3600_000).unref();
  saveDayMeta();
}

// 仅供测试
export const _pendingSize = () => pending.size;

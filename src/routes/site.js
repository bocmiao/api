// 站点运营：首页平台数据、接口文档页的调用统计、公告、友情链接、按请求 ID 查调用记录。
// 路由挂在 accountRouter 上（同源、JSON、同样的 CSRF 检查），由 app.js 在 account.js 之后加载
import { sql, STAT_COLS } from '../db.js';
import { HttpError, stripTags } from '../lib/http.js';
import { config } from '../config.js';
import { siteOrigin } from '../lib/origin.js';
import { checkCaptcha, sendEmailCode, consumeEmailCode } from '../lib/emailcode.js';
import { fetchFollow, readLimited, reasonOf } from '../apis/net/common.js';
import { accountRouter, requireUser, requireAdmin } from './account.js';
import { modules as apiModules } from '../apis/index.js';
import { isModuleEnabled } from '../lib/modules.js';
import { today } from '../lib/limits.js';
import { flushStats } from '../lib/stats.js';
import { metrics, sumRows } from '../lib/analytics.js';
import { publicUser } from '../lib/auth.js';
import { audit } from '../lib/audit.js';

const r = (method, path, handler) => accountRouter.add(method, path, handler);
const DAY = 86400_000;
const HOUR = 3600_000;
const flag = (name, def = '1') => (process.env[name] ?? def) !== '0';
const lastDays = (n, now = Date.now()) => Array.from({ length: n }, (_, i) => today(new Date(now - (n - 1 - i) * DAY)));
const pct = (a, b) => (b ? Math.round((a / b) * 10000) / 100 : null);

// 简单的 60 秒缓存：首页和文档页访问量大，统计数字晚一分钟无所谓
const memo = new Map();
function cached(key, fn, ttl = 60_000) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const data = fn();
  memo.set(key, { at: Date.now(), data });
  if (memo.size > 500) memo.delete(memo.keys().next().value);
  return data;
}
export const clearSiteCache = () => memo.clear();

// ---------- 首页平台数据 ----------
export function siteOverview(now = Date.now()) {
  flushStats();
  const mods = apiModules.filter((m) => isModuleEnabled(m.name));
  const pathToModule = new Map(mods.flatMap((m) => m.routes.map((x) => [x.path, m])));
  // 趋势只画已经过完的 7 天，今天单独显示，避免最后一天看起来像流量暴跌
  const all = lastDays(8, now);
  const days = all.slice(0, 7);
  const daily = sql('SELECT day, SUM(calls) AS calls, SUM(ok) AS ok, SUM(e4xx) AS e4xx, SUM(e5xx) AS e5xx FROM stats_daily WHERE day >= ? GROUP BY day').all(days[0]);
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const hourFloor = Math.floor(now / HOUR) * HOUR;
  const sumHours = (from, to) => sql('SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(e5xx), 0) AS e5xx FROM stats_hourly WHERE hour >= ? AND hour < ?').get(from, to);
  const h24 = sumHours(hourFloor - 23 * HOUR, hourFloor + HOUR);
  const prev24 = sumHours(hourFloor - 47 * HOUR, hourFloor - 23 * HOUR);
  const t = byDay.get(all.at(-1)) ?? { calls: 0, ok: 0, e5xx: 0 };
  // 热门接口：近 7 天调用最多的 6 个（按接口汇总多个调用地址）
  const hot = new Map();
  for (const row of sql('SELECT path, SUM(calls) AS calls FROM stats_daily WHERE day >= ? GROUP BY path').all(days[0])) {
    const m = pathToModule.get(row.path);
    if (m) hot.set(m.name, { name: m.name, title: m.title, category: m.category, calls: (hot.get(m.name)?.calls ?? 0) + row.calls });
  }
  return {
    apis: mods.length,
    routes: mods.reduce((n, m) => n + m.routes.length, 0),
    requestTotal: sql("SELECT COALESCE(SUM(total), 0) AS n FROM api_calls WHERE path LIKE '/api/%'").get().n,
    users: sql('SELECT COUNT(*) AS n FROM users').get().n,
    today: { calls: t.calls, availability: pct(t.calls - t.e5xx, t.calls) },
    last24h: { calls: h24.calls, delta: prev24.calls ? Math.round(((h24.calls - prev24.calls) / prev24.calls) * 1000) / 10 : null, availability: pct(h24.calls - h24.e5xx, h24.calls) },
    trend: days.map((day) => {
      const d = byDay.get(day);
      return { day, ok: d?.ok ?? 0, fail: d ? d.e4xx + d.e5xx : 0 };
    }),
    hot: [...hot.values()].sort((a, b) => b.calls - a.calls).slice(0, 6),
  };
}

r('GET', '/site/overview', () => {
  if (!flag('HOME_STATS')) return { data: null };
  return { data: cached('overview', () => siteOverview()) };
});

// ---------- 接口文档页：本周与上周调用、状态码分布、耗时 ----------
export function moduleStats(m, now = Date.now()) {
  flushStats();
  const paths = m.routes.map((x) => x.path);
  const marks = paths.map(() => '?').join(',');
  // 本周 = 最近 7 个完整的天（不含今天），上周 = 再往前 7 天
  const days = lastDays(15, now).slice(0, 14);
  const rows = sql(`SELECT day, path, ${STAT_COLS.join(', ')} FROM stats_daily WHERE day >= ? AND path IN (${marks})`).all(days[0], ...paths);
  const per = (list) => days.map((day) => {
    const s = sumRows(list.filter((x) => x.day === day));
    return { day, calls: s.calls, ok: s.ok, fail: s.e4xx + s.e5xx };
  });
  const week = sumRows(rows.filter((x) => x.day >= days[7] && x.day <= days.at(-1)));
  const mt = metrics(week);
  // 状态码分布读调用明细（近 7 天）；不登录也能调用的接口同样记录
  const codes = sql(`SELECT path, status, COUNT(*) AS n FROM request_log WHERE ts >= ? AND path IN (${marks}) GROUP BY path, status`).all(now - 7 * DAY, ...paths);
  const routes = Object.fromEntries(paths.map((p) => {
    const list = rows.filter((x) => x.path === p);
    const d = per(list);
    return [p, {
      total: sql('SELECT total FROM api_calls WHERE path = ?').get(p)?.total ?? 0,
      thisWeek: d.slice(7),
      lastWeek: d.slice(0, 7),
      codes: codes.filter((c) => c.path === p).map((c) => ({ status: c.status, n: c.n })).sort((a, b) => a.status - b.status),
    }];
  }));
  return {
    total: Object.values(routes).reduce((n, x) => n + x.total, 0),
    week: { calls: mt.calls, successRate: mt.successRate, avgMs: mt.avgMs, p50: mt.p50, p95: mt.p95, cacheHit: mt.cacheHit },
    routes,
  };
}

r('GET', '/stats/module/:name', (ctx) => {
  const m = apiModules.find((x) => x.name === ctx.params.name);
  if (!m || !isModuleEnabled(m.name)) throw new HttpError(404, '接口不存在');
  return { data: cached(`module:${m.name}`, () => moduleStats(m)) };
});

// ---------- 公告 ----------
const LEVELS = ['info', 'warn', 'important'];
const MODES = ['bar', 'popup'];
const FREQS = ['once', 'daily', 'always'];
// 可见人群：all 所有人，guest 未登录访客，user 已登录用户，admin 仅管理员
const AUDIENCES = ['all', 'guest', 'user', 'admin'];

const noticeRow = (n) => ({
  id: n.id, title: n.title, content: n.content, level: n.level, mode: n.mode, frequency: n.frequency,
  priority: n.priority, audience: n.audience, enabled: Boolean(n.enabled),
  startsAt: n.starts_at ? new Date(n.starts_at).toISOString() : null, endsAt: n.ends_at ? new Date(n.ends_at).toISOString() : null,
  createdAt: new Date(n.created_at).toISOString(), updatedAt: new Date(n.updated_at).toISOString(),
});

export function activeNotices(viewer = null, now = Date.now()) {
  const who = !viewer ? ['all', 'guest'] : publicUser(viewer).isAdmin ? ['all', 'user', 'admin'] : ['all', 'user'];
  return sql(`SELECT * FROM notices WHERE enabled = 1 AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at > ?)
              AND audience IN (${who.map(() => '?').join(',')}) ORDER BY priority DESC, updated_at DESC LIMIT 10`).all(now, now, ...who).map(noticeRow);
}

function parseTime(v, label) {
  if (v == null || v === '') return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new HttpError(400, `${label}格式不正确`);
  return t;
}

function noticeInput(body = {}, old = null) {
  const pick = (k, def) => (body[k] === undefined ? (old ? old[k] : def) : body[k]);
  const title = String(pick('title', '')).trim();
  const content = String(pick('content', '')).trim();
  if (!title || title.length > 80) throw new HttpError(400, '标题不能为空，最多 80 个字');
  if (content.length > 2000) throw new HttpError(400, '内容最多 2000 个字');
  const level = pick('level', 'info');
  const mode = pick('mode', 'bar');
  const frequency = pick('frequency', 'once');
  if (!LEVELS.includes(level)) throw new HttpError(400, '级别只能是 info / warn / important');
  if (!MODES.includes(mode)) throw new HttpError(400, '展示方式只能是 bar（顶部横幅）/ popup（弹窗）');
  if (!FREQS.includes(frequency)) throw new HttpError(400, '弹出频率只能是 once / daily / always');
  const startsAt = body.startsAt === undefined ? old?.starts_at ?? null : parseTime(body.startsAt, '开始时间');
  const endsAt = body.endsAt === undefined ? old?.ends_at ?? null : parseTime(body.endsAt, '结束时间');
  if (startsAt && endsAt && endsAt <= startsAt) throw new HttpError(400, '结束时间须晚于开始时间');
  const audience = pick('audience', 'all');
  if (!AUDIENCES.includes(audience)) throw new HttpError(400, '可见人群只能是 all / guest / user / admin');
  const priority = Number(pick('priority', 0));
  if (!Number.isInteger(priority) || priority < 0 || priority > 100) throw new HttpError(400, '优先级须为 0~100 的整数，越大越靠前');
  return {
    title, content, level, mode, frequency, startsAt, endsAt, audience, priority,
    enabled: Number(body.enabled === undefined ? (old ? Boolean(old.enabled) : true) : Boolean(body.enabled)),
  };
}

r('GET', '/site/notices', (ctx) => ({ data: activeNotices(ctx.user) }));

r('GET', '/admin/notices', (ctx) => {
  requireAdmin(ctx);
  return { data: sql('SELECT * FROM notices ORDER BY priority DESC, updated_at DESC').all().map(noticeRow) };
});
r('POST', '/admin/notices', (ctx) => {
  requireAdmin(ctx);
  if (sql('SELECT COUNT(*) AS n FROM notices').get().n >= 200) throw new HttpError(400, '公告最多 200 条，请先删除旧公告');
  const v = noticeInput(ctx.body);
  const now = Date.now();
  const { lastInsertRowid } = sql(`INSERT INTO notices (title, content, level, mode, frequency, priority, audience, enabled, starts_at, ends_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(v.title, v.content, v.level, v.mode, v.frequency, v.priority, v.audience, v.enabled, v.startsAt, v.endsAt, now, now);
  audit(ctx, 'notice.create', { target: v.title });
  return { data: noticeRow(sql('SELECT * FROM notices WHERE id = ?').get(lastInsertRowid)) };
});
r('PUT', '/admin/notices/:id', (ctx) => {
  requireAdmin(ctx);
  const old = sql('SELECT * FROM notices WHERE id = ?').get(Number(ctx.params.id));
  if (!old) throw new HttpError(404, '公告不存在');
  const v = noticeInput(ctx.body, old);
  sql(`UPDATE notices SET title = ?, content = ?, level = ?, mode = ?, frequency = ?, priority = ?, audience = ?, enabled = ?, starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?`)
    .run(v.title, v.content, v.level, v.mode, v.frequency, v.priority, v.audience, v.enabled, v.startsAt, v.endsAt, Date.now(), old.id);
  audit(ctx, 'notice.update', { target: v.title });
  return { data: noticeRow(sql('SELECT * FROM notices WHERE id = ?').get(old.id)) };
});
r('DELETE', '/admin/notices/:id', (ctx) => {
  requireAdmin(ctx);
  const old = sql('SELECT title FROM notices WHERE id = ?').get(Number(ctx.params.id));
  if (!old) throw new HttpError(404, '公告不存在');
  sql('DELETE FROM notices WHERE id = ?').run(Number(ctx.params.id));
  audit(ctx, 'notice.delete', { target: old.title });
  return { data: null };
});

// ---------- 友情链接 ----------
const LINK_STATUS = ['pending', 'approved', 'rejected'];
const parseJson = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
const linkRow = (l, { admin = false } = {}) => ({
  id: l.id, name: l.name, url: l.url, description: l.description,
  ...(admin ? {
    status: l.status, sort: l.sort, note: l.note, email: l.email ?? null, contactEmail: l.contact_email ?? null, ip: l.ip ?? null,
    createdAt: new Date(l.created_at).toISOString(), reviewedAt: l.reviewed_at ? new Date(l.reviewed_at).toISOString() : null,
    check: l.check_json ? { ...parseJson(l.check_json), at: new Date(l.checked_at).toISOString() } : null,
  } : {}),
});

// ---------- 友链防刷 ----------
// 每个账号每天最多提交 3 次、同时最多 3 个待审核；每个 IP 每天最多 5 次（挡多账号）；
// 被拒绝的网站 7 天内不能再申请；不能申请本站；判断是否同一网站时忽略 www.
// 配置了 SMTP 时还要填联系邮箱并输入邮箱验证码（发送验证码要先过图形验证码），否则提交时要填图形验证码
export const LINK_LIMITS = { userDaily: 3, pending: 3, ipDaily: 5, rejectCooldownDays: 7 };
const bareHost = (h) => String(h ?? '').toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
const hostOf = (u) => { try { return bareHost(new URL(u).hostname); } catch { return ''; } };
const ownHosts = (req) => [...new Set([hostOf(siteOrigin(req)), hostOf(config.publicUrl), bareHost(req?.headers?.host)].filter(Boolean))];
const dayStart = (now = Date.now()) => now - ((now + 8 * 3600_000) % DAY);
const linkEmailRequired = () => Boolean(config.smtp.host);
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
function contactEmail(raw) {
  const email = String(raw ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, '请填写正确的联系邮箱');
  return email;
}

export function normalizeSiteUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? '').trim()); } catch { throw new HttpError(400, '网站地址格式不正确，请以 https:// 开头'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new HttpError(400, '网站地址须以 http:// 或 https:// 开头');
  if (!u.hostname.includes('.')) throw new HttpError(400, '请填写可以公开访问的网站域名');
  if (u.href.length > 200) throw new HttpError(400, '网站地址过长');
  return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')}`;
}

function linkInput(body = {}, old = null) {
  const pick = (k, def = '') => (body[k] === undefined ? (old ? old[k] : def) : body[k]);
  const name = String(pick('name')).trim();
  const description = String(pick('description')).trim();
  if (!name || name.length > 30) throw new HttpError(400, '网站名称不能为空，最多 30 个字');
  if (description.length > 100) throw new HttpError(400, '网站描述最多 100 个字');
  if (/[<>]/.test(name + description)) throw new HttpError(400, '名称和描述不能包含 < >');
  return { name, description, url: normalizeSiteUrl(pick('url')) };
}

export const approvedLinks = () => sql("SELECT * FROM friend_links WHERE status = 'approved' ORDER BY sort DESC, id").all().map((l) => linkRow(l));

r('GET', '/site/links', (ctx) => ({
  data: {
    links: approvedLinks(),
    apply: {
      open: flag('FRIEND_LINK_APPLY'),
      notice: process.env.FRIEND_LINK_NOTICE || '请先在贵站添加本站链接，再提交申请。站点需能正常访问、内容合法，审核通过后展示。',
      // emailCode：需要联系邮箱 + 邮箱验证码；否则提交时填图形验证码
      emailCode: linkEmailRequired(),
      limits: LINK_LIMITS,
    },
    mine: ctx.user ? sql('SELECT * FROM friend_links WHERE user_id = ? ORDER BY id DESC LIMIT 10').all(ctx.user.id)
      .map((l) => ({ ...linkRow(l), status: l.status, note: l.status === 'rejected' ? l.note : null })) : [],
  },
}));

// 发送友链申请的邮箱验证码：要登录、要过图形验证码，发送频率沿用注册验证码的限制（按邮箱和 IP）
r('POST', '/site/links/send-code', async (ctx) => {
  requireUser(ctx);
  if (!flag('FRIEND_LINK_APPLY')) throw new HttpError(403, '暂未开放友情链接申请');
  if (!linkEmailRequired()) throw new HttpError(400, '站点未配置邮件服务，提交申请时填写图形验证码即可');
  const email = contactEmail(ctx.body?.email);
  checkCaptcha(ctx.body?.captchaToken, ctx.body?.captchaAnswer);
  return { data: await sendEmailCode({ email, purpose: 'friendlink', ip: ctx.ip, exists: true }) };
});

r('POST', '/site/links', (ctx) => {
  const user = requireUser(ctx);
  if (!flag('FRIEND_LINK_APPLY')) throw new HttpError(403, '暂未开放友情链接申请');
  const v = linkInput(ctx.body);
  const host = hostOf(v.url);
  if (ownHosts(ctx.req).includes(host)) throw new HttpError(400, '不能申请本站自己的地址，请填写你的网站地址');
  const since = dayStart();
  const L = LINK_LIMITS;
  if (sql("SELECT COUNT(*) AS n FROM friend_links WHERE user_id = ? AND status = 'pending'").get(user.id).n >= L.pending) throw new HttpError(429, `你已有 ${L.pending} 个申请在等待审核，请耐心等待`, 'RATE_LIMITED');
  if (sql('SELECT COUNT(*) AS n FROM friend_links WHERE user_id = ? AND created_at >= ?').get(user.id, since).n >= L.userDaily) throw new HttpError(429, `每个账号每天最多提交 ${L.userDaily} 次友链申请，请明天再试`, 'RATE_LIMITED');
  if (sql('SELECT COUNT(*) AS n FROM friend_links WHERE ip = ? AND created_at >= ?').get(ctx.ip, since).n >= L.ipDaily) throw new HttpError(429, '今天从你的网络提交的友链申请太多了，请明天再试', 'RATE_LIMITED');
  const same = sql('SELECT url, status, reviewed_at, created_at FROM friend_links').all().filter((l) => hostOf(l.url) === host);
  if (same.some((l) => l.status !== 'rejected')) throw new HttpError(400, '这个网站已经申请过或已在友情链接中');
  const lastReject = Math.max(0, ...same.map((l) => l.reviewed_at ?? l.created_at));
  const wait = lastReject + L.rejectCooldownDays * DAY - Date.now();
  if (lastReject && wait > 0) throw new HttpError(400, `这个网站的申请最近未通过，请 ${Math.ceil(wait / DAY)} 天后再申请`);
  // 校验（放在最后：前面的检查不通过时不浪费用户的验证码）
  let email = null;
  if (linkEmailRequired()) {
    email = contactEmail(ctx.body?.email);
    consumeEmailCode(email, 'friendlink', ctx.body?.emailCode);
  } else {
    checkCaptcha(ctx.body?.captchaToken, ctx.body?.captchaAnswer);
  }
  const { lastInsertRowid } = sql('INSERT INTO friend_links (name, url, description, status, user_id, ip, contact_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(v.name, v.url, v.description, 'pending', user.id, ctx.ip, email, Date.now());
  return { data: { id: Number(lastInsertRowid), status: 'pending' } };
});

// 后台检测：访问对方首页，看能不能打开、有没有加本站链接（只访问公网地址，最多跟随 5 次跳转、读取 2MB）
export async function checkLinkSite(url, hosts) {
  const t0 = Date.now();
  try {
    const r = await fetchFollow(url, { timeoutMs: 8000, headers: { 'user-agent': 'Mozilla/5.0 (compatible; MiaoAPI-LinkCheck/1.0)', accept: 'text/html,*/*' } });
    const status = r.res.statusCode;
    const { body } = await readLimited(r.res, { maxBytes: 2_000_000, decompress: true });
    const html = body.toString('utf8');
    const lower = html.toLowerCase();
    return {
      reachable: status >= 200 && status < 400, status, finalUrl: r.url.href, ms: Date.now() - t0,
      title: stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').slice(0, 100) || null,
      backlink: hosts.some((h) => lower.includes(h)),
    };
  } catch (err) {
    return { reachable: false, status: null, error: reasonOf(err), ms: Date.now() - t0, backlink: false };
  }
}

r('POST', '/admin/links/:id/check', async (ctx) => {
  requireAdmin(ctx);
  const l = sql('SELECT * FROM friend_links WHERE id = ?').get(Number(ctx.params.id));
  if (!l) throw new HttpError(404, '友情链接不存在');
  const result = await checkLinkSite(l.url, ownHosts(ctx.req));
  sql('UPDATE friend_links SET check_json = ?, checked_at = ? WHERE id = ?').run(JSON.stringify(result), Date.now(), l.id);
  return { data: { ...result, at: new Date().toISOString() } };
});

r('GET', '/admin/links', (ctx) => {
  requireAdmin(ctx);
  return {
    data: sql(`SELECT l.*, u.email FROM friend_links l LEFT JOIN users u ON u.id = l.user_id
               ORDER BY CASE l.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, l.sort DESC, l.id DESC`).all().map((l) => linkRow(l, { admin: true })),
  };
});
// 管理员直接添加（无需审核）
r('POST', '/admin/links', (ctx) => {
  requireAdmin(ctx);
  const v = linkInput(ctx.body);
  const { lastInsertRowid } = sql('INSERT INTO friend_links (name, url, description, status, sort, created_at, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(v.name, v.url, v.description, 'approved', Number.parseInt(ctx.body?.sort, 10) || 0, Date.now(), Date.now());
  audit(ctx, 'link.create', { target: `${v.name} ${v.url}` });
  return { data: { id: Number(lastInsertRowid) } };
});
r('PUT', '/admin/links/:id', (ctx) => {
  requireAdmin(ctx);
  const old = sql('SELECT * FROM friend_links WHERE id = ?').get(Number(ctx.params.id));
  if (!old) throw new HttpError(404, '友情链接不存在');
  const v = linkInput(ctx.body, old);
  const status = ctx.body?.status ?? old.status;
  if (!LINK_STATUS.includes(status)) throw new HttpError(400, '状态只能是 pending / approved / rejected');
  const sort = ctx.body?.sort === undefined ? old.sort : Number.parseInt(ctx.body.sort, 10) || 0;
  const note = ctx.body?.note === undefined ? old.note : String(ctx.body.note ?? '').trim().slice(0, 200) || null;
  sql('UPDATE friend_links SET name = ?, url = ?, description = ?, status = ?, sort = ?, note = ?, reviewed_at = ? WHERE id = ?')
    .run(v.name, v.url, v.description, status, sort, note, status !== old.status ? Date.now() : old.reviewed_at, old.id);
  audit(ctx, status !== old.status ? `link.${status}` : 'link.update', { target: `${v.name} ${v.url}`, reason: note });
  return { data: null };
});
r('DELETE', '/admin/links/:id', (ctx) => {
  requireAdmin(ctx);
  const old = sql('SELECT name, url FROM friend_links WHERE id = ?').get(Number(ctx.params.id));
  if (!old) throw new HttpError(404, '友情链接不存在');
  sql('DELETE FROM friend_links WHERE id = ?').run(Number(ctx.params.id));
  audit(ctx, 'link.delete', { target: `${old.name} ${old.url}` });
  return { data: null };
});

// ---------- 按请求 ID 查调用记录 ----------
r('GET', '/admin/request', (ctx) => {
  requireAdmin(ctx);
  const rid = String(ctx.query.get('rid') ?? '').trim();
  if (!/^[a-z0-9]{6,12}-[0-9a-f]{10}$/.test(rid)) throw new HttpError(400, '请求 ID 格式不正确，形如 mfx3k2a1-9f3c2b1a0d');
  const row = sql(`SELECT l.*, u.email, k.name AS keyName, k.prefix AS keyPrefix FROM request_log l
                   LEFT JOIN users u ON u.id = l.user_id LEFT JOIN api_keys k ON k.id = l.key_id WHERE l.rid = ?`).get(rid);
  if (!row) throw new HttpError(404, '没有找到这个请求：可能已超过调用明细保留天数，或这次请求没有记录（如被限流、调用的是非接口地址）');
  return {
    data: {
      rid: row.rid, at: new Date(row.ts).toISOString(), path: row.path, status: row.status, ms: row.ms, error: row.error,
      cached: row.cached, bytes: row.bytes, via: row.via, ip: row.ip, region: row.region, isp: row.isp, referer: row.referer, client: row.client,
      user: row.user_id ? { id: row.user_id, email: row.email } : null,
      key: row.key_id ? { id: row.key_id, name: row.keyName, prefix: row.keyPrefix } : null,
    },
  };
});

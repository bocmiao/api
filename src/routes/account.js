import { sql, db } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';
import {
  hashPassword, verifyPassword, validateCredentials, publicUser,
  createSession, destroySession, sessionCookie, generateApiKey,
} from '../lib/auth.js';
import { quota, today } from '../lib/limits.js';
import { channelCatalog, validateChannel, sendToChannel, maskConfig } from '../notify/channels.js';
import { topicCatalog, topics } from '../notify/topics.js';
import { pushNow } from '../notify/scheduler.js';
import { Router } from '../lib/router.js';
import { checkUpdate, startUpdate, updateProgress } from '../lib/updater.js';
import { checkCaptcha, sendEmailCode, consumeEmailCode, PURPOSES } from '../lib/emailcode.js';
import { createCaptcha } from '../apis/tools/captcha.js';
import { modules as apiModules, categories as apiCategories } from '../apis/index.js';
import { isModuleEnabled, setModulesEnabled } from '../lib/modules.js';
import { listSettings, saveSettings } from '../lib/settings.js';
import { testService, serviceOfKey, linkOfKey } from '../lib/keytest.js';
import { sendMail } from '../notify/smtp.js';
import { invoke, apiRouter } from '../registry.js';
import { localVersion, RUNNING_VERSION } from '../lib/updater.js';
import { cache } from '../lib/cache.js';
import { isBlockedIP } from '../lib/netguard.js';
import { loadIpInfo } from '../apis/life/ip.js';

export const accountRouter = new Router();
const r = (method, path, handler, opts = {}) => accountRouter.add(method, path, handler, opts);

function requireUser(ctx) {
  if (!ctx.user) throw new HttpError(401, '请先登录');
  return ctx.user;
}
function requireAdmin(ctx) {
  if (!publicUser(requireUser(ctx)).isAdmin) throw new HttpError(403, '需要管理员权限');
}

// 登录失败限速：同一 IP 15 分钟内最多失败 10 次
const loginFails = new Map();
function checkLoginRate(ip) {
  const e = loginFails.get(ip);
  if (e && e.until > Date.now() && e.count >= 10) throw new HttpError(429, '登录失败次数过多，请 15 分钟后再试');
}
function recordLoginFail(ip) {
  const e = loginFails.get(ip);
  if (!e || e.until < Date.now()) loginFails.set(ip, { count: 1, until: Date.now() + 15 * 60_000 });
  else e.count++;
}

// ---------- 注册 / 登录 ----------

// 图形验证码（发送邮箱验证码前使用）
r('GET', '/auth/captcha', () => ({ data: createCaptcha('alnum', 4) }));

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

r('POST', '/auth/send-code', async (ctx) => {
  if (!config.emailVerify) throw new HttpError(400, '未开启邮箱验证');
  const email = String(ctx.body?.email ?? '').trim().toLowerCase();
  const purpose = ctx.body?.purpose;
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, '邮箱格式不正确');
  if (!PURPOSES[purpose]) throw new HttpError(400, 'purpose 只能是 register 或 reset');
  if (purpose === 'register' && !config.registrationOpen) throw new HttpError(403, '暂未开放注册');
  checkCaptcha(ctx.body?.captchaToken, ctx.body?.captchaAnswer);
  const exists = Boolean(sql('SELECT 1 FROM users WHERE email = ?').get(email));
  return { data: await sendEmailCode({ email, purpose, ip: ctx.ip, exists }) };
});

r('POST', '/auth/reset-password', async (ctx) => {
  if (!config.emailVerify) throw new HttpError(400, '未开启邮箱验证，请联系管理员重置密码');
  const email = validateCredentials(ctx.body?.email, ctx.body?.password);
  consumeEmailCode(email, 'reset', ctx.body?.code);
  const user = sql('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) throw new HttpError(400, '请先获取邮箱验证码');
  sql('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(ctx.body.password), user.id);
  sql('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  if (user.disabled) throw new HttpError(403, '密码已重置，但账号已被停用');
  ctx.setCookie(sessionCookie(createSession(user.id), ctx.req));
  return { data: publicUser(user) };
});

r('POST', '/auth/register', async (ctx) => {
  if (!config.registrationOpen) throw new HttpError(403, '暂未开放注册');
  const email = validateCredentials(ctx.body?.email, ctx.body?.password);
  if (sql('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, '该邮箱已注册');
  if (config.emailVerify) consumeEmailCode(email, 'register', ctx.body?.code);
  // 第一个注册的用户自动成为管理员
  const isFirst = !sql('SELECT 1 FROM users LIMIT 1').get();
  const { lastInsertRowid } = sql('INSERT INTO users (email, password_hash, is_admin) VALUES (?, ?, ?)')
    .run(email, await hashPassword(ctx.body.password), isFirst ? 1 : 0);
  ctx.setCookie(sessionCookie(createSession(Number(lastInsertRowid)), ctx.req));
  return { data: publicUser(sql('SELECT * FROM users WHERE id = ?').get(lastInsertRowid)) };
});

r('POST', '/auth/login', async (ctx) => {
  checkLoginRate(ctx.ip);
  const email = String(ctx.body?.email ?? '').trim().toLowerCase();
  const user = sql('SELECT * FROM users WHERE email = ?').get(email);
  const ok = user && (await verifyPassword(String(ctx.body?.password ?? ''), user.password_hash));
  if (!ok) {
    recordLoginFail(ctx.ip);
    throw new HttpError(401, '邮箱或密码错误');
  }
  if (user.disabled) throw new HttpError(403, '账号已被停用');
  loginFails.delete(ctx.ip);
  ctx.setCookie(sessionCookie(createSession(user.id), ctx.req));
  return { data: publicUser(user) };
});

r('POST', '/auth/logout', (ctx) => {
  destroySession(ctx.sessionToken);
  ctx.setCookie(sessionCookie(null, ctx.req));
  return { data: null };
});

r('GET', '/auth/me', (ctx) => ({ data: { user: publicUser(ctx.user), quota: quota({ user: ctx.user, ip: ctx.ip }) } }));

r('POST', '/account/password', async (ctx) => {
  const user = requireUser(ctx);
  if (!(await verifyPassword(String(ctx.body?.current ?? ''), user.password_hash))) throw new HttpError(400, '当前密码不正确');
  validateCredentials(user.email, ctx.body?.next);
  sql('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(ctx.body.next), user.id);
  // 修改密码后注销其他设备
  sql('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  ctx.setCookie(sessionCookie(createSession(user.id), ctx.req));
  return { data: null };
});

r('DELETE', '/account', async (ctx) => {
  const user = requireUser(ctx);
  if (!(await verifyPassword(String(ctx.body?.password ?? ''), user.password_hash))) throw new HttpError(400, '密码不正确');
  sql('DELETE FROM users WHERE id = ?').run(user.id);
  ctx.setCookie(sessionCookie(null, ctx.req));
  return { data: null };
});

// ---------- API Key ----------

r('GET', '/account/keys', (ctx) => {
  const user = requireUser(ctx);
  const keys = sql('SELECT id, name, prefix, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY id DESC').all(user.id);
  return { data: keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, createdAt: k.created_at, lastUsedAt: k.last_used_at })) };
});

r('POST', '/account/keys', (ctx) => {
  const user = requireUser(ctx);
  const name = String(ctx.body?.name ?? '').trim() || '默认';
  if (name.length > 40) throw new HttpError(400, '名称最多 40 个字符');
  const count = sql('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?').get(user.id).n;
  if (count >= config.limits.maxKeys) throw new HttpError(400, `每个账号最多创建 ${config.limits.maxKeys} 个 Key`);
  const { key, prefix, hash } = generateApiKey();
  const { lastInsertRowid } = sql('INSERT INTO api_keys (user_id, name, prefix, key_hash) VALUES (?, ?, ?, ?)').run(user.id, name, prefix, hash);
  // 完整 Key 只在创建时返回一次
  return { data: { id: Number(lastInsertRowid), name, prefix, key } };
});

r('DELETE', '/account/keys/:id', (ctx) => {
  const user = requireUser(ctx);
  const { changes } = sql('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(Number(ctx.params.id), user.id);
  if (!changes) throw new HttpError(404, 'Key 不存在');
  return { data: null };
});

// ---------- 用量统计 ----------

function lastDays(n) {
  const days = [];
  for (let i = n - 1; i >= 0; i--) days.push(today(new Date(Date.now() - i * 86400_000)));
  return days;
}

function endpointStats(where, args, since, limit = 15) {
  return sql(`SELECT path, COUNT(*) AS calls, CAST(AVG(ms) AS INTEGER) AS avgMs,
                     SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors
              FROM request_log WHERE ts >= ? ${where} GROUP BY path ORDER BY calls DESC LIMIT ?`).all(since, ...args, limit);
}

r('GET', '/account/usage', (ctx) => {
  const user = requireUser(ctx);
  const days = lastDays(14);
  const rows = sql('SELECT day, count FROM usage_daily WHERE subject = ? AND day >= ?').all(`user:${user.id}`, days[0]);
  const map = Object.fromEntries(rows.map((x) => [x.day, x.count]));
  const since = Date.now() - 7 * 86400_000;
  return {
    data: {
      quota: quota({ user, ip: ctx.ip }),
      daily: days.map((day) => ({ day, count: map[day] ?? 0 })),
      endpoints: endpointStats('AND user_id = ?', [user.id], since),
      recent: sql(`SELECT l.ts, l.path, l.status, l.ms, k.name AS keyName FROM request_log l
                   LEFT JOIN api_keys k ON k.id = l.key_id WHERE l.user_id = ? ORDER BY l.id DESC LIMIT 20`).all(user.id),
    },
  };
});

// ---------- 推送 ----------

function channelRow(c) {
  return { id: c.id, type: c.type, name: c.name, config: maskConfig(c.type, JSON.parse(c.config)), createdAt: c.created_at };
}
function ownChannel(user, id) {
  const c = sql('SELECT * FROM channels WHERE id = ? AND user_id = ?').get(Number(id), user.id);
  if (!c) throw new HttpError(404, '推送渠道不存在');
  return c;
}

r('GET', '/account/notify', (ctx) => {
  const user = requireUser(ctx);
  return {
    data: {
      types: channelCatalog(),
      topics: topicCatalog(),
      channels: sql('SELECT * FROM channels WHERE user_id = ? ORDER BY id').all(user.id).map(channelRow),
      subscriptions: sql('SELECT s.topic, s.channel_id AS channelId FROM subscriptions s WHERE s.user_id = ?').all(user.id),
    },
  };
});

r('POST', '/account/channels', async (ctx) => {
  const user = requireUser(ctx);
  const { type, name } = ctx.body ?? {};
  const count = sql('SELECT COUNT(*) AS n FROM channels WHERE user_id = ?').get(user.id).n;
  if (count >= config.limits.maxChannels) throw new HttpError(400, `最多添加 ${config.limits.maxChannels} 个推送渠道`);
  const cfg = await validateChannel(type, ctx.body?.config);
  const label = String(name ?? '').trim().slice(0, 40) || type;
  const { lastInsertRowid } = sql('INSERT INTO channels (user_id, type, name, config) VALUES (?, ?, ?, ?)').run(user.id, type, label, JSON.stringify(cfg));
  return { data: channelRow(sql('SELECT * FROM channels WHERE id = ?').get(lastInsertRowid)) };
});

r('DELETE', '/account/channels/:id', (ctx) => {
  const user = requireUser(ctx);
  ownChannel(user, ctx.params.id);
  sql('DELETE FROM channels WHERE id = ?').run(Number(ctx.params.id));
  return { data: null };
});

async function sendOrExplain(fn) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, `推送失败：${err.message}`);
  }
}

r('POST', '/account/channels/:id/test', async (ctx) => {
  const channel = ownChannel(requireUser(ctx), ctx.params.id);
  await sendOrExplain(() => sendToChannel(channel, { title: 'Miao API 测试消息', text: '收到这条消息说明推送渠道配置成功 🎉', topic: 'test' }));
  return { data: null };
});

r('PUT', '/account/subscriptions', (ctx) => {
  const user = requireUser(ctx);
  const { topic, channelId, enabled } = ctx.body ?? {};
  if (!topics[topic]) throw new HttpError(400, '主题不存在');
  ownChannel(user, channelId);
  if (enabled) sql('INSERT OR IGNORE INTO subscriptions (user_id, topic, channel_id) VALUES (?, ?, ?)').run(user.id, topic, Number(channelId));
  else sql('DELETE FROM subscriptions WHERE topic = ? AND channel_id = ?').run(topic, Number(channelId));
  return { data: null };
});

r('POST', '/account/subscriptions/push', async (ctx) => {
  const user = requireUser(ctx);
  const channel = ownChannel(user, ctx.body?.channelId);
  await sendOrExplain(() => pushNow(ctx.body?.topic, channel));
  return { data: null };
});

// ---------- 管理员 ----------

r('GET', '/admin/stats', (ctx) => {
  requireAdmin(ctx);
  const days = lastDays(14);
  const rows = sql(`SELECT day, SUM(count) AS count,
                           SUM(CASE WHEN subject LIKE 'ip:%' THEN count ELSE 0 END) AS anon
                    FROM usage_daily WHERE day >= ? GROUP BY day`).all(days[0]);
  const map = Object.fromEntries(rows.map((x) => [x.day, x]));
  const since = Date.now() - 86400_000;
  const last24 = sql(`SELECT COUNT(*) AS calls, CAST(AVG(ms) AS INTEGER) AS avgMs,
                             SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
                             COUNT(DISTINCT ip) AS ips FROM request_log WHERE ts >= ?`).get(since);
  return {
    data: {
      totals: {
        users: sql('SELECT COUNT(*) AS n FROM users').get().n,
        keys: sql('SELECT COUNT(*) AS n FROM api_keys').get().n,
        channels: sql('SELECT COUNT(*) AS n FROM channels').get().n,
        subscriptions: sql('SELECT COUNT(*) AS n FROM subscriptions').get().n,
        ...last24,
      },
      daily: days.map((day) => ({ day, count: map[day]?.count ?? 0, anon: map[day]?.anon ?? 0 })),
      // 管理后台返回全部接口（前端每页显示 10 个）
      endpoints: endpointStats('', [], Date.now() - 7 * 86400_000, 1000),
      errors: sql(`SELECT path, status, COUNT(*) AS n FROM request_log WHERE ts >= ? AND status >= 500
                   GROUP BY path, status ORDER BY n DESC LIMIT 10`).all(since),
    },
  };
});

// 用户列表：支持按邮箱搜索、分页（每页 10）
r('GET', '/admin/users', (ctx) => {
  requireAdmin(ctx);
  const day = today();
  const q = String(ctx.query.get('q') ?? '').trim().slice(0, 100);
  const page = Math.max(1, Math.min(10_000, Number.parseInt(ctx.query.get('page') ?? '1', 10) || 1));
  const size = 10;
  const where = q ? 'WHERE u.email LIKE ? ESCAPE \'\\\'' : '';
  const args = q ? [`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`] : [];
  const total = sql(`SELECT COUNT(*) AS n FROM users u ${where}`).get(...args).n;
  const since7 = Date.now() - 7 * 86400_000;
  const users = sql(`SELECT u.*, (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = u.id) AS keys,
                            COALESCE((SELECT count FROM usage_daily d WHERE d.day = ? AND d.subject = 'user:' || u.id), 0) AS usedToday,
                            (SELECT COUNT(*) FROM request_log l WHERE l.user_id = u.id AND l.ts >= ?) AS calls7d,
                            (SELECT MAX(ts) FROM request_log l WHERE l.user_id = u.id) AS lastCallAt
                     FROM users u ${where} ORDER BY u.id DESC LIMIT ? OFFSET ?`).all(day, since7, ...args, size, (page - 1) * size);
  return {
    data: {
      total, page, size,
      items: users.map((u) => ({
        ...publicUser(u), disabled: Boolean(u.disabled), keys: u.keys, usedToday: u.usedToday, customLimit: u.daily_limit,
        calls7d: u.calls7d, lastCallAt: u.lastCallAt ? new Date(u.lastCallAt).toISOString() : null,
      })),
    },
  };
});

r('PATCH', '/admin/users/:id', (ctx) => {
  requireAdmin(ctx);
  const id = Number(ctx.params.id);
  const target = sql('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) throw new HttpError(404, '用户不存在');
  const { dailyLimit, disabled } = ctx.body ?? {};
  db.exec('BEGIN');
  try {
    if (dailyLimit !== undefined) {
      if (dailyLimit !== null && !(Number.isInteger(dailyLimit) && dailyLimit >= 0 && dailyLimit <= 1e9)) throw new HttpError(400, '额度须为非负整数');
      sql('UPDATE users SET daily_limit = ? WHERE id = ?').run(dailyLimit, id);
    }
    if (disabled !== undefined) {
      if (id === ctx.user.id) throw new HttpError(400, '不能停用自己');
      sql('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
      if (disabled) sql('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { data: null };
});

// ---------- 在线更新 ----------

r('GET', '/admin/update', async (ctx) => {
  requireAdmin(ctx);
  return { data: await checkUpdate() };
});

// 在后台执行更新并立即返回，前端轮询 /admin/update/progress 显示进度（避免长请求被 CDN / 反向代理超时断开）
r('POST', '/admin/update', (ctx) => {
  requireAdmin(ctx);
  const started = startUpdate({ sha: ctx.body?.sha }, (result) => {
    // 由守护进程启动时以退出码 75 退出，守护进程立即用新代码重启；留几秒让前端取到「更新完成」
    if (result.restart) setTimeout(() => process.exit(75), 3000).unref();
  });
  return { data: started };
});

r('GET', '/admin/update/progress', (ctx) => {
  requireAdmin(ctx);
  return { data: updateProgress() };
});

// ---------- 接口开关 ----------

r('GET', '/admin/modules', (ctx) => {
  requireAdmin(ctx);
  const since = Date.now() - 7 * 86400_000;
  const calls = new Map(sql('SELECT path, COUNT(*) AS n FROM request_log WHERE ts >= ? GROUP BY path').all(since).map((x) => [x.path, x.n]));
  return {
    data: {
      categories: apiCategories,
      modules: apiModules.map((m) => ({
        name: m.name,
        title: m.title,
        category: m.category,
        enabled: isModuleEnabled(m.name),
        routes: m.routes.map((x) => x.path),
        calls7d: m.routes.reduce((n, x) => n + (calls.get(x.path) ?? 0), 0),
      })),
    },
  };
});

// body: { names: [...], enabled: true|false }
r('PUT', '/admin/modules', (ctx) => {
  requireAdmin(ctx);
  const { names, enabled } = ctx.body ?? {};
  const known = new Set(apiModules.map((m) => m.name));
  if (!Array.isArray(names) || !names.length || names.some((n) => !known.has(n))) throw new HttpError(400, '模块名无效');
  if (typeof enabled !== 'boolean') throw new HttpError(400, 'enabled 须为 true 或 false');
  setModulesEnabled(names, enabled);
  return { data: { names, enabled } };
});

// ---------- 系统设置 ----------

r('GET', '/admin/settings', (ctx) => {
  requireAdmin(ctx);
  // link：申请密钥的地址；test：该项旁边显示「测试连通性」按钮，值为服务 id
  const groups = listSettings().map((g) => ({
    ...g,
    fields: g.fields.map((f) => ({ ...f, link: linkOfKey.get(f.key) ?? null, test: serviceOfKey.get(f.key)?.id ?? null })),
  }));
  return { data: groups };
});

// body: { service }；用已保存的配置向上游发一个最小请求，返回 { ok, message, detail }
r('POST', '/admin/settings/test-key', async (ctx) => {
  requireAdmin(ctx);
  return { data: await testService(String(ctx.body?.service ?? '')) };
});

// body: { KEY: 'value' | null }
r('PUT', '/admin/settings', (ctx) => {
  requireAdmin(ctx);
  return { data: { saved: saveSettings(ctx.body) } };
});

r('POST', '/admin/settings/test-mail', async (ctx) => {
  requireAdmin(ctx);
  if (!config.smtp.host) throw new HttpError(400, '请先填写并保存 SMTP 服务器');
  const to = String(ctx.body?.to || ctx.user.email).trim();
  if (!EMAIL_RE.test(to)) throw new HttpError(400, '收件邮箱格式不正确');
  try {
    await sendMail({ ...config.smtp, to, subject: 'Miao API 测试邮件', text: '收到这封邮件，说明 SMTP 配置正确。\n\n—— Miao API' });
  } catch (err) {
    throw new HttpError(502, `发送失败：${err.message}`);
  }
  return { data: { to } };
});

// ---------- 首页「今日」 ----------
// 服务器统一聚合并缓存 5 分钟，不计入访客额度；单个数据源失败只影响对应卡片
const TODAY_SOURCES = {
  greeting: ['/api/greeting'],
  epic: ['/api/epic/free'],
  holiday: ['/api/holiday/next'],
  hot: ['/api/hot/weibo', { limit: '10' }],
  fx: ['/api/fx/rates', { base: 'USD', symbols: 'CNY,EUR,JPY,HKD,GBP' }],
  bing: ['/api/bing'],
  hitokoto: ['/api/hitokoto'],
  history: ['/api/history/today'],
  metals: ['/api/metals'],
};
const DEFAULT_CITY = '北京';

// 天气按访客所在城市：优先用访客自己选的 city，否则按 IP 定位（城市级精度），都不行时用默认城市
async function todayWeather(ctx) {
  const chosen = String(ctx.query.get('city') ?? '').trim().slice(0, 30);
  if (chosen) {
    try {
      return { ...(await invoke('/api/weather', { city: chosen })), located: 'chosen' };
    } catch { /* 城市名查不到时退回 IP 定位 */ }
  }
  if (!isBlockedIP(ctx.ip)) {
    try {
      const loc = await loadIpInfo(ctx.ip);
      if (loc?.countryCode === 'CN' && loc.lat != null && loc.lon != null) {
        const w = await invoke('/api/weather', { lat: String(loc.lat), lon: String(loc.lon) });
        return { ...w, location: { ...w.location, name: loc.city || loc.region || w.location?.name }, located: 'ip' };
      }
    } catch { /* ip-api 限流或失败时用默认城市 */ }
  }
  return { ...(await invoke('/api/weather', { city: DEFAULT_CITY })), located: 'default' };
}

// 公共部分由服务器统一聚合，所有访客共用、不计入访客额度。
// 先返回已有数据、过期了再在后台刷新（访客不用等上游）；服务启动时预热，之后每 5 分钟自动刷新一次。
const TODAY_TTL = 5 * 60_000;
const todayState = { data: null, at: 0, pending: null };

function refreshToday() {
  todayState.pending ??= (async () => {
    const keys = Object.keys(TODAY_SOURCES);
    const settled = await Promise.allSettled(keys.map((k) => invoke(...TODAY_SOURCES[k])));
    const data = Object.fromEntries(keys.map((k, i) => [k, settled[i].status === 'fulfilled' ? settled[i].value : null]));
    // 某一项这次失败时沿用上一次的数据，避免卡片时有时无
    if (todayState.data) for (const k of keys) data[k] ??= todayState.data[k];
    todayState.data = data;
    todayState.at = Date.now();
    return data;
  })().finally(() => { todayState.pending = null; });
  return todayState.pending;
}

export function warmToday() {
  refreshToday().catch(() => {});
  setInterval(() => refreshToday().catch(() => {}), TODAY_TTL).unref();
}

r('GET', '/home/today', async () => {
  if (!todayState.data) return { data: await refreshToday() };
  if (Date.now() - todayState.at > TODAY_TTL) refreshToday().catch(() => {});
  return { data: todayState.data };
});

// 天气按访客城市单独取（同一城市、同一 IP 都有缓存），和公共部分分开请求，慢了也不拖累其他卡片
r('GET', '/home/weather', async (ctx) => ({ data: await todayWeather(ctx).catch(() => null) }));

// ---------- 运行状态 ----------
const STARTED_AT = Date.now();

r('GET', '/status', () => {
  const since = Date.now() - 86400_000;
  const rows = sql(`SELECT path, COUNT(*) AS calls,
                           SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS errors,
                           CAST(AVG(ms) AS INTEGER) AS avgMs,
                           MAX(CASE WHEN status >= 500 THEN ts END) AS lastErrorAt
                    FROM request_log WHERE ts >= ? GROUP BY path`).all(since);
  const byModule = new Map();
  for (const row of rows) {
    const hit = apiRouter.match('GET', row.path) ?? apiRouter.match('POST', row.path);
    const name = hit?.route?.module?.name;
    if (!name) continue;
    const m = byModule.get(name) ?? { calls: 0, errors: 0, msTotal: 0, lastErrorAt: null };
    m.calls += row.calls;
    m.errors += row.errors;
    m.msTotal += row.avgMs * row.calls;
    if (row.lastErrorAt && (!m.lastErrorAt || row.lastErrorAt > m.lastErrorAt)) m.lastErrorAt = row.lastErrorAt;
    byModule.set(name, m);
  }
  const modules = apiModules.filter((m) => isModuleEnabled(m.name)).map((m) => {
    const st = byModule.get(m.name);
    const errorRate = st?.calls ? st.errors / st.calls : 0;
    return {
      name: m.name, title: m.title, category: m.category,
      calls: st?.calls ?? 0,
      errorRate: Math.round(errorRate * 1000) / 10,
      avgMs: st?.calls ? Math.round(st.msTotal / st.calls) : null,
      lastErrorAt: st?.lastErrorAt ? new Date(st.lastErrorAt).toISOString() : null,
      status: !st?.calls ? 'idle' : errorRate >= 0.5 ? 'down' : errorRate >= 0.1 ? 'degraded' : 'ok',
    };
  });
  return {
    data: {
      version: RUNNING_VERSION ?? localVersion(),
      diskVersion: localVersion(),
      uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
      categories: apiCategories,
      modules,
    },
  };
});

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
import { checkUpdate, applyUpdate } from '../lib/updater.js';
import { checkCaptcha, sendEmailCode, consumeEmailCode, PURPOSES } from '../lib/emailcode.js';
import { createCaptcha } from '../apis/tools/captcha.js';
import { modules as apiModules, categories as apiCategories } from '../apis/index.js';
import { isModuleEnabled, setModulesEnabled } from '../lib/modules.js';

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

function endpointStats(where, args, since) {
  return sql(`SELECT path, COUNT(*) AS calls, CAST(AVG(ms) AS INTEGER) AS avgMs,
                     SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors
              FROM request_log WHERE ts >= ? ${where} GROUP BY path ORDER BY calls DESC LIMIT 15`).all(since, ...args);
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
      endpoints: endpointStats('', [], Date.now() - 7 * 86400_000),
      errors: sql(`SELECT path, status, COUNT(*) AS n FROM request_log WHERE ts >= ? AND status >= 500
                   GROUP BY path, status ORDER BY n DESC LIMIT 10`).all(since),
    },
  };
});

r('GET', '/admin/users', (ctx) => {
  requireAdmin(ctx);
  const day = today();
  const users = sql(`SELECT u.*, (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = u.id) AS keys,
                            COALESCE((SELECT count FROM usage_daily d WHERE d.day = ? AND d.subject = 'user:' || u.id), 0) AS usedToday
                     FROM users u ORDER BY u.id DESC LIMIT 200`).all(day);
  return {
    data: users.map((u) => ({ ...publicUser(u), disabled: Boolean(u.disabled), keys: u.keys, usedToday: u.usedToday, customLimit: u.daily_limit })),
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

r('POST', '/admin/update', async (ctx) => {
  requireAdmin(ctx);
  const result = await applyUpdate({ sha: ctx.body?.sha });
  // 由守护进程启动时，响应发出后以退出码 75 退出，守护进程立即用新代码重启
  if (result.restart) setTimeout(() => process.exit(75), 500).unref();
  return { data: result };
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

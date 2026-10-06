import { randomBytes } from 'node:crypto';
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
import { checkUpdate, startUpdate, startUploadUpdate, updateProgress, versionInfo, localChangelog } from '../lib/updater.js';
import { diagnose } from '../lib/diagnose.js';
import { startInspect, stopInspect, inspectStatus, COSTLY } from '../lib/inspect.js';
import { checkCaptcha, sendEmailCode, consumeEmailCode, PURPOSES } from '../lib/emailcode.js';
import { createCaptcha } from '../apis/tools/captcha.js';
import { modules as apiModules, categories as apiCategories } from '../apis/index.js';
import { isModuleEnabled, isModuleSwitchedOn, setModulesEnabled } from '../lib/modules.js';
import { complianceBlocks, COMPLIANCE_MODULES } from '../lib/compliance.js';
import { listSettings, saveSettings, SETTING_GROUPS } from '../lib/settings.js';
import { testService, serviceOfKey, linkOfKey } from '../lib/keytest.js';
import { sendMail } from '../notify/smtp.js';
import { invoke, apiRouter } from '../registry.js';
import { localVersion, RUNNING_VERSION } from '../lib/updater.js';
import { cache } from '../lib/cache.js';
import { isBlockedIP } from '../lib/netguard.js';
import { loadIpInfo, normalizeIp } from '../apis/life/ip.js';
import { parseRange, overview, endpoints, endpointDetail, audience, userGrowth, issues, statusData } from '../lib/analytics.js';
import { healthStatus, runHealthCheck } from '../lib/health.js';
import { normalizeRules } from '../lib/keysource.js';
import { audit, requireReason, recordLogin } from '../lib/audit.js';
import { moduleOptions, setModuleOptions } from '../lib/modules.js';
import { clearModuleCache } from '../lib/cache.js';

export const accountRouter = new Router();
const r = (method, path, handler, opts = {}) => accountRouter.add(method, path, handler, opts);

export function requireUser(ctx) {
  if (!ctx.user) throw new HttpError(401, '请先登录', 'LOGIN_REQUIRED');
  return ctx.user;
}
export function requireAdmin(ctx) {
  const user = requireUser(ctx);
  if (!publicUser(user).isAdmin) throw new HttpError(403, '需要管理员权限');
  return user;
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
  const created = sql('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
  recordLogin(ctx, { user: created, ok: true, reason: '注册' });
  return { data: publicUser(created) };
});

r('POST', '/auth/login', async (ctx) => {
  checkLoginRate(ctx.ip);
  const email = String(ctx.body?.email ?? '').trim().toLowerCase();
  const user = sql('SELECT * FROM users WHERE email = ?').get(email);
  const ok = user && (await verifyPassword(String(ctx.body?.password ?? ''), user.password_hash));
  if (!ok) {
    recordLoginFail(ctx.ip);
    recordLogin(ctx, { user, email, ok: false, reason: user ? '密码错误' : '账号不存在' });
    throw new HttpError(401, '邮箱或密码错误');
  }
  if (user.disabled) {
    recordLogin(ctx, { user, ok: false, reason: '账号已停用' });
    throw new HttpError(403, '账号已被停用');
  }
  loginFails.delete(ctx.ip);
  recordLogin(ctx, { user, ok: true });
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
const keyRow = (k) => ({
  id: k.id, name: k.name, prefix: k.prefix, disabled: Boolean(k.disabled),
  allow: k.allow ? k.allow.split('\n') : [], scopes: k.scopes ? k.scopes.split('\n') : [],
  createdAt: k.created_at, lastUsedAt: k.last_used_at,
});
function ownKey(user, id) {
  const key = sql('SELECT * FROM api_keys WHERE id = ? AND user_id = ?').get(Number(id), user.id);
  if (!key) throw new HttpError(404, 'Key 不存在');
  return key;
}
function keyName(raw) {
  const name = String(raw ?? '').trim() || '默认';
  if (name.length > 40) throw new HttpError(400, '名称最多 40 个字符');
  return name;
}
// 接口范围：模块名列表，返回每行一个的文本；为空返回 null（不限制）
function normalizeScopes(input) {
  const list = [...new Set((Array.isArray(input) ? input : String(input ?? '').split(/[\s,，]+/)).map((x) => String(x).trim()).filter(Boolean))];
  const known = new Set(apiModules.map((m) => m.name));
  const bad = list.find((n) => !known.has(n));
  if (bad) throw new HttpError(400, `接口「${bad.slice(0, 40)}」不存在`);
  return list.length ? list.join('\n') : null;
}

r('GET', '/account/keys', (ctx) => {
  const user = requireUser(ctx);
  const keys = sql('SELECT * FROM api_keys WHERE user_id = ? ORDER BY id DESC').all(user.id);
  return { data: keys.map(keyRow) };
});

r('POST', '/account/keys', (ctx) => {
  const user = requireUser(ctx);
  const name = keyName(ctx.body?.name);
  const allow = normalizeRules(ctx.body?.allow);
  const scopes = normalizeScopes(ctx.body?.scopes);
  const count = sql('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?').get(user.id).n;
  if (count >= config.limits.maxKeys) throw new HttpError(400, `每个账号最多创建 ${config.limits.maxKeys} 个 Key`);
  const { key, prefix, hash } = generateApiKey();
  const { lastInsertRowid } = sql('INSERT INTO api_keys (user_id, name, prefix, key_hash, allow, scopes) VALUES (?, ?, ?, ?, ?, ?)').run(user.id, name, prefix, hash, allow, scopes);
  // 完整 Key 只在创建时返回一次
  return { data: { ...keyRow(sql('SELECT * FROM api_keys WHERE id = ?').get(lastInsertRowid)), key } };
});

// 修改名称、启用 / 停用、来源限制、可调用的接口范围：
// body { name?, disabled?, allow?: ['example.com', '1.2.3.4'] | '每行一条', scopes?: ['weather', 'epic'] }（allow / scopes 为空表示不限制）
r('PATCH', '/account/keys/:id', (ctx) => {
  const user = requireUser(ctx);
  const key = ownKey(user, ctx.params.id);
  const b = ctx.body ?? {};
  const name = b.name === undefined ? key.name : keyName(b.name);
  const allow = b.allow === undefined ? key.allow : normalizeRules(b.allow);
  const scopes = b.scopes === undefined ? key.scopes : normalizeScopes(b.scopes);
  const disabled = b.disabled === undefined ? key.disabled : Number(Boolean(b.disabled));
  sql('UPDATE api_keys SET name = ?, allow = ?, scopes = ?, disabled = ? WHERE id = ?').run(name, allow, scopes, disabled, key.id);
  return { data: keyRow(sql('SELECT * FROM api_keys WHERE id = ?').get(key.id)) };
});

// 重置：换一个新的 Key，名称和各项限制保留，旧 Key 立即失效；新 Key 只返回这一次
r('POST', '/account/keys/:id/reset', (ctx) => {
  const user = requireUser(ctx);
  const key = ownKey(user, ctx.params.id);
  const { key: fresh, prefix, hash } = generateApiKey();
  sql('UPDATE api_keys SET prefix = ?, key_hash = ?, last_used_at = NULL WHERE id = ?').run(prefix, hash, key.id);
  return { data: { ...keyRow(sql('SELECT * FROM api_keys WHERE id = ?').get(key.id)), key: fresh } };
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
      recent: sql(`SELECT l.ts, l.path, l.status, l.ms, l.rid, l.error, k.name AS keyName FROM request_log l
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

// 用户列表：支持按邮箱搜索、分页（每页 10 / 20 / 50 / 100，默认 20）
r('GET', '/admin/users', (ctx) => {
  requireAdmin(ctx);
  const day = today();
  const q = String(ctx.query.get('q') ?? '').trim().slice(0, 100);
  const page = Math.max(1, Math.min(10_000, Number.parseInt(ctx.query.get('page') ?? '1', 10) || 1));
  const size = [10, 20, 50, 100].includes(Number(ctx.query.get('size'))) ? Number(ctx.query.get('size')) : 20;
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
  // 调整额度、停用 / 启用账号都要填原因，记入操作日志
  const reason = requireReason(ctx.body);
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
  const changes = {};
  if (dailyLimit !== undefined) changes.dailyLimit = { from: target.daily_limit, to: dailyLimit };
  if (disabled !== undefined) changes.disabled = { from: Boolean(target.disabled), to: Boolean(disabled) };
  audit(ctx, dailyLimit !== undefined ? 'user.limit' : 'user.disable', { target: `${target.email}（#${id}）`, detail: changes, reason });
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

// 一键巡检：body { includeCostly: 是否包括会消耗额度或产生数据的接口 }；进度和结果用 GET 查询
r('POST', '/admin/inspect', (ctx) => {
  const admin = requireAdmin(ctx);
  return { data: startInspect({ includeCostly: Boolean(ctx.body?.includeCostly), user: { id: admin.id, email: admin.email } }) };
});
r('GET', '/admin/inspect', (ctx) => {
  requireAdmin(ctx);
  return { data: { ...inspectStatus(), costly: COSTLY } };
});
r('POST', '/admin/inspect/stop', (ctx) => {
  requireAdmin(ctx);
  return { data: stopInspect() };
});

// AI 分析接口失败原因：body { path: '/api/xxx' }
r('POST', '/admin/diagnose', async (ctx) => {
  requireAdmin(ctx);
  const path = String(ctx.body?.path ?? '').trim();
  if (!/^\/api\/[\w\-./:]{1,150}$/.test(path)) throw new HttpError(400, '请指定要分析的接口路径，例如 /api/epic/free');
  return { data: await diagnose(path) };
});

// 当前版本（不访问 GitHub，打开后台即可显示）
r('GET', '/admin/version', (ctx) => {
  requireAdmin(ctx);
  return { data: versionInfo() };
});

// 更新记录：本地 CHANGELOG.md 里的全部版本
r('GET', '/admin/changelog', (ctx) => {
  requireAdmin(ctx);
  return { data: { ...versionInfo(), entries: localChangelog() } };
});

// ---------- 敏感操作二次确认 ----------
// 上传更新包等高危操作前再输一次密码，换取 5 分钟内有效、只能用一次的确认码（登录状态被盗也无法直接操作）
const confirmTokens = new Map();
const CONFIRM_TTL = 5 * 60_000;

r('POST', '/admin/confirm', async (ctx) => {
  const admin = requireAdmin(ctx);
  checkLoginRate(ctx.ip);
  const row = sql('SELECT password_hash FROM users WHERE id = ?').get(admin.id);
  if (!row || !(await verifyPassword(String(ctx.body?.password ?? ''), row.password_hash))) {
    recordLoginFail(ctx.ip);
    throw new HttpError(401, '密码不正确');
  }
  loginFails.delete(ctx.ip);
  const now = Date.now();
  for (const [k, v] of confirmTokens) if (v.exp < now) confirmTokens.delete(k);
  const token = randomBytes(24).toString('base64url');
  confirmTokens.set(token, { userId: admin.id, exp: now + CONFIRM_TTL });
  return { data: { token, expiresIn: CONFIRM_TTL / 1000 } };
});

// consume=false 只检查（开始接收上传文件前），consume=true 检查并作废（真正执行时）
export function checkConfirm(token, userId, { consume = false } = {}) {
  const t = confirmTokens.get(String(token ?? ''));
  const ok = Boolean(t && t.userId === userId && t.exp > Date.now());
  if (ok && consume) confirmTokens.delete(String(token));
  return ok;
}

// 手动上传更新包（GitHub 的 Download ZIP 或 .tar.gz），最大 60 MB；在后台安装，进度同样查 /admin/update/progress
r('POST', '/admin/update/upload', (ctx) => {
  const admin = requireAdmin(ctx);
  if (!checkConfirm(ctx.req.headers['x-admin-confirm'], admin.id, { consume: true })) throw new HttpError(403, '请先输入管理员密码确认');
  if (!ctx.body?.length) throw new HttpError(400, '没有收到文件');
  const started = startUploadUpdate(ctx.body, (result) => {
    if (result.restart) setTimeout(() => process.exit(75), 3000).unref();
  });
  return { data: started };
}, { rawBody: 60 * 1024 * 1024 });

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
        enabled: isModuleSwitchedOn(m.name),
        options: moduleOptions(m.name),
        // 备案合规模式下线的原因；不为空时无论开关如何都不对外提供
        compliance: complianceBlocks(m.name) ? COMPLIANCE_MODULES[m.name] : null,
        routes: m.routes.map((x) => x.path),
        calls7d: m.routes.reduce((n, x) => n + (calls.get(x.path) ?? 0), 0),
        keys: moduleKeys(m),
      })),
    },
  };
});

// 接口需要的第三方密钥：required 不填就用不了（含「任选其一」），optional 不填也能用、填了更好
function moduleKeys(m) {
  const env = (m.env ?? []).map((e) => (typeof e === 'string' ? { name: e, optional: false } : { name: e.name, optional: Boolean(e.optional) }));
  if (!env.length) return null;
  const isSet = (name) => Boolean((process.env[name] || '').trim());
  const required = Boolean(m.isAvailable) || env.some((e) => !e.optional);
  const available = m.isAvailable ? Boolean(m.isAvailable()) : env.every((e) => e.optional || isSet(e.name));
  const group = SETTING_GROUPS.find((g) => g.fields.some((f) => f.key === env[0].name))?.id ?? 'keys';
  return {
    mode: required ? 'required' : 'optional',
    anyOf: Boolean(m.isAvailable) && env.every((e) => e.optional), // 多个服务任选其一（如翻译）
    configured: required ? available : env.some((e) => isSet(e.name)),
    names: env.map((e) => e.name),
    group,
  };
}

// body: { names: [...], enabled: true|false }
r('PUT', '/admin/modules', (ctx) => {
  requireAdmin(ctx);
  const { names, enabled } = ctx.body ?? {};
  const known = new Set(apiModules.map((m) => m.name));
  if (!Array.isArray(names) || !names.length || names.some((n) => !known.has(n))) throw new HttpError(400, '模块名无效');
  if (typeof enabled !== 'boolean') throw new HttpError(400, 'enabled 须为 true 或 false');
  setModulesEnabled(names, enabled);
  audit(ctx, enabled ? 'module.enable' : 'module.disable', { target: names.join(', ') });
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
  const saved = saveSettings(ctx.body);
  // 只记录改了哪些设置项，不记录值（可能是密钥）
  audit(ctx, 'settings.save', { target: saved.join(', ') });
  return { data: { saved } };
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
      // loadIpInfo 返回 { data }；国内 IP 多由本地 ip2region 命中，只有城市名、没有经纬度，此时按城市名查
      const loc = (await loadIpInfo(normalizeIp(ctx.ip)))?.data;
      if (loc?.countryCode === 'CN' && loc.lat != null && loc.lon != null) {
        const w = await invoke('/api/weather', { lat: String(loc.lat), lon: String(loc.lon) });
        return { ...w, location: { ...w.location, name: loc.city || loc.region || w.location?.name }, located: 'ip' };
      }
      if (loc?.countryCode === 'CN' && loc.city) {
        return { ...(await invoke('/api/weather', { city: loc.city })), located: 'ip' };
      }
    } catch { /* 定位或查询失败时用默认城市 */ }
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

// 各接口最近 24 小时的健康状况（运行状态页、首页接口卡片共用）
// 运行状态：汇总表 + 自动检测，缓存 60 秒（首页卡片和运行状态页共用）
let statusCache = null;
function cachedStatus() {
  if (statusCache && Date.now() - statusCache.at < 60_000) return statusCache.data;
  statusCache = { at: Date.now(), data: statusData() };
  return statusCache.data;
}
const moduleHealth = () => cachedStatus().modules;

// 首页接口卡片：运行状态、累计调用、今日调用（公开，缓存 1 分钟）
let cardStats = null;
r('GET', '/stats/modules', () => {
  if (cardStats && Date.now() - cardStats.at < 60_000) return { data: cardStats.data };
  const totals = new Map(sql('SELECT path, total FROM api_calls').all().map((x) => [x.path, x.total]));
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0); // 服务器时区为北京时间
  const today = new Map(sql('SELECT path, COUNT(*) AS n FROM request_log WHERE ts >= ? GROUP BY path').all(dayStart.getTime()).map((x) => [x.path, x.n]));
  const health = new Map(moduleHealth().map((h) => [h.name, h.status]));
  const data = {};
  for (const m of apiModules) {
    if (!isModuleEnabled(m.name)) continue;
    const sum = (map) => m.routes.reduce((n, x) => n + (map.get(x.path) ?? 0), 0);
    data[m.name] = { total: sum(totals), today: sum(today), status: health.get(m.name) ?? 'idle' };
  }
  cardStats = { at: Date.now(), data };
  return { data };
});

r('GET', '/status', () => {
  const st = cachedStatus();
  return {
    data: {
      version: RUNNING_VERSION ?? localVersion(),
      diskVersion: localVersion(),
      uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
      categories: apiCategories,
      ...st,
    },
  };
});

// ---------- 详细统计（仅管理员） ----------
const analyticsRoute = (path, fn) => r('GET', `/admin/analytics/${path}`, (ctx) => {
  requireAdmin(ctx);
  return { data: fn(parseRange(ctx.query), ctx) };
});
analyticsRoute('overview', (range) => overview(range));
analyticsRoute('endpoints', (range) => endpoints(range));
analyticsRoute('endpoint', (range, ctx) => endpointDetail(range, String(ctx.query.get('path') ?? '')));
analyticsRoute('audience', (range) => audience(range));
analyticsRoute('users', (range) => userGrowth(range));
analyticsRoute('issues', (range) => issues(range));

r('GET', '/admin/health', (ctx) => {
  requireAdmin(ctx);
  const failed = sql(`SELECT h.ts, h.module, h.path, h.status, h.ms, h.error FROM health_checks h
    WHERE h.ts = (SELECT MAX(ts) FROM health_checks) AND h.ok = 0 ORDER BY h.module`).all();
  return { data: { ...healthStatus(), failed } };
});
r('POST', '/admin/health/run', (ctx) => {
  requireAdmin(ctx);
  if (healthStatus().running) throw new HttpError(409, '自动检测正在进行中');
  runHealthCheck().then(() => { statusCache = null; }).catch((err) => console.error('[health]', err.message));
  return { data: { started: true } };
});

// ---------- 接口运行参数 ----------
// body { pinned?, featured?, cacheTtlSec?: 秒数 | null（恢复接口自带）, minuteLimit?: 次数 | null（不单独限制） }
r('PUT', '/admin/modules/:name/options', (ctx) => {
  requireAdmin(ctx);
  const m = apiModules.find((x) => x.name === ctx.params.name);
  if (!m) throw new HttpError(404, '接口不存在');
  const b = ctx.body ?? {};
  const num = (v, label, min, max) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label}须为 ${min}~${max} 的整数，留空表示使用默认`);
    return n;
  };
  const cacheSec = num(b.cacheTtlSec, '缓存时长（秒）', 0, 7 * 86400);
  const before = moduleOptions(m.name);
  const after = setModuleOptions(m.name, {
    pinned: b.pinned, featured: b.featured,
    cacheTtlMs: cacheSec === undefined ? undefined : cacheSec === null ? null : cacheSec * 1000,
    minuteLimit: num(b.minuteLimit, '每分钟上限', 1, 100000),
  });
  if (before.cacheTtlMs !== after.cacheTtlMs) clearModuleCache(m.name);
  audit(ctx, 'module.options', { target: m.name, detail: { from: before, to: after } });
  return { data: after };
});

r('POST', '/admin/modules/:name/cache/clear', (ctx) => {
  requireAdmin(ctx);
  const m = apiModules.find((x) => x.name === ctx.params.name);
  if (!m) throw new HttpError(404, '接口不存在');
  const cleared = clearModuleCache(m.name);
  audit(ctx, 'module.cache.clear', { target: m.name, detail: { cleared } });
  return { data: { cleared } };
});

// ---------- 操作日志、登录记录 ----------
const pageArgs = (q) => ({
  page: Math.max(1, Math.min(10_000, Number.parseInt(q.get('page') ?? '1', 10) || 1)),
  size: [20, 50, 100].includes(Number(q.get('size'))) ? Number(q.get('size')) : 20,
});

r('GET', '/admin/audit', (ctx) => {
  requireAdmin(ctx);
  const { page, size } = pageArgs(ctx.query);
  return {
    data: {
      page, size, total: sql('SELECT COUNT(*) AS n FROM audit_log').get().n,
      items: sql('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?').all(size, (page - 1) * size).map((a) => ({
        id: a.id, at: new Date(a.ts).toISOString(), admin: a.admin_email, action: a.action, target: a.target, detail: a.detail, reason: a.reason, ip: a.ip,
      })),
    },
  };
});

const loginRow = (l) => ({ at: new Date(l.ts).toISOString(), email: l.email, ip: l.ip, region: l.region, client: l.client, ok: Boolean(l.ok), reason: l.reason });

r('GET', '/admin/logins', (ctx) => {
  requireAdmin(ctx);
  const { page, size } = pageArgs(ctx.query);
  const failedOnly = ctx.query.get('failed') === '1';
  const where = failedOnly ? 'WHERE ok = 0' : '';
  return {
    data: {
      page, size, total: sql(`SELECT COUNT(*) AS n FROM login_log ${where}`).get().n,
      items: sql(`SELECT * FROM login_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(size, (page - 1) * size).map(loginRow),
    },
  };
});

// 自己最近的登录记录（发现异地登录可以及时改密码）
r('GET', '/account/logins', (ctx) => {
  const user = requireUser(ctx);
  return { data: sql('SELECT * FROM login_log WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(user.id).map(loginRow) };
});

// ---------- 兑换码 ----------
// 兑换后给账号加「额外次数」：当天额度用完后从这里扣，用完为止，不会过期
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => {
  const bytes = randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  return s.match(/.{4}/g).join('-');
};
const redeemFails = new Map();

r('GET', '/admin/redeem', (ctx) => {
  requireAdmin(ctx);
  return {
    data: sql('SELECT * FROM redeem_codes ORDER BY created_at DESC, code LIMIT 500').all().map((c) => ({
      code: c.code, calls: c.calls, maxUses: c.max_uses, used: c.used, note: c.note,
      expiresAt: c.expires_at ? new Date(c.expires_at).toISOString() : null, createdAt: new Date(c.created_at).toISOString(),
    })),
  };
});

// body { calls, count, maxUses, expiresAt?, note? }
r('POST', '/admin/redeem', (ctx) => {
  requireAdmin(ctx);
  const b = ctx.body ?? {};
  const int = (v, label, min, max, def) => {
    const n = v === undefined || v === '' ? def : Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label}须为 ${min}~${max} 的整数`);
    return n;
  };
  const calls = int(b.calls, '每个兑换码的次数', 1, 10_000_000);
  const count = int(b.count, '生成数量', 1, 200, 1);
  const maxUses = int(b.maxUses, '每个兑换码可兑换人数', 1, 100_000, 1);
  const expiresAt = b.expiresAt ? Date.parse(b.expiresAt) : null;
  if (b.expiresAt && !(expiresAt > Date.now())) throw new HttpError(400, '过期时间须晚于现在');
  const note = String(b.note ?? '').trim().slice(0, 60) || null;
  const codes = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const code = newCode();
    sql('INSERT INTO redeem_codes (code, calls, max_uses, expires_at, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(code, calls, maxUses, expiresAt, note, ctx.user.id, now);
    codes.push(code);
  }
  audit(ctx, 'redeem.create', { target: note ?? `${count} 个`, detail: { count, calls, maxUses } });
  return { data: { codes } };
});

r('DELETE', '/admin/redeem/:code', (ctx) => {
  requireAdmin(ctx);
  const { changes } = sql('DELETE FROM redeem_codes WHERE code = ?').run(String(ctx.params.code).toUpperCase());
  if (!changes) throw new HttpError(404, '兑换码不存在');
  audit(ctx, 'redeem.delete', { target: ctx.params.code });
  return { data: null };
});

r('POST', '/account/redeem', (ctx) => {
  const user = requireUser(ctx);
  // 防止穷举：每个账号 10 分钟内最多输错 10 次
  const fails = redeemFails.get(user.id);
  if (fails && fails.until > Date.now() && fails.n >= 10) throw new HttpError(429, '兑换码输错次数过多，请 10 分钟后再试', 'RATE_LIMITED');
  const code = String(ctx.body?.code ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(.{4})(?=.)/g, '$1-');
  const row = sql('SELECT * FROM redeem_codes WHERE code = ?').get(code);
  const fail = (msg) => {
    const f = redeemFails.get(user.id);
    redeemFails.set(user.id, f && f.until > Date.now() ? { n: f.n + 1, until: f.until } : { n: 1, until: Date.now() + 10 * 60_000 });
    throw new HttpError(400, msg);
  };
  if (!row) fail('兑换码不存在');
  if (row.expires_at && row.expires_at <= Date.now()) fail('兑换码已过期');
  if (sql('SELECT 1 FROM redemptions WHERE code = ? AND user_id = ?').get(code, user.id)) fail('你已经兑换过这个兑换码');
  if (row.used >= row.max_uses) fail('兑换码已被用完');
  db.exec('BEGIN');
  try {
    const { changes } = sql('UPDATE redeem_codes SET used = used + 1 WHERE code = ? AND used < max_uses').run(code);
    if (!changes) throw new HttpError(400, '兑换码已被用完');
    sql('INSERT INTO redemptions (code, user_id, calls, ts) VALUES (?, ?, ?, ?)').run(code, user.id, row.calls, Date.now());
    sql('UPDATE users SET bonus_calls = bonus_calls + ? WHERE id = ?').run(row.calls, user.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { data: { calls: row.calls, bonus: sql('SELECT bonus_calls FROM users WHERE id = ?').get(user.id).bonus_calls } };
});


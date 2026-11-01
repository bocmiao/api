// 市场层接口：异常上报、收藏。页面路由在 app.js 中映射到 market.html
import { sql } from '../db.js';
import { HttpError } from '../lib/http.js';
import { accountRouter, requireUser, requireAdmin } from './account.js';
import { modules as apiModules } from '../apis/index.js';
import { isModuleEnabled } from '../lib/modules.js';
import { audit } from '../lib/audit.js';

const r = (method, path, handler) => accountRouter.add(method, path, handler);
const DAY = 86400_000;
const dayStart = (now = Date.now()) => now - ((now + 8 * 3600_000) % DAY);
const findModule = (name) => {
  const m = apiModules.find((x) => x.name === name);
  if (!m || !isModuleEnabled(name)) throw new HttpError(404, '接口不存在或已下线');
  return m;
};

// ---------- 收藏 ----------
r('GET', '/site/favorites', (ctx) => {
  const user = requireUser(ctx);
  return { data: { modules: sql('SELECT module FROM api_favorites WHERE user_id = ? ORDER BY created_at DESC').all(user.id).map((x) => x.module) } };
});

r('POST', '/site/favorites/:name', (ctx) => {
  const user = requireUser(ctx);
  const m = findModule(ctx.params.name);
  const exists = sql('SELECT 1 FROM api_favorites WHERE user_id = ? AND module = ?').get(user.id, m.name);
  if (exists) sql('DELETE FROM api_favorites WHERE user_id = ? AND module = ?').run(user.id, m.name);
  else sql('INSERT INTO api_favorites (user_id, module, created_at) VALUES (?, ?, ?)').run(user.id, m.name, Date.now());
  return { data: { favorited: !exists } };
});

// ---------- 异常上报 ----------
r('POST', '/site/reports', (ctx) => {
  const user = requireUser(ctx);
  const module = String(ctx.body?.module ?? '').trim();
  const m = findModule(module);
  const path = String(ctx.body?.path ?? '').trim().slice(0, 300) || null;
  const description = String(ctx.body?.description ?? '').trim();
  const contact = String(ctx.body?.contact ?? '').trim().slice(0, 100) || null;
  if (description.length < 5) throw new HttpError(400, '请至少描述 5 个字的问题现象');
  if (description.length > 500) throw new HttpError(400, '问题描述最多 500 个字');
  const since = dayStart();
  if (sql('SELECT COUNT(*) AS n FROM api_reports WHERE user_id = ? AND created_at >= ?').get(user.id, since).n >= 5) {
    throw new HttpError(429, '今天提交的异常反馈已达上限，请明天再试', 'RATE_LIMITED');
  }
  const { lastInsertRowid } = sql('INSERT INTO api_reports (module, path, description, contact, user_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(m.name, path, description, contact, user.id, 'open', Date.now());
  return { data: { id: Number(lastInsertRowid) } };
});

// ---------- 后台：异常上报列表 ----------
r('GET', '/admin/reports', (ctx) => {
  requireAdmin(ctx);
  const status = String(ctx.query.get('status') ?? '').trim();
  const rows = sql(`SELECT r.*, u.email FROM api_reports r LEFT JOIN users u ON u.id = r.user_id
    ${status === 'open' || status === 'closed' ? 'WHERE r.status = ?' : ''}
    ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END, r.created_at DESC LIMIT 200`).all(...(status === 'open' || status === 'closed' ? [status] : []));
  return { data: { reports: rows.map((x) => ({ ...x, createdAt: new Date(x.created_at).toISOString(), handledAt: x.handled_at ? new Date(x.handled_at).toISOString() : null })) } };
});

r('PATCH', '/admin/reports/:id', (ctx) => {
  const admin = requireAdmin(ctx);
  const id = Number(ctx.params.id);
  const status = String(ctx.body?.status ?? '').trim();
  if (!['open', 'closed'].includes(status)) throw new HttpError(400, '状态只能是 open / closed');
  const old = sql('SELECT id, module, status FROM api_reports WHERE id = ?').get(id);
  if (!old) throw new HttpError(404, '反馈不存在');
  sql('UPDATE api_reports SET status = ?, handled_at = ? WHERE id = ?').run(status, status === 'closed' ? Date.now() : null, id);
  audit(ctx, 'report.update', { target: `${old.module} #${id}`, reason: status });
  return { data: null };
});

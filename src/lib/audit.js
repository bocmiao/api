// 管理操作记录（只增不改，数据库触发器禁止修改）与登录记录
import { sql } from '../db.js';
import { HttpError } from './http.js';
import { regionOf, clientOf } from './stats.js';

// 需要填原因的操作调用 requireReason：不填直接拒绝
export function requireReason(body) {
  const reason = String(body?.reason ?? '').trim();
  if (reason.length < 2) throw new HttpError(400, '请填写操作原因（至少 2 个字），会记录在操作日志里');
  if (reason.length > 200) throw new HttpError(400, '操作原因最多 200 个字');
  return reason;
}

export function audit(ctx, action, { target = null, detail = null, reason = null } = {}) {
  sql('INSERT INTO audit_log (ts, admin_id, admin_email, action, target, detail, reason, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(Date.now(), ctx.user?.id ?? null, ctx.user?.email ?? null, action, target == null ? null : String(target).slice(0, 200),
      detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 1000), reason, ctx.ip ?? null);
}

export function recordLogin(ctx, { user = null, email = null, ok, reason = null }) {
  const { region } = regionOf(ctx.ip);
  sql('INSERT INTO login_log (ts, user_id, email, ip, region, client, ok, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(Date.now(), user?.id ?? null, String(email ?? user?.email ?? '').slice(0, 254) || null, ctx.ip ?? null, region,
      clientOf(ctx.req?.headers?.['user-agent']), ok ? 1 : 0, reason);
}

// 登录记录保留 180 天
export function pruneLoginLog() {
  sql('DELETE FROM login_log WHERE ts < ?').run(Date.now() - 180 * 86400_000);
}

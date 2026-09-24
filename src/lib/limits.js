import { sql } from '../db.js';
import { config } from '../config.js';
import { HttpError } from './http.js';

// 按北京时间计算"今天"，每天 0 点重置额度
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
export const today = (d = new Date()) => dayFmt.format(d);

export function secondsUntilReset(now = Date.now()) {
  const shanghai = now + 8 * 3600_000;
  return Math.ceil((86400_000 - (shanghai % 86400_000)) / 1000);
}

const minuteWindows = new Map();
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [k, w] of minuteWindows) if (w.start < cutoff) minuteWindows.delete(k);
}, 60_000).unref();

function hitMinute(subject, limit) {
  const now = Date.now();
  let w = minuteWindows.get(subject);
  if (!w || now - w.start >= 60_000) minuteWindows.set(subject, (w = { start: now, count: 0 }));
  w.count++;
  return w.count <= limit;
}

// user 为 null 时按 IP 限流（未注册用户），否则按用户限流（该用户所有 Key 共享额度）
export function consume({ user, ip }) {
  const subject = user ? `user:${user.id}` : `ip:${ip}`;
  const daily = user ? (user.daily_limit ?? config.limits.userDaily) : config.limits.anonDaily;
  const minute = user ? config.limits.userMinute : config.limits.anonMinute;
  const day = today();

  const used = sql('SELECT count FROM usage_daily WHERE day = ? AND subject = ?').get(day, subject)?.count ?? 0;
  const headers = {
    'x-ratelimit-limit': String(daily),
    'x-ratelimit-remaining': String(Math.max(0, daily - used - 1)),
    'x-ratelimit-reset': String(secondsUntilReset()),
  };

  if (used >= daily) {
    const err = new HttpError(429, user
      ? '今日调用次数已用完，额度将于北京时间 0 点重置'
      : `未登录用户每天可免费调用 ${daily} 次，今日已用完。注册并创建 API Key 可获得每天 ${config.limits.userDaily} 次额度`);
    err.headers = { ...headers, 'x-ratelimit-remaining': '0' };
    throw err;
  }
  if (!hitMinute(subject, minute)) {
    const err = new HttpError(429, `请求过于频繁，每分钟最多 ${minute} 次`);
    err.headers = headers;
    throw err;
  }

  sql(`INSERT INTO usage_daily (day, subject, count) VALUES (?, ?, 1)
       ON CONFLICT(day, subject) DO UPDATE SET count = count + 1`).run(day, subject);
  return headers;
}

export function quota({ user, ip }) {
  const subject = user ? `user:${user.id}` : `ip:${ip}`;
  const limit = user ? (user.daily_limit ?? config.limits.userDaily) : config.limits.anonDaily;
  const used = sql('SELECT count FROM usage_daily WHERE day = ? AND subject = ?').get(today(), subject)?.count ?? 0;
  return { limit, used, remaining: Math.max(0, limit - used), resetIn: secondsUntilReset() };
}

export function logRequest({ user, keyId, ip, path, status, ms }) {
  sql('INSERT INTO request_log (ts, user_id, key_id, ip, path, status, ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(Date.now(), user?.id ?? null, keyId ?? null, ip, path, status, ms);
}

export function pruneLogs() {
  const cutoff = Date.now() - config.logRetentionDays * 86400_000;
  sql('DELETE FROM request_log WHERE ts < ?').run(cutoff);
  sql('DELETE FROM usage_daily WHERE day < ?').run(today(new Date(cutoff)));
  sql('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

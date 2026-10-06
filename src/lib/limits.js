import { sql } from '../db.js';
import { config } from '../config.js';
import { HttpError } from './http.js';
import { recordCall, regionOf, refererHost, clientOf, pruneStats } from './stats.js';

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

function hitMinute(subject, limit, cost = 1) {
  const now = Date.now();
  let w = minuteWindows.get(subject);
  if (!w || now - w.start >= 60_000) minuteWindows.set(subject, (w = { start: now, count: 0 }));
  w.count += cost;
  return w.count <= limit;
}

// 兑换码送的额外次数（只有注册用户有）
const bonusOf = (user) => (user ? sql('SELECT bonus_calls FROM users WHERE id = ?').get(user.id)?.bonus_calls ?? 0 : 0);

// user 为 null 时按 IP 限流（未注册用户），否则按用户限流（该用户所有 Key 共享额度）。
// cost：本次计入的调用次数（批量接口按目标数多计，见 app.js 的 ctx.charge）；额度不足时整笔拒绝、不部分扣减。
// 当天额度用完后，注册用户再从兑换码送的额外次数里扣。
// charges：传入数组时把这次扣了什么记进去，调用因服务端原因失败（5xx）时用 refund() 退回。
// module / moduleMinute：接口单独设置的每分钟上限（后台「接口运行参数」），与账号的每分钟上限分开计算
export function consume({ user, ip }, cost = 1, { charges = null, module = null, moduleMinute = null } = {}) {
  const subject = user ? `user:${user.id}` : `ip:${ip}`;
  const daily = user ? (user.daily_limit ?? config.limits.userDaily) : config.limits.anonDaily;
  const minute = user ? config.limits.userMinute : config.limits.anonMinute;
  const day = today();

  const used = sql('SELECT count FROM usage_daily WHERE day = ? AND subject = ?').get(day, subject)?.count ?? 0;
  const bonus = used + cost > daily ? bonusOf(user) : 0;
  const headers = {
    'x-ratelimit-limit': String(daily),
    'x-ratelimit-remaining': String(Math.max(0, daily - used - cost)),
    'x-ratelimit-reset': String(secondsUntilReset()),
  };
  // 当天额度不够、额外次数够：这次从额外次数里扣
  const useBonus = used + cost > daily && bonus >= cost;
  if (useBonus) headers['x-ratelimit-bonus'] = String(bonus - cost);

  if (used >= daily && !useBonus) {
    const err = new HttpError(429, user
      ? '今日调用次数已用完，额度将于北京时间 0 点重置'
      : `未登录用户每天可免费调用 ${daily} 次，今日已用完。注册并创建 API Key 可获得每天 ${config.limits.userDaily} 次额度`, 'QUOTA_EXCEEDED');
    err.headers = { ...headers, 'x-ratelimit-remaining': '0' };
    throw err;
  }
  if (cost > 1 && used + cost > daily && !useBonus) {
    const err = new HttpError(429, `今日剩余额度不足：本次请求需要 ${cost} 次，剩余 ${daily - used} 次`, 'QUOTA_EXCEEDED');
    err.headers = { ...headers, 'x-ratelimit-remaining': String(daily - used) };
    throw err;
  }
  if (module && moduleMinute && !hitMinute(`${subject}|${module}`, moduleMinute, cost)) {
    const err = new HttpError(429, `请求过于频繁，该接口每分钟最多 ${moduleMinute} 次`, 'RATE_LIMITED');
    err.headers = headers;
    throw err;
  }
  if (!hitMinute(subject, minute, cost)) {
    const err = new HttpError(429, `请求过于频繁，每分钟最多 ${minute} 次`, 'RATE_LIMITED');
    err.headers = headers;
    throw err;
  }

  if (useBonus) {
    sql('UPDATE users SET bonus_calls = bonus_calls - ? WHERE id = ? AND bonus_calls >= ?').run(cost, user.id, cost);
  } else {
    sql(`INSERT INTO usage_daily (day, subject, count) VALUES (?, ?, ?)
         ON CONFLICT(day, subject) DO UPDATE SET count = count + excluded.count`).run(day, subject, cost);
  }
  charges?.push({ day, subject, cost, bonus: useBonus, userId: user?.id ?? null });
  return headers;
}

// 调用因服务端或上游原因失败（5xx）时退回本次扣的额度；每分钟的频率限制不退，防止有人靠失败请求刷接口
export function refund(charges) {
  for (const c of charges ?? []) {
    if (c.bonus) sql('UPDATE users SET bonus_calls = bonus_calls + ? WHERE id = ?').run(c.cost, c.userId);
    else sql('UPDATE usage_daily SET count = MAX(0, count - ?) WHERE day = ? AND subject = ?').run(c.cost, c.day, c.subject);
  }
  if (charges) charges.length = 0;
}

export function quota({ user, ip }) {
  const subject = user ? `user:${user.id}` : `ip:${ip}`;
  const limit = user ? (user.daily_limit ?? config.limits.userDaily) : config.limits.anonDaily;
  const used = sql('SELECT count FROM usage_daily WHERE day = ? AND subject = ?').get(today(), subject)?.count ?? 0;
  return { limit, used, remaining: Math.max(0, limit - used), resetIn: secondsUntilReset(), bonus: bonusOf(user) };
}

// error：失败时的原因（只记我们自己的错误说明，不含请求参数），最多 300 字
export function logRequest({ user, keyId, ip, path, status, ms, error = null, cached = null, bytes = null, headers = {}, rid = null }) {
  const ts = Date.now();
  const via = keyId ? 'apikey' : user ? 'session' : 'anon';
  const { region, isp } = regionOf(ip);
  sql(`INSERT INTO request_log (ts, user_id, key_id, ip, path, status, ms, error, cached, bytes, via, referer, client, region, isp, rid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(ts, user?.id ?? null, keyId ?? null, ip, path, status, ms, error ? String(error).slice(0, 300) : null,
      cached, bytes, via, refererHost(headers), clientOf(headers['user-agent']), region, isp, rid);
  if (path.startsWith('/api/') && status !== 404) {
    sql('INSERT INTO api_calls (path, total) VALUES (?, 1) ON CONFLICT(path) DO UPDATE SET total = total + 1').run(path);
  }
  recordCall({ ts, path, status, ms, cached: cached ?? 0, bytes: bytes ?? 0, via });
}

export function pruneLogs() {
  const cutoff = Date.now() - config.logRetentionDays * 86400_000;
  sql('DELETE FROM request_log WHERE ts < ?').run(cutoff);
  pruneStats({ hourlyDays: config.statsHourlyDays, rawDays: config.logRetentionDays });
  sql('DELETE FROM usage_daily WHERE day < ?').run(today(new Date(cutoff)));
  sql('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

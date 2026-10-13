import { createHash } from 'node:crypto';
import { HttpError } from '../lib/http.js';

const windows = new Map();
const successful = new Map();
const pending = new Map();
const uncertain = new Map();
const MAX_UNCERTAIN = 5000;

// 本进程安全阀；平台侧仍有独立频控。未知结果不自动重试，避免重复发送。
export async function guardedDelivery(channel, message, send) {
  const id = `${channel.id}:${channel.type}`;
  const now = Date.now();
  const fingerprint = createHash('sha256').update(JSON.stringify([id, message])).digest('hex');
  if (uncertain.size >= MAX_UNCERTAIN) for (const [key, expires] of uncertain) if (expires <= now) uncertain.delete(key);
  if ((successful.get(fingerprint) ?? 0) > now) return { deduplicated: true };
  if ((uncertain.get(fingerprint) ?? 0) > now) throw new HttpError(503, '上次推送结果未知，请先到目标会话核实，稍后再试');
  if (pending.has(fingerprint)) { await pending.get(fingerprint); return { deduplicated: true }; }
  // 容量耗尽时拒绝新发送，不能淘汰仍有效的未知结果后允许其重发。
  if (uncertain.size + pending.size >= MAX_UNCERTAIN) throw new HttpError(503, '推送结果待核实过多，请稍后再试');
  const current = windows.get(id);
  const window = current && now - current.start < 60_000 ? current : { start: now, count: 0 };
  if (++window.count > 10) throw new HttpError(429, '该推送渠道每分钟最多发送 10 条，请稍后重试');
  windows.set(id, window);
  const running = Promise.resolve().then(send);
  pending.set(fingerprint, running);
  try { await running; successful.set(fingerprint, Date.now() + 60_000); }
  catch (err) { uncertain.set(fingerprint, Date.now() + 60_000); throw err; }
  finally { pending.delete(fingerprint); }
  if (successful.size > 5000) for (const [key, expires] of successful) if (expires <= now) successful.delete(key);
  return { deduplicated: false };
}

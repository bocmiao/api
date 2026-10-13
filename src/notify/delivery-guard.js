import { createHash } from 'node:crypto';
import { HttpError } from '../lib/http.js';

const windows = new Map();
const successful = new Map();
const pending = new Map();

// 本进程安全阀；平台侧仍有独立频控。未知结果不自动重试，避免重复发送。
export async function guardedDelivery(channel, message, send) {
  const id = `${channel.id}:${channel.type}`;
  const now = Date.now();
  const fingerprint = createHash('sha256').update(JSON.stringify([id, message])).digest('hex');
  if ((successful.get(fingerprint) ?? 0) > now) return { deduplicated: true };
  if (pending.has(fingerprint)) { await pending.get(fingerprint); return { deduplicated: true }; }
  const current = windows.get(id);
  const window = current && now - current.start < 60_000 ? current : { start: now, count: 0 };
  if (++window.count > 10) throw new HttpError(429, '该推送渠道每分钟最多发送 10 条，请稍后重试');
  windows.set(id, window);
  const running = Promise.resolve().then(send);
  pending.set(fingerprint, running);
  try { await running; successful.set(fingerprint, Date.now() + 60_000); }
  finally { pending.delete(fingerprint); }
  if (successful.size > 5000) for (const [key, expires] of successful) if (expires <= now) successful.delete(key);
  return { deduplicated: false };
}

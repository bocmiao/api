import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { HttpError } from '../lib/http.js';

const protectedTypes = new Set(['wecom', 'qq-bot']);
export const needsEncryption = (type) => protectedTypes.has(type);
export const encryptionAvailable = () => /^[0-9a-f]{64}$/i.test(process.env.NOTIFY_ENCRYPTION_KEY ?? '');

function key() {
  const raw = process.env.NOTIFY_ENCRYPTION_KEY ?? '';
  if (!/^[0-9a-f]{64}$/i.test(raw)) throw new HttpError(503, '请先配置 NOTIFY_ENCRYPTION_KEY（32 字节十六进制），才能使用加密推送渠道');
  return Buffer.from(raw, 'hex');
}

export function sealChannel(type, config) {
  if (!needsEncryption(type)) return config;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
  return { sealed: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), body: body.toString('base64url') };
}

export function openChannel(type, config) {
  if (!needsEncryption(type) || !config?.sealed) return config; // 兼容历史明文渠道，保存新渠道时一律加密
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(config.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(config.tag, 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(config.body, 'base64url')), decipher.final()]).toString('utf8'));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(503, '推送渠道凭据无法解密，请检查加密密钥');
  }
}

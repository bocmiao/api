import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { sql } from '../db.js';
import { config } from '../config.js';
import { HttpError } from './http.js';

const scrypt = promisify(scryptCb);
const SESSION_DAYS = 30;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [, saltHex, hashHex] = stored.split('$');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

export function validateCredentials(email, password) {
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim()) || email.length > 254) {
    throw new HttpError(400, '邮箱格式不正确');
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new HttpError(400, '密码长度需为 8~128 位');
  }
  return email.trim().toLowerCase();
}

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    isAdmin: Boolean(u.is_admin) || config.adminEmails.includes(u.email.toLowerCase()),
    dailyLimit: u.daily_limit ?? config.limits.userDaily,
    createdAt: u.created_at,
  };
}

// ---------- 会话 ----------

export function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  sql('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    sha256(token), userId, Date.now() + SESSION_DAYS * 86400_000,
  );
  return token;
}

export function destroySession(token) {
  if (token) sql('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function userFromSession(token) {
  if (!token) return null;
  return sql(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
              WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`).get(sha256(token), Date.now()) ?? null;
}

export function sessionCookie(token, req) {
  const secure = config.publicUrl.startsWith('https://') || req.headers['x-forwarded-proto'] === 'https';
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${token ? SESSION_DAYS * 86400 : 0}`];
  if (secure) attrs.push('Secure');
  return `sid=${token || ''}; ${attrs.join('; ')}`;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---------- API Key ----------

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function base62(n) {
  const bytes = randomBytes(n * 2);
  let s = '';
  for (let i = 0; s.length < n && i < bytes.length; i++) if (bytes[i] < 248) s += B62[bytes[i] % 62];
  return s.length === n ? s : base62(n);
}

export function generateApiKey() {
  const key = `ak_${base62(32)}`;
  return { key, prefix: key.slice(0, 10), hash: sha256(key) };
}

export function userFromApiKey(key) {
  if (!key || !/^ak_[0-9A-Za-z]{32}$/.test(key)) return null;
  const row = sql(`SELECT k.id AS key_id, u.* FROM api_keys k JOIN users u ON u.id = k.user_id
                   WHERE k.key_hash = ? AND u.disabled = 0`).get(sha256(key));
  if (!row) return null;
  sql("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.key_id);
  return row;
}

export function extractApiKey(req, query) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  return req.headers['x-api-key'] || query.get('key') || null;
}

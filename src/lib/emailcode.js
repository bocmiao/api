// 邮箱验证码：注册与重置密码。只保存哈希；发送前须通过图形验证码；按邮箱和 IP 限制发送频率。
import { randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { sql } from '../db.js';
import { config } from '../config.js';
import { HttpError } from './http.js';
import { store as captchaStore } from '../apis/tools/captcha.js';
import { sendMail } from '../notify/smtp.js';

export const PURPOSES = { register: '注册', reset: '重置密码' };

// 发信函数，测试时可替换
let mailer = sendMail;
export const setMailer = (fn) => { mailer = fn ?? sendMail; };
const MAX_ATTEMPTS = 5;
const hashCode = (email, purpose, code) => createHash('sha256').update(`${email}|${purpose}|${code}`).digest('hex');

// 北京时间当天 0 点的时间戳
function startOfDay(now = Date.now()) {
  const shanghai = now + 8 * 3600_000;
  return now - (shanghai % 86400_000);
}

export function checkCaptcha(token, answer) {
  if (!token || !answer) throw new HttpError(400, '请先填写图形验证码');
  const r = captchaStore.verify(String(token), String(answer));
  if (!r.valid) {
    throw new HttpError(400, { wrong: '图形验证码错误', expired: '图形验证码已过期，请刷新' }[r.reason] ?? '图形验证码无效，请刷新');
  }
}

const mailBody = (purpose, code) => [
  `您好！`,
  '',
  `您正在 Miao API ${PURPOSES[purpose]}，验证码为：`,
  '',
  `    ${code}`,
  '',
  `验证码 ${config.emailCode.ttlMin} 分钟内有效，请勿泄露给他人。`,
  `如果这不是您本人的操作，请忽略本邮件。`,
  '',
  '—— Miao API',
].join('\n');

// 发送验证码。exists：该邮箱是否已注册（由调用方查询）
export async function sendEmailCode({ email, purpose, ip, exists, send = mailer }) {
  if (purpose === 'register' && exists) throw new HttpError(409, '该邮箱已注册，请直接登录');
  const now = Date.now();
  const last = sql('SELECT created_at FROM email_codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1').get(email, purpose);
  const wait = last ? Math.ceil((last.created_at + config.emailCode.cooldownSec * 1000 - now) / 1000) : 0;
  if (wait > 0) throw new HttpError(429, `发送太频繁，请 ${wait} 秒后再试`);

  const today = startOfDay(now);
  const byEmail = sql('SELECT COUNT(*) AS n FROM email_codes WHERE email = ? AND created_at >= ?').get(email, today).n;
  if (byEmail >= config.emailCode.perEmailDaily) throw new HttpError(429, '该邮箱今天的验证码发送次数已达上限');
  const byIp = sql('SELECT COUNT(*) AS n FROM email_codes WHERE ip = ? AND created_at >= ?').get(ip, today).n;
  if (byIp >= config.emailCode.perIpDaily) throw new HttpError(429, '今天发送验证码的次数已达上限，请明天再试');


  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const { lastInsertRowid } = sql(`INSERT INTO email_codes (email, purpose, code_hash, ip, created_at, expires_at)
                                   VALUES (?, ?, ?, ?, ?, ?)`).run(email, purpose, hashCode(email, purpose, code), ip, now, now + config.emailCode.ttlMin * 60_000);

  // 重置密码时邮箱不存在：照常计数并返回成功，但不真正发信，避免被用来探测哪些邮箱已注册
  if (purpose === 'reset' && !exists) return { cooldown: config.emailCode.cooldownSec };

  try {
    await send({ ...config.smtp, to: email, subject: `【Miao API】${PURPOSES[purpose]}验证码：${code}`, text: mailBody(purpose, code) });
  } catch (err) {
    sql('DELETE FROM email_codes WHERE id = ?').run(lastInsertRowid);
    console.error('[email] 发送失败：', err.message);
    throw new HttpError(502, '验证码邮件发送失败，请稍后重试');
  }
  return { cooldown: config.emailCode.cooldownSec };
}

// 校验验证码：只认最近一条；最多尝试 5 次；成功后作废
export function consumeEmailCode(email, purpose, code) {
  if (!/^\d{6}$/.test(String(code ?? ''))) throw new HttpError(400, '请输入 6 位邮箱验证码');
  const row = sql('SELECT * FROM email_codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1').get(email, purpose);
  if (!row || row.used) throw new HttpError(400, '请先获取邮箱验证码');
  if (row.expires_at < Date.now()) throw new HttpError(400, '邮箱验证码已过期，请重新获取');
  if (row.attempts >= MAX_ATTEMPTS) throw new HttpError(400, '验证码错误次数过多，请重新获取');
  const ok = timingSafeEqual(Buffer.from(row.code_hash, 'hex'), Buffer.from(hashCode(email, purpose, String(code)), 'hex'));
  if (!ok) {
    sql('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    throw new HttpError(400, `邮箱验证码错误，还可尝试 ${MAX_ATTEMPTS - row.attempts - 1} 次`);
  }
  sql('UPDATE email_codes SET used = 1 WHERE id = ?').run(row.id);
}

export function pruneEmailCodes() {
  sql('DELETE FROM email_codes WHERE created_at < ?').run(Date.now() - 2 * 86400_000);
}

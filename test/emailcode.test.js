import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.SMTP_HOST = 'smtp.example.com';
process.env.SMTP_USER = 'i@example.com';
const { handle } = await import('../src/app.js');
const { setMailer } = await import('../src/lib/emailcode.js');
const { store } = await import('../src/apis/tools/captcha.js');

const mails = [];
let failNext = false;
setMailer(async (m) => {
  if (failNext) { failNext = false; throw new Error('smtp down'); }
  mails.push(m);
});
const lastCode = () => mails.at(-1).subject.match(/(\d{6})$/)[1];

let server, base;
before(async () => {
  server = createServer(handle).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); setMailer(null); });

function client() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie?.() ?? []) cookie = c.split(';')[0].endsWith('=') ? '' : c.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}

// 取一张图形验证码并直接读出答案
async function captcha(c) {
  const { body } = await c('GET', '/auth/captcha');
  return { captchaToken: body.data.token, captchaAnswer: store.map.get(body.data.token).answer };
}

const noCooldown = (fn) => async () => {
  process.env.EMAIL_CODE_COOLDOWN_SEC = '0';
  try { await fn(); } finally { delete process.env.EMAIL_CODE_COOLDOWN_SEC; }
};

test('配置 SMTP 后开启邮箱验证，/api 目录中可见', async () => {
  const { body } = await client()('GET', '/api');
  assert.equal(body.data.auth.emailVerify, true);
});

test('注册必须先通过图形验证码获取邮箱验证码', async () => {
  const c = client();
  assert.equal((await c('POST', '/auth/register', { email: 'a@example.com', password: 'password123' })).status, 400);
  const bad = await c('POST', '/auth/send-code', { email: 'a@example.com', purpose: 'register', ...(await captcha(c)), captchaAnswer: 'WRONG' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.message, /图形验证码/);
  assert.equal(mails.length, 0);

  const ok = await c('POST', '/auth/send-code', { email: 'A@Example.com', purpose: 'register', ...(await captcha(c)) });
  assert.equal(ok.status, 200);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'a@example.com');
  assert.match(mails[0].text, /注册/);

  // 图形验证码只能用一次
  const cap = await captcha(c);
  await c('POST', '/auth/send-code', { email: 'x@example.com', purpose: 'register', ...cap });
  const reused = await c('POST', '/auth/send-code', { email: 'y@example.com', purpose: 'register', ...cap });
  assert.equal(reused.status, 400);

  const wrong = await c('POST', '/auth/register', { email: 'a@example.com', password: 'password123', code: '000000' === lastCode() ? '111111' : '000000' });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.message, /还可尝试 4 次/);

  const code = mails.find((m) => m.to === 'a@example.com').subject.match(/(\d{6})$/)[1];
  const reg = await c('POST', '/auth/register', { email: 'a@example.com', password: 'password123', code });
  assert.equal(reg.status, 200);
  assert.equal((await c('GET', '/auth/me')).body.data.user.email, 'a@example.com');
});

test('60 秒内不能重复发送；已注册邮箱不能再发注册验证码', async () => {
  const c = client();
  assert.equal((await c('POST', '/auth/send-code', { email: 'b@example.com', purpose: 'register', ...(await captcha(c)) })).status, 200);
  const again = await c('POST', '/auth/send-code', { email: 'b@example.com', purpose: 'register', ...(await captcha(c)) });
  assert.equal(again.status, 429);
  assert.match(again.body.message, /秒后再试/);
  const taken = await c('POST', '/auth/send-code', { email: 'a@example.com', purpose: 'register', ...(await captcha(c)) });
  assert.equal(taken.status, 409);
});

test('验证码错误 5 次后作废，用过的验证码不能再用', noCooldown(async () => {
  const c = client();
  await c('POST', '/auth/send-code', { email: 'c@example.com', purpose: 'register', ...(await captcha(c)) });
  const code = lastCode();
  const other = code === '999999' ? '888888' : '999999';
  for (let i = 0; i < 5; i++) await c('POST', '/auth/register', { email: 'c@example.com', password: 'password123', code: other });
  const locked = await c('POST', '/auth/register', { email: 'c@example.com', password: 'password123', code });
  assert.equal(locked.status, 400);
  assert.match(locked.body.message, /次数过多/);
}));

test('邮件发送失败返回 502，且不占用冷却时间', noCooldown(async () => {
  const c = client();
  failNext = true;
  const r = await c('POST', '/auth/send-code', { email: 'd@example.com', purpose: 'register', ...(await captcha(c)) });
  assert.equal(r.status, 502);
  assert.equal((await c('POST', '/auth/send-code', { email: 'd@example.com', purpose: 'register', ...(await captcha(c)) })).status, 200);
}));

test('重置密码：未注册的邮箱也返回成功但不发信；已注册的可以用验证码改密码', noCooldown(async () => {
  const c = client();
  const before = mails.length;
  const ghost = await c('POST', '/auth/send-code', { email: 'nobody@example.com', purpose: 'reset', ...(await captcha(c)) });
  assert.equal(ghost.status, 200);
  assert.equal(mails.length, before);

  await c('POST', '/auth/send-code', { email: 'a@example.com', purpose: 'reset', ...(await captcha(c)) });
  assert.match(mails.at(-1).text, /重置密码/);
  const res = await c('POST', '/auth/reset-password', { email: 'a@example.com', password: 'newpassword456', code: lastCode() });
  assert.equal(res.status, 200);
  const login = client();
  assert.equal((await login('POST', '/auth/login', { email: 'a@example.com', password: 'password123' })).status, 401);
  assert.equal((await login('POST', '/auth/login', { email: 'a@example.com', password: 'newpassword456' })).status, 200);
}));

test('单个邮箱每天的发送次数有上限', noCooldown(async () => {
  const c = client();
  process.env.EMAIL_CODE_PER_EMAIL_DAILY = '2';
  try {
    for (let i = 0; i < 2; i++) assert.equal((await c('POST', '/auth/send-code', { email: 'e@example.com', purpose: 'register', ...(await captcha(c)) })).status, 200);
    const r = await c('POST', '/auth/send-code', { email: 'e@example.com', purpose: 'register', ...(await captcha(c)) });
    assert.equal(r.status, 429);
    assert.match(r.body.message, /上限/);
  } finally {
    delete process.env.EMAIL_CODE_PER_EMAIL_DAILY;
  }
}));

import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

process.env.ANON_DAILY_LIMIT = '3';
process.env.USER_DAILY_LIMIT = '5';
const { handle } = await import('../src/app.js');

const fixture = readFileSync(new URL('./fixtures/epic.json', import.meta.url), 'utf8');
const realFetch = globalThis.fetch;
const outbound = [];
let server, base;

before(async () => {
  mock.method(globalThis, 'fetch', async (url, opts) => {
    const u = String(url);
    if (u.startsWith(base)) return realFetch(url, opts);
    outbound.push({ url: u, body: opts?.body });
    if (u.includes('epicgames.com')) return new Response(fixture, { headers: { 'content-type': 'application/json' } });
    if (u.includes('oapi.dingtalk.com')) return Response.json({ errcode: 0, errmsg: 'ok' });
    return new Response('not mocked', { status: 500 });
  });
  server = createServer(handle).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); mock.restoreAll(); });

// 简易客户端：自动携带 Cookie
function client() {
  let cookie = '';
  return async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) cookie = c.split(';')[0].endsWith('=') ? '' : c.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, headers: res.headers, body: json, text };
  };
}

test('首页与静态资源带安全头', async () => {
  const r = await client()('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await client()('GET', '/../package.json')).status, 404);
});

test('/api 目录包含分类与模块', async () => {
  const { body } = await client()('GET', '/api');
  assert.ok(body.data.categories.length >= 6);
  assert.ok(body.data.modules.some((m) => m.name === 'epic'));
});

test('注册、登录、会话', async () => {
  const c = client();
  assert.equal((await c('POST', '/auth/register', { email: 'bad', password: '12345678' })).status, 400);
  assert.equal((await c('POST', '/auth/register', { email: 'a@b.com', password: 'short' })).status, 400);

  const reg = await c('POST', '/auth/register', { email: 'Admin@Example.com', password: 'password123' });
  assert.equal(reg.status, 200);
  assert.equal(reg.body.data.email, 'admin@example.com');
  assert.equal(reg.body.data.isAdmin, true, '第一个用户是管理员');
  assert.match(reg.headers.get('set-cookie'), /HttpOnly/);

  assert.equal((await c('POST', '/auth/register', { email: 'admin@example.com', password: 'password123' })).status, 409);
  assert.equal((await c('GET', '/auth/me')).body.data.user.email, 'admin@example.com');

  await c('POST', '/auth/logout', {});
  assert.equal((await c('GET', '/auth/me')).body.data.user, null);
  assert.equal((await c('POST', '/auth/login', { email: 'admin@example.com', password: 'wrong-pass' })).status, 401);
  assert.equal((await c('POST', '/auth/login', { email: 'ADMIN@example.com', password: 'password123' })).status, 200);
});

test('CSRF：非 JSON 或跨站 Origin 的写请求被拒绝', async () => {
  const c = client();
  const form = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 415);
  assert.equal((await c('POST', '/auth/login', { email: 'x@y.com', password: '12345678' }, { origin: 'https://evil.com' })).status, 403);
});

test('未登录按 IP 限额，超出后 429 并提示注册', async () => {
  const c = client();
  for (let i = 0; i < 3; i++) {
    const r = await c('GET', '/api/epic/free');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-ratelimit-remaining'), String(2 - i));
  }
  const r = await c('GET', '/api/epic/free');
  assert.equal(r.status, 429);
  assert.match(r.body.message, /注册/);
});

test('API Key：创建、使用、独立额度、删除', async () => {
  const c = client();
  await c('POST', '/auth/register', { email: 'user2@example.com', password: 'password123' });
  const created = await c('POST', '/account/keys', { name: '测试' });
  const { key, id } = created.body.data;
  assert.match(key, /^ak_[0-9A-Za-z]{32}$/);

  const list = await c('GET', '/account/keys');
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].key, undefined, '列表不返回完整 Key');

  const anon = client();
  for (let i = 0; i < 5; i++) assert.equal((await anon('GET', '/api/epic/free', undefined, { 'x-api-key': key })).status, 200);
  assert.equal((await anon('GET', '/api/epic/free', undefined, { authorization: `Bearer ${key}` })).status, 429);
  assert.equal((await anon('GET', '/api/epic/free?key=ak_' + 'x'.repeat(32))).status, 401);

  const usage = await c('GET', '/account/usage');
  assert.equal(usage.body.data.quota.used, 5);
  assert.equal(usage.body.data.endpoints[0].path, '/api/epic/free');
  assert.equal(usage.body.data.recent[0].keyName, '测试');

  assert.equal((await c('DELETE', `/account/keys/${id}`, {})).status, 200);
  assert.equal((await anon('GET', '/api/epic/free', undefined, { 'x-api-key': key })).status, 401);
});

test('推送渠道：校验、脱敏、测试发送、订阅', async () => {
  const c = client();
  await c('POST', '/auth/register', { email: 'push@example.com', password: 'password123' });

  assert.equal((await c('POST', '/account/channels', { type: 'webhook', config: { url: 'http://127.0.0.1:8080/x' } })).status, 400);
  assert.equal((await c('POST', '/account/channels', { type: 'webhook', config: { url: 'http://[::ffff:10.0.0.1]/' } })).status, 400);
  assert.equal((await c('POST', '/account/channels', { type: 'dingtalk', config: { webhook: 'https://evil.com/robot' } })).status, 400);
  assert.equal((await c('POST', '/account/channels', { type: 'nope', config: {} })).status, 400);

  const token = 'abcdef1234567890abcdef';
  const ch = await c('POST', '/account/channels', {
    type: 'dingtalk', name: '群', config: { webhook: `https://oapi.dingtalk.com/robot/send?access_token=${token}`, secret: 'SECabcdefghijklmn' },
  });
  assert.equal(ch.status, 200);
  assert.ok(!JSON.stringify(ch.body.data.config).includes(token), '配置已脱敏');

  outbound.length = 0;
  assert.equal((await c('POST', `/account/channels/${ch.body.data.id}/test`, {})).status, 200);
  assert.match(outbound[0].url, /timestamp=\d+&sign=/);

  assert.equal((await c('PUT', '/account/subscriptions', { topic: 'epic-free', channelId: ch.body.data.id, enabled: true })).status, 200);
  const notify = await c('GET', '/account/notify');
  assert.deepEqual(notify.body.data.subscriptions, [{ topic: 'epic-free', channelId: ch.body.data.id }]);
  assert.ok(notify.body.data.types.some((t) => t.id === 'serverchan'));

  // 别人的渠道不能操作
  const other = client();
  await other('POST', '/auth/register', { email: 'other@example.com', password: 'password123' });
  assert.equal((await other('DELETE', `/account/channels/${ch.body.data.id}`, {})).status, 404);
});

test('管理后台仅管理员可访问，可调整用户额度', async () => {
  const admin = client();
  await admin('POST', '/auth/login', { email: 'admin@example.com', password: 'password123' });
  const stats = await admin('GET', '/admin/stats');
  assert.equal(stats.status, 200);
  assert.ok(stats.body.data.totals.users >= 3);

  const users = await admin('GET', '/admin/users');
  const u2 = users.body.data.find((u) => u.email === 'user2@example.com');
  assert.equal((await admin('PATCH', `/admin/users/${u2.id}`, { dailyLimit: 50 })).status, 200);
  assert.equal((await admin('GET', '/admin/users')).body.data.find((u) => u.id === u2.id).dailyLimit, 50);

  const normal = client();
  await normal('POST', '/auth/login', { email: 'user2@example.com', password: 'password123' });
  assert.equal((await normal('GET', '/admin/stats')).status, 403);
  assert.equal((await normal('GET', '/admin/update')).status, 403);
  assert.equal((await normal('POST', '/admin/update', {})).status, 403);
  assert.equal((await normal('GET', '/admin/update/progress')).status, 403);

  // 在线更新在后台执行，立即返回进度；GitHub 不可用时进度变为 error 并带原因
  const started = await admin('POST', '/admin/update', {});
  assert.equal(started.status, 200);
  assert.equal(started.body.data.state, 'running');
  let prog;
  for (let i = 0; i < 50; i++) {
    prog = (await admin('GET', '/admin/update/progress')).body.data;
    if (prog.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(prog.state, 'error');
  assert.ok(prog.error);
  assert.equal((await client()('GET', '/admin/stats')).status, 401);
});

test('404 与参数错误', async () => {
  const c = client();
  assert.equal((await c('GET', '/api/nope')).status, 404);
  const k = await c('GET', '/api/epic/free?country=china');
  assert.ok([400, 429].includes(k.status));
});

test('raw 路由返回 SVG 时附带禁止脚本的 CSP', async () => {
  // 匿名额度在前面的用例里已用完，这里用登录用户请求
  const c = client();
  await c('POST', '/auth/register', { email: 'svg@example.com', password: 'password123' });
  const r = await c('GET', '/api/qrcode?text=hi');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /svg/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
});

test('管理员可关闭指定接口模块：所有人 403，普通用户目录中隐藏', async () => {
  const admin = client();
  await admin('POST', '/auth/login', { email: 'admin@example.com', password: 'password123' });
  const list = await admin('GET', '/admin/modules');
  assert.ok(list.body.data.modules.some((m) => m.name === 'devtools' && m.enabled));

  assert.equal((await admin('PUT', '/admin/modules', { names: ['devtools'], enabled: false })).status, 200);
  assert.equal((await admin('PUT', '/admin/modules', { names: ['no-such'], enabled: false })).status, 400);

  const user = client();
  await user('POST', '/auth/register', { email: 'toggle@example.com', password: 'password123' });
  const blocked = await user('GET', '/api/tools/uuid');
  assert.equal(blocked.status, 403);
  assert.match(blocked.body.message, /已被管理员关闭/);
  assert.ok(!(await user('GET', '/api')).body.data.modules.some((m) => m.name === 'devtools'));
  assert.equal((await client()('GET', '/api/tools/uuid')).status, 403);

  assert.equal((await admin('GET', '/api/tools/uuid')).status, 403, '管理员调用也返回 403');
  const adminCatalog = (await admin('GET', '/api')).body.data.modules.find((m) => m.name === 'devtools');
  assert.equal(adminCatalog.enabled, false);
  assert.equal((await user('PUT', '/admin/modules', { names: ['devtools'], enabled: true })).status, 403);

  assert.equal((await admin('PUT', '/admin/modules', { names: ['devtools'], enabled: true })).status, 200);
  assert.equal((await user('GET', '/api/tools/uuid')).status, 200);
});

test('系统设置：保存后即时生效，密钥不回显，清除后恢复默认', async () => {
  const admin = client();
  await admin('POST', '/auth/login', { email: 'admin@example.com', password: 'password123' });
  const list = await admin('GET', '/admin/settings');
  const field = (key) => list.body.data.flatMap((g) => g.fields).find((f) => f.key === key);
  assert.equal(field('SMTP_PASS').value, undefined);
  assert.equal(field('SMTP_PASS').isSet, false);

  assert.equal((await admin('PUT', '/admin/settings', { ANON_DAILY_LIMIT: 'abc' })).status, 400);
  assert.equal((await admin('PUT', '/admin/settings', { NO_SUCH: '1' })).status, 400);
  assert.equal((await admin('PUT', '/admin/settings', { PUBLIC_URL: 'javascript:alert(1)' })).status, 400);
  assert.equal((await admin('PUT', '/admin/settings', { SMTP_HOST: 'a\nb' })).status, 400);

  assert.equal((await admin('PUT', '/admin/settings', { USER_DAILY_LIMIT: '777', SMTP_PASS: 's3cret' })).status, 200);
  assert.equal((await client()('GET', '/api')).body.data.limits.userDaily, 777);
  const after = await admin('GET', '/admin/settings');
  const pass = after.body.data.flatMap((g) => g.fields).find((f) => f.key === 'SMTP_PASS');
  assert.equal(pass.isSet, true);
  assert.equal(pass.source, 'panel');
  assert.ok(!JSON.stringify(after.body).includes('s3cret'), '密钥不回显');

  assert.equal((await admin('PUT', '/admin/settings', { USER_DAILY_LIMIT: null, SMTP_PASS: '' })).status, 200);
  assert.equal((await client()('GET', '/api')).body.data.limits.userDaily, 5, '恢复为环境变量的值');

  const normal = client();
  await normal('POST', '/auth/login', { email: 'user2@example.com', password: 'password123' });
  assert.equal((await normal('GET', '/admin/settings')).status, 403);
  assert.equal((await normal('PUT', '/admin/settings', { USER_DAILY_LIMIT: '1' })).status, 403);
});

test('静态文件使用 ETag，未变化时返回 304', async () => {
  const first = await fetch(`${base}/app.js`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-cache');
  const etag = first.headers.get('etag');
  assert.ok(etag);
  const again = await fetch(`${base}/app.js`, { headers: { 'if-none-match': etag } });
  assert.equal(again.status, 304);
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /\/app\.js\?v=[\w-]{10}"/, '首页引用的脚本带内容指纹');
  assert.match(html, /\/styles\.css\?v=[\w-]{10}"/);
  // 带正确指纹的地址可长期缓存；指纹不对（旧版本）仍然 no-cache
  const v = html.match(/\/app\.js\?v=([\w-]{10})"/)[1];
  assert.match((await fetch(`${base}/app.js?v=${v}`)).headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(`${base}/app.js?v=stale00000`)).headers.get('cache-control'), 'no-cache');
});

test('首页今日聚合与运行状态接口', async () => {
  const c = client();
  const today = await c('GET', '/home/today');
  assert.equal(today.status, 200);
  assert.ok('epic' in today.body.data && 'history' in today.body.data);
  // 第二次直接返回服务器上已聚合好的数据
  const again = await c('GET', '/home/today');
  assert.deepEqual(again.body.data, today.body.data);
  // 天气单独请求；指定城市时上游不可用也返回 200（data 为 null）
  const w = await c('GET', `/home/weather?city=${encodeURIComponent('汝阳')}`);
  assert.equal(w.status, 200);
  const st = await c('GET', '/status');
  assert.equal(st.status, 200);
  assert.ok(st.body.data.modules.length > 50);
  assert.ok(st.body.data.modules.every((m) => ['ok', 'degraded', 'down', 'idle'].includes(m.status)));
  const epic = st.body.data.modules.find((m) => m.name === 'epic');
  assert.ok(epic.calls > 0, '有调用记录的模块计入统计');
});

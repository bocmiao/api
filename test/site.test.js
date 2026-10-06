import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.ANON_DAILY_LIMIT = '3';
process.env.USER_DAILY_LIMIT = '1000';
process.env.TRUST_PROXY = '1';
const { handle } = await import('../src/app.js');
const { parseRule, normalizeRules, checkKeySource } = await import('../src/lib/keysource.js');
const { db } = await import('../src/db.js');
const { siteOverview } = await import('../src/routes/site.js');
const { TTLCache, cacheScope } = await import('../src/lib/cache.js');

const realFetch = globalThis.fetch;
let server, base;
let epicStatus = 500;

before(async () => {
  mock.method(globalThis, 'fetch', async (url, opts) => {
    const u = String(url);
    if (u.startsWith(base)) return realFetch(url, opts);
    if (u.includes('epicgames.com')) return new Response('down', { status: epicStatus });
    return new Response('not mocked', { status: 500 });
  });
  server = createServer(handle).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await admin('POST', '/auth/register', { email: 'admin@example.com', password: 'password123' })).status, 200);
  assert.equal((await alice('POST', '/auth/register', { email: 'alice@example.com', password: 'password123' })).status, 200);
});
after(() => { server.close(); mock.restoreAll(); });

function client() {
  let cookie = '';
  return async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    for (const c of res.headers.getSetCookie?.() ?? []) cookie = c.split(';')[0].endsWith('=') ? '' : c.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, headers: res.headers, body: json, text };
  };
}

// 第一个注册的账号是管理员
const admin = client();
const alice = client();
// 每个测试用不同的访客 IP，互不占用额度
let ipSeq = 10;
const anonClient = () => {
  const c = client();
  const ip = `9.9.8.${ipSeq++}`;
  return (method, path, body, headers = {}) => c(method, path, body, { 'x-forwarded-for': ip, ...headers });
};
const anon = anonClient();

test('每个响应都带请求 ID，错误响应带错误代码，调用记录可按请求 ID 查到', async () => {
  const ok = await anon('GET', '/api/qq/avatar/urls?qq=10000');
  assert.equal(ok.status, 200);
  const rid = ok.headers.get('x-request-id');
  assert.match(rid, /^[a-z0-9]+-[0-9a-f]{10}$/);
  assert.equal(ok.body.requestId, rid);
  assert.match(ok.headers.get('access-control-expose-headers'), /X-Request-Id/);

  const bad = await anon('GET', '/api/qq/avatar/urls?qq=abc');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.errorCode, 'BAD_REQUEST');
  assert.equal(bad.body.requestId, bad.headers.get('x-request-id'));

  const badKey = await anon('GET', '/api/qq/avatar/urls?qq=10000', undefined, { 'x-api-key': `ak_${'x'.repeat(32)}` });
  assert.equal(badKey.body.errorCode, 'INVALID_API_KEY');
  assert.equal((await anon('GET', '/api/nope')).body.errorCode, 'NOT_FOUND');

  const found = await admin('GET', `/admin/request?rid=${rid}`);
  assert.equal(found.status, 200);
  assert.equal(found.body.data.path, '/api/qq/avatar/urls');
  assert.equal((await alice('GET', `/admin/request?rid=${rid}`)).status, 403);
  assert.equal((await admin('GET', '/admin/request?rid=bad')).status, 400);
});

test('上游失败（5xx）的调用不扣当天额度，正常失败（4xx）照常计数', async () => {
  const c = anonClient();
  epicStatus = 500;
  for (let i = 0; i < 5; i++) {
    const r = await c('GET', '/api/epic/free');
    assert.equal(r.status, 502, '超过 3 次后也不会变成 429');
    assert.equal(r.body.errorCode, 'UPSTREAM_ERROR');
  }
  assert.equal((await c('GET', '/auth/me')).body.data.quota.used, 0);
  // 参数错误照常计数
  assert.equal((await c('GET', '/api/qq/avatar/urls?qq=1')).status, 400);
  assert.equal((await c('GET', '/auth/me')).body.data.quota.used, 1);
});

test('API Key：停用、重置、接口范围、来源限制', async () => {
  const k = (await alice('POST', '/account/keys', { name: '测试' })).body.data;
  assert.ok(k.key.startsWith('ak_'));
  const call = (path, key = k.key, h = {}) => anon('GET', path, undefined, { 'x-api-key': key, ...h });
  assert.equal((await call('/api/qq/avatar/urls?qq=10000')).status, 200);

  // 停用后 403，重新启用恢复
  assert.equal((await alice('PATCH', `/account/keys/${k.id}`, { disabled: true })).body.data.disabled, true);
  const off = await call('/api/qq/avatar/urls?qq=10000');
  assert.equal(off.status, 403);
  assert.equal(off.body.errorCode, 'KEY_DISABLED');
  await alice('PATCH', `/account/keys/${k.id}`, { disabled: false });

  // 接口范围
  assert.equal((await alice('PATCH', `/account/keys/${k.id}`, { scopes: ['nope'] })).status, 400);
  await alice('PATCH', `/account/keys/${k.id}`, { scopes: ['weather'] });
  const scoped = await call('/api/qq/avatar/urls?qq=10000');
  assert.equal(scoped.status, 403);
  assert.equal(scoped.body.errorCode, 'KEY_SCOPE_DENIED');
  await alice('PATCH', `/account/keys/${k.id}`, { scopes: ['qq-avatar'] });
  assert.equal((await call('/api/qq/avatar/urls?qq=10000')).status, 200);

  // 来源限制：只允许 *.example.com 的网页
  assert.equal((await alice('PATCH', `/account/keys/${k.id}`, { allow: 'not a rule!' })).status, 400);
  const p = await alice('PATCH', `/account/keys/${k.id}`, { allow: 'https://www.example.com/path\n*.example.com' });
  assert.deepEqual(p.body.data.allow, ['www.example.com', '*.example.com']);
  assert.equal((await call('/api/qq/avatar/urls?qq=10000', k.key, { origin: 'https://blog.example.com' })).status, 200);
  const denied = await call('/api/qq/avatar/urls?qq=10000', k.key, { referer: 'https://evil.test/' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.errorCode, 'KEY_SOURCE_DENIED');
  assert.equal((await call('/api/qq/avatar/urls?qq=10000')).status, 403, '没有来源也不满足域名规则');
  await alice('PATCH', `/account/keys/${k.id}`, { allow: [] });

  // 重置：旧 Key 失效，新 Key 可用，设置保留
  const r = (await alice('POST', `/account/keys/${k.id}/reset`, {})).body.data;
  assert.notEqual(r.key, k.key);
  assert.deepEqual(r.scopes, ['qq-avatar']);
  assert.equal((await call('/api/qq/avatar/urls?qq=10000')).status, 401);
  assert.equal((await call('/api/qq/avatar/urls?qq=10000', r.key)).status, 200);
  assert.equal((await client()('POST', `/account/keys/${k.id}/reset`, {})).status, 401);
});

test('来源规则解析与匹配', () => {
  assert.equal(parseRule('1.2.3.0/24').type, 'ip4');
  assert.equal(parseRule('2408:8000::/32').type, 'ip6');
  assert.equal(parseRule('*.miao.club').text, '*.miao.club');
  assert.equal(parseRule('localhost'), null);
  assert.equal(parseRule('1.2.3.4/40'), null);
  assert.equal(normalizeRules(''), null);
  assert.equal(normalizeRules('a.com, a.com 1.2.3.4'), 'a.com\n1.2.3.4');
  assert.doesNotThrow(() => checkKeySource('1.2.3.0/24', { ip: '1.2.3.99', headers: {} }));
  assert.doesNotThrow(() => checkKeySource('2408:8000::/32', { ip: '2408:8000:1::5', headers: {} }));
  assert.throws(() => checkKeySource('1.2.3.0/24', { ip: '1.2.4.1', headers: {} }), /来源限制/);
  assert.throws(() => checkKeySource('*.a.com', { ip: '1.1.1.1', headers: { origin: 'https://a.com' } }), /a\.com/);
  assert.doesNotThrow(() => checkKeySource(null, { ip: '1.1.1.1', headers: {} }));
});

test('兑换码：当天额度用完后扣额外次数，同一个码不能重复兑换', async () => {
  const bob = client();
  const me = (await bob('POST', '/auth/register', { email: 'bob@example.com', password: 'password123' })).body.data;
  assert.equal((await admin('PATCH', `/admin/users/${me.id}`, { dailyLimit: 4, reason: '测试兑换码' })).status, 200);
  const created = await admin('POST', '/admin/redeem', { calls: 2, count: 2, maxUses: 1, note: '活动' });
  assert.equal(created.status, 200);
  const [code] = created.body.data.codes;
  assert.match(code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  assert.equal((await alice('POST', '/admin/redeem', { calls: 1 })).status, 403);

  // 用完每天 4 次
  for (let i = 0; i < 4; i++) assert.equal((await bob('GET', '/api/qq/avatar/urls?qq=10000')).status, 200);
  assert.equal((await bob('GET', '/api/qq/avatar/urls?qq=10000')).status, 429);

  assert.equal((await bob('POST', '/account/redeem', { code: 'XXXX-XXXX-XXXX-XXXX' })).status, 400);
  const red = await bob('POST', '/account/redeem', { code: code.toLowerCase().replace(/-/g, ' ') });
  assert.equal(red.status, 200, JSON.stringify(red.body));
  assert.equal(red.body.data.bonus, 2);
  assert.equal((await bob('POST', '/account/redeem', { code })).status, 400, '不能重复兑换');
  assert.equal((await alice('POST', '/account/redeem', { code })).status, 400, '兑换人数已满');

  const r1 = await bob('GET', '/api/qq/avatar/urls?qq=10000');
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get('x-ratelimit-bonus'), '1');
  assert.equal((await bob('GET', '/api/qq/avatar/urls?qq=10000')).status, 200);
  assert.equal((await bob('GET', '/api/qq/avatar/urls?qq=10000')).status, 429);
  assert.equal((await bob('GET', '/auth/me')).body.data.quota.bonus, 0);
});

test('公告：按可见人群和时间显示，管理员可增删改', async () => {
  assert.equal((await alice('POST', '/admin/notices', { title: 'x' })).status, 403);
  assert.equal((await admin('POST', '/admin/notices', { title: '' })).status, 400);
  assert.equal((await admin('POST', '/admin/notices', { title: 'x', audience: 'vip' })).status, 400);
  const a = (await admin('POST', '/admin/notices', { title: '维护通知', content: '今晚维护', mode: 'popup', frequency: 'daily', priority: 5 })).body.data;
  await admin('POST', '/admin/notices', { title: '给访客', audience: 'guest' });
  await admin('POST', '/admin/notices', { title: '给管理员', audience: 'admin' });
  await admin('POST', '/admin/notices', { title: '还没开始', startsAt: new Date(Date.now() + 86400_000).toISOString() });
  const titles = async (c) => (await c('GET', '/site/notices')).body.data.map((n) => n.title);
  assert.deepEqual(await titles(client()), ['维护通知', '给访客']);
  assert.deepEqual(await titles(alice), ['维护通知']);
  assert.deepEqual(await titles(admin), ['维护通知', '给管理员']);
  await admin('PUT', `/admin/notices/${a.id}`, { enabled: false });
  assert.deepEqual(await titles(alice), []);
  assert.equal((await admin('DELETE', `/admin/notices/${a.id}`, {})).status, 200);
  assert.equal((await admin('DELETE', `/admin/notices/${a.id}`, {})).status, 404);
});

test('友情链接：登录用户申请，管理员审核后出现在友链页、首页和站点地图', async () => {
  assert.equal((await client()('POST', '/site/links', { name: 'A', url: 'https://a.example.org' })).status, 401);
  assert.equal((await alice('POST', '/site/links', { name: 'A', url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await alice('POST', '/site/links', { name: '<b>', url: 'https://a.example.org' })).status, 400);
  assert.equal((await alice('POST', '/site/links', { name: '小站', url: 'https://blog.example.org/', description: '个人博客' })).status, 200);
  assert.equal((await alice('POST', '/site/links', { name: '小站2', url: 'https://blog.example.org/x' })).status, 400, '同一网站不能重复申请');
  assert.equal((await client()('GET', '/site/links')).body.data.links.length, 0, '未审核不展示');
  assert.equal((await alice('GET', '/site/links')).body.data.mine[0].status, 'pending');

  const list = (await admin('GET', '/admin/links')).body.data;
  assert.equal(list[0].email, 'alice@example.com');
  assert.equal((await admin('PUT', `/admin/links/${list[0].id}`, { status: 'approved' })).status, 200);
  assert.deepEqual((await client()('GET', '/site/links')).body.data.links.map((l) => l.url), ['https://blog.example.org']);

  const page = await client()('GET', '/links', undefined, { accept: 'text/html' });
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>友情链接/);
  assert.match(page.text, /https:\/\/blog\.example\.org/);
  assert.match((await client()('GET', '/', undefined, { accept: 'text/html' })).text, /blog\.example\.org/);
  assert.match((await client()('GET', '/sitemap.xml')).text, /\/links</);

  process.env.FRIEND_LINK_APPLY = '0';
  assert.equal((await alice('POST', '/site/links', { name: 'B', url: 'https://b.example.org' })).status, 403);
  delete process.env.FRIEND_LINK_APPLY;
});

test('首页平台数据与接口文档页统计', async () => {
  const ov = await client()('GET', '/site/overview');
  assert.equal(ov.status, 200);
  const d = ov.body.data;
  assert.ok(d.apis > 100);
  assert.equal(d.trend.length, 7);
  assert.ok(d.users >= 2);
  assert.notEqual(d.trend.at(-1).day, siteOverview().today?.day, '趋势不含今天');
  process.env.HOME_STATS = '0';
  assert.equal((await client()('GET', '/site/overview')).body.data, null);
  delete process.env.HOME_STATS;

  const ms = await client()('GET', '/stats/module/qq-avatar');
  assert.equal(ms.status, 200);
  const route = ms.body.data.routes['/api/qq/avatar/urls'];
  assert.equal(route.thisWeek.length, 7);
  assert.equal(route.lastWeek.length, 7);
  assert.ok(route.total > 0);
  assert.ok(route.codes.some((c) => c.status === 200));
  assert.equal((await client()('GET', '/stats/module/nope')).status, 404);

  // 文档页：TechArticle 结构化数据、og:type=article
  const doc = await client()('GET', '/docs/qq-avatar', undefined, { accept: 'text/html' });
  assert.match(doc.text, /"TechArticle"/);
  assert.match(doc.text, /og:type" content="article"/);
  // 首页预渲染里有 GitHub 地址和部署说明
  const home = await client()('GET', '/', undefined, { accept: 'text/html' });
  assert.match(home.text, /github\.com\/bocmiao\/api/);
  assert.match(home.text, /theme-init\.js/);
});

test('接口运行参数：置顶推荐、缓存时长、每分钟上限、清缓存都记入操作日志', async () => {
  assert.equal((await alice('PUT', '/admin/modules/qq-avatar/options', { pinned: true })).status, 403);
  assert.equal((await admin('PUT', '/admin/modules/qq-avatar/options', { minuteLimit: 0 })).status, 400);
  const r = await admin('PUT', '/admin/modules/qq-avatar/options', { pinned: true, featured: true, minuteLimit: 2 });
  assert.equal(r.status, 200);
  const cat = (await client()('GET', '/api')).body.data.modules.find((m) => m.name === 'qq-avatar');
  assert.equal(cat.pinned, true);
  assert.equal(cat.featured, true);
  const c = anonClient();
  assert.equal((await c('GET', '/api/qq/avatar/urls?qq=10000')).status, 200);
  assert.equal((await c('GET', '/api/qq/avatar/urls?qq=10000')).status, 200);
  const limited = await c('GET', '/api/qq/avatar/urls?qq=10000');
  assert.equal(limited.status, 429);
  assert.equal(limited.body.errorCode, 'RATE_LIMITED');
  await admin('PUT', '/admin/modules/qq-avatar/options', { minuteLimit: null, pinned: false });
  assert.equal((await admin('POST', '/admin/modules/qq-avatar/cache/clear', {})).status, 200);

  const log = (await admin('GET', '/admin/audit')).body.data.items.map((a) => a.action);
  assert.ok(log.includes('module.options'));
  assert.ok(log.includes('module.cache.clear'));
  assert.ok(log.includes('notice.create'));
  assert.throws(() => db.exec("UPDATE audit_log SET reason = 'x'"), /append-only/);
});

test('缓存时长可由后台覆盖，0 表示不缓存', async () => {
  const c = new TTLCache();
  let n = 0;
  const load = async () => ++n;
  await cacheScope.run({ ttlOverride: 0 }, () => c.wrap('k', 60_000, load));
  const r = await cacheScope.run({ ttlOverride: 0 }, () => c.wrap('k', 60_000, load));
  assert.equal(r.cached, false);
  assert.equal(n, 2);
  const scope = { ttlOverride: 5000 };
  await cacheScope.run(scope, () => c.wrap('k2', 60_000, load));
  assert.equal(scope.ttl, 5000);
});

test('登录记录：成功与失败都记录，用户只能看自己的', async () => {
  const c = client();
  assert.equal((await c('POST', '/auth/login', { email: 'alice@example.com', password: 'wrong-password' })).status, 401);
  assert.equal((await c('POST', '/auth/login', { email: 'alice@example.com', password: 'password123' })).status, 200);
  const mine = (await c('GET', '/account/logins')).body.data;
  assert.equal(mine[0].ok, true);
  assert.equal(mine[1].ok, false);
  const all = (await admin('GET', '/admin/logins?failed=1')).body.data;
  assert.ok(all.items.every((x) => !x.ok));
  assert.equal((await alice('GET', '/admin/logins')).status, 403);
});

test('QQ 头像接口：跳转到官方头像地址，参数校验', async () => {
  const anon = anonClient();
  const r = await anon('GET', '/api/qq/avatar?qq=10000&size=140');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://q1.qlogo.cn/g?b=qq&nk=10000&s=140');
  assert.equal((await anon('GET', '/api/qq/avatar?qq=12')).status, 400);
  assert.equal((await anon('GET', '/api/qq/avatar?qq=10000&size=99')).status, 400);
});

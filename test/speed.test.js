import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const { handle } = await import('../src/app.js');
const { warmable, hotPaths } = await import('../src/lib/prewarm.js');
const { sql } = await import('../src/db.js');

let server, base;
before(async () => {
  server = createServer(handle).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('预热只挑无需参数、依赖外部数据源的 GET 接口', () => {
  assert.equal(warmable('/api/epic/free'), true);
  assert.equal(warmable('/api/hot/weibo'), true);
  assert.equal(warmable('/api/tools/uuid'), false, '本地计算的不需要预热');
  assert.equal(warmable('/api/steam/app'), false, '有必填参数');
  assert.equal(warmable('/api/bing/image'), false, '图片等原始输出');
  assert.equal(warmable('/api/ip'), false, '结果取决于调用者');
  assert.equal(warmable('/api/probe/ping'), false, '会消耗第三方额度');
  assert.equal(warmable('/api/nope'), false);
});

test('按最近调用次数排序取热门接口', () => {
  const now = Date.now();
  const ins = sql('INSERT INTO request_log (ts, user_id, key_id, ip, path, status, ms) VALUES (?, NULL, NULL, ?, ?, ?, ?)');
  for (let i = 0; i < 5; i++) ins.run(now, '1.1.1.1', '/api/hot/zhihu', 200, 10);
  for (let i = 0; i < 3; i++) ins.run(now, '1.1.1.1', '/api/epic/free', 200, 10);
  for (let i = 0; i < 9; i++) ins.run(now, '1.1.1.1', '/api/tools/uuid', 200, 1);
  ins.run(now - 2 * 86400_000, '1.1.1.1', '/api/hot/baidu', 200, 10);
  const paths = hotPaths();
  assert.deepEqual(paths.slice(0, 2), ['/api/hot/zhihu', '/api/epic/free']);
  assert.ok(!paths.includes('/api/tools/uuid'));
  assert.ok(!paths.includes('/api/hot/baidu'), '超过 24 小时的不算');
});

test('开启信任反向代理时优先使用 EdgeOne 的 EO-Connecting-IP', async () => {
  const prev = process.env.TRUST_PROXY;
  try {
    process.env.TRUST_PROXY = '1';
    const r = await fetch(`${base}/api/visitor?geo=0`, { headers: { 'eo-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1' } });
    assert.equal((await r.json()).data.ip, '203.0.113.9');
    const bad = await fetch(`${base}/api/visitor?geo=0`, { headers: { 'eo-connecting-ip': 'not-an-ip', 'x-forwarded-for': '198.51.100.1' } });
    assert.equal((await bad.json()).data.ip, '198.51.100.1', '格式不对时退回 X-Forwarded-For');
    process.env.TRUST_PROXY = '0';
    const off = await fetch(`${base}/api/visitor?geo=0`, { headers: { 'eo-connecting-ip': '203.0.113.9' } });
    assert.equal((await off.json()).data.ip, '127.0.0.1', '未开启时不信任请求头');
  } finally {
    if (prev == null) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = prev;
  }
});

test('接口、错误和短链跳转默认带 no-store，防止被 CDN 缓存', async () => {
  for (const p of ['/api/tools/uuid', '/api/nope', '/s/zzzzzz', '/health']) {
    const r = await fetch(`${base}${p}`, { redirect: 'manual' });
    assert.equal(r.headers.get('cache-control'), 'no-store', p);
  }
});

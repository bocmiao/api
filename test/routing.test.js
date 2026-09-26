import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';

const { handle } = await import('../src/app.js');

let server, base;
before(async () => {
  server = createServer(handle).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const nav = { 'sec-fetch-mode': 'navigate', accept: 'text/html,application/xhtml+xml' };
// fetch 会强制把 Sec-Fetch-Mode 设为 cors，模拟浏览器打开页面要用 http.request
function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    request(`${base}${path}`, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject).end();
  });
}

test('浏览器直接打开页面地址时返回网页', async () => {
  for (const p of ['/', '/docs', '/docs/epic', '/status', '/login', '/console/keys', '/admin/users', '/admin/settings/keys/GITHUB_TOKEN']) {
    const r = await get(p, nav);
    assert.equal(r.status, 200, p);
    assert.match(r.headers['content-type'], /text\/html/, p);
    assert.match(r.headers['cache-control'], /private/, `${p} 不能被 CDN 缓存`);
    assert.match(r.headers.vary, /Sec-Fetch-Mode/, p);
    assert.match(r.body, /<main id="main">/, p);
  }
});

test('没有 Sec-Fetch-Mode 的旧浏览器按 Accept 判断', async () => {
  const r = await get('/docs/epic', { accept: 'text/html' });
  assert.match(r.headers['content-type'], /text\/html/);
  const curl = await get('/status', { accept: '*/*' });
  assert.match(curl.headers['content-type'], /json/, '命令行调用照常返回 JSON');
});

test('网页程序用 fetch 取数据时同一地址照常返回 JSON', async () => {
  const r = await fetch(`${base}/status`);
  assert.match(r.headers.get('content-type'), /json/);
  assert.equal((await r.json()).code, 200);
  const admin = await fetch(`${base}/admin/users`);
  assert.ok(admin.status === 401 || admin.status === 403);
  assert.match(admin.headers.get('content-type'), /json/);
});

test('/api/ 接口、短链接和静态文件不受页面路由影响', async () => {
  const api = await get('/api/tools/uuid', nav);
  assert.match(api.headers['content-type'], /json/);
  const short = await get('/s/zzzzzz', nav);
  assert.doesNotMatch(short.body, /<main id="main">/);
  const js = await get('/app.js', nav);
  assert.match(js.headers['content-type'], /javascript/);
});

test('不存在的页面返回网页和 404 状态', async () => {
  const r = await get('/no-such-page', nav);
  assert.equal(r.status, 404);
  assert.match(r.headers['content-type'], /text\/html/);
  const json = await fetch(`${base}/no-such-page`);
  assert.equal(json.status, 404);
  assert.match(json.headers.get('content-type'), /json/);
});

test('前端不再使用 #/ 地址', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const f of ['public/app.js', 'public/index.html']) {
    const src = await readFile(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.ok(!/href="#\//.test(src) && !/location\.hash\s*=/.test(src), f);
  }
});

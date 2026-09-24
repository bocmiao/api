import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { handle } from '../src/app.js';

const fixture = readFileSync(new URL('./fixtures/epic.json', import.meta.url), 'utf8');
let server, base, upstreamCalls = 0, upstreamFails = false;
const realFetch = globalThis.fetch;

before(async () => {
  mock.method(globalThis, 'fetch', async (url, opts) => {
    if (!String(url).includes('epicgames.com')) return realFetch(url, opts);
    upstreamCalls++;
    if (upstreamFails) return new Response('boom', { status: 503 });
    return new Response(fixture, { status: 200, headers: { 'content-type': 'application/json' } });
  });
  server = createServer(handle).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); mock.restoreAll(); });

const get = async (p) => { const r = await realFetch(base + p); return { status: r.status, headers: r.headers, body: await r.json() }; };

test('/api 列出全部接口', async () => {
  const { status, body } = await get('/api');
  assert.equal(status, 200);
  assert.equal(body.code, 200);
  assert.ok(body.data.some((m) => m.name === 'epic' && m.routes[0].path === '/api/epic/free'));
});

test('/api/epic/free 返回统一格式，第二次命中缓存，上游失败且无缓存时返回 502', async () => {
  const first = await get('/api/epic/free');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('access-control-allow-origin'), '*');
  assert.equal(first.body.cached, false);
  assert.ok(Array.isArray(first.body.data.current));
  assert.ok(Array.isArray(first.body.data.upcoming));

  const second = await get('/api/epic/free');
  assert.equal(second.body.cached, true);
  assert.equal(upstreamCalls, 1);

  upstreamFails = true;
  const failed = await get('/api/epic/free?locale=en-US&country=US');
  assert.equal(failed.status, 502);
  assert.equal(failed.body.data, null);
  upstreamFails = false;
});

test('参数校验与 404', async () => {
  assert.equal((await get('/api/epic/free?country=china')).status, 400);
  assert.equal((await get('/api/epic/free?locale=../x')).status, 400);
  const nf = await get('/api/nope');
  assert.equal(nf.status, 404);
  assert.equal(nf.body.code, 404);
});

test('首页可访问', async () => {
  const r = await realFetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
});

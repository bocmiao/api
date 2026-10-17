import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import http, { createServer } from 'node:http';
import https from 'node:https';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = await mkdtemp(join(tmpdir(), 'news60s-http-'));
Object.assign(process.env, { DATA_DIR: root, NODE_ENV: 'test', EMAIL_VERIFY: '0', PUBLIC_URL: '', ADMIN_EMAILS: '', ANON_DAILY_LIMIT: '10000', ANON_MINUTE_LIMIT: '10000', NEWS_60S_SOURCE_URL: '' });
const outbound = [];
for (const transport of [http, https]) mock.method(transport, 'request', (...args) => {
  outbound.push(args[0]);
  throw new Error('Unexpected external request during local publication/read test');
});
const { handle } = await import('../src/app.js');
const { today } = await import('../src/lib/news60s/format.js');
const { news60sStore } = await import('../src/lib/news60s/store.js');
const { topics } = await import('../src/notify/topics.js');
const sample = JSON.parse(await readFile(new URL('../examples/news60s/manual.json', import.meta.url), 'utf8'));
let server, base;

function client() {
  let cookie;
  return async (method, path, body, extra = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const item of res.headers.getSetCookie()) cookie = item.split(';')[0];
    const raw = await res.text();
    let json;
    try { json = JSON.parse(raw); } catch {}
    return { status: res.status, body: json, raw, headers: res.headers };
  };
}
const admin = client();
const user = client();
const anon = client();

before(async () => {
  server = createServer(handle).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await admin('POST', '/auth/register', { email: 'news-admin@example.test', password: 'only-test-password-123' })).status, 200);
  assert.equal((await user('POST', '/auth/register', { email: 'news-reader@example.test', password: 'only-test-password-456' })).status, 200);
});
after(async () => {
  await new Promise((r) => server.close(r));
  news60sStore().close();
  mock.restoreAll();
  await rm(root, { recursive: true, force: true });
});

test('空库不调用任何作者服务；更新入口仅管理员会话可用', async () => {
  process.env.NEWS_60S_SOURCE_URL = 'https://author.invalid/must-not-fetch';
  assert.equal((await anon('GET', '/api/news/60s')).status, 503);
  delete process.env.NEWS_60S_SOURCE_URL;
  assert.equal((await anon('GET', '/admin/news/60s')).status, 401);
  assert.equal((await anon('POST', '/admin/news/60s/update', { data: sample })).status, 401);
  assert.equal((await user('POST', '/admin/news/60s/update', { data: sample })).status, 403);
  assert.equal((await admin('POST', '/admin/news/60s/update', { data: sample }, { origin: 'https://other.example' })).status, 403);
  const key = (await admin('POST', '/account/keys', { name: 'test-only-key' })).body.data.key;
  assert.equal((await anon('POST', '/admin/news/60s/update', { data: sample }, { 'x-api-key': key })).status, 401, '即使管理员API Key也不能替代管理员会话');
  assert.equal((await fetch(base + '/admin/news/60s/update', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal(outbound.length, 0);
});

test('实际HTTP更新 → 读取JSON → 读取本地图片 → ETag，推送仍复用原路由', async () => {
  const current = today();
  const update = await admin('POST', '/admin/news/60s/update', { data: { ...sample, date: current } });
  assert.equal(update.status, 200, update.raw);
  assert.equal(update.body.data.date, current);
  const read = await anon('GET', '/api/news/60s');
  assert.equal(read.status, 200, read.raw);
  assert.equal(read.body.data.date, current);
  assert.deepEqual(read.body.data.news, sample.news);
  assert.equal(read.body.stale, undefined);
  assert.ok(read.body.updatedAt);
  assert.equal(read.body.data.source, sample.source);
  assert.match(read.body.data.image, /^\/api\/news\/60s\/assets\//);
  const image = await fetch(base + read.body.data.image);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.ok((await image.arrayBuffer()).byteLength > 24);
  assert.equal((await fetch(base + read.body.data.image, { headers: { 'if-none-match': image.headers.get('etag') } })).status, 304);
  const push = await topics['news-60s'].check();
  assert.equal(push.fingerprint, current);
  assert.ok(push.message.text.includes(sample.news[0]));
  assert.equal(outbound.length, 0);
});

test('安全输入、缺失历史、未来或不存在日期均明确拒绝，不污染latest', async () => {
  const before = (await anon('GET', '/api/news/60s')).body.data;
  for (const url of ['http://127.0.0.1/internal', 'http://169.254.169.254/latest/meta-data/', 'https://example.com/?key=synthetic-test']) {
    assert.equal((await admin('POST', '/admin/news/60s/update', { url })).status, 400);
  }
  assert.equal((await admin('POST', '/admin/news/60s/update', { data: { ...sample, date: '2026-02-30' } })).status, 400);
  assert.equal((await admin('POST', '/admin/news/60s/update', { data: { ...sample, date: '2099-01-01' } })).status, 400);
  assert.equal((await admin('POST', '/admin/news/60s/update', { data: { ...sample, date: today(), image: 'data:image/svg+xml;base64,PHN2Zz4=' } })).status, 400);
  assert.equal((await anon('GET', '/api/news/60s?date=2026-01-01')).status, 404);
  assert.equal((await anon('GET', '/api/news/60s?date=2026-02-30')).status, 400);
  assert.deepEqual((await anon('GET', '/api/news/60s')).body.data, before);
  assert.equal(outbound.length, 0);
});

test('独立CLI进程回填历史并在另一个进程读取，运行中的HTTP服务立即可见', async () => {
  const cwd = new URL('../', import.meta.url);
  const options = { cwd, env: { ...process.env, NODE_NO_WARNINGS: '1', NEWS_60S_SOURCE_URL: '' }, encoding: 'utf8' };
  const update = spawnSync(process.execPath, ['scripts/news60s-update.js', '--json', 'examples/news60s/manual.json', '--date', sample.date], options);
  assert.equal(update.status, 0, update.stderr);
  assert.equal(JSON.parse(update.stdout).date, sample.date);
  const history = await anon('GET', '/api/news/60s?date=' + sample.date);
  assert.equal(history.status, 200, history.raw);
  assert.deepEqual(history.body.data.news, sample.news);
  assert.equal((await anon('GET', '/api/news/60s')).body.data.date, today(), '回填不降低latest');
  const restarted = spawnSync(process.execPath, ['scripts/news60s-update.js', '--status'], options);
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.ok(JSON.parse(restarted.stdout).dates.includes(sample.date));
  const failed = spawnSync(process.execPath, ['scripts/news60s-update.js', '--json', '-', '--date', '2026-01-03'], { ...options, input: JSON.stringify(sample) });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /日期不一致/);
  assert.equal((await anon('GET', '/api/news/60s?date=2026-01-03')).status, 404);
  assert.equal(outbound.length, 0);
});

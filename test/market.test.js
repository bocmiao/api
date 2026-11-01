// 市场层页面：广场 / 工具箱 / 排行 / 套餐 / 导航
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'miao-market-'));
process.env.DATA_DIR = dataDir;
const { handle } = await import('../src/app.js');

let server, base, adminClient;
before(async () => {
  server = createServer(handle).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  adminClient = client();
  const admin = await adminClient('POST', '/auth/register', { email: 'admin-market@example.com', password: 'password123' });
  assert.equal(admin.status, 200);
});
after(() => {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const get = (path, headers = {}) => fetch(base + path, { headers, redirect: 'manual' });

test('market pages return the shell with page-specific SEO title', async () => {
  for (const [path, title] of [
    ['/square', '接口广场'],
    ['/tools', '开发者工具箱'],
    ['/ranking', 'API 调用排行榜'],
    ['/packages', '接口套餐'],
    ['/nav', '导航'],
  ]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), /text\/html/, path);
    const html = await res.text();
    assert.ok(html.includes('market.js'), `${path} 应加载市场脚本`);
    assert.ok(html.includes(title), `${path} 标题应包含 ${title}`);
    assert.ok(html.includes('id="market"') === false || html.includes('id="main"'), `${path} 应有主容器`);
  }
});

test('market assets are served', async () => {
  for (const [path, type] of [['/market.js', /javascript/], ['/market.css', /text\/css/]]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), type, path);
  }
});

test('sitemap includes market pages', async () => {
  const res = await get('/sitemap.xml');
  assert.equal(res.status, 200);
  const xml = await res.text();
  for (const path of ['/square', '/tools', '/ranking', '/packages', '/nav']) assert.ok(xml.includes(path), path);
});

test('api endpoint stays JSON after adding page routes', async () => {
  const res = await get('/api');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const body = await res.json();
  assert.equal(body.code, 200);
  assert.ok(Array.isArray(body.data.modules));
  assert.ok(body.data.modules.length > 0);
});

function client() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) cookie = c.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, body: json, text };
  };
}

test('favorites toggle requires login and persists per user', async () => {
  const c = client();
  assert.equal((await c('GET', '/site/favorites')).status, 401);
  assert.equal((await c('POST', '/auth/register', { email: 'market@example.com', password: 'password123' })).status, 200);
  const on = await c('POST', '/site/favorites/epic', {});
  assert.equal(on.status, 200);
  assert.equal(on.body.data.favorited, true);
  const list = await c('GET', '/site/favorites');
  assert.ok(list.body.data.modules.includes('epic'));
  const off = await c('POST', '/site/favorites/epic', {});
  assert.equal(off.body.data.favorited, false);
  assert.ok(!(await c('GET', '/site/favorites')).body.data.modules.includes('epic'));
});

test('reports validate module and description and can be listed by admin', async () => {
  const c = client();
  const user = await c('POST', '/auth/register', { email: 'reporter@example.com', password: 'password123' });
  assert.equal(user.status, 200);
  assert.equal((await c('POST', '/site/reports', { module: 'not-exist', description: '12345' })).status, 404);
  assert.equal((await c('POST', '/site/reports', { module: 'epic', description: 'x' })).status, 400);
  const ok = await c('POST', '/site/reports', { module: 'epic', path: '/api/epic/free', description: '返回字段缺失，无法渲染。', contact: 'test@example.com' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.data.id > 0);
  const list = await adminClient('GET', '/admin/reports?status=open');
  assert.equal(list.status, 200);
  const row = list.body.data.reports.find((r) => r.module === 'epic');
  assert.ok(row);
  const closed = await adminClient('PATCH', `/admin/reports/${row.id}`, { status: 'closed' });
  assert.equal(closed.status, 200);
  assert.ok(!(await adminClient('GET', '/admin/reports?status=open')).body.data.reports.some((r) => r.id === row.id));
  assert.ok((await adminClient('GET', '/admin/reports?status=closed')).body.data.reports.some((r) => r.id === row.id));
});


import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.DB_FILE = ':memory:';
const { handle } = await import('../src/app.js');
const { sql } = await import('../src/db.js');
const { createSession } = await import('../src/lib/auth.js');
const { workbenchRev } = await import('../src/registry.js');
let server, base, admin, member;
before(async () => {
  // 仅此测试进程的内存数据库；不改实际账号或凭据。
  for (const [id, isAdmin] of [[901, 1], [902, 0]]) sql('INSERT INTO users (id, email, password_hash, is_admin) VALUES (?, ?, ?, ?)').run(id, `fixture-${id}@example.test`, 'unusable-fixture-hash', isAdmin);
  admin = createSession(901); member = createSession(902);
  server = createServer(handle).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
async function request(method, path, body, token = admin, headers = {}) {
  const res = await fetch(base + path, { method, headers: { ...(token ? { cookie: `sid=${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, headers: res.headers, json: await res.json() };
}
const cfg = (title = 'HTTP 测试') => ({ name: 'custom-http-review', category: 'tools', title, routes: [{ path: '/api/custom/http-review', summary: '本地测试', url: 'https://fixture.example/', fields: [{ name: 'value', type: 'string', desc: '值' }], cacheTtlSec: 0 }] });

test('每个后台入口都检查管理员；跨站和非 JSON 写入被拒绝', async () => {
  for (const [method, path] of [['GET', '/admin/apis'], ['GET', '/admin/apis/weather'], ['GET', '/admin/apis/doctor'], ['GET', '/admin/custom-apis'], ['POST', '/admin/custom-apis/validate'], ['POST', '/admin/custom-apis'], ['PUT', '/admin/apis/weather/meta'], ['DELETE', '/admin/apis/weather/meta'], ['POST', '/admin/apis/weather/try'], ['PUT', '/admin/custom-apis/no-such'], ['POST', '/admin/custom-apis/no-such/publish'], ['POST', '/admin/custom-apis/no-such/rollback'], ['POST', '/admin/custom-apis/no-such/discard'], ['DELETE', '/admin/custom-apis/no-such'], ['GET', '/admin/custom-apis/no-such/versions']]) {
    for (const token of [null, member]) {
      const r = await request(method, path, method === 'GET' ? undefined : {}, token);
      assert.ok([401, 403].includes(r.status), `${method} ${path}: ${r.status}`);
    }
  }
  const before = workbenchRev();
  for (const origin of ['https://evil.example', 'null', 'not an origin']) {
    const r = await request('PUT', '/admin/apis/weather/meta', { changes: [], expectedRev: before }, admin, { origin });
    assert.equal(r.status, 403, origin);
  }
  assert.equal((await request('PUT', '/admin/apis/weather/meta', {}, admin, { 'content-type': 'text/plain' })).status, 415);
  assert.equal(workbenchRev(), before);
});

test('缺失或过期编辑版本不能覆盖新文案；还原也受同一锁保护', async () => {
  const detail = (await request('GET', '/admin/apis/weather')).json.data;
  const target = 'module|title';
  assert.equal((await request('PUT', '/admin/apis/weather/meta', { changes: [{ target, value: '不得保存' }] })).status, 409);
  const saved = await request('PUT', '/admin/apis/weather/meta', { expectedRev: detail.editRev, changes: [{ target, value: '并发测试标题' }] });
  assert.equal(saved.status, 200);
  assert.equal((await request('PUT', '/admin/apis/weather/meta', { expectedRev: detail.editRev, changes: [{ target, value: '旧页面覆盖' }] })).status, 409);
  const current = (await request('GET', '/admin/apis/weather')).json.data;
  assert.equal(current.module.title, '并发测试标题');
  assert.equal((await request('PUT', '/admin/apis/weather/meta', { expectedRev: current.editRev, reset: [target] })).status, 200);
  const audit = sql("SELECT detail FROM audit_log WHERE action = 'api.meta.save' ORDER BY id DESC LIMIT 1").get();
  assert.equal(JSON.parse(audit.detail).before, '并发测试标题');
  assert.equal(JSON.parse(audit.detail).after, null);
});

test('显式发布当前编辑内容；同名新建、旧 revision、丢失草稿均安全处理', async () => {
  let rev = workbenchRev();
  const draft = await request('POST', '/admin/custom-apis', { expectedRev: rev, config: cfg() });
  assert.equal(draft.status, 200); rev = draft.json.data.editRev;
  assert.equal((await request('POST', '/admin/custom-apis', { expectedRev: rev, config: cfg('不能覆盖') })).status, 409);
  const published = await request('POST', '/admin/custom-apis/custom-http-review/publish', { expectedRev: rev, config: cfg('编辑器当前内容'), reason: '本地测试发布' });
  assert.equal(published.status, 200); rev = published.json.data.editRev;
  assert.equal((await request('GET', '/admin/apis/custom-http-review')).json.data.module.title, '编辑器当前内容');
  assert.equal((await request('DELETE', '/admin/custom-apis/custom-http-review', { expectedRev: rev - 1, reason: '过期删除' })).status, 409);
  assert.equal((await request('DELETE', '/admin/custom-apis/custom-http-review', { expectedRev: rev, reason: '测试清理' })).status, 200);
  const next = await request('POST', '/admin/custom-apis', { expectedRev: workbenchRev(), config: cfg() });
  assert.equal((await request('POST', '/admin/custom-apis/custom-http-review/discard', { expectedRev: next.json.data.editRev })).status, 200);
  assert.equal((await request('GET', '/admin/apis/custom-http-review')).status, 404);
});

test('外部试跑未确认不访问上游；关闭模块不能绕过开关', async () => {
  const before = sql("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'api.try.external'").get().n;
  const r = await request('POST', '/admin/apis/weather/try', { path: '/api/weather', query: { city: '北京' } });
  assert.equal(r.status, 400);
  assert.equal(sql("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'api.try.external'").get().n, before);
  const { setModulesEnabled } = await import('../src/lib/modules.js');
  setModulesEnabled(['devtools'], false);
  assert.equal((await request('POST', '/admin/apis/devtools/try', { path: '/api/tools/uuid' })).status, 403);
  setModulesEnabled(['devtools'], true);
});

test('OpenAPI 路径参数完整，契约即时读取且不被公共缓存保留', async () => {
  const r = await request('GET', '/openapi.json');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  for (const name of ['revision', 'file']) assert.ok(r.json.paths['/api/news/60s/assets/{revision}/{file}'].get.parameters.some((p) => p.name === name && p.in === 'path' && p.required));
  const text = await fetch(base + '/llms.txt');
  assert.equal(text.headers.get('cache-control'), 'no-store');
});

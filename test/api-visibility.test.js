import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mock } from 'node:test';
import { mockCustomUpstream } from './helpers/custom-upstream.js';

process.env.DB_FILE = ':memory:';
process.env.ANON_DAILY_LIMIT = '10000';
mockCustomUpstream(async () => Response.json({ value: 'local fixture' }));
const { handle } = await import('../src/app.js');
const { sql } = await import('../src/db.js');
const { createSession } = await import('../src/lib/auth.js');
const { workbenchRev, apiRouter, invoke } = await import('../src/registry.js');
const { isModuleHidden, isModuleSwitchedOn } = await import('../src/lib/modules.js');
let server, base, admin, member;
before(async () => {
  for (const [id, role] of [[991, 1], [992, 0]]) sql('INSERT INTO users (id,email,password_hash,is_admin) VALUES (?,?,?,?)').run(id, `fixture-${id}@example.test`, 'unusable-fixture', role);
  admin = createSession(991); member = createSession(992);
  server = createServer(handle).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
async function request(method, path, body, token = null, headers = {}) {
  const response = await fetch(base + path, { method, headers: { ...(token ? { cookie: `sid=${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); let json;
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, data: json?.data, json, text, headers: response.headers };
}
const hide = (name, hidden, revision = workbenchRev()) => request('PUT', `/admin/apis/${name}/visibility`, { hidden, expectedRev: revision }, admin);

test('默认旧数据可见；/admin 返回所有接口的隐藏状态和一致的编辑版本', async () => {
  const r = await request('GET', '/admin/modules', undefined, admin);
  assert.equal(r.status, 200); assert.equal(r.data.editRev, workbenchRev());
  assert.ok(r.data.modules.length >= 129); assert.ok(r.data.modules.every((m) => m.hidden === false));
  assert.equal(isModuleHidden('not-recorded'), false);
});

test('隐藏端点检查管理员、JSON、同源、类型和并发版本', async () => {
  const body = { hidden: true, expectedRev: workbenchRev() };
  for (const token of [null, member]) assert.ok([401, 403].includes((await request('PUT', '/admin/apis/devtools/visibility', body, token)).status));
  assert.equal((await request('PUT', '/admin/apis/devtools/visibility', body, admin, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('PUT', '/admin/apis/devtools/visibility', body, admin, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await request('PUT', '/admin/apis/devtools/visibility', { hidden: 'false', expectedRev: workbenchRev() }, admin)).status, 400);
  assert.equal((await request('PUT', '/admin/apis/devtools/visibility', { hidden: true }, admin)).status, 409);
  assert.equal((await hide('does-not-exist', true)).status, 404);
  assert.equal(isModuleHidden('devtools'), false);
});

test('隐藏覆盖所有公开入口和已有缓存，直接调用保持成功，后台仍可恢复', async () => {
  const catalog = (await request('GET', '/api')).data;
  const original = catalog.modules.find((m) => m.name === 'devtools');
  assert.ok(original);
  assert.equal((await request('GET', '/api/tools/uuid?count=1')).status, 200);
  const cards = await request('GET', '/stats/modules'); assert.ok(cards.data.devtools);
  const overview = await request('GET', '/site/overview');
  await request('GET', '/status');
  const previous = workbenchRev();
  const r = await hide('devtools', true, previous);
  assert.equal(r.status, 200); assert.ok(r.data.editRev > previous);
  assert.equal(isModuleSwitchedOn('devtools'), true);
  assert.equal((await hide('devtools', false, previous)).status, 409);
  for (const token of [null, admin, member]) {
    const c = (await request('GET', '/api', undefined, token)).data;
    assert.equal(c.modules.some((m) => m.name === 'devtools'), false);
    for (const category of c.categories) assert.equal(category.count, c.modules.filter((m) => m.category === category.id).length);
  }
  assert.equal((await request('GET', '/stats/modules')).data.devtools, undefined);
  assert.equal((await request('GET', '/stats/module/devtools')).status, 404);
  assert.equal((await request('GET', '/site/overview')).data.apis, overview.data.apis - 1);
  assert.equal((await request('GET', '/status')).data.modules.some((m) => m.name === 'devtools'), false);
  const spec = (await request('GET', '/openapi.json')).json;
  for (const route of original.routes) assert.equal(spec.paths[route.path], undefined);
  assert.equal((await request('GET', '/llms.txt')).text.includes('/api/tools/uuid'), false);
  const sitemap = await request('GET', '/sitemap.xml');
  assert.equal(sitemap.text.includes('/docs/devtools'), false); assert.equal(sitemap.headers.get('cache-control'), 'no-store');
  assert.equal((await request('GET', '/docs/devtools', undefined, null, { accept: 'text/html' })).status, 404);
  assert.equal((await request('GET', '/', undefined, null, { accept: 'text/html' })).text.includes('href="/docs/devtools"'), false);
  assert.equal((await request('GET', '/api/tools/uuid?count=1')).status, 200);
  const adminList = (await request('GET', '/admin/modules', undefined, admin)).data;
  assert.equal(adminList.modules.find((m) => m.name === 'devtools').hidden, true);
  assert.equal((await request('GET', '/admin/apis/devtools', undefined, admin)).data.module.hidden, true);
  assert.equal((await hide('devtools', false)).status, 200);
  assert.ok((await request('GET', '/stats/modules')).data.devtools);
  assert.equal((await request('GET', '/docs/devtools', undefined, null, { accept: 'text/html' })).status, 200);
});

test('禁用和隐藏互不覆盖，恢复显示不会重新启用接口', async () => {
  assert.equal((await request('PUT', '/admin/modules', { names: ['devtools'], enabled: false }, admin)).status, 200);
  await hide('devtools', true); await hide('devtools', false);
  assert.equal(isModuleSwitchedOn('devtools'), false);
  assert.equal((await request('GET', '/api/tools/uuid?count=1')).status, 403);
  await request('PUT', '/admin/modules', { names: ['devtools'], enabled: true }, admin);
  assert.equal((await request('GET', '/api/tools/uuid?count=1')).status, 200);
  const audit = sql("SELECT detail FROM audit_log WHERE action = 'api.visibility.save' AND target = 'devtools' ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual(JSON.parse(audit.detail), { before: true, hidden: false });
});

test('审计写入失败时回滚可见性和编辑版本，不留下部分保存', async () => {
  const revision = workbenchRev();
  sql("CREATE TRIGGER fail_visibility_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'api.visibility.save' BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END").run();
  try {
    assert.equal((await hide('devtools', true, revision)).status, 500);
    assert.equal(isModuleHidden('devtools'), false);
    assert.equal(workbenchRev(), revision);
    assert.equal((await request('GET', '/api/tools/uuid?count=1')).status, 200);
  } finally { sql('DROP TRIGGER fail_visibility_audit').run(); }
});

test('自定义草稿预设隐藏，发布/新版本/回滚保留；删除重建默认可见', async () => {
  const config = { name: 'custom-visible-test', category: 'tools', title: '自定义可见性', routes: [{ method: 'GET', path: '/api/custom/visible-test', summary: '本地模拟', url: 'https://fixture.example/', fields: [{ name: 'value', desc: '值', type: 'string' }], cacheTtlSec: 300 }] };
  const edit = (method, path, body) => request(method, path, { ...body, expectedRev: workbenchRev() }, admin);
  assert.equal((await edit('POST', '/admin/custom-apis', { config })).status, 200);
  assert.equal((await hide(config.name, true)).status, 200);
  assert.equal((await edit('POST', `/admin/custom-apis/${config.name}/publish`, { reason: '本地测试发布' })).status, 200);
  assert.equal((await request('GET', '/api')).data.modules.some((m) => m.name === config.name), false);
  assert.equal((await request('GET', config.routes[0].path)).status, 200);
  await hide(config.name, false);
  assert.equal((await request('GET', config.routes[0].path)).json.cached, true, '恢复显示保留已有调用缓存');
  await hide(config.name, true);
  assert.equal((await request('GET', config.routes[0].path)).json.cached, true, '隐藏不重建调用处理函数或清空缓存');
  config.title = '第二版';
  await edit('PUT', `/admin/custom-apis/${config.name}`, { config });
  await edit('POST', `/admin/custom-apis/${config.name}/publish`, { reason: '发布第二版' });
  await edit('POST', `/admin/custom-apis/${config.name}/rollback`, { version: 1, reason: '测试回滚' });
  assert.equal(isModuleHidden(config.name), true);
  assert.equal((await request('GET', config.routes[0].path)).status, 200);
  await edit('DELETE', `/admin/custom-apis/${config.name}`, { reason: '测试删除' });
  await edit('POST', '/admin/custom-apis', { config });
  assert.equal(isModuleHidden(config.name), false);
  await edit('DELETE', `/admin/custom-apis/${config.name}`, { reason: '测试清理' });
});

test('今日推荐预热缓存和旧值回填不能重现隐藏接口；内部 invoke 仍可调用', async () => {
  const fixtures = ['/api/greeting', '/api/epic/free', '/api/holiday/next', '/api/hot/weibo', '/api/fx/rates', '/api/bing', '/api/hitokoto', '/api/history/today', '/api/metals', '/api/weather'];
  const replacements = fixtures.map((path) => mock.method(apiRouter.match('GET', path).route, 'handler', async () => ({ data: { fixture: path } })));
  try {
    const before = (await request('GET', '/home/today')).data;
    assert.deepEqual(before.greeting, { fixture: '/api/greeting' });
    await hide('greeting', true);
    assert.equal((await request('GET', '/home/today')).data.greeting, null);
    assert.deepEqual(await invoke('/api/greeting'), { fixture: '/api/greeting' }, '隐藏不影响内部调用和推送');
    await hide('greeting', false);
    assert.deepEqual((await request('GET', '/home/today')).data.greeting, before.greeting, '恢复显示即时复用缓存');
    await hide('weather', true);
    assert.equal((await request('GET', '/home/weather?city=北京')).data, null);
    assert.deepEqual(await invoke('/api/weather', { city: '北京' }), { fixture: '/api/weather' });
    await hide('weather', false);
  } finally { for (const replacement of replacements) replacement.mock.restore(); }
});

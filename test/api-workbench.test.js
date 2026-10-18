import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';
const { accountRouter } = await import('../src/routes/account.js');
await import('../src/routes/api-admin.js');
const { catalog } = await import('../src/registry.js');

const admin = { id: 1, email: 'admin@example.com', is_admin: 1 };
const call = (method, path, { body = null, query = {} } = {}) => {
  const hit = accountRouter.match(method, path);
  assert.ok(hit?.route, `路由应存在：${method} ${path}`);
  return hit.route.handler({ user: admin, ip: '127.0.0.1', params: hit.params, query: new URLSearchParams(query), body, req: { headers: {} } });
};

test('非管理员不能访问接口工作台', async () => {
  const hit = accountRouter.match('GET', '/admin/apis');
  await assert.rejects(async () => hit.route.handler({ user: { id: 2, email: 'u@example.com', is_admin: 0 }, ip: '', params: {}, query: new URLSearchParams(), body: null, req: { headers: {} } }), { status: 403 });
});

test('列表与详情：核心接口可见，文案目标带代码默认值', async () => {
  const list = await call('GET', '/admin/apis');
  assert.ok(list.data.modules.length >= 129);
  assert.equal(list.data.doctor.ok, true);
  assert.ok(list.data.modules.every((m) => m.origin === 'core'));

  const detail = await call('GET', '/admin/apis/weather');
  const m = detail.data.module;
  assert.equal(m.name, 'weather');
  assert.ok(m.routes.length >= 1);
  assert.ok(detail.data.shapeHash.length === 40);
  const title = detail.data.targets.find((t) => t.target === 'module|title');
  assert.equal(title.code, '天气预报');
  assert.equal(title.overridden, false);
  assert.ok(detail.data.targets.some((t) => t.target.startsWith('param|/api/weather|')));
});

test('改文案后目录、文档和 OpenAPI 立即生效；还原后恢复', async () => {
  const before = catalog().modules.find((m) => m.name === 'weather').title;
  const saved = await call('PUT', '/admin/apis/weather/meta', {
    body: { changes: [{ target: 'module|title', value: '天气（后台改）' }, { target: 'param|/api/weather|city|desc', value: '城市名（后台改）' }] },
  });
  assert.equal(saved.data.applied.length, 2);
  assert.equal(catalog().modules.find((m) => m.name === 'weather').title, '天气（后台改）');
  assert.equal(catalog().modules.find((m) => m.name === 'weather').routes[0].params.find((p) => p.name === 'city').desc, '城市名（后台改）');

  const listAfter = await call('GET', '/admin/apis');
  const row = listAfter.data.modules.find((m) => m.name === 'weather');
  assert.equal(row.overrides, 2);

  await call('PUT', '/admin/apis/weather/meta', { body: { reset: ['module|title', 'param|/api/weather|city|desc'] } });
  assert.equal(catalog().modules.find((m) => m.name === 'weather').title, before);
  const doctor = await call('GET', '/admin/apis/doctor');
  assert.equal(doctor.data.ok, true);
});

test('保存文案会写审计日志', async () => {
  const { sql } = await import('../src/db.js');
  const before = sql('SELECT COUNT(*) AS n FROM audit_log').get().n;
  await call('PUT', '/admin/apis/bmi/meta', { body: { changes: [{ target: 'module|title', value: 'BMI（审计）' }] } });
  const rows = sql("SELECT action, target FROM audit_log WHERE action = 'api.meta.save' ORDER BY id DESC LIMIT 1").get();
  assert.equal(rows.target, 'bmi');
  assert.equal(sql('SELECT COUNT(*) AS n FROM audit_log').get().n, before + 1);
  await call('PUT', '/admin/apis/bmi/meta', { body: { reset: ['module|title'] } });
});

test('试跑直接调用接口处理函数，不写调用日志', async () => {
  const { sql } = await import('../src/db.js');
  const before = sql('SELECT COUNT(*) AS n FROM request_log').get().n;
  const r = await call('POST', '/admin/apis/devtools/try', { body: { path: '/api/tools/uuid', query: { count: '2' } } });
  assert.equal(r.data.ok, true);
  assert.equal(r.data.data.length, 2);
  assert.equal(sql('SELECT COUNT(*) AS n FROM request_log').get().n, before);

  const bad = await call('POST', '/admin/apis/devtools/try', { body: { path: '/api/tools/uuid', query: { count: '999' } } });
  assert.equal(bad.data.ok, false);
  assert.equal(bad.data.error.status, 400);
});

test('只有草稿的接口也能在列表、详情里看到并试跑', async () => {
  const realFetch = globalThis.fetch;
  const config = {
    name: 'custom-draft-only',
    category: 'tools',
    title: '草稿接口',
    description: '还没发布',
    sourceInfo: { kind: 'third-party-service', network: 'required', summary: '草稿测试上游' },
    routes: [{
      method: 'GET', path: '/api/custom/draft-only', summary: '草稿试跑',
      params: [{ name: 'q', required: true, desc: '关键词', example: 'x', maxLength: 10 }],
      url: 'https://example.com/api?q={q}', extract: 'data',
      map: { title: 'name' }, fields: [{ name: 'title', type: 'string', desc: '标题' }],
      cacheTtlSec: 0,
    }],
  };
  try {
    await call('POST', '/admin/custom-apis', { body: { config } });
    const list = await call('GET', '/admin/apis');
    const row = list.data.modules.find((m) => m.name === 'custom-draft-only');
    assert.ok(row, '草稿也应在列表里');
    assert.equal(row.customDraft, true);

    const detail = await call('GET', '/admin/apis/custom-draft-only');
    assert.equal(detail.data.module.title, '草稿接口');
    assert.ok(detail.data.custom.draft);
    assert.equal(detail.data.custom.config, null);

    globalThis.fetch = async () => new Response(JSON.stringify({ data: { name: '草稿数据' } }), { headers: { 'content-type': 'application/json' } });
    const tried = await call('POST', '/admin/apis/custom-draft-only/try', { body: { path: '/api/custom/draft-only', query: { q: 'x' } } });
    assert.equal(tried.data.ok, true);
    assert.deepEqual(tried.data.data, { title: '草稿数据' });
  } finally {
    globalThis.fetch = realFetch;
    await call('DELETE', '/admin/custom-apis/custom-draft-only', { body: { reason: '测试清理' } });
  }
});

test('自定义接口：校验 → 保存草稿 → 发布 → 详情 → 删除', async () => {
  const config = {
    name: 'custom-audit-demo',
    category: 'tools',
    title: '后台新增演示',
    description: '测试用接口',
    sourceInfo: { kind: 'third-party-service', network: 'required', summary: '测试上游数据源' },
    routes: [{
      method: 'GET', path: '/api/custom/audit-demo', summary: '演示',
      params: [{ name: 'q', required: true, desc: '关键词', example: 'hi' }],
      url: 'https://example.com/api?q={q}', extract: 'data',
      map: { title: 'name' }, fields: [{ name: 'title', type: 'string', desc: '标题' }],
      cacheTtlSec: 0,
    }],
  };
  const valid = await call('POST', '/admin/custom-apis/validate', { body: { config } });
  assert.equal(valid.data.ok, true);
  assert.deepEqual(valid.data.warnings, []);

  await call('POST', '/admin/custom-apis', { body: { config } });
  const published = await call('POST', '/admin/custom-apis/custom-audit-demo/publish', { body: { reason: '测试发布', note: '第一次' } });
  assert.equal(published.data.version, 1);
  assert.ok(catalog().modules.some((m) => m.name === 'custom-audit-demo'));

  const detail = await call('GET', '/admin/apis/custom-audit-demo');
  assert.equal(detail.data.module.custom, true);
  assert.ok(detail.data.custom.versions.length >= 1);

  const versions = await call('GET', '/admin/custom-apis/custom-audit-demo/versions');
  assert.equal(versions.data.items[0].version, 1);

  const del = await call('DELETE', '/admin/custom-apis/custom-audit-demo', { body: { reason: '测试删除' } });
  assert.equal(del.data.name, 'custom-audit-demo');
  assert.equal(catalog().modules.some((m) => m.name === 'custom-audit-demo'), false);
});

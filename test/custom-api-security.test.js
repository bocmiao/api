import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';
const { parseConfig, buildModule, saveCustomDraft, publishCustomApi, getCustomApi } = await import('../src/lib/custom-api.js');
const { sql } = await import('../src/db.js');
const { applyMeta, targetRev, saveMeta } = await import('../src/lib/api-meta.js');
const { mutateWorkbench, workbenchRev, rebuildRegistry, getModules, registryRev } = await import('../src/registry.js');
const { cache } = await import('../src/lib/cache.js');

const config = () => ({ name: 'custom-secure', category: 'tools', title: '安全测试', routes: [{ method: 'GET', path: '/api/custom/secure', summary: '测试', params: [{ name: 'q', desc: '输入', maxLength: 3 }], url: 'https://upstream.example/?q={q}', fields: [{ name: 'value', type: 'string', desc: '值' }], cacheTtlSec: 300 }] });
const call = (mod, query = '', extra = {}) => mod.routes[0].handler({ query: new URLSearchParams(query), ...extra });
afterEach(() => { delete process.env.CUSTOM_API_TEST_TOKEN; cache.store.clear(); cache.pending.clear(); });

test('配置静态拒绝内网、凭据、动态域名与非专用/未声明环境变量', () => {
  for (const url of ['http://127.0.0.1/a', 'http://2130706433/a', 'http://[::1]/', 'http://169.254.169.254/latest', 'https://user:pass@upstream.example/', 'https://{q}/', 'https://upstream.example:{q}/']) {
    const c = config(); c.routes[0].url = url;
    assert.throws(() => parseConfig(c), { status: 400 }, url);
  }
  for (const token of ['SMTP_PASS', 'CUSTOM_API_TEST_TOKEN']) {
    const c = config(); c.routes[0].url = `https://upstream.example/?k={env:${token}}`;
    assert.throws(() => parseConfig(c), { status: 400 });
  }
  const c = config(); c.env = ['SMTP_PASS'];
  assert.throws(() => parseConfig(c), { status: 400 });
});

test('拒绝原型字段、继承路径、自定义正则及嵌套拼写错误', () => {
  for (const patch of [JSON.parse('{"map":{"__proto__":"value"}}'), { map: { value: 'constructor.name' } }, { extract: '__proto__' }, { extra: true }, { headers: { connection: 'keep-alive' } }]) {
    const c = config(); Object.assign(c.routes[0], patch);
    assert.throws(() => parseConfig(c), { status: 400 });
  }
  const c = config(); c.routes[0].params[0].pattern = '(a+)+$';
  assert.throws(() => parseConfig(c), { status: 400 });
});

test('参数限制先于请求；映射仅读取自己的字段', async () => {
  let calls = 0;
  const c = parseConfig(config());
  const mod = buildModule(c, { request: async () => { calls++; return { value: 'ok' }; } });
  await assert.rejects(call(mod, 'q=long'), { status: 400 });
  assert.equal(calls, 0);
  c.routes[0].map = { value: 'toString' };
  await assert.rejects(call(buildModule(c, { request: async () => ({}) })), { status: 502 });
});

test('POST body 参数被读取、校验并转发，不复用缓存', async () => {
  const c = config(); Object.assign(c.routes[0], { method: 'POST', cacheTtlSec: 0, body: { title: '{q}' } });
  c.routes[0].params[0].in = 'body';
  let calls = 0;
  const mod = buildModule(parseConfig(c), { request: async (url, init) => { calls++; assert.equal(new URL(url).searchParams.get('q'), '好'); assert.deepEqual(JSON.parse(init.body), { title: '好' }); return { value: 'ok' }; } });
  await call(mod, '', { body: { q: '好' } }); await call(mod, '', { body: { q: '好' } });
  assert.equal(calls, 2);
  await assert.rejects(call(mod, '', { body: { q: { nested: true } } }), { status: 400 });
  c.routes[0].cacheTtlSec = 1;
  assert.throws(() => parseConfig(c), { status: 400 });
});

test('专用变量不从上游反射泄露，变量变化隔离缓存', async () => {
  const c = config(); c.env = ['CUSTOM_API_TEST_TOKEN']; c.routes[0].headers = { authorization: 'Bearer {env:CUSTOM_API_TEST_TOKEN}' };
  process.env.CUSTOM_API_TEST_TOKEN = 'dummy-one/token';
  let calls = 0;
  const mod = buildModule(parseConfig(c), { request: async (_url, init) => { calls++; return { value: init.headers.authorization + ' ' + encodeURIComponent(process.env.CUSTOM_API_TEST_TOKEN) }; } });
  const first = await call(mod);
  assert.equal(first.data.value, 'Bearer [已隐藏] [已隐藏]');
  await call(mod); assert.equal(calls, 1);
  process.env.CUSTOM_API_TEST_TOKEN = 'dummy-two/token';
  assert.equal((await call(mod)).data.value, 'Bearer [已隐藏] [已隐藏]');
  assert.equal(calls, 2);
});

test('草稿试跑与新配置不共享线上缓存，在途旧加载不能污染新版本', async () => {
  let finish;
  const first = buildModule(parseConfig(config()), { request: () => new Promise((r) => { finish = r; }) });
  const pending = call(first);
  const c = config(); c.routes[0].url = 'https://other.example/';
  let calls = 0;
  const next = buildModule(parseConfig(c), { request: async () => ({ value: ++calls }) });
  assert.equal((await call(next)).data.value, 1);
  finish({ value: 'old' }); await pending;
  assert.equal((await call(next)).data.value, 1);
  assert.equal((await call(next, '', { trial: true })).data.value, 2);
  assert.equal((await call(next)).data.value, 1);
});

test('过期和无效文案不生效，约束变化使参数文案失效', () => {
  const m = { name: 'probe', title: '默认', routes: [{ path: '/api/probe', method: 'GET', params: [{ name: 'q', maxLength: 3 }], fields: [] }] };
  const target = 'param|/api/probe|q|example';
  const patch = new Map([[target, { value: 'abc', baseRev: targetRev(m, target) }], ['module|title', { value: '旧标题', baseRev: 'old' }]]);
  assert.equal(applyMeta(m, patch).title, '默认');
  m.routes[0].params[0].maxLength = 2;
  assert.equal(applyMeta(m, patch).routes[0].params[0].example, undefined);
  assert.throws(() => saveMeta(m, { changes: [{ target, value: 'abc' }] }), { status: 400 });
});

test('持久编辑版本拒绝过期写入；registry 构建失败回滚 DB、审计和版本', () => {
  sql('DELETE FROM custom_api_versions').run(); sql('DELETE FROM custom_apis').run(); rebuildRegistry();
  const editRev = workbenchRev();
  mutateWorkbench(editRev, () => { saveCustomDraft(config()); return {}; }, { rebuild: false });
  assert.throws(() => mutateWorkbench(editRev, () => { throw new Error('不该执行'); }), { status: 409 });
  const before = workbenchRev(), runtimeRev = registryRev();
  const current = getCustomApi('custom-secure');
  assert.throws(() => mutateWorkbench(before, () => {
    publishCustomApi('custom-secure');
    sql("INSERT INTO custom_apis (name, config, created_at, updated_at) VALUES ('broken-row', '{}', 1, 1)").run();
    sql("INSERT INTO audit_log (ts, action) VALUES (1, 'probe.rollback')").run();
    return {};
  }));
  assert.equal(workbenchRev(), before); assert.equal(registryRev(), runtimeRev);
  assert.deepEqual(getCustomApi('custom-secure'), current);
  assert.equal(getModules().some((m) => m.name === 'custom-secure'), false);
  assert.equal(sql("SELECT 1 FROM custom_apis WHERE name = 'broken-row'").get(), undefined);
  assert.equal(sql("SELECT 1 FROM audit_log WHERE action = 'probe.rollback'").get(), undefined);
});

test('核心动态路由与自定义静态地址的冲突不能发布', () => {
  const c = config(); c.name = 'custom-clash-dynamic'; c.routes[0].path = '/api/news/60s/assets/one/two';
  saveCustomDraft(c);
  assert.throws(() => publishCustomApi(c.name), { status: 409 });
});


test('保留工作台静态页面名称；未知字段和超出整数范围在发布前拒绝', async () => {
  for (const name of ['new', 'doctor']) assert.throws(() => parseConfig({ ...config(), name }), { status: 400 });
  const c = config(); c.routes[0].params = [{ name: 'q', desc: '安全整数', type: 'int' }];
  await assert.rejects(call(buildModule(parseConfig(c), { request: async () => ({ value: 'ok' }) }), 'q=9007199254740993'), { status: 400 });
  const unknown = config(); unknown.routes[0].params = {};
  assert.throws(() => parseConfig(unknown), { status: 400 });
  await assert.rejects(call(buildModule(parseConfig(config()), { request: async () => ({ value: 'ok', unexpected: 'private' }) })), { status: 502 });
});


test('声明式上游始终标记联网，不能通过自动巡检或预热产生额外外部调用', async () => {
  const misleading = config(); misleading.sourceInfo = { kind: 'local-data', network: 'none' };
  assert.throws(() => parseConfig(misleading), { status: 400 });
  saveCustomDraft(config()); publishCustomApi('custom-secure'); rebuildRegistry();
  const { planTargets, callTarget } = await import('../src/lib/inspect.js');
  const { warmable } = await import('../src/lib/prewarm.js');
  const target = planTargets({ includeCostly: true }).find((t) => t.module === 'custom-secure');
  assert.match(target.skip, /工作台/);
  assert.equal(warmable('/api/custom/secure'), false);
  assert.equal((await callTarget({ method: 'GET', path: '/api/custom/secure' })).httpStatus, 403);
});

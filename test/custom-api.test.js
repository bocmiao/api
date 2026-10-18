import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';
const { sql } = await import('../src/db.js');
const {
  parseConfig, saveCustomDraft, publishCustomApi, rollbackCustomApi, removeCustomApi, loadCustomModules, getCustomApi,
} = await import('../src/lib/custom-api.js');
const { rebuildRegistry, apiRouter, getModules } = await import('../src/registry.js');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function config(over = {}) {
  return {
    name: 'custom-demo',
    category: 'tools',
    title: '演示接口',
    description: '后台新增的演示接口',
    sourceInfo: { kind: 'third-party-service', network: 'required', summary: '演示上游数据源' },
    routes: [{
      method: 'GET',
      path: '/api/custom/demo',
      summary: '演示：按关键词查询',
      params: [{ name: 'q', required: true, desc: '关键词', example: 'hi', maxLength: 20 }],
      url: 'https://example.com/api?q={q}',
      extract: 'data',
      map: { title: 'name' },
      fields: [{ name: 'title', type: 'string', desc: '标题' }],
      cacheTtlSec: 0,
      timeoutMs: 5000,
    }],
    ...over,
  };
}

const clean = () => {
  sql('DELETE FROM custom_api_versions').run();
  sql('DELETE FROM custom_apis').run();
};

test('parseConfig 拒绝不合法配置', () => {
  assert.throws(() => parseConfig({ ...config(), name: 'Bad Name' }), { status: 400 });
  assert.throws(() => parseConfig({ ...config(), name: 'epic' }), { status: 400 }, '不能和核心接口重名');
  assert.throws(() => parseConfig({ ...config(), category: 'nope' }), { status: 400 });
  assert.throws(() => parseConfig({ ...config(), extra: 1 }), { status: 400 });
  const noFields = config();
  noFields.routes[0].fields = [];
  assert.throws(() => parseConfig(noFields), { status: 400 });
  const badTemplate = config();
  badTemplate.routes[0].url = 'https://example.com/api?x={missing}';
  assert.throws(() => parseConfig(badTemplate), { status: 400 });
  const badPath = config();
  badPath.routes[0].path = '/custom/demo';
  assert.throws(() => parseConfig(badPath), { status: 400 });
  const missingMapDoc = config();
  missingMapDoc.routes[0].map = { title: 'name', link: 'url' };
  assert.throws(() => parseConfig(missingMapDoc), { status: 400 });
  const noExample = config();
  noExample.routes[0].params[0].example = '';
  assert.throws(() => parseConfig(noExample), { status: 400 }, '必填参数必须有示例');
});

test('草稿发布后才进入路由表，调用返回映射后的数据', async () => {
  clean();
  saveCustomDraft(config());
  rebuildRegistry();
  assert.equal(getModules().some((m) => m.name === 'custom-demo'), false, '草稿不能上线');

  publishCustomApi('custom-demo', { by: 'admin@test', note: '首发' });
  rebuildRegistry();
  const mod = getModules().find((m) => m.name === 'custom-demo');
  assert.ok(mod, '发布后应出现在模块表');
  assert.equal(mod.origin, 'custom');
  assert.equal(mod.sourceInfo.label, '第三方数据');

  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    assert.match(String(url), /q=hi/);
    return new Response(JSON.stringify({ data: { name: '你好' } }), { headers: { 'content-type': 'application/json' } });
  };
  const hit = apiRouter.match('GET', '/api/custom/demo');
  const res = await hit.route.handler({ query: new URLSearchParams('q=hi') });
  assert.deepEqual(res.data, { title: '你好' });
  assert.equal(calls, 1);
});

function publishNext(over = {}) {
  saveCustomDraft(config(over));
  publishCustomApi('custom-demo', { by: 'admin@test' });
  rebuildRegistry();
}

test('上游结构变化时返回 502，而不是静默返回空数据', async () => {
  publishNext({ title: '结构变化' });
  globalThis.fetch = async () => new Response(JSON.stringify({ items: [] }), { headers: { 'content-type': 'application/json' } });
  const hit = apiRouter.match('GET', '/api/custom/demo');
  await assert.rejects(hit.route.handler({ query: new URLSearchParams('q=hi') }), (err) => err.status === 502 && /data/.test(err.message));
});

test('发布新版本后可回滚，删除后路由消失', () => {
  const v1 = 1; // 第二个用例发布的第一个版本
  publishNext({ title: '第二版标题' });
  assert.equal(getModules().find((m) => m.name === 'custom-demo').title, '第二版标题');
  rollbackCustomApi('custom-demo', v1, { by: 'admin@test' });
  rebuildRegistry();
  assert.equal(getModules().find((m) => m.name === 'custom-demo').title, '演示接口');

  removeCustomApi('custom-demo');
  rebuildRegistry();
  assert.equal(getModules().some((m) => m.name === 'custom-demo'), false);
  assert.equal(apiRouter.match('GET', '/api/custom/demo'), null);
  assert.equal(loadCustomModules().length, 0);
});

test('路径和核心接口冲突时拒绝发布', () => {
  clean();
  const clash = config({ name: 'custom-clash', routes: [{ ...config().routes[0], path: '/api/epic/free' }] });
  saveCustomDraft(clash);
  assert.throws(() => publishCustomApi('custom-clash', { by: 'admin@test' }), (err) => err.status === 409);
});

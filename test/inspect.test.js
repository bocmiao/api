import { test } from 'node:test';
import assert from 'node:assert/strict';

const { planTargets, callTarget, COSTLY } = await import('../src/lib/inspect.js');

test('巡检计划：默认跳过会消耗额度或产生数据的接口，勾选后一起巡检', () => {
  const def = planTargets();
  const costly = def.filter((t) => COSTLY[t.module] && !t.path.includes('/:'));
  assert.ok(costly.length > 0 && costly.every((t) => /默认跳过/.test(t.skip)));
  const all = planTargets({ includeCostly: true });
  assert.ok(all.filter((t) => COSTLY[t.module]).every((t) => !/默认跳过/.test(t.skip ?? '')));
  assert.ok(def.find((t) => t.path === '/api/express').skip.includes('密钥'), '没配置密钥的接口跳过并说明');
  assert.ok(def.find((t) => t.path === '/api/tools/uuid').attempts, '本地接口会被调用');
});

test('调用：先用必填参数，参数错误时带上全部示例参数重试；仍然参数错误标为「参数不适用」', async () => {
  const plan = planTargets();
  const get = (p) => plan.find((t) => t.path === p);
  assert.equal((await callTarget(get('/api/tools/uuid'))).status, 'ok');
  assert.equal((await callTarget(get('/api/tools/radix'))).status, 'ok', '重试时带上 from 参数后成功');
  const { apiRouter } = await import('../src/registry.js');
  const { HttpError } = await import('../src/lib/http.js');
  apiRouter.add('GET', '/api/__badparam', () => { throw new HttpError(400, '参数不对'); }, { route: { method: 'GET' }, module: { name: 'test' } });
  const w = await callTarget({ method: 'GET', path: '/api/__badparam', attempts: [{ query: {}, body: {} }, { query: { a: 1 }, body: {} }] });
  assert.equal(w.status, 'param');
  assert.match(w.error, /接口本身多半正常/);
  const missing = await callTarget({ method: 'GET', path: '/api/nope' });
  assert.equal(missing.status, 'fail');
});

test('超时和程序错误分别标出', async () => {
  const { apiRouter } = await import('../src/registry.js');
  apiRouter.add('GET', '/api/__boom', () => { throw new TypeError('x is undefined'); }, { route: { method: 'GET' }, module: { name: 'test' } });
  const r = await callTarget({ method: 'GET', path: '/api/__boom', attempts: [{ query: {}, body: {} }] });
  assert.equal(r.status, 'fail');
  assert.match(r.error, /程序错误：x is undefined/);
});

test('「两个参数只能传一个」的接口：去掉一个可选参数后能调通', async () => {
  const t = planTargets().find((x) => x.path === '/api/workdays');
  const r = await callTarget(t);
  assert.equal(r.status, 'ok', r.error);
});

test('要先建任务才能查的接口直接跳过', () => {
  const t = planTargets({ includeCostly: true }).find((x) => x.path === '/api/crawl/result');
  assert.match(t.skip, /先创建抓取任务/);
});

test('暂停服务的接口：巡检跳过，调用直接返回 503 并说明原因，不去请求上游', async () => {
  const t = planTargets().find((x) => x.path === '/api/boxoffice');
  assert.equal(t.skip, '接口已暂停服务');
  const { invoke, catalog } = await import('../src/registry.js');
  const prev = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('不应请求上游'); };
  try {
    await assert.rejects(invoke('/api/boxoffice'), (e) => e.status === 503 && /暂不可用.*猫眼/.test(e.message));
  } finally {
    globalThis.fetch = prev;
  }
  assert.equal(called, false);
  assert.match(catalog().modules.find((m) => m.name === 'boxoffice').suspended, /猫眼/);
  const { warmable } = await import('../src/lib/prewarm.js');
  assert.equal(warmable('/api/boxoffice'), false);
});

import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const { diagnose, gatherEvidence, normalizeDiagnosis } = await import('../src/lib/diagnose.js');
const { logRequest } = await import('../src/lib/limits.js');

const saved = { key: process.env.LLM_API_KEY, base: process.env.LLM_BASE_URL, kuaidi: process.env.KUAIDI100_KEY };
afterEach(() => {
  mock.restoreAll();
  for (const [k, env] of [['key', 'LLM_API_KEY'], ['base', 'LLM_BASE_URL'], ['kuaidi', 'KUAIDI100_KEY']]) {
    if (saved[k] == null) delete process.env[env]; else process.env[env] = saved[k];
  }
});

test('未配置 AI 时给出去哪里配置的提示', async () => {
  delete process.env.LLM_API_KEY;
  await assert.rejects(diagnose('/api/epic/free'), (e) => e.status === 503 && /设置 → AI/.test(e.message));
});

test('汇总材料：调用统计、失败原因、密钥是否配置（不含密钥内容）、实际调用结果', async () => {
  for (let i = 0; i < 3; i++) logRequest({ ip: '1.1.1.1', path: '/api/express', status: 503, ms: 5, error: '缺少配置 KUAIDI100_KEY' });
  logRequest({ ip: '1.1.1.1', path: '/api/express', status: 400, ms: 2, error: '缺少参数 number' });
  process.env.KUAIDI100_KEY = 'secret-value-should-not-leak';
  const ev = await gatherEvidence('/api/express');
  assert.equal(ev.last7d.calls, 4);
  assert.equal(ev.last7d.failed, 4);
  assert.deepEqual(ev.errors[0], { ...ev.errors[0], status: 503, error: '缺少配置 KUAIDI100_KEY', n: 3 });
  assert.ok(ev.module.env.some((e) => e.name === 'KUAIDI100_KEY' && e.configured === true));
  assert.ok(!JSON.stringify(ev).includes('secret-value-should-not-leak'), '材料里没有密钥内容');
  assert.ok('liveTest' in ev);
  await assert.rejects(gatherEvidence('/api/nope'), (e) => e.status === 404);
});

test('实际调用一次：上游失败时记录状态码和原因；会消耗额度的接口不测', async () => {
  mock.method(globalThis, 'fetch', async () => new Response('down', { status: 500 }));
  const ev = await gatherEvidence('/api/epic/free');
  assert.equal(ev.liveTest.ok, false);
  assert.equal(ev.liveTest.status, 502);
  assert.match(ev.liveTest.error, /HTTP 500/);
  assert.ok((await gatherEvidence('/api/probe/ping')).liveTest.skipped);
});

test('调用大模型并规范化结果', async () => {
  process.env.LLM_API_KEY = 'sk-test';
  process.env.LLM_BASE_URL = 'https://llm.example/v1';
  let sent;
  mock.method(globalThis, 'fetch', async (url, opts) => {
    if (String(url).startsWith('https://llm.example')) {
      sent = JSON.parse(opts.body);
      const content = JSON.stringify({ status: '故障', category: '网络不通', summary: '服务器连不上 Epic。', causes: ['境外网络不稳定'], suggestions: ['稍后再试', '配置代理'], confidence: '中' });
      return Response.json({ model: 'm', choices: [{ message: { content } }], usage: {} });
    }
    return new Response('down', { status: 500 });
  });
  const r = await diagnose('/api/epic/free');
  assert.equal(r.diagnosis.category, '网络不通');
  assert.deepEqual(r.diagnosis.suggestions, ['稍后再试', '配置代理']);
  assert.match(sent.messages[0].content, /运维助手/);
  assert.match(sent.messages[1].content, /\/api\/epic\/free/);
  assert.equal(r.evidence.path, '/api/epic/free');
});

test('规范化：缺少结论时判为无效，未知取值换成默认值', () => {
  assert.equal(normalizeDiagnosis({}), null);
  const d = normalizeDiagnosis({ summary: ' 结论 ', status: '怪', category: '怪', causes: ['a', '', 'b', 'c', 'd', 'e'], confidence: 'x' });
  assert.deepEqual(d, { status: '部分失败', category: '其他', summary: '结论', causes: ['a', 'b', 'c', 'd'], suggestions: [], confidence: '中' });
});

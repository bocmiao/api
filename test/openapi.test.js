import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';
const { openapi, llmsTxt } = await import('../src/lib/openapi.js');
const { getModules } = await import('../src/registry.js');

test('OpenAPI 覆盖全部路由，operationId 唯一，字段说明随目录输出', () => {
  const spec = openapi('https://api.example.com');
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.servers[0].url, 'https://api.example.com');
  assert.equal(spec.info.version.length > 0, true);

  const routes = getModules().flatMap((m) => m.routes.map((r) => ({ m, r })));
  const operations = Object.values(spec.paths).flatMap((p) => Object.values(p));
  assert.equal(operations.length, routes.length);
  const ids = new Set(operations.map((o) => o.operationId));
  assert.equal(ids.size, operations.length, 'operationId 必须唯一');

  for (const { m, r } of routes) {
    const key = r.path.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');
    const op = spec.paths[key][r.method.toLowerCase()];
    assert.ok(op, `${r.method} ${r.path}`);
    assert.equal(op['x-miao'].module, m.name);
    assert.equal(op.summary.length > 0, true);
  }
});

test('llms.txt 用纯文本列出接口、参数和字段', () => {
  const text = llmsTxt('https://api.example.com');
  assert.match(text, /^# Miao API/m);
  assert.match(text, /GET \/api\/weather/);
  assert.match(text, /返回字段：/);
  assert.match(text, /https:\/\/api\.example\.com\/openapi\.json/);
  assert.ok(text.length > 5000, '应包含全部接口，而不是摘要');
});

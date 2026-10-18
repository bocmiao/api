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


test('自定义整数参数保持整数契约，易混路径也有不同 operationId', async () => {
  const { rebuildRegistry } = await import('../src/registry.js');
  const { buildModule, parseConfig } = await import('../src/lib/custom-api.js');
  const c = parseConfig({ name: 'custom-schema', category: 'tools', title: '契约测试', routes: ['a-b', 'a_b'].map((name) => ({ method: 'GET', path: `/api/custom/${name}`, summary: '不同地址', url: 'https://fixture.example/', params: [{ name: 'count', type: 'int', desc: '数量', example: '2', oneOf: ['1', '2'], min: 1, max: 2 }], fields: [{ name: 'value', desc: '值', type: 'string' }] })) });
  try {
    rebuildRegistry({ extra: [buildModule(c)] });
    const paths = openapi('https://api.example.com').paths;
    assert.notEqual(paths['/api/custom/a-b'].get.operationId, paths['/api/custom/a_b'].get.operationId);
    const p = paths['/api/custom/a-b'].get.parameters[0];
    assert.equal(p.schema.type, 'integer'); assert.deepEqual(p.schema.enum, [1, 2]); assert.equal(p.example, 2);
  } finally { rebuildRegistry(); }
});

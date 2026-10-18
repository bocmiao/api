import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.DB_FILE = ':memory:';
const { modules, categories } = await import('../src/apis/index.js');
const { checkContract, buildSurface, surfaceJson } = await import('../src/lib/api-contract.js');

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const surfaceText = readFileSync(new URL('../docs/api-surface.json', import.meta.url), 'utf8');

test('接口契约：路径/命名唯一、来源已登记、README 数量正确', () => {
  const result = checkContract({ modules, categories, readmeText: readme, surfaceText });
  assert.deepEqual(result.errors, []);
  assert.ok(result.routeTotal > 0);
});

test('接口清单快照必须和代码一致', () => {
  assert.equal(surfaceText, surfaceJson(modules), '新增/删除/改名接口后运行 npm run api:sync 并提交 docs/api-surface.json');
  assert.deepEqual(JSON.parse(surfaceText), buildSurface(modules));
});

test('契约检查能发现构造出来的错误', () => {
  // 只复制结构，不复制 handler（函数不能 structuredClone）
  const broken = modules.map((m) => ({
    name: m.name,
    category: m.category,
    routes: m.routes.map((r) => ({ method: r.method, path: r.path, summary: r.summary, params: r.params, fields: r.fields })),
  }));
  broken.push({
    name: broken[0].name,
    category: 'nope',
    routes: [{ method: 'GET', path: broken[0].routes[0].path, summary: '' }],
  });
  broken.push({ name: 'not-registered', category: 'tools', routes: [{ method: 'GET', path: '/api/not-registered', summary: '未登记来源' }] });
  const result = checkContract({ modules: broken, categories, readmeText: readme, surfaceText });
  assert.ok(result.errors.some((e) => e.includes('模块名重复')));
  assert.ok(result.errors.some((e) => e.includes('分类不存在')));
  assert.ok(result.errors.some((e) => e.includes('地址重复')));
  assert.ok(result.errors.some((e) => e.includes('没有在 src/lib/api-sources.js 登记')));
  assert.ok(result.errors.some((e) => e.includes('接口清单快照')));
  assert.ok(result.warnings.some((w) => w.includes('缺少 summary')));
});

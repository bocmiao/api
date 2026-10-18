import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';
const { sql } = await import('../src/db.js');
const {
  shapeHash, applyMeta, saveMeta, metaTargets, metaDoctor, parseTarget, targetRev,
} = await import('../src/lib/api-meta.js');

const demo = () => ({
  name: 'demo',
  category: 'tools',
  title: '演示',
  description: '演示说明',
  routes: [{
    method: 'GET',
    path: '/api/demo',
    summary: '演示接口',
    params: [
      { name: 'q', desc: '关键词', example: 'hi' },
      { name: 'mode', desc: '模式', example: 'a', oneOf: ['a', 'b'] },
    ],
    fields: [{ name: 'title', type: 'string', desc: '标题' }],
  }],
});

test('shapeHash 只看结构，改文案不算结构变化', () => {
  const mod = demo();
  const before = shapeHash(mod);
  assert.equal(before, shapeHash(structuredClone(mod)));
  const textOnly = structuredClone(mod);
  textOnly.title = '改了标题';
  textOnly.routes[0].params[0].desc = '改了说明';
  assert.equal(shapeHash(textOnly), before);
  const structural = structuredClone(mod);
  structural.routes[0].fields.push({ name: 'extra', type: 'string' });
  assert.notEqual(shapeHash(structural), before);
});

test('applyMeta 只覆盖文字，孤儿补丁不生效但会被标出', () => {
  const patch = new Map([
    ['module|title', { value: '新标题' }],
    ['module|description', { value: '' }],
    ['route|/api/demo|summary', { value: '新说明' }],
    ['param|/api/demo|q|desc', { value: '新参数说明' }],
    ['param|/api/demo|mode|example', { value: 'b' }],
    ['field|/api/demo|title|desc', { value: '新字段说明' }],
    ['field|/api/demo|gone|desc', { value: '孤儿' }],
  ]);
  const out = applyMeta(demo(), patch);
  assert.equal(out.title, '新标题');
  assert.equal(out.description, '');
  assert.equal(out.routes[0].summary, '新说明');
  assert.equal(out.routes[0].params[0].desc, '新参数说明');
  assert.equal(out.routes[0].params[1].example, 'b');
  assert.equal(out.routes[0].fields[0].desc, '新字段说明');
  assert.deepEqual(out.metaOrphans, ['field|/api/demo|gone|desc']);
  assert.equal(shapeHash(out), shapeHash(demo()), '覆盖层不能改结构');
  assert.equal(out.routes[0].params[0].name, 'q');
});

test('parseTarget 拒绝格式不对的目标', () => {
  assert.deepEqual(parseTarget('module|title'), { kind: 'module', attr: 'title' });
  assert.deepEqual(parseTarget('param|/api/demo|q|desc'), { kind: 'param', path: '/api/demo', name: 'q', attr: 'desc' });
  for (const bad of ['', 'module|body', 'param|/api/demo|q', 'field|/api/demo|f|name', 'route|/api/demo']) {
    assert.throws(() => parseTarget(bad), { status: 400 }, bad);
  }
});

test('saveMeta 校验长度、枚举示例和未知目标，并支持还原', () => {
  const mod = demo();
  sql('DELETE FROM api_meta WHERE name = ?').run('demo');
  saveMeta(mod, { changes: [{ target: 'module|title', value: '后台标题' }] }, 'admin@test');
  assert.equal(sql("SELECT value FROM api_meta WHERE name = 'demo' AND target = 'module|title'").get().value, '后台标题');
  // 覆盖后结构指纹仍在：改文案不会把自己变成"过期"
  const row = sql("SELECT base_rev FROM api_meta WHERE name = 'demo' AND target = 'module|title'").get();
  assert.equal(row.base_rev, targetRev(mod, 'module|title'));

  assert.throws(() => saveMeta(mod, { changes: [{ target: 'module|title', value: '' }] }), { status: 400 });
  assert.throws(() => saveMeta(mod, { changes: [{ target: 'module|title', value: 'x'.repeat(61) }] }), { status: 400 });
  assert.throws(() => saveMeta(mod, { changes: [{ target: 'param|/api/demo|mode|example', value: 'z' }] }), { status: 400 });
  assert.throws(() => saveMeta(mod, { changes: [{ target: 'field|/api/demo|gone|desc', value: 'x' }] }), { status: 400 });

  const targets = metaTargets(mod);
  const title = targets.find((t) => t.target === 'module|title');
  assert.equal(title.overridden, true);
  assert.equal(title.code, '演示');
  assert.equal(title.value, '后台标题');

  saveMeta(mod, { reset: ['module|title'] });
  assert.equal(sql("SELECT 1 FROM api_meta WHERE name = 'demo' AND target = 'module|title'").get(), undefined);
  assert.equal(metaTargets(mod).find((t) => t.target === 'module|title').value, '演示');
});

test('metaDoctor 归类孤儿、过期与无效补丁', () => {
  const mod = demo();
  sql('DELETE FROM api_meta WHERE name = ?').run('demo');
  sql("INSERT INTO api_meta (name, target, value, base_rev, rev, updated_by, updated_at) VALUES (?, ?, ?, ?, 1, 't', ?)")
    .run('demo', 'field|/api/demo|gone|desc', '孤儿', '', Date.now());
  sql("INSERT INTO api_meta (name, target, value, base_rev, rev, updated_by, updated_at) VALUES (?, ?, ?, ?, 1, 't', ?)")
    .run('demo', 'module|title', '旧结构时写的标题', 'old-rev', Date.now());
  sql("INSERT INTO api_meta (name, target, value, base_rev, rev, updated_by, updated_at) VALUES (?, ?, ?, ?, 1, 't', ?)")
    .run('demo', 'module|description', 'x'.repeat(301), targetRev(mod, 'module|description'), Date.now());
  sql("INSERT INTO api_meta (name, target, value, base_rev, rev, updated_by, updated_at) VALUES (?, ?, ?, ?, 1, 't', ?)")
    .run('deleted-module', 'module|title', '已删除接口的文案', '', Date.now());

  const doctor = metaDoctor([mod]);
  const kinds = doctor.issues.map((i) => `${i.kind}:${i.target}`).sort();
  assert.deepEqual(kinds, [
    'invalid:module|description',
    'module-missing:module|title',
    'orphan:field|/api/demo|gone|desc',
    'stale:module|title',
  ].sort());
  assert.equal(doctor.ok, false);
  assert.equal(doctor.counts.orphan, 1);
  sql('DELETE FROM api_meta WHERE name IN (?, ?)').run('demo', 'deleted-module');
  assert.equal(metaDoctor([mod]).ok, true);
});

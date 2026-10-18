import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const directory = mkdtempSync(join(tmpdir(), 'miao-workbench-persistence-'));
process.env.DATA_DIR = directory;
process.env.DB_FILE = join(directory, 'fixture.sqlite');
const src = new URL('../src/', import.meta.url).href;
function child(mode) {
  const code = `
    const { sql } = await import(${JSON.stringify(src + 'db.js')});
    const { mutateWorkbench, workbenchRev, getModules } = await import(${JSON.stringify(src + 'registry.js')});
    const { saveCustomDraft, publishCustomApi, rollbackCustomApi, getCustomApi, customVersions } = await import(${JSON.stringify(src + 'lib/custom-api.js')});
    const config = (title) => ({ name: 'custom-persist', title, category: 'tools', routes: [{ method: 'GET', path: '/api/custom/persist', summary: '持久化测试', url: 'https://fixture.example/', fields: [{ name: 'value', type: 'string', desc: '值' }] }] });
    const edit = (fn, rebuild = true) => mutateWorkbench(workbenchRev(), fn, { rebuild });
    if (${JSON.stringify(mode)} === 'seed') {
      edit(() => saveCustomDraft(config('第一版')), false); edit(() => publishCustomApi('custom-persist'));
      edit(() => saveCustomDraft(config('第二版')), false); edit(() => publishCustomApi('custom-persist'));
      edit(() => rollbackCustomApi('custom-persist', 1));
    }
    if (${JSON.stringify(mode)} === 'publish-other-process') {
      edit(() => saveCustomDraft(config('另一个进程发布')), false); edit(() => publishCustomApi('custom-persist'));
    }
    console.log(JSON.stringify({ rev: workbenchRev(), title: getModules().find((m) => m.name === 'custom-persist')?.title, row: getCustomApi('custom-persist'), versions: customVersions('custom-persist') }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: process.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}
let db;
after(() => { db?.close(); rmSync(directory, { recursive: true, force: true }); });

test('发布/回滚和编辑版本跨重启保留；别的进程发布后下一请求同步 registry', async () => {
  const seeded = child('seed');
  assert.equal(seeded.title, '第一版'); assert.equal(seeded.row.version, 1); assert.equal(seeded.versions.length, 2);
  const restarted = child('read');
  assert.equal(restarted.rev, seeded.rev); assert.equal(restarted.title, '第一版'); assert.equal(restarted.row.draft, null);
  ({ db } = await import('../src/db.js'));
  const registry = await import('../src/registry.js');
  assert.equal(registry.getModules().find((m) => m.name === 'custom-persist').title, '第一版');
  const next = child('publish-other-process');
  assert.equal(next.row.version, 3, '回滚后的发布继续递增，历史不覆盖');
  registry.readWorkbench(() => {
    assert.equal(registry.getModules().find((m) => m.name === 'custom-persist').title, '另一个进程发布');
    assert.equal(registry.workbenchRev(), next.rev);
  });
  assert.throws(() => registry.mutateWorkbench(seeded.rev, () => { throw new Error('不能执行'); }), { status: 409 });
});


test('两个已启动进程用同一个编辑版本竞争时恰有一个提交，另一个返回409', async () => {
  const registry = await import('../src/registry.js');
  const expected = registry.workbenchRev();
  const racers = [];
  for (const label of ['one', 'two']) {
    const code = `
      const { mutateWorkbench } = await import(${JSON.stringify(src + 'registry.js')});
      const { getCustomApi, saveCustomDraft } = await import(${JSON.stringify(src + 'lib/custom-api.js')});
      const ready = new Promise((resolve) => process.stdin.once('data', resolve));
      console.log('ready'); await ready;
      try {
        mutateWorkbench(${expected}, () => { const c = getCustomApi('custom-persist').config; c.title = ${JSON.stringify(label)}; return saveCustomDraft(c); }, { rebuild: false });
        console.log(JSON.stringify({ status: 200, label: ${JSON.stringify(label)} }));
      } catch (err) { console.log(JSON.stringify({ status: err.status, message: err.message })); }
    `;
    const processFixture = spawn(process.execPath, ['--input-type=module', '-e', code], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    const ready = new Promise((resolve, reject) => {
      processFixture.stdout.on('data', (chunk) => { output += chunk; if (output.includes('ready\n')) resolve(); });
      processFixture.once('error', reject);
      processFixture.once('exit', (status) => { if (status) reject(new Error(errors)); });
    });
    processFixture.stderr.on('data', (chunk) => { errors += chunk; });
    const done = new Promise((resolve, reject) => processFixture.once('exit', (status) => { if (status) reject(new Error(errors)); else resolve(JSON.parse(output.trim().split('\n').at(-1))); }));
    await ready;
    racers.push({ processFixture, done });
  }
  for (const { processFixture } of racers) processFixture.stdin.end('go\n');
  const results = await Promise.all(racers.map(({ done }) => done));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(registry.workbenchRev(), expected + 1);
  const { getCustomApi } = await import('../src/lib/custom-api.js');
  assert.equal(getCustomApi('custom-persist').draft.title, results.find((r) => r.status === 200).label);
});

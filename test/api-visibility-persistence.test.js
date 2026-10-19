import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

test('旧 module_settings 自动迁移默认可见，隐藏跨重启/进程保留且不改变禁用状态', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'miao-visibility-'));
  const file = join(directory, 'fixture.sqlite');
  const src = new URL('../src/', import.meta.url).href;
  const legacy = new DatabaseSync(file);
  legacy.exec("CREATE TABLE module_settings (name TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT (datetime('now'))); INSERT INTO module_settings(name, enabled) VALUES ('devtools', 0)");
  legacy.close();
  const run = (code) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `const { sql, db } = await import(${JSON.stringify(src + 'db.js')}); const { isModuleHidden, isModuleSwitchedOn, setModuleHidden } = await import(${JSON.stringify(src + 'lib/modules.js')}); ${code}; db.close();`], { env: { ...process.env, NODE_ENV: 'test', DB_FILE: file, DATA_DIR: directory }, encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout.trim());
  };
  try {
    const first = run("console.log(JSON.stringify({ hidden: isModuleHidden('devtools'), enabled: isModuleSwitchedOn('devtools'), defaultValue: sql('SELECT hidden FROM module_settings').get().hidden })); setModuleHidden('devtools', true)");
    assert.deepEqual(first, { hidden: false, enabled: false, defaultValue: 0 });
    const second = run("console.log(JSON.stringify({ hidden: isModuleHidden('devtools'), enabled: isModuleSwitchedOn('devtools'), missing: isModuleHidden('never-configured') })); setModuleHidden('devtools', false)");
    assert.deepEqual(second, { hidden: true, enabled: false, missing: false });
    const third = run("console.log(JSON.stringify({ hidden: isModuleHidden('devtools'), enabled: isModuleSwitchedOn('devtools') }))");
    assert.deepEqual(third, { hidden: false, enabled: false });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

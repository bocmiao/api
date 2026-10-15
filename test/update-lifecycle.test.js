// 在临时仓库运行真实 updater/swap；网络由本地 git 生成的官方树与包替代，不接触工作仓库安装目录。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { codeDigest } from '../src/lib/deployment.js';

const tmp = mkdtempSync(join(tmpdir(), 'miao-update-lifecycle-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let seq = 0;
function fixture() {
  const dir = join(tmp, String(seq++)), root = join(dir, 'app');
  mkdirSync(join(root, 'src'), { recursive: true });
  cpSync(fileURLToPath(new URL('../src/lib', import.meta.url)), join(root, 'src/lib'), { recursive: true });
  mkdirSync(join(root, 'public'));
  writeFileSync(join(root, 'public/index.html'), '<!doctype html><title>fixture</title>');
  writeFileSync(join(root, 'package.json'), '{"name":"miao-api","type":"module","version":"0.11.1"}');
  writeFileSync(join(root, '.gitignore'), 'data/\n.update*/\n');
  writeFileSync(join(root, 'src/app.js'), 'export const marker = "old";');
  writeFileSync(join(root, 'src/server.js'), '// fixture, no services');
  writeFileSync(join(root, 'src/launcher.js'), '// fixture, no launcher');
  writeFileSync(join(root, 'CHANGELOG.md'), '## v0.11.1 · 2026-10-13\n- fixture\n');
  writeFileSync(join(root, 'UPDATE_NOTES.json'), '[]');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
  const commit = () => { git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD').toString().trim(); };
  git('init', '-q');
  const oldSha = commit();
  writeFileSync(join(root, 'src/app.js'), 'export const marker = "new";');
  const sha = commit();
  const files = {};
  for (const path of git('ls-tree', '-r', '--name-only', 'HEAD').toString().trim().split('\n')) files[path] = readFileSync(join(root, path)).toString('base64');
  const tree = { truncated: false, tree: Object.entries(files).map(([path, value]) => {
    const data = Buffer.from(value, 'base64');
    return { path, type: 'blob', mode: '100644', size: data.length, sha: createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex') };
  }) };
  writeFileSync(join(dir, 'update.zip'), git('archive', '--format=zip', '--prefix=api/', sha));
  writeFileSync(join(dir, 'update.tar.gz'), git('archive', '--format=tar.gz', '--prefix=api/', sha));
  git('reset', '--hard', oldSha);
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'data/keep.txt'), 'synthetic private data');
  writeFileSync(join(root, '.env'), 'SECRET=synthetic');
  const oldRecord = { schema: 2, version: '0.11.1', sha: oldSha, codeDigest: codeDigest(root), installationId: '11111111-1111-4111-8111-111111111111', updatedAt: '2026-10-13T00:00:00Z' };
  writeFileSync(join(root, 'data/version.json'), JSON.stringify(oldRecord));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ root, oldSha, sha, tree, files, oldRecord }));
  return dir;
}

const worker = String.raw`
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [dir, mode] = process.argv.slice(1);
const meta = JSON.parse(readFileSync(join(dir, 'meta.json')));
process.env.DATA_DIR = join(meta.root, 'data');
process.env.MIAO_LAUNCHER = mode === 'manual' ? '' : '1';
process.env.UPDATE_REPO = 'fixture/api'; process.env.UPDATE_BRANCH = 'Miao-API';
process.env.UPDATE_UPLOAD_VERIFY = mode === 'unverified' ? '0' : '1';
const unknown = ['online-unknown','online-legacy'].includes(mode);
if (unknown) {
  rmSync(join(meta.root,'.git'),{recursive:true,force:true});
  if (mode==='online-unknown') rmSync(join(meta.root,'data/version.json'));
  else writeFileSync(join(meta.root,'data/version.json'),JSON.stringify({version:'0.11.1',sha:meta.oldSha,updatedAt:'2026-10-13T00:00:00Z'}));
}
const u = await import(pathToFileURL(join(meta.root, 'src/lib/updater.js')));
const before = u.versionInfo();
assert.equal(before.runningIdentity.sha, unknown ? null : meta.oldSha);
assert.equal(before.restartNeeded, false);
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes('/commits/')) return Response.json({ sha: meta.sha, commit: { message: 'target\n\n- fixture change', committer: { date: '2026-10-15T10:00:00Z' } } });
  if (url.includes('/compare/')) return Response.json({ status: url.includes(meta.sha+'...Miao-API') ? 'identical' : 'ahead', merge_base_commit:{sha:url.includes(meta.sha+'...Miao-API')?meta.sha:meta.oldSha}, ahead_by: 1, commits: [{ sha: meta.sha, commit: { message: 'target\n\n- fixture change' } }] });
  if (url.includes('/git/trees/')) return Response.json(mode === 'online-full' ? { truncated: true } : meta.tree);
  if (url.includes('/tarball/')) return new Response(readFileSync(join(dir, 'update.tar.gz')));
  const path = url.split('/'+meta.sha+'/')[1];
  if (path && meta.files[path]) return new Response(Buffer.from(meta.files[path], 'base64'));
  throw new Error('Unmocked network: '+url);
};
if (unknown) {
  const check = await u.checkUpdate({maxAgeMs:0});
  assert.equal(check.current.sha,null);
  assert.equal(check.current.updatedAt,null);
  assert.equal(check.hasUpdate,false);
  assert.equal(check.upToDate,false);
  assert.equal(check.comparisonUnknown,true);
  assert.equal(check.canInstall,true, '允许按明确目标重新安装建立身份');
}
if (mode === 'pin-mismatch') {
  await assert.rejects(u.applyUpdate({sha:'f'.repeat(40)}), /远端已有更新/);
  assert.equal(u.versionInfo().diskIdentity.sha, meta.oldSha);
  process.exit(0);
}
let callback;
const start = mode.startsWith('online') ? u.startUpdate({sha:meta.sha}, r=>callback=r) : u.startUploadUpdate(readFileSync(join(dir, 'update.zip')), r=>callback=r);
assert.equal(start.previousInstanceId, before.runningIdentity.instanceId);
for (let i=0; i<1000 && u.updateProgress().state==='running'; i++) await new Promise(r=>setTimeout(r,5));
const progress = u.updateProgress();
assert.equal(progress.state, 'done', JSON.stringify(progress));
assert.ok(callback);
assert.equal(callback.restart, mode !== 'manual');
const installed = callback.version;
assert.equal(progress.target.installationId, installed.installationId);
assert.equal(progress.target.sha, mode==='unverified' ? null : meta.sha);
const oldProcess = u.versionInfo();
assert.equal(oldProcess.runningIdentity.sha, unknown ? null : meta.oldSha);
assert.equal(oldProcess.diskIdentity.sha, mode==='unverified' ? null : meta.sha);
assert.equal(oldProcess.diskIdentity.installationId, installed.installationId);
assert.equal(oldProcess.restartNeeded, true);
assert.equal(oldProcess.health, 'pending');
assert.equal(u.confirmRunningUpdate(), false, '旧进程不得确认新安装');
assert.equal(readFileSync(join(meta.root,'data/keep.txt'),'utf8'),'synthetic private data');
assert.equal(readFileSync(join(meta.root,'.env'),'utf8'),'SECRET=synthetic');
const pending = JSON.parse(readFileSync(join(meta.root,'data/update-pending.json')));
assert.ok(existsSync(pending.backup));
const probe = (confirm) => JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',
  'const u=await import('+JSON.stringify(pathToFileURL(join(meta.root,'src/lib/updater.js')).href)+'); console.log(JSON.stringify({before:u.versionInfo(),confirmed:'+ (confirm?'u.confirmRunningUpdate()':'false') +',after:u.versionInfo()}));'
], {cwd:meta.root, env:process.env, encoding:'utf8'}));
if (mode === 'legacy-pending') {
  // 模拟旧更新器首次装入新代码：记录没有指纹，保留的 .git 仍是旧提交。
  writeFileSync(join(meta.root,'data/version.json'), JSON.stringify({version:'0.11.1',sha:meta.sha,updatedAt:installed.updatedAt}));
  delete pending.installationId;
  writeFileSync(join(meta.root,'data/update-pending.json'), JSON.stringify(pending));
  const fresh = probe(true);
  assert.equal(fresh.before.runningIdentity.sha, null, '旧记录不能用来冒认提交');
  assert.equal(fresh.before.runningIdentity.installationId, null);
  assert.equal(fresh.confirmed, true, '兼容旧安装的启动观察标记，避免永久待确认');
  assert.equal(fresh.after.health, 'confirmed');
} else if (mode === 'rollback') {
  const {rollbackPending} = await import(pathToFileURL(join(meta.root,'src/lib/swap.js')));
  assert.equal(rollbackPending(), true);
  const restored = probe(false).before;
  assert.equal(restored.runningIdentity.sha, meta.oldSha);
  assert.equal(restored.diskIdentity.sha, meta.oldSha);
  assert.equal(restored.lastRollback.failedInstallationId, installed.installationId);
  assert.equal(restored.lastRollback.failedSha, meta.sha);
} else if (mode === 'overwrite') {
  writeFileSync(join(meta.root,'src/app.js'),'export const marker = "manual";');
  const changed = probe(true);
  assert.equal(changed.before.runningIdentity.sha, null);
  assert.equal(changed.confirmed, false);
  assert.equal(changed.after.health, 'pending');
} else {
  const fresh = probe(true);
  assert.notEqual(fresh.before.runningIdentity.instanceId, before.runningIdentity.instanceId);
  assert.equal(fresh.before.runningIdentity.installationId, installed.installationId);
  assert.equal(fresh.before.runningIdentity.codeDigest, installed.codeDigest);
  assert.equal(fresh.before.runningIdentity.sha, mode==='unverified' ? null : meta.sha);
  assert.equal(fresh.before.health, 'pending');
  assert.equal(fresh.confirmed, true);
  assert.equal(fresh.after.health, 'confirmed');
  assert.equal(fresh.after.restartNeeded, false);
}
console.log(JSON.stringify({mode, old:meta.oldSha, target:meta.sha, installationId:installed.installationId}));
`;

for (const [mode, title] of [
  ['online', '在线增量更新'], ['online-full', '在线完整更新'], ['upload', '已核验上传'],
  ['online-unknown', '无 Git 的未知手动部署不会宣称最新，允许重新安装'],
  ['online-legacy', '无 Git 的同版本旧记录不能冒认 SHA，允许重新安装'],
  ['unverified', '关闭官方核验的上传仍可核对安装指纹，但不冒认 SHA'],
  ['manual', '手动启动安装仍待重启'], ['rollback', '同版本新代码失败回滚'],
  ['legacy-pending', '旧更新器首次安装保持未知身份且兼容健康标记'],
  ['overwrite', '安装后再次手动覆盖不能确认目标'], ['pin-mismatch', '在线目标改变时拒绝安装'],
]) test(`真实更新流程：${title}`, () => {
  const dir = fixture();
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', worker, dir, mode], {
    cwd: join(dir, 'app'), encoding: 'utf8', timeout: 20000, maxBuffer: 2*1024*1024,
    env: { ...process.env, NODE_ENV: 'test', DB_FILE: ':memory:', GITHUB_TOKEN: '', UPDATE_MIRROR: '' },
  });
  if (mode !== 'pin-mismatch') assert.equal(JSON.parse(output.trim()).mode, mode);
});

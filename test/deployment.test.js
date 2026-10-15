import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codeDigest, diskIdentity, captureRunningIdentity, restartState } from '../src/lib/deployment.js';

const tmp = mkdtempSync(join(tmpdir(), 'miao-identity-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let seq = 0;
const makeRoot = () => {
  const root = join(tmp, String(seq++));
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), '{"version":"0.11.1"}');
  writeFileSync(join(root, 'app.js'), 'old');
  return root;
};
const recordFor = (root, sha = 'a'.repeat(40)) => ({ schema: 2, version: '0.11.1', sha,
  codeDigest: codeDigest(root), installationId: '11111111-1111-4111-8111-111111111111',
  updatedAt: '2026-10-15T16:00:00Z', commitDate: '2026-10-13T10:00:00Z' });

test('相同语义版本与 SHA：运行身份固定，安装/提交时间分别保留', () => {
  const root = makeRoot(), record = recordFor(root);
  const running = captureRunningIdentity({ root, record });
  const disk = diskIdentity({ root, record });
  assert.equal(running.sha, record.sha);
  assert.equal(disk.installedAt, record.updatedAt);
  assert.equal(disk.commitDate, record.commitDate);
  assert.deepEqual(restartState(running, disk), { restartNeeded: false, restartUnknown: false });
  assert.ok(Object.isFrozen(running));
});

test('同版本不同 SHA 安装后，旧进程身份不变且必须重启', () => {
  const root = makeRoot(), old = recordFor(root);
  const running = captureRunningIdentity({ root, record: old });
  writeFileSync(join(root, 'app.js'), 'new');
  const next = { ...recordFor(root, 'b'.repeat(40)), installationId: '22222222-2222-4222-8222-222222222222' };
  const disk = diskIdentity({ root, record: next });
  assert.equal(disk.version, running.version);
  assert.notEqual(disk.sha, running.sha);
  assert.equal(restartState(running, disk).restartNeeded, true);
  const restarted = captureRunningIdentity({ root, record: next });
  assert.notEqual(restarted.instanceId, running.instanceId);
  assert.equal(restarted.sha, next.sha);
  assert.equal(restartState(restarted, disk).restartNeeded, false);
});

test('手动覆盖相同版本代码：旧 SHA、安装编号和安装时间失效，指纹仍检测到需重启', () => {
  const root = makeRoot(), record = recordFor(root);
  const running = captureRunningIdentity({ root, record });
  writeFileSync(join(root, 'app.js'), 'new'); // 与旧文件等长，不依赖大小和修改时间
  const disk = diskIdentity({ root, record });
  assert.equal(disk.sha, null);
  assert.equal(disk.installationId, null);
  assert.equal(disk.installedAt, null);
  assert.equal(restartState(running, disk).restartNeeded, true);
});

test('未知手动部署及同版本旧记录不能证明提交身份', () => {
  const root = makeRoot();
  for (const record of [null, { version: '0.11.1', sha: 'a'.repeat(40), updatedAt: '2026-10-13' },
    { sha: 'a'.repeat(40) }, { ...recordFor(root), version: '0.10.0' }, { ...recordFor(root), codeDigest: 'stale' }]) {
    const disk = diskIdentity({ root, record });
    assert.equal(disk.sha, null);
    assert.equal(disk.installedAt, null);
    assert.ok(disk.codeDigest);
  }
});

test('保留的数据、密钥、备份、Git 元数据不影响代码指纹；新增程序文件会使记录失效', () => {
  const root = makeRoot(), record = recordFor(root);
  for (const dir of ['data', '.update-backup', '.git', 'node_modules']) {
    mkdirSync(join(root, dir)); writeFileSync(join(root, dir, 'private'), 'synthetic secret');
  }
  writeFileSync(join(root, '.env'), 'SECRET=synthetic');
  assert.equal(codeDigest(root), record.codeDigest);
  writeFileSync(join(root, 'extra.js'), '// extra');
  assert.equal(diskIdentity({ root, record }).sha, null);
});

test('Git 身份需逐文件匹配，保留旧 HEAD、增加文件或符号链接都不能冒认', () => {
  const root = makeRoot();
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  const sha = git('rev-parse', 'HEAD');
  assert.equal(diskIdentity({ root, record: null }).sha, sha);
  writeFileSync(join(root, 'app.js'), 'new');
  assert.equal(diskIdentity({ root, record: null }).sha, null);
  writeFileSync(join(root, 'app.js'), 'old');
  writeFileSync(join(root, 'extra.js'), '//');
  assert.equal(diskIdentity({ root, record: null }).sha, null);
  rmSync(join(root, 'extra.js'));
  symlinkSync(join(root, 'app.js'), join(root, 'link.js'));
  assert.equal(diskIdentity({ root, record: null }).codeDigest, null);
  assert.equal(restartState(captureRunningIdentity({ root, record: null }), diskIdentity({ root, record: null })).restartUnknown, true);
});

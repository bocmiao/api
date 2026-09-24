import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'miao-update-'));
process.env.DATA_DIR = join(tmp, 'data');
after(() => rmSync(tmp, { recursive: true, force: true }));

const { extractTar } = await import('../src/lib/tar.js');
const { unpackTo, checkUpdate } = await import('../src/lib/updater.js');
const { swapIn, writePending, readPending, rollbackPending } = await import('../src/lib/swap.js');

// 构造 GitHub 风格的 tar.gz：pax 全局头带提交 SHA，所有文件位于 "owner-repo-sha/" 之下
function header(name, size, type) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write('0000644\0', 100);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  return h;
}
const pad = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = body.length;
  len += String(len + String(len).length).length;
  return `${len}${body}`;
}
function makeTarGz(files, { sha = 'abc1234', prefix = 'bocmiao-api-abc1234/' } = {}) {
  const parts = [];
  const pax = Buffer.from(paxRecord('comment', sha));
  parts.push(header('pax_global_header', pax.length, 'g'), pad(pax));
  parts.push(header(prefix, 0, '5'));
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    parts.push(header(prefix + name, data.length, '0'), pad(data));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

test('解析 tar：读出文件内容和提交 SHA', async () => {
  const { gunzipSync } = await import('node:zlib');
  const { entries, comment } = extractTar(gunzipSync(makeTarGz({ 'a.txt': 'hello', 'src/b.js': 'x' }, { sha: 'deadbeef' })));
  assert.equal(comment, 'deadbeef');
  const a = entries.find((e) => e.path.endsWith('a.txt'));
  assert.equal(a.data.toString(), 'hello');
  assert.ok(entries.some((e) => e.path.endsWith('src/b.js')));
});

test('解包：去掉顶层目录，跳过 data 与 .env，拒绝越界路径', () => {
  const dest = join(tmp, 'stage1');
  const { files, sha } = unpackTo(makeTarGz({
    'package.json': '{}', 'src/server.js': '//', 'data/miao-api.db': 'X', '.env': 'SECRET=1',
  }), dest);
  assert.equal(sha, 'abc1234');
  assert.equal(files, 2);
  assert.ok(existsSync(join(dest, 'src/server.js')));
  assert.ok(!existsSync(join(dest, 'data')));
  assert.ok(!existsSync(join(dest, '.env')));

  assert.throws(() => unpackTo(makeTarGz({ '../../evil.js': 'x' }), join(tmp, 'stage2')), /非法路径/);
  assert.throws(() => unpackTo(makeTarGz({ 'src/../../evil.js': 'x' }), join(tmp, 'stage3')), /非法路径/);
  assert.throws(() => unpackTo(Buffer.from('not gzip'), join(tmp, 'stage4')), /解压失败/);
});

function makeRoot(name, files) {
  const root = join(tmp, name);
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(root, f, '..'), { recursive: true });
    writeFileSync(join(root, f), c);
  }
  return root;
}

test('替换：旧代码进备份，新代码就位，data 与 .env 保持不动；可回滚', () => {
  const root = makeRoot('root', { 'src/server.js': 'old', 'old-only.txt': 'x', 'data/db': 'keep', '.env': 'A=1' });
  const staging = makeRoot('staging', { 'src/server.js': 'new', 'README.md': 'r' });
  const backup = join(tmp, 'backup1');

  swapIn(backup, { root, staging });
  assert.equal(readFileSync(join(root, 'src/server.js'), 'utf8'), 'new');
  assert.ok(existsSync(join(root, 'README.md')));
  assert.ok(!existsSync(join(root, 'old-only.txt')), '上游删除的文件不再保留');
  assert.equal(readFileSync(join(root, 'data/db'), 'utf8'), 'keep');
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'A=1');
  assert.equal(readFileSync(join(backup, 'src/server.js'), 'utf8'), 'old');

  writePending({ backup, sha: 'new', previousVersion: { sha: 'old' } });
  assert.ok(readPending());
  assert.equal(rollbackPending({ root }), true);
  assert.equal(readFileSync(join(root, 'src/server.js'), 'utf8'), 'old');
  assert.ok(existsSync(join(root, 'old-only.txt')));
  assert.equal(readFileSync(join(root, 'data/db'), 'utf8'), 'keep');
  assert.equal(readPending(), null);
  assert.equal(JSON.parse(readFileSync(join(process.env.DATA_DIR, 'version.json'), 'utf8')).sha, 'old');
  assert.equal(JSON.parse(readFileSync(join(process.env.DATA_DIR, 'update-rollback.json'), 'utf8')).failedSha, 'new');
});

test('替换中途失败时恢复原样', () => {
  const root = makeRoot('root2', { 'src/a.js': 'old' });
  const backup = join(tmp, 'backup2');
  assert.throws(() => swapIn(backup, { root, staging: join(tmp, 'no-such-staging') }));
  assert.equal(readFileSync(join(root, 'src/a.js'), 'utf8'), 'old');
});

function mockGitHub({ version, changelog, sha = 'ccc3333' }) {
  const commit = (h, msg) => ({ sha: h, commit: { message: `${msg}\n\n详细说明`, author: { name: 'bocmiao', date: '2026-09-25T10:00:00Z' }, committer: { date: '2026-09-25T10:00:00Z' } } });
  mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    if (u.endsWith('/repos/bocmiao/api')) return Response.json({ default_branch: 'Miao-API' });
    if (u.includes('/commits/Miao-API')) return Response.json(commit(sha, 'Latest'));
    if (u.includes('/contents/package.json')) return new Response(JSON.stringify({ version }));
    if (u.includes('/contents/CHANGELOG.md')) return changelog == null ? new Response('', { status: 404 }) : new Response(changelog);
    if (u.includes('/compare/')) return Response.json({ ahead_by: 1, commits: [commit(sha, 'Latest')] });
    return new Response('', { status: 404 });
  });
}

const CHANGELOG = `# 更新日志

## v9.1.0 · 2099-01-02
- 新功能 B
- 修复 C

## v9.0.0 · 2099-01-01
- 新功能 A

## v0.1.0 · 2026-09-24
- 首个版本
`;

test('版本号与更新日志解析', async () => {
  const { compareVersions, parseChangelog } = await import('../src/lib/updater.js');
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('v1.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.2.0', '0.3.0'), -1);
  const log = parseChangelog(CHANGELOG);
  assert.deepEqual(log.map((e) => e.version), ['9.1.0', '9.0.0', '0.1.0']);
  assert.equal(log[0].date, '2099-01-02');
  assert.deepEqual(log[0].items, ['新功能 B', '修复 C']);
});

test('检查更新：远端版本更高时列出之间所有版本的中文更新内容', async () => {
  rmSync(join(process.env.DATA_DIR, 'update-rollback.json'), { force: true });
  rmSync(join(process.env.DATA_DIR, 'version.json'), { force: true });
  mockGitHub({ version: '9.1.0', changelog: CHANGELOG });
  const u = await checkUpdate();
  mock.restoreAll();
  assert.equal(u.branch, 'Miao-API');
  assert.ok(u.current.version, '当前版本从本地 package.json 读取，不再是未知');
  assert.equal(u.latest.version, '9.1.0');
  assert.equal(u.hasUpdate, true);
  assert.equal(u.remoteOlder, false);
  assert.deepEqual(u.changes.map((e) => e.version), ['9.1.0', '9.0.0']);
});

test('检查更新：仓库中的版本比当前旧时不提示更新', async () => {
  mockGitHub({ version: '0.0.1', changelog: CHANGELOG });
  const u = await checkUpdate();
  mock.restoreAll();
  assert.equal(u.hasUpdate, false);
  assert.equal(u.remoteOlder, true);
  assert.deepEqual(u.changes, []);
});

test('检查更新：版本号相同但代码不同视为小修复', async () => {
  const { localVersion } = await import('../src/lib/updater.js');
  writeFileSync(join(process.env.DATA_DIR, 'version.json'), JSON.stringify({ sha: 'aaa1111' }));
  mockGitHub({ version: localVersion(), changelog: null, sha: 'bbb2222' });
  const u = await checkUpdate();
  mock.restoreAll();
  assert.equal(u.hasUpdate, true);
  assert.equal(u.patch, true);
  assert.equal(u.commits.length, 1);
});

test('GitHub 不可达时给出明确错误', async () => {
  mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(checkUpdate(), /无法连接 GitHub/);
  mock.restoreAll();
});

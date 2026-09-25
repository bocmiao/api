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
const { unpackTo, checkUpdate, verifyAgainstGitHub, mirrorUrl, buildStagingIncremental, makeFileFetcher, fileSources } = await import('../src/lib/updater.js');
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
    if (u.includes('/contents/package.json') || u.endsWith('/package.json')) return new Response(JSON.stringify({ version }));
    if (u.includes('/contents/CHANGELOG.md') || u.endsWith('/CHANGELOG.md')) return changelog == null ? new Response('', { status: 404 }) : new Response(changelog);
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
  const u = await checkUpdate({ maxAgeMs: 0 });
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
  const u = await checkUpdate({ maxAgeMs: 0 });
  mock.restoreAll();
  assert.equal(u.hasUpdate, false);
  assert.equal(u.remoteOlder, true);
  assert.deepEqual(u.changes, []);
});

test('检查更新：版本号相同但代码不同视为小修复', async () => {
  const { localVersion } = await import('../src/lib/updater.js');
  writeFileSync(join(process.env.DATA_DIR, 'version.json'), JSON.stringify({ sha: 'aaa1111' }));
  mockGitHub({ version: localVersion(), changelog: null, sha: 'bbb2222' });
  const u = await checkUpdate({ maxAgeMs: 0 });
  mock.restoreAll();
  assert.equal(u.hasUpdate, true);
  assert.equal(u.patch, true);
  assert.equal(u.commits.length, 1);
});

test('GitHub 不可达时给出明确错误', async () => {
  mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(checkUpdate({ maxAgeMs: 0 }), /无法连接 GitHub/);
  mock.restoreAll();
});

test('加速下载：地址拼接，并逐个文件核对 GitHub 官方指纹', async () => {
  assert.equal(mirrorUrl('https://ghfast.top/', 'bocmiao/api', 'abc'), 'https://ghfast.top/https://github.com/bocmiao/api/archive/abc.tar.gz');
  const { createHash } = await import('node:crypto');
  const blob = (t) => createHash('sha1').update(`blob ${Buffer.byteLength(t)}\0${t}`).digest('hex');
  const files = { 'a.txt': 'hello', 'src/b.js': 'x' };
  const tree = { truncated: false, tree: [
    { path: 'a.txt', type: 'blob', mode: '100644', sha: blob('hello') },
    { path: 'src', type: 'tree', mode: '040000', sha: 't' },
    { path: 'src/b.js', type: 'blob', mode: '100644', sha: blob('x') },
  ] };
  const fetchTree = async () => tree;
  await verifyAgainstGitHub(makeTarGz(files), 'bocmiao/api', 'abc', fetchTree);
  await assert.rejects(verifyAgainstGitHub(makeTarGz({ ...files, 'src/b.js': 'evil' }), 'r', 's', fetchTree), /不一致（src\/b\.js）/);
  await assert.rejects(verifyAgainstGitHub(makeTarGz({ 'a.txt': 'hello' }), 'r', 's', fetchTree), /缺少文件 src\/b\.js/);
  await assert.rejects(verifyAgainstGitHub(makeTarGz({ ...files, 'extra.js': '1' }), 'r', 's', fetchTree), /不一致（extra\.js）/);
  await assert.rejects(verifyAgainstGitHub(makeTarGz(files), 'r', 's', async () => ({ truncated: true, tree: [] })), /无法从 GitHub 获取文件清单/);
});

test('检查结果缓存 1 分钟；文件优先从 raw.githubusercontent.com 读取；次数用完时提示 Token 与恢复时间', async () => {
  mockGitHub({ version: '9.1.0', changelog: CHANGELOG });
  await checkUpdate({ maxAgeMs: 0 });
  const calls = globalThis.fetch.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(calls.some((u) => u.startsWith('https://raw.githubusercontent.com/bocmiao/api/ccc3333/package.json')));
  assert.ok(!calls.some((u) => u.includes('/contents/')), '公开仓库不走 contents 接口');
  const n = globalThis.fetch.mock.callCount();
  await checkUpdate();
  assert.equal(globalThis.fetch.mock.callCount(), n, '1 分钟内复用上次结果');
  mock.restoreAll();

  const token = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    mock.method(globalThis, 'fetch', async () => new Response('', { status: 403, headers: { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) } }));
    await assert.rejects(checkUpdate({ maxAgeMs: 0 }), /每小时只有 60 次.*分钟后恢复.*GitHub Token/);
  } finally {
    mock.restoreAll();
    if (token != null) process.env.GITHUB_TOKEN = token;
  }
});

test('手动上传了新代码后，旧的版本记录不再用来判断「小修复」', async () => {
  const { localVersion } = await import('../src/lib/updater.js');
  writeFileSync(join(process.env.DATA_DIR, 'version.json'), JSON.stringify({ version: '0.0.1', sha: 'aaa1111', updatedAt: '2026-01-01T00:00:00Z' }));
  mockGitHub({ version: localVersion(), changelog: null, sha: 'bbb2222' });
  const u = await checkUpdate({ maxAgeMs: 0 });
  mock.restoreAll();
  assert.equal(u.current.sha, null);
  assert.equal(u.hasUpdate, false, '版本号相同且无法确认提交时视为已是最新');
  assert.ok(u.current.running, '带上正在运行的版本');
});

test('增量更新：没变的文件复用本地，只下载改动的文件并核对指纹，删除的文件不带入', async () => {
  const { createHash } = await import('node:crypto');
  const blob = (t) => createHash('sha1').update(`blob ${Buffer.byteLength(t)}\0${t}`).digest('hex');
  const root = makeRoot('inc-root', { 'package.json': '{"version":"1"}', 'src/a.js': 'same', 'src/old.js': 'removed', 'big.json': 'x'.repeat(1000) });
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'db.sqlite'), 'keep');
  const next = { 'package.json': '{"version":"2"}', 'src/a.js': 'same', 'src/new.js': 'added', 'big.json': 'x'.repeat(1000) };
  const tree = { truncated: false, tree: Object.entries(next).map(([path, t]) => ({ path, type: 'blob', mode: '100644', sha: blob(t), size: Buffer.byteLength(t) })) };
  const fetched = [];
  const staging = join(tmp, 'inc-staging');
  const progress = [];
  const r = await buildStagingIncremental({ repo: 'o/r' }, 'sha', (...a) => progress.push(a), {
    root, staging, fetchTree: async () => tree,
    fetchFile: async (path) => { fetched.push(path); return Buffer.from(next[path]); },
  });
  assert.deepEqual(fetched.sort(), ['package.json', 'src/new.js']);
  assert.deepEqual([r.files, r.downloaded, r.reused], [4, 2, 2]);
  assert.equal(readFileSync(join(staging, 'package.json'), 'utf8'), '{"version":"2"}');
  assert.equal(readFileSync(join(staging, 'big.json'), 'utf8'), 'x'.repeat(1000));
  assert.ok(!existsSync(join(staging, 'src/old.js')), '新版本删掉的文件不带入');
  assert.ok(!existsSync(join(staging, 'data')), 'data 等保留目录不进入临时目录');
  assert.deepEqual(progress.at(-1), [2, 2, 2]);

  // 下载内容被篡改 → 拒绝
  await assert.rejects(buildStagingIncremental({ repo: 'o/r' }, 'sha', null, {
    root, staging, fetchTree: async () => tree, fetchFile: async () => Buffer.from('evil'),
  }), /与 GitHub 官方不一致/);
  // 清单被截断或改动太多 → 返回 null，改用整包
  assert.equal(await buildStagingIncremental({ repo: 'o/r' }, 'sha', null, { root, staging, fetchTree: async () => ({ truncated: true, tree: [] }) }), null);
  const allNew = { truncated: false, tree: Object.keys(next).map((path) => ({ path, type: 'blob', mode: '100644', sha: blob(`new-${path}`), size: 1000 })) };
  assert.equal(await buildStagingIncremental({ repo: 'o/r' }, 'sha', null, { root, staging, fetchTree: async () => allNew, fetchFile: async () => Buffer.from('') }), null);
});

test('增量下载来源：国内连不上的来源只试一次，之后的文件直接用能用的来源', async () => {
  const cfg = { repo: 'o/r', token: '', mirror: 'https://ghfast.top/' };
  assert.deepEqual(fileSources(cfg, 's').map((x) => x.name), ['加速地址', 'jsDelivr', 'raw.githubusercontent.com', 'GitHub 接口']);
  assert.equal(fileSources(cfg, 's')[0].url('src/a b.js'), 'https://ghfast.top/https://raw.githubusercontent.com/o/r/s/src/a%20b.js');
  assert.ok(!fileSources({ ...cfg, token: 't' }, 's').some((x) => x.name === 'jsDelivr'), '私有仓库不走 jsDelivr');

  const hits = [];
  mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    hits.push(u);
    if (u.startsWith('https://dead.example')) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (u.startsWith('https://miss.example')) return new Response('', { status: 404 });
    return new Response(`data:${u.split('/').pop()}`);
  });
  const sources = [
    { name: 'dead', url: (p) => `https://dead.example/${p}` },
    { name: 'miss', url: (p) => `https://miss.example/${p}` },
    { name: 'ok', url: (p) => `https://ok.example/${p}` },
  ];
  const used = [];
  const get = makeFileFetcher({ repo: 'o/r' }, 's', { sources, onSource: (n) => used.push(n) });
  assert.equal((await get('a.js')).toString(), 'data:a.js');
  assert.equal((await get('b.js')).toString(), 'data:b.js');
  assert.deepEqual(used, ['ok', 'ok']);
  assert.equal(hits.filter((u) => u.startsWith('https://dead.example')).length, 1, '连不上的来源只尝试一次');
  assert.equal(hits.filter((u) => u.startsWith('https://miss.example')).length, 2, '404 不算连不上，下个文件仍会尝试');

  const none = makeFileFetcher({ repo: 'o/r' }, 's', { sources: sources.slice(0, 2) });
  await assert.rejects(none('c.js'), /下载 c\.js 失败（dead：ECONNREFUSED；miss：HTTP 404）/);
  mock.restoreAll();
});

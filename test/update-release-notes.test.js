import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseChangelog, parseUpdateNotes, compareVersions } from '../src/lib/updater.js';
import { releaseFiles, legacyReleaseCheck } from './helpers/update-release.js';

test('发布元数据一致，保留中文功能说明和升级边界', () => {
  const files = releaseFiles();
  const pkg = JSON.parse(files['package.json']);
  const entry = parseChangelog(files['CHANGELOG.md'])[0];
  assert.equal(compareVersions(pkg.version, '0.13.0'), 1);
  assert.equal(entry.version, pkg.version);
  assert.equal(compareVersions(pkg.version, '0.11.1'), 1);
  assert.ok(entry.items.length > 0);
  const text = parseChangelog(files['CHANGELOG.md']).find((e) => e.version === '0.13.0').items.join('\n');
  for (const re of [/默认/, /本地/, /provider=jinrishici/, /provider=hitokoto/, /fallback=true/, /mode=offline/, /404/, /2023-12/, /129个模块/, /204个调用地址/]) assert.match(text, re);
  const previous = parseChangelog(files['CHANGELOG.md']).find((e) => e.version === '0.12.0').items.join('\n');
  for (const re of [/60 秒简报/, /首次导入/, /503/, /404/, /全自动发现/, /账号 ID\/Key ID/]) assert.match(previous, re);
  assert.doesNotMatch(text, /Git blob|ahead\/identical|launcher|Chromium|node --test|20 秒/);
  for (const name of ['package-lock.json', 'npm-shrinkwrap.json']) {
    const file = new URL('../' + name, import.meta.url);
    if (existsSync(file)) {
      const lock = JSON.parse(readFileSync(file, 'utf8'));
      if (lock.version) assert.equal(lock.version, pkg.version);
      if (lock.packages?.['']) assert.equal(lock.packages[''].version, pkg.version);
    }
  }
});

test('四个说明映射到真实功能/修复提交，保留提交当时版本并去除技术验收日志', () => {
  const notes = parseUpdateNotes(releaseFiles()['UPDATE_NOTES.json']);
  assert.equal(new Set(notes.map((n) => n.sha)).size, notes.length);
  const get = (prefix) => notes.find((n) => n.sha.startsWith(prefix));
  for (const prefix of ['b92ad7c', 'd5db3e9', '6be54ee', '9a20a6d']) {
    assert.equal(get(prefix).version, '0.11.1', '映射保留原提交实际版本，v0.12.0由新CHANGELOG汇总');
    assert.doesNotMatch(get(prefix).items.join('\n'), /Git blob|ahead\/identical|launcher|Chromium|node --test|20 秒/);
  }
  assert.match(get('9a20a6d').items.join('\n'), /首次导入/);
  assert.match(get('9a20a6d').items.join('\n'), /503/);
  assert.match(get('9a20a6d').items.join('\n'), /全自动发现尚未完成/);
  assert.match(get('6be54ee').items.join('\n'), /账号 ID 或 Key ID/);
});

test('历史v0.11.1真实解析函数读取新日志，显示新功能版本而非同版本修复', async () => {
  const { result, requests } = await legacyReleaseCheck();
  assert.equal(result.current.version, '0.11.1');
  assert.equal(result.latest.version, JSON.parse(releaseFiles()['package.json']).version);
  assert.equal(result.hasUpdate, true);
  assert.equal(result.patch, false);
  assert.deepEqual(result.changes.map((c) => c.version), parseChangelog(releaseFiles()['CHANGELOG.md']).filter((e) => compareVersions(e.version, '0.11.1') > 0).map((e) => e.version));
  const visible = result.changes.flatMap((c) => c.items).join('\n');
  assert.match(visible, /60 秒简报/);
  assert.match(visible, /内部测试/);
  assert.match(visible, /首次导入/);
  assert.match(visible, /503/);
  assert.doesNotMatch(visible, /Git blob|ahead\/identical|launcher/);
  assert.equal(requests.length, 2, '仅运行本地模拟的只读提交和比较请求');
});

test('旧版同版本回退路径也能使用新映射，补回无正文/普通段落功能说明', async () => {
  const { result } = await legacyReleaseCheck({ sameVersion: true });
  assert.equal(result.patch, true);
  assert.deepEqual(result.changes, []);
  const notes = result.commits.flatMap((c) => c.notes).join('\n');
  assert.match(notes, /60 秒简报/);
  assert.match(notes, /内部测试/);
  assert.match(notes, /首次导入/);
  assert.doesNotMatch(notes, /SHA Git blob|technical fixture/);
});

test('历史解析夹具来自固定提交，验收不依赖线上SHA或安装版本', () => {
  const bytes = readFileSync(new URL('./fixtures/update-v0.11.1-reader.txt', import.meta.url));
  assert.match(bytes.toString('utf8'), /2f0ded7d62e6c5ec923055812d0a7a041924d7f7/);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '0aa5c9467d8ff0391845766a9fce862dabaede52d0b991b528c73b15b7fc83d7');
});


test('票房恢复有中文发布说明与原始无正文提交映射', () => {
  const files = releaseFiles();
  const note = parseChangelog(files['CHANGELOG.md']).find((e) => e.version === '0.13.1');
  assert.ok(note);
  for (const re of [/票房/, /万元/, /空榜/, /502/, /验证码/]) assert.match(note.items.join('\n'), re);
  const mapped = parseUpdateNotes(files['UPDATE_NOTES.json']).find((e) => e.sha.startsWith('6f64019'));
  assert.match(mapped.items.join('\n'), /恢复猫眼实时票房/);
});


test('重试发布说明明确显式启用、总预算、取消与限流边界', () => {
  const files = releaseFiles();
  const note = parseChangelog(files['CHANGELOG.md']).find((e) => e.version === '0.13.2');
  assert.ok(note);
  for (const re of [/显式/, /未知GET默认不重试/, /总超时预算/, /取消/, /Retry-After/, /无需/]) assert.match(note.items.join('\n'), re);
  for (const prefix of ['5e11cb7', 'abeac6d']) assert.ok(parseUpdateNotes(files['UPDATE_NOTES.json']).some((e) => e.sha.startsWith(prefix)));
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { deflateRawSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { unpackUpload } = await import('../src/lib/updater.js');
const { extractZip } = await import('../src/lib/zip.js');
const { handle } = await import('../src/app.js');

const tmp = mkdtempSync(join(tmpdir(), 'miao-upload-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

// 最小 zip 生成（deflate），用来构造各种情况
function makeZip(files) {
  const locals = [];
  const cens = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const comp = deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(8, 8); loc.writeUInt32LE(comp.length, 18); loc.writeUInt32LE(data.length, 22); loc.writeUInt16LE(nameBuf.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(0x800, 8); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    locals.push(loc, nameBuf, comp);
    cens.push(cen, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cenBuf = Buffer.concat(cens);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cenBuf, end]);
}

test('解开 git/GitHub 生成的真实 zip：内容与仓库一致，去掉顶层目录', () => {
  const zip = execFileSync('git', ['archive', '--format=zip', '--prefix=api-Miao-API/', 'HEAD'], { maxBuffer: 100 * 1024 * 1024 });
  const dest = join(tmp, 'real');
  const files = unpackUpload(zip, dest);
  const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD']).toString().trim().split('\n');
  assert.equal(files, tracked.length);
  for (const f of ['package.json', 'src/app.js', 'src/apis/life/data/ip2region_v4.xdb']) {
    assert.deepEqual(readFileSync(join(dest, f)), execFileSync('git', ['show', `HEAD:${f}`], { maxBuffer: 50 * 1024 * 1024 }), f);
  }
});

test('zip：拒绝越界路径、跳过 data 与 .env；没有顶层目录的也能处理', () => {
  assert.throws(() => unpackUpload(makeZip({ 'x/../../evil.js': '1' }), join(tmp, 'e1')), /非法路径/);
  const dest = join(tmp, 'e2');
  unpackUpload(makeZip({ 'repo/package.json': '{}', 'repo/data/db.sqlite': 'x', 'repo/.env': 'SECRET=1' }), dest);
  assert.ok(existsSync(join(dest, 'package.json')));
  assert.ok(!existsSync(join(dest, 'data')) && !existsSync(join(dest, '.env')));
  const flat = join(tmp, 'e3');
  unpackUpload(makeZip({ 'package.json': '{}', 'src/app.js': '1' }), flat);
  assert.ok(existsSync(join(flat, 'src/app.js')), '直接压缩代码（没有外层目录）也能识别');
  assert.throws(() => unpackUpload(Buffer.from('hello world'), join(tmp, 'e4')), /只支持 \.zip 或 \.tar\.gz/);
  assert.throws(() => extractZip(Buffer.from('PK\x03\x04garbage')), /不是有效的 zip/);
});

let server, base;
before(async () => {
  server = createServer(handle).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('上传接口：必须管理员、本站页面发出、二进制格式', async () => {
  const post = (headers) => fetch(`${base}/admin/update/upload`, { method: 'POST', headers, body: Buffer.from('x') }).then((r) => r.status);
  assert.equal(await post({ 'content-type': 'application/octet-stream' }), 403, '没有 Origin');
  assert.equal(await post({ 'content-type': 'application/octet-stream', origin: 'https://evil.example' }), 403, '跨站');
  assert.equal(await post({ 'content-type': 'application/json', origin: base }), 415);
  assert.equal(await post({ 'content-type': 'application/octet-stream', origin: base }), 403, '未登录');
  const big = await fetch(`${base}/admin/update/upload`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', origin: base, 'content-length': String(70 * 1024 * 1024) }, body: Buffer.alloc(10) }).catch(() => null);
  assert.ok(!big || [403, 413].includes(big.status));
});

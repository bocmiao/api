import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { deflateRawSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { unpackUpload, verifyUploadOfficial } = await import('../src/lib/updater.js');
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
  const { files, sha } = unpackUpload(zip, dest);
  assert.equal(sha, execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(), 'zip 注释里带提交 SHA');
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

test('核对官方代码：必须是本仓库分支上的提交，且每个文件都与 GitHub 一致', async () => {
  const zip = execFileSync('git', ['archive', '--format=zip', '--prefix=api-x/', 'HEAD'], { maxBuffer: 100 * 1024 * 1024 });
  const { entries, sha } = unpackUpload(zip, join(tmp, 'v'));
  // 用本地 git 生成与 GitHub 相同的文件清单
  const tree = { truncated: false, tree: execFileSync('git', ['ls-tree', '-r', 'HEAD']).toString().trim().split('\n').map((l) => {
    const [meta, path] = l.split('\t'); const [mode, type, blob] = meta.split(' ');
    return { path, mode, type, sha: blob };
  }) };
  const fakeGh = (status) => async (p) => {
    if (p.endsWith('/repos/bocmiao/api')) return { default_branch: 'Miao-API' };
    if (p.includes('/compare/')) return { status, merge_base_commit: { sha } };
    if (p.includes('/git/trees/')) return tree;
    throw new Error('unexpected ' + p);
  };
  await verifyUploadOfficial(entries, sha, { gh: fakeGh('identical') });
  await verifyUploadOfficial(entries, sha, { gh: fakeGh('ahead') }); // HEAD（配置分支）领先上传 SHA
  await assert.rejects(verifyUploadOfficial(entries, sha, { gh: fakeGh('behind') }), /不是 .* 分支上的代码/);
  await assert.rejects(verifyUploadOfficial(entries, sha, { gh: fakeGh('diverged') }), /不是 .* 分支上的代码/);
  await assert.rejects(verifyUploadOfficial(entries, null, { gh: fakeGh('identical') }), /没有 GitHub 提交记录/);
  const tampered = entries.map((e) => (e.path.endsWith('src/app.js') ? { ...e, data: Buffer.from('evil') } : e));
  await assert.rejects(verifyUploadOfficial(tampered, sha, { gh: fakeGh('identical') }), /与 GitHub 官方不一致（src\/app\.js）/);
  await assert.rejects(verifyUploadOfficial(entries, sha, { gh: async () => { throw Object.assign(new Error('无法连接 GitHub'), { status: 502 }); } }), /无法连接 GitHub 核对更新包/);
});

test('真实 Git 提交图：上传包可为分支祖先/当前，后继/分叉拒绝，祖先关系与文件核验同时满足', async () => {
  const root = mkdtempSync(join(tmp, 'ancestry-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  git('init', '-q');
  const commit = (value) => {
    writeFileSync(join(root,'package.json'),JSON.stringify({name:'fixture',version:'0.11.1',marker:value}));
    git('add','.'); git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm',value);
    return git('rev-parse','HEAD');
  };
  const ancestor=commit('ancestor');
  const current=commit('current'); git('branch','Miao-API',current);
  const successor=commit('successor'); git('branch','unmerged-successor',successor);
  git('checkout','-q','--detach',ancestor); const diverged=commit('diverged');
  const compare = (base, head) => {
    // GitHub BASE...HEAD 的计数来自真实 Git，不手写关系状态。
    const [behind,ahead]=git('rev-list','--left-right','--count',`${base}...${head}`).split(/\s+/).map(Number);
    return {status:!behind&&!ahead?'identical':!behind?'ahead':!ahead?'behind':'diverged',
      ahead_by:ahead,behind_by:behind,merge_base_commit:{sha:git('merge-base',base,head)}};
  };
  const relations = [[ancestor,'ahead',true],[current,'identical',true],[successor,'behind',false],[diverged,'diverged',false]];
  const previousBranch=process.env.UPDATE_BRANCH; process.env.UPDATE_BRANCH='Miao-API';
  try {
    for (const [sha,status,allowed] of relations) {
      const archive=execFileSync('git',['-C',root,'archive','--format=zip','--prefix=fixture/',sha]);
      const {entries,sha:archiveSha}=unpackUpload(archive,join(tmp,'ancestry-package'));
      assert.equal(archiveSha,sha);
      const expected=compare(sha,'Miao-API'); assert.equal(expected.status,status);
      // 独立用 Git 的祖先退出码判定许可，防止计数映射与被测实现互相掩盖。
      const {status:ancestryExit}= (await import('node:child_process')).spawnSync('git',['-C',root,'merge-base','--is-ancestor',sha,'Miao-API']);
      assert.equal(ancestryExit===0,allowed);
      let trees=0;
      const api=async path=>{
        if(path.includes('/compare/')) {
          assert.ok(path.endsWith(`/compare/${sha}...Miao-API`));
          return expected;
        }
        if(path.includes('/git/trees/')) {
          trees++;
          return {truncated:false,tree:git('ls-tree','-r',sha).split('\n').map(line=>{const [meta,path]=line.split('\t'),[mode,type,blob]=meta.split(' ');return {path,mode,type,sha:blob};})};
        }
        throw new Error('unexpected '+path);
      };
      if(allowed) {
        await verifyUploadOfficial(entries,sha,{gh:api});
        assert.equal(trees,1);
        const tampered=entries.map(e=>e.type==='file'?{...e,data:Buffer.from('tampered')}:e);
        await assert.rejects(verifyUploadOfficial(tampered,sha,{gh:api}),/与 GitHub 官方不一致/);
        await assert.rejects(verifyUploadOfficial(entries,sha,{gh:async path=>path.includes('/compare/')?{...expected,merge_base_commit:{sha:successor}}:api(path)}),/不是 .* 分支上的代码/);
        await assert.rejects(verifyUploadOfficial(entries,sha,{gh:async path=>path.includes('/compare/')?{status:expected.status}:api(path)}),/不是 .* 分支上的代码/);
      } else {
        await assert.rejects(verifyUploadOfficial(entries,sha,{gh:api}),/不是 .* 分支上的代码/);
        assert.equal(trees,0,'不合法祖先关系在读取文件树前拒绝');
      }
    }
  } finally {if(previousBranch==null)delete process.env.UPDATE_BRANCH;else process.env.UPDATE_BRANCH=previousBranch;}
});

test('上传前必须再输一次密码：确认码 5 分钟内有效、只能用一次、错误密码被拒', async () => {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(`${base}${path}`, {
      method, body,
      headers: { origin: base, cookie, ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}), ...headers },
    });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  assert.equal((await call('POST', '/auth/register', JSON.stringify({ email: 'boss@example.com', password: 'Passw0rd!123' }))).status, 200);
  const up = (token) => call('POST', '/admin/update/upload', Buffer.from('not an archive'), { 'content-type': 'application/octet-stream', ...(token ? { 'x-admin-confirm': token } : {}) });

  assert.equal((await up()).status, 403, '没有确认码');
  assert.equal((await up('forged-token')).status, 403, '伪造的确认码');
  assert.equal((await call('POST', '/admin/confirm', JSON.stringify({ password: 'wrong' }))).status, 401);
  const ok = await call('POST', '/admin/confirm', JSON.stringify({ password: 'Passw0rd!123' }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.expiresIn, 300);
  const first = await up(ok.body.data.token);
  assert.equal(first.status, 200, '有确认码时开始处理');
  assert.equal((await up(ok.body.data.token)).status, 403, '同一个确认码不能用第二次');
  // 这个包不是有效的压缩包：后台处理失败，不会动到代码
  let prog;
  for (let i = 0; i < 50; i++) {
    prog = (await call('GET', '/admin/update/progress')).body.data;
    if (prog.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(prog.state, 'error');
  assert.match(prog.error, /只支持 \.zip 或 \.tar\.gz/);
});

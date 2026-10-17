import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import dns from 'node:dns';
import { News60sStore } from '../src/lib/news60s/store.js';
import { updateNews60s, configuredSource } from '../src/lib/news60s/update.js';
import { normalizeEdition, editionDate, today, parseWechatArticle, publicSourceUrl, inlineImage, MAX_IMAGE_BYTES } from '../src/lib/news60s/format.js';
import { createPublicDownloader } from '../src/lib/news60s/download.js';
import { makeLookup, isBlockedIP } from '../src/lib/netguard.js';

export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
const INLINE = 'data:image/png;base64,' + PNG.toString('base64');
const DATA = (date = '2026-01-02', news = ['第一条新闻', '第二条新闻']) => ({ date, news, tip: '今日微语', source: '测试编辑', image: INLINE, link: 'https://news.example/article' });
const failDownload = async () => { throw new Error('unexpected outbound request'); };

async function storeFor(t) {
  const root = await mkdtemp(join(tmpdir(), 'news60s-unit-'));
  const store = new News60sStore(root);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return store;
}

test('日期明确、真实且不允许未来；历史日期不能用当前时间替代', () => {
  assert.equal(editionDate('2024-02-29'), '2024-02-29');
  for (const d of ['2023-02-29', '2026-04-31', '../latest', '2026-1-02', '2099-01-01']) assert.throws(() => editionDate(d), { status: 400 });
  assert.throws(() => normalizeEdition(DATA(), { expectedDate: '2026-01-03' }), /日期不一致/);
  assert.throws(() => normalizeEdition({ news: ['news'] }), /日期/);
  assert.throws(() => normalizeEdition({ date: '2026-01-02', news: ['<b>a</b>', 'a'] }), /重复/);
  assert.throws(() => normalizeEdition({ date: '2026-01-02', news: [''] }), /不能为空/);
});

test('来源拒绝内网、映射地址、非HTTP、凭据和密钥参数', () => {
  for (const u of ['file:///etc/passwd', 'http://127.0.0.1/', 'http://2130706433/', 'http://[::ffff:127.0.0.1]/', 'http://localhost/', 'https://a:b@example.com/', 'https://example.com/?key=test-only', 'https://example.com/?access_token=test-only']) {
    assert.throws(() => publicSourceUrl(u), { status: 400 }, u);
  }
  assert.equal(publicSourceUrl('/a.png', 'https://images.example/data.json'), 'https://images.example/a.png');
});

const ARTICLE = `<html><head><meta property="og:title" content="每天60秒读懂世界 2026年1月2日"></head>
<body><div id="js_content"><section><p>2026年1月2日 星期五</p><p>1、第一条新闻；</p>
<div><p>2、第二条新闻；</p></div><p>【微语】珍惜今天。</p></section></div>
<script>const ignored = 'gemini.viki.moe'; throw new Error('never execute');</script></body></html>`;

test('微信解析仅接受明确日期与连续编号，不猜年份、不执行脚本', () => {
  const result = parseWechatArticle(ARTICLE, { url: 'https://mp.weixin.qq.com/s/public-article', date: '2026-01-02' });
  assert.deepEqual(result.news, ['第一条新闻', '第二条新闻']);
  assert.equal(result.tip, '珍惜今天。');
  assert.equal(result.provenance.dateBasis, 'article-visible-date');
  assert.throws(() => parseWechatArticle(ARTICLE, { url: 'https://mp.weixin.qq.com/s/a', date: '2026-01-03' }), /日期不一致/);
  assert.throws(() => parseWechatArticle(ARTICLE.replaceAll('2026年', ''), { url: 'https://mp.weixin.qq.com/s/a', date: '2026-01-02' }), /完整的年月日/);
  assert.throws(() => parseWechatArticle(ARTICLE.replace('2、第二', '3、第二'), { url: 'https://mp.weixin.qq.com/s/a' }), /编号不连续/);
  assert.throws(() => parseWechatArticle('<html>请输入验证码</html>', { url: 'https://mp.weixin.qq.com/s/a' }), /验证页/);
});

test('JSON与镜像图片持久发布，独立连接重开后仍可读取', async (t) => {
  const store = await storeFor(t);
  const result = await updateNews60s({ data: DATA() }, { store, download: failDownload });
  const first = await store.read('2026-01-02');
  assert.equal(first.data.date, result.date);
  assert.match(first.data.image, /^\/api\/news\/60s\/assets\//);
  assert.equal(first.data.provenance.image, null);
  const [revision, name] = first.data.image.split('/').slice(-2);
  assert.deepEqual((await store.asset(revision, name)).bytes, PNG);
  const record = JSON.parse(await readFile(join(store.revisions, revision, 'record.json'), 'utf8'));
  assert.deepEqual(record.data.news, DATA().news);
  const reopened = new News60sStore(store.root);
  try { assert.deepEqual(await reopened.read('2026-01-02'), first); } finally { reopened.close(); }
  assert.equal((await store.read(undefined, { now: new Date('2026-01-03T08:00:00Z') })).stale, true);
  assert.equal((await store.read('2026-01-02')).stale, undefined, '明确的历史请求不被当作抓取过期');
  await assert.rejects(store.read('2026-01-01'), { status: 404 });
});

test('图片完成但发布前失败，旧JSON与旧图片保持可用', async (t) => {
  const store = await storeFor(t);
  const first = await updateNews60s({ data: DATA() }, { store });
  const original = await store.read();
  await assert.rejects(updateNews60s({ data: DATA('2026-01-02', ['被拒的新内容']) }, {
    store, beforeCommit: () => { throw new Error('simulated disk/commit failure'); },
  }), /simulated/);
  assert.deepEqual(await store.read(), original);
  assert.deepEqual(await readdir(store.revisions), [first.revision]);
  assert.deepEqual((await store.asset(...original.data.image.split('/').slice(-2))).bytes, PNG);
});

test('同日并发提交仅一份成功；读取不会看到半发布版本', async (t) => {
  const store = await storeFor(t);
  await updateNews60s({ data: DATA() }, { store });
  const peer = new News60sStore(store.root);
  t.after(() => peer.close());
  const previous = await store.read();
  let ready = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const beforeCommit = async () => {
    assert.deepEqual(await store.read(), previous);
    if (++ready === 2) release();
    await gate;
  };
  const results = await Promise.allSettled(['A', 'B'].map((s, i) => updateNews60s({ data: DATA('2026-01-02', ['新内容 ' + s]) }, { store: i ? peer : store, beforeCommit })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
  const published = await store.read();
  assert.match(published.data.news[0], /^新内容 [AB]$/);
  assert.deepEqual((await store.asset(...published.data.image.split('/').slice(-2))).bytes, PNG);
  assert.deepEqual((await store.asset(...previous.data.image.split('/').slice(-2))).bytes, PNG, '旧不可变图片地址仍有效');
});

test('SQLite真实索引写入故障回滚事务与新文件，旧版本保持一致', async (t) => {
  const store = await storeFor(t);
  const first = await updateNews60s({ data: DATA() }, { store });
  const original = await store.read();
  store.db.exec("CREATE TRIGGER refuse_edition BEFORE UPDATE ON editions BEGIN SELECT RAISE(ABORT,'simulated index failure'); END");
  await assert.rejects(updateNews60s({ data: DATA('2026-01-02', ['索引拒绝的新内容']) }, { store }), /simulated index failure/);
  assert.deepEqual(await store.read(), original);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM revisions').get().n, 1);
  assert.deepEqual(await readdir(store.revisions), [first.revision]);
});

test('历史回填不能降低latest，相同内容重复同步不新增版本', async (t) => {
  const store = await storeFor(t);
  await updateNews60s({ data: DATA('2026-01-03') }, { store });
  await updateNews60s({ data: DATA('2026-01-01') }, { store });
  assert.equal((await store.read()).data.date, '2026-01-03');
  const before = await readdir(store.revisions);
  assert.equal((await updateNews60s({ data: DATA('2026-01-03') }, { store })).unchanged, true);
  assert.deepEqual(await readdir(store.revisions), before);
});

test('JSON URL正确带日期，静态模板正确回填，不接受来源返回最新来冒充历史', async (t) => {
  const store = await storeFor(t);
  const seen = [];
  const download = async (url) => {
    seen.push(url);
    return { url, contentType: 'application/json', bytes: Buffer.from(JSON.stringify({ ...DATA('2026-01-02'), image: null })) };
  };
  await updateNews60s({ url: 'https://own.example/{date}.json', date: '2026-01-02' }, { store, download });
  assert.equal(seen[0], 'https://own.example/2026-01-02.json');
  await assert.rejects(updateNews60s({ url: 'https://own.example/v2/60s', date: '2026-01-01' }, { store, download }), /日期不一致/);
  assert.equal(seen[1], 'https://own.example/v2/60s?date=2026-01-01');
  await assert.rejects(store.read('2026-01-01'), { status: 404 });
  assert.equal(configuredSource(undefined, 'https://own.example/{date}.json'), 'https://own.example/latest.json');
  assert.throws(() => configuredSource(undefined, ''), { status: 503 });
});

test('远程图片镜像、去重，图片失败或MIME不符时保留旧数据', async (t) => {
  const store = await storeFor(t);
  let images = 0;
  const download = async (url) => { images++; return { url, contentType: 'image/png', bytes: PNG }; };
  const data = { ...DATA(), image: 'https://images.example/a.png', cover: 'https://images.example/a.png' };
  await updateNews60s({ data }, { store, download });
  assert.equal(images, 1);
  const published = await store.read();
  assert.equal(published.data.image, published.data.cover);
  assert.equal(published.data.provenance.image, data.image);
  await assert.rejects(updateNews60s({ data: { ...data, news: ['new'] } }, { store, download: async () => ({ bytes: PNG, contentType: 'text/html' }) }), /Content-Type/);
  await assert.rejects(updateNews60s({ data: { ...data, news: ['new'] } }, { store, download: async () => { throw new Error('offline'); } }), /offline/);
  assert.deepEqual(await store.read(), published);
  assert.throws(() => inlineImage('data:image/svg+xml;base64,PHN2Zz4='), { status: 400 });
  assert.throws(() => inlineImage('data:image/png;base64,' + Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64')), { status: 400 });
});

test('公开下载限制流量、跳转与总超时；重定向不能访问内网', async (t) => {
  const received = [];
  const server = createServer((req, res) => {
    received.push(req.url);
    if (req.url === '/private') { res.writeHead(302, { location: 'http://127.0.0.1/private' }); res.end(); }
    else if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); }
    else if (req.url === '/large') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('x'.repeat(200)); }
    else if (req.url === '/slow') setTimeout(() => res.end('{}'), 150);
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const lookup = (_host, options, callback) => callback(null, options.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4);
  const download = createPublicDownloader({ lookup });
  const base = `http://fixture.example:${server.address().port}`;
  assert.equal(JSON.parse((await download(base + '/ok')).bytes).ok, true);
  await assert.rejects(download(base + '/private'), { status: 400 });
  assert.equal(received.filter((u) => u === '/private').length, 1);
  await assert.rejects(download(base + '/loop'), /超过 3 次/);
  await assert.rejects(download(base + '/large', { maxBytes: 50 }), { status: 413 });
  await assert.rejects(download(base + '/slow', { timeoutMs: 25 }), { status: 504 });
});

test('真实本地JSON源跳转、相对图片下载、发布和读取全链，无cookie或Authorization转发', async (t) => {
  const store = await storeFor(t);
  const received = [];
  const server = createServer((req, res) => {
    received.push({ path: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie });
    if (req.url === '/feed?date=2026-01-02') { res.writeHead(302, { location: '/daily/data.json' }); res.end(); }
    else if (req.url === '/daily/data.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'not-forwarded=synthetic' });
      res.end(JSON.stringify({ ...DATA(), image: '../poster.png' }));
    } else if (req.url === '/poster.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); }
    else { res.writeHead(404); res.end(); }
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const lookup = (_host, options, callback) => callback(null, options.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4);
  const download = createPublicDownloader({ lookup });
  const base = `http://fixture.example:${server.address().port}`;
  const published = await updateNews60s({ url: base + '/feed', date: '2026-01-02' }, { store, download });
  assert.equal(published.date, '2026-01-02');
  const item = await store.read('2026-01-02');
  assert.equal(item.data.provenance.url, base + '/daily/data.json');
  assert.equal(item.data.provenance.image, base + '/poster.png');
  assert.deepEqual((await store.asset(...item.data.image.split('/').slice(-2))).bytes, PNG);
  assert.equal(received.length, 3);
  assert.ok(received.every((r) => !r.authorization && !r.cookie));
});

test('连接时DNS检查拒绝混合公网/内网结果，防止DNS重绑定', async () => {
  const replace = mock.method(dns, 'lookup', (_h, _o, callback) => callback(null, [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]));
  try {
    await assert.rejects(new Promise((resolve, reject) => makeLookup(isBlockedIP)('source.example', {}, (err, ...value) => err ? reject(err) : resolve(value))), { code: 'EBLOCKED' });
  } finally { replace.mock.restore(); }
});

test('未发布资产不可访问，路径穿越与文件篡改被拒绝', async (t) => {
  const store = await storeFor(t);
  await updateNews60s({ data: DATA() }, { store });
  const item = await store.read();
  const [revision, name] = item.data.image.split('/').slice(-2);
  await assert.rejects(store.asset('../outside', name), { status: 404 });
  await assert.rejects(store.asset(revision, '../record.json'), { status: 404 });
  await writeFile(join(store.revisions, revision, 'record.json'), '{}');
  await assert.rejects(store.read(), { status: 503 });
});

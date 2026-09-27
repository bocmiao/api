// 网易云音乐搜索与播放：解析、播放地址、歌词、播放器页面（上游全部 mock）
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import musicPlay, { feeInfo, parseSong, parseSearch, parseLrc, parseLyric, playerHtml } from '../../src/apis/fun/music-play.js';
import { cache } from '../../src/lib/cache.js';
import { assertFieldsDocumented } from '../helpers/fields.js';

const route = (p) => musicPlay.routes.find((r) => r.path === p);
const call = (p, qs) => route(p).handler({ query: new URLSearchParams(qs), req: { headers: { host: 'api.example.com' } } });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  cache.store.clear();
});
function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    for (const [pattern, body] of routes) {
      if (u.includes(pattern)) return body instanceof Response ? body : new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  };
  return calls;
}

// 新版结构（cloudsearch）
const NEW_SONG = { id: 186016, name: '晴天', ar: [{ id: 6452, name: '周杰伦' }], al: { id: 18905, name: '叶惠美', picUrl: 'http://p1.music.126.net/a.jpg' }, dt: 269000, fee: 8 };
const VIP_SONG = { id: 1901371647, name: '会员歌曲', ar: [{ name: '某歌手' }, { name: '另一位' }], al: { name: '专辑', picUrl: 'https://p2.music.126.net/b.jpg' }, dt: 200000, fee: 1 };
// 旧版结构（search/get/web、song/detail）
const OLD_SONG = { id: 25906124, name: '旧版结构', artists: [{ name: '歌手甲' }], album: { name: '专辑乙', picUrl: 'http://p3.music.126.net/c.jpg' }, duration: 180000, fee: 0 };
const LYRIC = {
  code: 200,
  lrc: { lyric: '[ar:周杰伦]\n{"t":0,"c":[{"tx":"作词: "},{"tx":"方文山"}]}\n[00:01.5]第一句\n[00:12.345][01:00.00]重复的一句\n[00:20.00]\n' },
  tlyric: { lyric: '[00:01.50]First line\n' },
};

test('收费类型：免费可以外链播放，会员和付费专辑不行', () => {
  assert.deepEqual(feeInfo(0), { fee: 0, playable: true, feeText: '免费' });
  assert.equal(feeInfo(8).playable, true);
  assert.deepEqual(feeInfo(1), { fee: 1, playable: false, feeText: '会员专享' });
  assert.equal(feeInfo(4).feeText, '付费专辑');
  assert.deepEqual(feeInfo(undefined), { fee: null, playable: null, feeText: '未知' });
});

test('歌曲解析兼容新旧两种结构，封面改成 https，给出官方外链播放地址', () => {
  const a = parseSong(NEW_SONG);
  assert.deepEqual(a.artists, ['周杰伦']);
  assert.equal(a.cover, 'https://p1.music.126.net/a.jpg');
  assert.equal(a.durationMs, 269000);
  assert.equal(a.playUrl, 'https://music.163.com/song/media/outer/url?id=186016.mp3');
  const b = parseSong(OLD_SONG);
  assert.equal(b.album, '专辑乙');
  assert.equal(b.durationMs, 180000);
  assert.equal(parseSong({ name: '没有 id' }), null);
  assert.throws(() => parseSearch({ code: -460, msg: 'Cheating' }), { status: 502, message: /Cheating/ });
  assert.throws(() => parseSearch({ code: 200 }), { status: 502 });
});

test('LRC 歌词：多个时间标签、毫秒位数不同、跳过标签行和署名行，翻译按时间对齐', () => {
  const lines = parseLrc(LYRIC.lrc.lyric);
  assert.deepEqual(lines.map((l) => l.time), [1500, 12345, 20000, 60000]);
  assert.equal(lines[1].text, '重复的一句');
  assert.equal(lines[2].text, '', '间奏空行保留');
  const d = parseLyric(LYRIC);
  assert.equal(d.hasLyric, true);
  assert.equal(d.hasTranslation, true);
  assert.equal(d.lines[0].translation, 'First line');
  assert.equal(d.lines[1].translation, null);
  const none = parseLyric({ code: 200, nolyric: true });
  assert.equal(none.instrumental, true);
  assert.equal(none.lrc, null);
});

test('GET /api/music/search：新接口失败时退回旧接口，每首歌带播放器地址', async () => {
  const calls = mockFetch([
    ['/api/cloudsearch/pc', new Response('bad', { status: 500 })],
    ['/api/search/get/web', { code: 200, result: { songCount: 2, songs: [OLD_SONG, { ...OLD_SONG, id: 2, name: '第二首', fee: 1 }] } }],
  ]);
  const { data } = await call('/api/music/search', 'keyword=晴天&limit=2');
  assert.ok(calls[0].includes('cloudsearch') && calls[1].includes('search/get/web'));
  assert.ok(calls[1].includes('s=%E6%99%B4%E5%A4%A9') && calls[1].includes('limit=2'));
  assert.equal(data.total, 2);
  assert.equal(data.songs[0].player, 'http://api.example.com/api/music/player?id=25906124');
  assert.equal(data.songs[1].playable, false);
  assertFieldsDocumented(route('/api/music/search'), data);
  mockFetch([['/api/cloudsearch/pc', { code: 200, result: { songCount: 1, songs: [NEW_SONG] } }]]);
  cache.store.clear();
  const again = await call('/api/music/search', 'keyword=周杰伦');
  assert.equal(again.data.songs[0].cover, 'https://p1.music.126.net/a.jpg');
  await assert.rejects(call('/api/music/search', 'keyword=%20'), { status: 400 });
  await assert.rejects(call('/api/music/search', 'keyword=a&limit=51'), { status: 400 });
});

test('GET /api/music/song 与 /api/music/lyric', async () => {
  const calls = mockFetch([
    ['/api/song/detail/', { code: 200, songs: [OLD_SONG] }],
    ['/api/song/lyric', LYRIC],
  ]);
  const song = (await call('/api/music/song', 'id=25906124')).data;
  assert.ok(calls[0].includes('ids=%5B25906124%5D'));
  assert.equal(song.player, 'http://api.example.com/api/music/player?id=25906124');
  assertFieldsDocumented(route('/api/music/song'), song);
  const lyric = (await call('/api/music/lyric', 'id=25906124')).data;
  assert.equal(lyric.id, 25906124);
  assertFieldsDocumented(route('/api/music/lyric'), lyric);
  await assert.rejects(call('/api/music/song', 'id=12345'), { status: 404 }, '返回的歌曲与 id 不符');
  await assert.rejects(call('/api/music/song', 'id=abc'), { status: 400 });
  await assert.rejects(call('/api/music/lyric', ''), { status: 400 });
});

test('GET /api/music/url 直接跳转到网易云官方外链，不请求上游', async () => {
  const calls = mockFetch([]);
  const r = await call('/api/music/url', 'id=186016');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, 'https://music.163.com/song/media/outer/url?id=186016.mp3');
  assert.equal(calls.length, 0);
  await assert.rejects(call('/api/music/url', 'id=1;rm'), { status: 400 });
});

test('GET /api/music/player：按 id 或关键词打开，带歌词；会员歌曲不放音频而是给出提示', async () => {
  mockFetch([
    ['/api/song/detail/', { code: 200, songs: [NEW_SONG] }],
    ['/api/song/lyric', LYRIC],
    ['/api/cloudsearch/pc', { code: 200, result: { songCount: 2, songs: [VIP_SONG, NEW_SONG] } }],
  ]);
  const r = await call('/api/music/player', 'id=186016&theme=dark');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.match(r.headers['content-security-policy'], /default-src 'none'/);
  assert.equal(r.headers['referrer-policy'], 'no-referrer', '网易云音频有防盗链');
  assert.match(r.body, /data-theme="dark"/);
  assert.match(r.body, /<audio id="audio" controls preload="metadata" src="https:\/\/music\.163\.com\/song\/media\/outer\/url\?id=186016\.mp3">/);
  assert.match(r.body, /"第一句","First line"/);
  // 关键词：跳过会员歌曲，播放第一首免费的
  const byKw = await call('/api/music/player', 'keyword=晴天');
  assert.match(byKw.body, /<div class="name">晴天<\/div>/);
  // 只有会员歌曲时给出提示
  assert.match(playerHtml(parseSong(VIP_SONG), null), /会员专享歌曲，网易云不提供外链播放/);
  assert.doesNotMatch(playerHtml(parseSong(VIP_SONG), null), /<audio/);
  await assert.rejects(call('/api/music/player', ''), { status: 400 });
  await assert.rejects(call('/api/music/player', 'id=1&theme=pink'), { status: 400 });
});

test('播放器页面：歌名等内容全部转义，不能注入脚本', () => {
  const evil = parseSong({ ...NEW_SONG, name: '</script><script>alert(1)</script>', ar: [{ name: '<img src=x onerror=alert(1)>' }] });
  const html = playerHtml(evil, { lines: [{ time: 0, text: '</script><script>alert(2)</script>', translation: null }] });
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /\\u003c\/script>/, '歌词 JSON 里的 </ 被转义');
});

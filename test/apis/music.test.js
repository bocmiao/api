// 网易云音乐榜单（mock fetch）
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import music, { parsePlaylist, TOPLISTS } from '../../src/apis/fun/music.js';
import { cache } from '../../src/lib/cache.js';
import { assertFieldsDocumented, matcher } from '../helpers/fields.js';

const fx = (name) => readFileSync(new URL(`../fixtures/fun/${name}`, import.meta.url), 'utf8');
const json = (name) => JSON.parse(fx(name));
const route = music.routes[0];
const call = (qs = '') => route.handler({ query: new URLSearchParams(qs) });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  cache.store.clear();
});

function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, headers: opts?.headers ?? {} });
    for (const [pattern, body] of routes) {
      if (u.includes(pattern)) {
        if (body instanceof Error) throw body;
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('not found', { status: 404 });
  };
  return calls;
}

test('榜单 id', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(TOPLISTS).map(([k, v]) => [k, v.id])), {
    hot: 3778678, soaring: 19723756, new: 3779629, original: 2884035,
  });
});

test('解析旧版 result 结构：跳过无效条目，封面改 https', () => {
  const d = parsePlaylist(json('netease-playlist.json'));
  assert.equal(d.name, '云音乐热歌榜');
  assert.equal(d.updatedAt, new Date(1790467200000).toISOString());
  assert.equal(d.trackCount, 200);
  assert.equal(d.tracks.length, 3);
  assert.deepEqual(d.tracks[0], {
    rank: 1, id: 186016, name: '晴天', artists: ['周杰伦'], album: '叶惠美', durationMs: 269000,
    cover: 'https://p1.music.126.net/album/yehuimei.jpg', url: 'https://music.163.com/#/song?id=186016', playUrl: 'https://music.163.com/song/media/outer/url?id=186016.mp3',
  });
  assert.deepEqual(d.tracks[1].artists, ['买辣椒也用券']);
  assert.deepEqual(d.tracks[2], {
    rank: 3, id: 2, name: '只有名字', artists: [], album: null, durationMs: null, cover: null, url: 'https://music.163.com/#/song?id=2', playUrl: 'https://music.163.com/song/media/outer/url?id=2.mp3',
  });
});

test('解析 v6 playlist 结构与错误', () => {
  const d = parsePlaylist(json('netease-playlist-v6.json'));
  assert.equal(d.name, '飙升榜');
  assert.deepEqual(d.tracks[0].artists, ['歌手甲', '歌手乙']);
  assert.equal(d.tracks[0].album, '专辑一号');
  assert.equal(d.tracks[0].durationMs, 201000);
  assert.throws(() => parsePlaylist({ code: 200, result: {} }), { status: 502, message: /网易云音乐返回的数据格式无法识别/ });
  assert.throws(() => parsePlaylist({ code: -460, message: 'Cheating' }), { status: 502, message: /Cheating/ });
});

test('/api/music/toplist：默认热歌榜、limit、referer 与缓存', async () => {
  const calls = mockFetch([['/api/playlist/detail?id=3778678', fx('netease-playlist.json')]]);
  const res = await call('limit=2');
  assert.equal(res.data.list, 'hot');
  assert.equal(res.data.title, '热歌榜');
  assert.equal(res.data.tracks.length, 2);
  assert.equal(calls[0].headers.referer, 'https://music.163.com/');
  const again = await call('list=hot');
  assert.equal(again.cached, true);
  assert.equal(again.data.tracks.length, 3);
});

test('/api/music/toplist：旧接口失败时改用 v6 接口', async () => {
  const calls = mockFetch([
    ['/api/playlist/detail?id=19723756', JSON.stringify({ code: 200, result: { tracks: [] } })],
    ['/api/v6/playlist/detail?id=19723756', fx('netease-playlist-v6.json')],
  ]);
  const res = await call('list=soaring');
  assert.equal(res.data.id, 19723756);
  assert.equal(res.data.tracks[0].name, '新歌一号');
  assert.equal(calls.length, 2);

  cache.store.clear();
  mockFetch([]);
  await assert.rejects(call('list=new'), { status: 502 });
});

test('参数校验', async () => {
  await assert.rejects(call('list=rock'), { status: 400 });
  await assert.rejects(call('limit=0'), { status: 400 });
  await assert.rejects(call('limit=101'), { status: 400 });
});

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

test('返回字段都有说明且类型一致', async () => {
  mockFetch([
    ['/api/playlist/detail?id=3778678', fx('netease-playlist.json')],
    ['/api/playlist/detail?id=2884035', '{"code":200,"result":{"tracks":[]}}'],
    ['/api/v6/playlist/detail?id=2884035', JSON.stringify({ code: 200, playlist: { tracks: json('netease-playlist-v6.json').playlist.tracks } })],
  ]);
  const samples = [(await call()).data, (await call('list=original')).data];
  assert.equal(samples[1].name, '原创榜', '上游缺少名称时用简称');
  assert.equal(samples[1].updatedAt, null);
  const seen = new Set();
  for (const data of samples) {
    assertFieldsDocumented(route, data);
    const visit = (value, path) => {
      if (path && !(path.endsWith('[]') && value && typeof value === 'object')) {
        seen.add(path);
        const f = route.fields.find((x) => matcher(x.name).test(path));
        assert.ok(f.type.split('|').includes(typeOf(value)), `${path} 实际为 ${typeOf(value)}，说明写的是 ${f.type}`);
      }
      if (Array.isArray(value)) return value.forEach((v) => visit(v, `${path}[]`));
      if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, path ? `${path}.${k}` : k);
    };
    visit(data, '');
  }
  const unseen = route.fields.filter((f) => ![...seen].some((p) => matcher(f.name).test(p))).map((f) => f.name);
  assert.deepEqual(unseen, []);
});

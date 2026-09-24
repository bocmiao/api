import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import funModules from '../../src/apis/fun/index.js';
import { parseHitokoto, parseTypes, buildHitokotoUrl, pickFallbackHitokoto, FALLBACK_HITOKOTO, loadHitokoto } from '../../src/apis/fun/hitokoto.js';
import { parsePoem, pickFallbackPoem, FALLBACK_POEMS, loadPoem } from '../../src/apis/fun/poem.js';
import { parseBing, buildBingUrl } from '../../src/apis/fun/bing.js';
import { parseWallhaven, buildWallhavenUrl, picsumWallpaper } from '../../src/apis/fun/wallpaper.js';
import { parseCalendar, todayWeekday } from '../../src/apis/fun/anime.js';
import { parseTop250, parseNowPlaying } from '../../src/apis/fun/douban.js';
import { parseBoxOffice } from '../../src/apis/fun/boxoffice.js';
import { parseIciba, todayCN } from '../../src/apis/fun/english.js';

const fx = (name) => readFileSync(new URL(`../fixtures/fun/${name}`, import.meta.url), 'utf8');
const json = (name) => JSON.parse(fx(name));

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const mockFetch = (fn) => { globalThis.fetch = async (url, opts) => fn(String(url), opts); };
const jsonRes = (obj) => new Response(JSON.stringify(obj), { headers: { 'content-type': 'application/json' } });

function route(path) {
  for (const m of funModules) for (const r of m.routes) if (r.path === path) return r;
  throw new Error(`no route ${path}`);
}
const call = (path, qs = '') => route(path).handler({ query: new URLSearchParams(qs), params: {}, body: null, ip: '127.0.0.1', user: null, req: null });

test('模块元数据：分类、source、每个参数都有 desc', () => {
  assert.equal(funModules.length, 8);
  const names = new Set();
  for (const m of funModules) {
    assert.equal(m.category, 'fun');
    assert.ok(m.name && m.title && m.source && m.description, m.name);
    assert.ok(!names.has(m.name)); names.add(m.name);
    for (const r of m.routes) {
      assert.ok(r.path.startsWith('/api/') && r.summary && Array.isArray(r.params), r.path);
      for (const p of r.params) assert.ok(p.name && p.desc, `${r.path} ${p.name}`);
    }
  }
  assert.ok(funModules.find((m) => m.name === 'douban').unofficial);
  assert.ok(funModules.find((m) => m.name === 'boxoffice').unofficial);
});

test('一言：解析、分类校验、URL 构造', () => {
  const h = parseHitokoto(json('hitokoto.json'));
  assert.equal(h.hitokoto, '所谓奇迹，只有在相信的人身上才会发生。');
  assert.equal(h.typeName, '动画');
  assert.equal(h.from, 'CLANNAD');
  assert.equal(h.fromWho, '冈崎朋也');
  assert.equal(h.url, 'https://hitokoto.cn/?uuid=2d7e6b1f-0c5a-4c3a-9f7e-8f1c0d3a2b61');
  assert.equal(h.fallback, false);
  assert.deepEqual(parseTypes('a,D'), ['a', 'd']);
  assert.deepEqual(parseTypes(undefined), []);
  assert.throws(() => parseTypes('z'), { status: 400 });
  assert.equal(buildHitokotoUrl(['a', 'b']), 'https://v1.hitokoto.cn/?encode=json&charset=utf-8&c=a&c=b');
  assert.throws(() => parseHitokoto({}), { status: 502 });
});

test('一言：兜底列表按分类挑选，上游失败时返回兜底', async () => {
  assert.ok(FALLBACK_HITOKOTO.length >= 30);
  const f = pickFallbackHitokoto(['i'], () => 0.5);
  assert.equal(f.type, 'i');
  assert.equal(f.fallback, true);
  mockFetch(() => { throw new TypeError('network'); });
  const h = await loadHitokoto(['k']);
  assert.equal(h.fallback, true);
  assert.equal(h.type, 'k');
});

test('诗词：解析 all.json 并补朝代；上游失败时兜底', async () => {
  const p = parsePoem(json('jinrishici.json'));
  assert.deepEqual([p.content, p.title, p.author, p.dynasty], ['会当凌绝顶，一览众山小。', '望岳', '杜甫', '唐']);
  assert.equal(p.category, '古诗文-山水-泰山');
  assert.throws(() => parsePoem({ status: 'error' }), { status: 502 });
  assert.ok(FALLBACK_POEMS.length >= 30);
  assert.ok(FALLBACK_POEMS.every((x) => x.content && x.title && x.author && x.dynasty));
  assert.equal(pickFallbackPoem(() => 0).title, '静夜思');
  mockFetch(() => new Response('bad gateway', { status: 502 }));
  assert.equal((await loadPoem()).fallback, true);
});

test('Bing：完整 URL、UHD、日期与版权拆分', () => {
  const [a, b] = parseBing(json('bing.json'));
  assert.equal(a.date, '2026-09-24');
  assert.equal(a.url, 'https://cn.bing.com/th?id=OHR.AutumnLarch_ZH-CN1234567890_1920x1080.jpg&rf=LaDigue_1920x1080.jpg&pid=hp');
  assert.equal(a.urlUHD, 'https://cn.bing.com/th?id=OHR.AutumnLarch_ZH-CN1234567890_UHD.jpg');
  assert.equal(a.title, '金色的季节');
  assert.equal(a.description, '瑞士恩加丁山谷中的落叶松林');
  assert.equal(a.author, '© Jane Doe/Getty Images');
  assert.ok(a.copyrightLink.startsWith('https://www.bing.com/search'));
  assert.equal(b.title, '月光下的港口，挪威罗弗敦群岛');
  assert.equal(b.copyrightLink, null);
  assert.ok(parseBing(json('bing.json'), { mkt: 'en-US' })[0].url.startsWith('https://www.bing.com/th?'));
  assert.equal(buildBingUrl({ idx: 1, n: 2 }), 'https://cn.bing.com/HPImageArchive.aspx?format=js&idx=1&n=2&mkt=zh-CN');
  assert.throws(() => parseBing({}), { status: 502 });
});

test('Bing：/api/bing/image 302 跳转，参数校验', async () => {
  mockFetch((url) => {
    assert.ok(url.includes('idx=2'));
    return jsonRes(json('bing.json'));
  });
  const r = await call('/api/bing/image', 'idx=2&uhd=1');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, 'https://cn.bing.com/th?id=OHR.AutumnLarch_ZH-CN1234567890_UHD.jpg');
  await assert.rejects(call('/api/bing', 'n=9'), { status: 400 });
  await assert.rejects(call('/api/bing', 'mkt=../x'), { status: 400 });
});

test('壁纸：只保留 SFW，URL 固定 purity=100', () => {
  const list = parseWallhaven(json('wallhaven.json'));
  assert.deepEqual(list.map((w) => w.id), ['zyxvqy', '9d8e7f']);
  assert.equal(list[0].url, 'https://w.wallhaven.cc/full/zy/wallhaven-zyxvqy.jpg');
  assert.equal(list[0].thumb, 'https://th.wallhaven.cc/lg/zy/zyxvqy.jpg');
  assert.equal(list[0].width, 3840);
  const u = new URL(buildWallhavenUrl({ category: 'anime', resolution: '2560x1440', ratio: '16x9', q: 'sky & sea' }));
  assert.equal(u.searchParams.get('purity'), '100');
  assert.equal(u.searchParams.get('categories'), '010');
  assert.equal(u.searchParams.get('sorting'), 'random');
  assert.equal(u.searchParams.get('atleast'), '2560x1440');
  assert.equal(u.searchParams.get('q'), 'sky & sea');
  assert.equal(picsumWallpaper('1280x720', 'abc').url, 'https://picsum.photos/seed/abc/1280/720');
  assert.throws(() => parseWallhaven({ error: 'x' }), { status: 502 });
});

test('壁纸：random.jpg 302；上游失败降级 picsum；参数校验', async () => {
  mockFetch(() => jsonRes(json('wallhaven.json')));
  const r = await call('/api/wallpaper/random.jpg', 'category=general');
  assert.equal(r.status, 302);
  assert.match(r.headers.location, /^https:\/\/w\.wallhaven\.cc\/full\//);
  mockFetch(() => { throw new TypeError('network'); });
  const { data } = await call('/api/wallpaper/random', 'category=people&resolution=1920x1080');
  assert.equal(data.source, 'picsum');
  await assert.rejects(call('/api/wallpaper/random', 'resolution=big'), { status: 400 });
  await assert.rejects(call('/api/wallpaper/random', 'category=nsfw'), { status: 400 });
});

test('番剧：按星期排序，优先中文名，https 图片', () => {
  const days = parseCalendar(json('bgm-calendar.json'));
  assert.deepEqual(days.map((d) => d.weekday), [1, 2, 7]);
  const [a, b] = days[0].items;
  assert.equal(a.title, '葬送的芙莉莲');
  assert.equal(a.name, '葬送のフリーレン');
  assert.equal(a.score, 8.8);
  assert.equal(a.cover, 'https://lain.bgm.tv/pic/cover/l/13/c5/400602_ZI8Y9.jpg');
  assert.equal(a.url, 'https://bgm.tv/subject/400602');
  assert.equal(b.title, '新作アニメ');
  assert.equal(b.score, null);
  assert.equal(b.cover, null);
  assert.equal(days[2].weekdayName, '星期日');
  assert.equal(todayWeekday(new Date('2026-09-26T20:00:00Z')), 7); // 北京时间周日凌晨
  assert.throws(() => parseCalendar({}), { status: 502 });
});

test('番剧：weekday 筛选与 UA', async () => {
  mockFetch((url, opts) => {
    assert.equal(url, 'https://api.bgm.tv/calendar');
    assert.match(opts.headers['user-agent'], /^api-hub\//);
    return jsonRes(json('bgm-calendar.json'));
  });
  const { data } = await call('/api/anime/calendar', 'weekday=7');
  assert.equal(data.items[0].title, '周日动画');
  await assert.rejects(call('/api/anime/calendar', 'weekday=8'), { status: 400 });
});

test('豆瓣 Top250 解析', () => {
  const [a, b] = parseTop250(fx('douban-top250.html'));
  assert.equal(a.rank, 1);
  assert.equal(a.id, '1292052');
  assert.equal(a.title, '肖申克的救赎');
  assert.equal(a.originalTitle, 'The Shawshank Redemption');
  assert.equal(a.otherTitles, '月黑高飞(港) / 刺激1995(台)');
  assert.equal(a.rating, 9.7);
  assert.equal(a.votes, 3156892);
  assert.equal(a.year, 1994);
  assert.equal(a.region, '美国');
  assert.deepEqual(a.genres, ['犯罪', '剧情']);
  assert.equal(a.poster, 'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p480747492.webp');
  assert.equal(a.url, 'https://movie.douban.com/subject/1292052/');
  assert.equal(a.quote, '希望让人自由。');
  assert.match(a.crew, /^导演: 弗兰克·德拉邦特/);
  assert.equal(b.originalTitle, null);
  assert.equal(b.region, '中国大陆 中国香港');
  assert.equal(b.quote, null);
  assert.throws(() => parseTop250('<html>验证码</html>'), { status: 502 });
});

test('豆瓣正在热映解析，排除即将上映', () => {
  const list = parseNowPlaying(fx('douban-nowplaying.html'));
  assert.equal(list.length, 2);
  const [a, b] = list;
  assert.equal(a.id, '36154853');
  assert.equal(a.title, '示例电影甲');
  assert.equal(a.rating, 8.1);
  assert.equal(a.votes, 152340);
  assert.equal(a.year, 2026);
  assert.deepEqual(a.actors, ['李四', '王五', '赵六']);
  assert.equal(a.poster, 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/p2912345678.jpg');
  assert.equal(a.url, 'https://movie.douban.com/subject/36154853/');
  assert.equal(b.title, 'Tom & Jerry 示例');
  assert.equal(b.rating, null);
  assert.throws(() => parseNowPlaying('<html></html>'), { status: 502 });
});

test('豆瓣 city 参数校验', async () => {
  await assert.rejects(call('/api/douban/nowplaying', 'city=../../x'), { status: 400 });
  await assert.rejects(call('/api/douban/top250', 'page=11'), { status: 400 });
});

test('猫眼票房解析', () => {
  const d = parseBoxOffice(json('maoyan-second.json'));
  assert.equal(d.date, '2026-09-24');
  assert.equal(d.totalBox, '3370.88');
  assert.equal(d.totalBoxUnit, '万');
  assert.equal(d.list.length, 2);
  const [a] = d.list;
  assert.equal(a.rank, 1);
  assert.equal(a.name, '示例电影甲');
  assert.equal(a.box, 1523.67);
  assert.equal(a.boxRate, '45.2%');
  assert.equal(a.sumBox, '4.55亿');
  assert.equal(a.showCount, 128563);
  assert.equal(a.url, 'https://piaofang.maoyan.com/movie/1492913');
  assert.throws(() => parseBoxOffice({ success: false }), { status: 502 });
});

test('每日一句英语解析与日期校验', async () => {
  const e = parseIciba(json('iciba.json'));
  assert.equal(e.content, 'The best way to predict the future is to create it.');
  assert.equal(e.translation, '预测未来的最好方法就是创造未来。');
  assert.equal(e.editorNote, null);
  assert.equal(e.date, '2026-09-24');
  assert.ok(e.audio.endsWith('.mp3'));
  assert.ok(e.shareImage.startsWith('https://'));
  assert.equal(todayCN(new Date('2026-09-24T17:00:00Z')), '2026-09-25');
  await assert.rejects(call('/api/english/daily', 'date=2999-01-01'), { status: 400 });
  await assert.rejects(call('/api/english/daily', 'date=abc'), { status: 400 });
  mockFetch((url) => {
    assert.equal(url, 'https://open.iciba.com/dsapi/?date=2026-09-01');
    return jsonRes(json('iciba.json'));
  });
  const { data } = await call('/api/english/daily', 'date=2026-09-01');
  assert.equal(data.translation, '预测未来的最好方法就是创造未来。');
});

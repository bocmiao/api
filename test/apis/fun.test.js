import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import funModules from '../../src/apis/fun/index.js';
import { cache } from '../../src/lib/cache.js';
import { assertFieldsDocumented, collectPaths, matcher } from '../helpers/fields.js';
import { parseHitokoto, parseTypes, buildHitokotoUrl, pickFallbackHitokoto, FALLBACK_HITOKOTO, HITOKOTO_TYPES, loadHitokoto } from '../../src/apis/fun/hitokoto.js';
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
  assert.equal(d.totalBox, 3370.88);
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

// ---- 返回字段说明：用 fixture + mock 的 fetch 调用 handler，拿真实 data 校验 fields ----

const htmlRes = (s) => new Response(s, { headers: { 'content-type': 'text/html; charset=utf-8' } });
// handler 走内存缓存，清空后才会真正请求（mock 的）上游
const clearCache = () => cache.store.clear();
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function* entries(value, prefix = '') {
  if (Array.isArray(value)) {
    for (const item of value) yield* entries(item, `${prefix}[]`);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = prefix ? `${prefix}.${k}` : k;
      yield [p, v];
      yield* entries(v, p);
    }
  }
}

// 每个样例：字段都有说明，且实际类型在说明的 type 之内；
// 所有样例合起来：说明里的每个字段都至少出现一次（避免写了不存在的字段）
function checkFields(r, samples) {
  for (const data of samples) {
    assertFieldsDocumented(r, data);
    for (const [p, v] of entries(data)) {
      const f = r.fields.find((x) => matcher(x.name).test(p));
      assert.ok(f.type.split('|').includes(typeOf(v)), `${r.path} ${p} 实际类型 ${typeOf(v)}，说明里是 ${f.type}`);
    }
  }
  const seen = [...new Set(samples.flatMap((d) => [...collectPaths(d)]))];
  const unseen = r.fields.filter((f) => !seen.some((p) => matcher(f.name).test(p))).map((f) => f.name);
  assert.deepEqual(unseen, [], `${r.path} 说明了但样例中没有出现的字段：${unseen.join(', ')}`);
}

test('字段说明：一言（上游 / 上游缺省字段 / 兜底）', async () => {
  const r = route('/api/hitokoto');
  mockFetch(() => jsonRes(json('hitokoto.json')));
  const ok = (await call('/api/hitokoto', 'type=a')).data;
  assert.equal(ok.fallback, false);
  assert.equal(ok.id, 6412);
  assert.equal(ok.creator, 'ANO');
  assert.equal(ok.length, 19);

  const partial = json('hitokoto.json');
  for (const k of ['uuid', 'length', 'from_who', 'creator']) delete partial[k];
  partial.type = 'x';
  mockFetch(() => jsonRes(partial));
  const p = (await call('/api/hitokoto')).data;
  assert.deepEqual([p.uuid, p.url, p.fromWho, p.creator], [null, null, null, null]);
  assert.equal(p.length, [...partial.hitokoto].length);
  assert.equal(p.typeName, '其他');

  // 内置库没有 g 分类，兜底时从全部内置句子里取
  assert.ok(!FALLBACK_HITOKOTO.some((h) => h.type === 'g'));
  mockFetch(() => { throw new TypeError('network'); });
  const fb = (await call('/api/hitokoto', 'type=g')).data;
  assert.equal(fb.fallback, true);
  assert.deepEqual([fb.id, fb.uuid, fb.creator, fb.url], [null, null, null, null]);
  assert.ok(fb.type in HITOKOTO_TYPES);
  const fbNoWho = pickFallbackHitokoto(['a'], () => 0.99); // 夏目友人帐，from_who 为 null
  assert.equal(fbNoWho.fromWho, null);

  const typeDesc = r.fields.find((f) => f.name === 'type').desc;
  for (const [k, v] of Object.entries(HITOKOTO_TYPES)) assert.ok(typeDesc.includes(`${k}=${v}`), k);
  checkFields(r, [ok, p, fb, fbNoWho]);
});

test('字段说明：诗词（上游 / 作者不在朝代表 / 兜底）', async () => {
  const r = route('/api/poem');
  mockFetch(() => jsonRes(json('jinrishici.json')));
  const ok = (await call('/api/poem')).data;
  assert.equal(ok.fallback, false);
  assert.equal(ok.dynasty, '唐');

  mockFetch(() => jsonRes({ content: '青青子衿，悠悠我心。', origin: '子衿', author: '佚名' }));
  const anon = (await call('/api/poem')).data;
  assert.deepEqual([anon.dynasty, anon.category], [null, null]);

  mockFetch(() => new Response('bad gateway', { status: 502 }));
  const fb = (await call('/api/poem')).data;
  assert.equal(fb.fallback, true);
  assert.equal(fb.category, null);
  assert.ok(fb.title && fb.author && fb.dynasty);

  const dynastyDesc = r.fields.find((f) => f.name === 'dynasty').desc;
  for (const p of FALLBACK_POEMS) assert.ok(dynastyDesc.includes(p.dynasty), p.dynasty);
  checkFields(r, [ok, anon, fb]);
});

test('字段说明：Bing 壁纸（完整 / 字段缺失）', async () => {
  clearCache();
  const r = route('/api/bing');
  mockFetch(() => jsonRes(json('bing.json')));
  const full = (await call('/api/bing', 'n=2')).data;
  assert.equal(full.length, 2);
  assert.equal(full[0].url1080, 'https://cn.bing.com/th?id=OHR.AutumnLarch_ZH-CN1234567890_1920x1080.jpg');
  assert.equal(full[0].urlMobile, 'https://cn.bing.com/th?id=OHR.AutumnLarch_ZH-CN1234567890_1080x1920.jpg');
  assert.equal(full[0].hash, 'a1b2c3d4e5f60718293a4b5c6d7e8f90');

  mockFetch(() => jsonRes({ images: [{ startdate: '2026-9-1', url: '/th?id=OHR.X_EN-US1_1920x1080.jpg' }] }));
  const sparse = (await call('/api/bing', 'mkt=en-US&idx=1')).data;
  assert.equal(sparse[0].url, 'https://www.bing.com/th?id=OHR.X_EN-US1_1920x1080.jpg');
  assert.deepEqual(
    [sparse[0].date, sparse[0].title, sparse[0].description, sparse[0].author, sparse[0].urlUHD, sparse[0].urlbase, sparse[0].hash],
    [null, null, null, null, null, null, null],
  );
  checkFields(r, [full, sparse]);
});

test('字段说明：随机壁纸（wallhaven / picsum / 回退）', async () => {
  clearCache();
  const r = route('/api/wallpaper/random');
  mockFetch(() => jsonRes(json('wallhaven.json')));
  const wh = (await call('/api/wallpaper/random', 'category=anime')).data;
  assert.equal(wh.source, 'wallhaven');
  assert.ok(['zyxvqy', '9d8e7f'].includes(wh.id));

  const pic = (await call('/api/wallpaper/random', 'source=picsum&resolution=1280x720')).data;
  assert.equal(pic.source, 'picsum');
  assert.match(pic.id, /^[0-9a-f]{12}$/);
  assert.equal(pic.thumb, `https://picsum.photos/seed/${pic.id}/480/270`);
  assert.deepEqual([pic.width, pic.height, pic.fileSize], [1280, 720, null]);

  // 上游失败 / 没有结果且未传 q → 回退 picsum；传了 q → 404
  mockFetch(() => { throw new TypeError('network'); });
  const fb = (await call('/api/wallpaper/random', 'category=general')).data;
  assert.equal(fb.source, 'picsum');
  assert.deepEqual([fb.width, fb.height], [1920, 1080]);
  mockFetch(() => jsonRes({ data: [], meta: {} }));
  assert.equal((await call('/api/wallpaper/random', 'ratio=9x16')).data.source, 'picsum');
  await assert.rejects(call('/api/wallpaper/random', 'q=nothing'), { status: 404 });

  checkFields(r, [wh, pic, fb]);
});

test('字段说明：番剧放送表（整周数组 / 单日对象 / 没有数据的一天）', async () => {
  clearCache();
  const r = route('/api/anime/calendar');
  mockFetch(() => jsonRes(json('bgm-calendar.json')));
  const week = (await call('/api/anime/calendar')).data;
  assert.ok(Array.isArray(week));
  assert.deepEqual(week.map((d) => d.weekday), [1, 2, 7]);
  const [sparse] = week[1].items;
  assert.deepEqual(
    [sparse.nameCn, sparse.airDate, sparse.score, sparse.votes, sparse.rank, sparse.watching],
    [null, null, null, 0, null, 0],
  );
  assert.equal(sparse.cover, 'https://lain.bgm.tv/pic/cover/c/cc/dd/620000.jpg');
  assert.equal(sparse.thumb, 'https://lain.bgm.tv/pic/cover/s/cc/dd/620000.jpg');

  const mon = (await call('/api/anime/calendar', 'weekday=1')).data;
  assert.equal(mon.weekdayName, '星期一');
  const wed = (await call('/api/anime/calendar', 'weekday=3')).data;
  assert.deepEqual(wed, { weekday: 3, weekdayName: '星期三', items: [] });
  checkFields(r, [week, mon, wed]);
});

test('字段说明：豆瓣 Top250（含解析不到的条目）', async () => {
  clearCache();
  const r = route('/api/douban/top250');
  const pages = [];
  mockFetch((url) => {
    pages.push(new URL(url).searchParams.get('start'));
    return htmlRes(pages.length === 1 ? fx('douban-top250.html') : '<ol class="grid_view"><li><div class="item"><em>51</em></div></li></ol>');
  });
  const full = (await call('/api/douban/top250', 'page=1')).data;
  assert.deepEqual([full.page, full.pageSize, full.totalPages, full.list.length], [1, 25, 10, 2]);
  const sparse = (await call('/api/douban/top250', 'page=3')).data;
  assert.deepEqual(pages, ['0', '50']);
  const [s] = sparse.list;
  assert.equal(s.rank, 51);
  assert.deepEqual([s.id, s.title, s.rating, s.year, s.crew, s.poster, s.url], [null, null, null, null, null, null, null]);
  assert.deepEqual(s.genres, []);
  checkFields(r, [full, sparse]);
});

test('字段说明：豆瓣正在热映（含缺少属性的条目）', async () => {
  clearCache();
  const r = route('/api/douban/nowplaying');
  mockFetch((url) => htmlRes(url.includes('/shanghai/')
    ? fx('douban-nowplaying.html')
    : '<div id="nowplaying"><ul><li id="30000001" class="list-item" data-title="信息很少的电影" data-score=""></li></ul></div>'));
  const full = (await call('/api/douban/nowplaying', 'city=shanghai')).data;
  assert.equal(full.city, 'shanghai');
  assert.equal(full.list.length, 2);
  const sparse = (await call('/api/douban/nowplaying', 'city=lasa')).data;
  const [s] = sparse.list;
  assert.deepEqual(
    [s.rating, s.votes, s.year, s.duration, s.region, s.director, s.poster],
    [null, null, null, null, null, null, null],
  );
  assert.deepEqual(s.actors, []);
  assert.equal(s.url, 'https://movie.douban.com/subject/30000001/');
  checkFields(r, [full, sparse]);
});

test('字段说明：猫眼实时票房（万元 / 亿元单位 / 缺失值）', async () => {
  const r = route('/api/boxoffice');
  clearCache();
  mockFetch(() => jsonRes(json('maoyan-second.json')));
  const normal = (await call('/api/boxoffice', 'limit=1')).data;
  assert.equal(normal.list.length, 1);
  assert.deepEqual([normal.totalBox, normal.totalBoxUnit, normal.splitTotalBox, normal.splitTotalBoxUnit], [3370.88, '万', 3001.55, '万']);
  assert.equal(normal.serverTime, '2026-09-24 15:32:10');

  // 综合票房已过亿、分账仍以万计：两个单位要分开给
  clearCache();
  mockFetch(() => jsonRes(json('maoyan-second-yi.json')));
  const yi = (await call('/api/boxoffice')).data;
  assert.deepEqual([yi.totalBox, yi.totalBoxUnit, yi.splitTotalBox, yi.splitTotalBoxUnit], [1.08, '亿', 9868.3, '万']);
  const [a, b] = yi.list;
  assert.equal(a.box, 6739.52);
  assert.equal(a.avgSeatView, '31.5%');
  assert.deepEqual(
    [b.movieId, b.url, b.releaseInfo, b.splitBox, b.showCount, b.avgShowView],
    [null, null, null, null, null, null],
  );
  assert.equal(b.box, 12.4);
  checkFields(r, [normal, yi]);
});

test('字段说明：每日一句英语（普通 / 小编的话与缺失字段）', async () => {
  clearCache();
  const r = route('/api/english/daily');
  mockFetch(() => jsonRes(json('iciba.json')));
  const normal = (await call('/api/english/daily', 'date=2026-08-01')).data;
  assert.equal(normal.picture, 'https://staticedu-wps.cache.iciba.com/image/f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1.jpg');
  assert.equal(normal.pictureSmall, 'https://staticedu-wps.cache.iciba.com/image/c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6.jpg');
  assert.equal(normal.shareImage, 'https://staticedu-wps.cache.iciba.com/image/0a1b2c3d4e5f60718293a4b5c6d7e8f9.png');
  assert.equal(normal.url, 'https://news.iciba.com/views/dailysentence/daily.html#!/detail/sid/5321');

  const raw = json('iciba.json');
  for (const k of ['sid', 'dateline', 'picture2', 'tts', 'fenxiang_img']) delete raw[k];
  Object.assign(raw, { note: ' ', translation: '小编的话：多读几遍，试着背下来。' });
  mockFetch(() => jsonRes(raw));
  const sparse = (await call('/api/english/daily', 'date=2026-08-02')).data;
  assert.equal(sparse.editorNote, '多读几遍，试着背下来。');
  assert.equal(sparse.picture, sparse.pictureSmall);
  assert.deepEqual(
    [sparse.date, sparse.translation, sparse.audio, sparse.shareImage, sparse.sid, sparse.url],
    [null, null, null, null, null, null],
  );
  checkFields(r, [normal, sparse]);
});

test('豆瓣 Top250：多个上映年份时仍能取到地区和类型', async () => {
  const { parseTop250 } = await import('../../src/apis/fun/douban.js');
  const html = `<div class="item"><div class="pic"><em>1</em><a href="https://movie.douban.com/subject/1418019/"><img alt="大闹天宫" src="https://img/p.jpg"></a></div>
    <div class="info"><div class="hd"><a href="https://movie.douban.com/subject/1418019/"><span class="title">大闹天宫</span></a></div>
    <div class="bd"><p class="">导演: 万籁鸣<br>1961(中国大陆) / 1964 / 1978 / 2004 / 中国大陆 / 剧情 动画 奇幻</p>
    <div class="star"><span class="rating_num">9.4</span><span>400000人评价</span></div></div></div></div>`;
  const [m] = parseTop250(html);
  assert.equal(m.year, 1961);
  assert.equal(m.region, '中国大陆');
  assert.deepEqual(m.genres, ['剧情', '动画', '奇幻']);
});

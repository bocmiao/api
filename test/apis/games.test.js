import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cache } from '../../src/lib/cache.js';
import { assertFieldsDocumented, matcher } from '../helpers/fields.js';
import { parseSteamFreeSearch, parseFeaturedCategories, steamLocale } from '../../src/apis/games/steam.js';
import { parseAppDetails, parseStoreSearch, parsePlayerCount, parseItadOverview } from '../../src/apis/games/steam-info.js';
import { parseGogFree } from '../../src/apis/games/gog.js';
import { parsePsPlusMonthly, splitGames } from '../../src/apis/games/psplus.js';
import { parseSiglIds, parseProducts } from '../../src/apis/games/gamepass.js';
import { normalizeEpic, normalizeSteam, normalizeGog, loadFreeGamesAll } from '../../src/apis/games/free.js';
import { parseFreeGames } from '../../src/apis/games/epic.js';
import games from '../../src/apis/games/index.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/games/${name}`, import.meta.url), 'utf8');
const json = (name) => JSON.parse(fixture(name));

test('Steam 限免：只保留 100% 折扣条目，兼容新旧两种页面布局', () => {
  const items = parseSteamFreeSearch(json('steam-search-free.json'));
  assert.deepEqual(items.map((i) => `${i.type}:${i.id}`), ['app:1172470', 'app:2215430', 'sub:54321']);
  const [a, b, pack] = items;
  assert.equal(a.title, 'Free Game One & Friends');
  assert.equal(a.url, 'https://store.steampowered.com/app/1172470/');
  assert.equal(a.originalPrice, '¥ 58.00');
  assert.equal(a.releaseDate, '2020 年 11 月 5 日');
  assert.equal(a.image, 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1172470/header.jpg?t=1726000000');
  assert.equal(b.image, 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2215430/a1b2c3d4e5f6/header.jpg?t=1726000000');
  assert.equal(pack.title, 'Old Layout Pack');
  assert.equal(pack.originalPrice, '¥ 20.00');
  assert.equal(pack.url, 'https://store.steampowered.com/sub/54321/');
  assert.equal(pack.releaseDate, null);
});

test('Steam 限免：格式异常抛 502', () => {
  assert.throws(() => parseSteamFreeSearch({ success: 1 }), { status: 502 });
});

test('Steam 精选特惠：价格换算、截止时间、去重、礼包链接', () => {
  const items = parseFeaturedCategories(json('steam-featured.json'));
  assert.equal(items.length, 3);
  const elden = items.find((i) => i.id === 1245620);
  assert.equal(elden.discountPercent, 40);
  assert.equal(elden.originalPrice, '¥ 298.00');
  assert.equal(elden.finalPrice, '¥ 178.80');
  assert.equal(elden.expiresAt, new Date(1759338000 * 1000).toISOString());
  assert.equal(elden.url, 'https://store.steampowered.com/app/1245620/');
  const pack = items.find((i) => i.id === 12345);
  assert.equal(pack.url, 'https://store.steampowered.com/sub/12345/');
  assert.equal(pack.expiresAt, null);
  assert.equal(parseFeaturedCategories(json('steam-featured.json'), 'top_sellers')[0].title, 'Counter-Strike 2');
  assert.throws(() => parseFeaturedCategories({ status: 1 }), { status: 502 });
});

test('Steam 参数校验', () => {
  assert.deepEqual(steamLocale(new URLSearchParams('cc=US')), { cc: 'us', l: 'schinese' });
  assert.throws(() => steamLocale(new URLSearchParams('cc=c%26n')), { status: 400 });
  assert.throws(() => steamLocale(new URLSearchParams('l=../x')), { status: 400 });
});

test('Steam 详情', () => {
  const d = parseAppDetails(json('steam-appdetails.json'), 1245620);
  assert.equal(d.name, 'ELDEN RING');
  assert.equal(d.shortDescription, '全新奇幻动作RPG。"艾尔登法环"之王。');
  assert.deepEqual(d.price, { currency: 'CNY', initial: 298, final: 178.8, discountPercent: 40, initialFormatted: '¥ 298.00', finalFormatted: '¥ 178.80' });
  assert.deepEqual(d.genres, ['动作', '角色扮演']);
  assert.equal(d.supportedLanguages, '英语*, 简体中文*, 日语*');
  assert.equal(d.metacritic, 94);
  assert.equal(d.url, 'https://store.steampowered.com/app/1245620/');
  assert.throws(() => parseAppDetails({ 1: { success: false } }, 1), { status: 404 });
  assert.throws(() => parseAppDetails({}, 1), { status: 502 });
});

test('Steam 搜索与在线人数', () => {
  const { total, items } = parseStoreSearch(json('steam-storesearch.json'));
  assert.equal(total, 2);
  assert.deepEqual(items[0].price, { currency: 'CNY', initial: 298, final: 178.8 });
  assert.equal(items[0].metascore, 94);
  assert.equal(items[1].price, null);
  assert.equal(items[1].metascore, null);
  assert.equal(parsePlayerCount(json('steam-players.json')), 812345);
  assert.throws(() => parsePlayerCount({ response: { result: 42 } }), { status: 404 });
});

test('ITAD 史低', () => {
  const r = parseItadOverview(json('itad-overview.json'), json('itad-lookup.json').game.id);
  assert.deepEqual(r.lowest, { shop: 'GreenManGaming', price: 29.39, regular: 59.99, currency: 'USD', cut: 51, date: '2025-06-26T17:00:00+00:00' });
  assert.equal(r.current.shop, 'Steam');
  assert.equal(r.current.cut, 40);
  assert.equal(r.url, 'https://isthereanydeal.com/game/elden-ring/');
  assert.equal(parseItadOverview({ prices: [] }, 'x'), null);
});

test('GOG 限免：排除本就免费和非 0 元条目', () => {
  const items = parseGogFree(json('gog-catalog.json'));
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'The Witcher: Enhanced Edition');
  assert.equal(items[0].originalPrice, '¥68.00');
  assert.equal(items[0].url, 'https://www.gog.com/zh/game/the_witcher_enhanced_edition');
  assert.equal(items[0].image, 'https://images.gog-statics.com/abc_glx_logo.jpg');
  assert.throws(() => parseGogFree({}), { status: 502 });
});

test('PS Plus：从 RSS 找每月会免公告并拆出游戏名', () => {
  const [oct, jan] = parsePsPlusMonthly(fixture('psplus-feed.xml'));
  assert.equal(oct.month, '2026-10');
  assert.deepEqual(oct.games, ['Stardew Valley', 'Rock and Roll Racing', 'Psychonauts 2']);
  assert.equal(oct.url, 'https://blog.playstation.com/2026/09/24/playstation-plus-monthly-games-for-october/');
  assert.equal(oct.image, 'https://blog.playstation.com/tachyon/2026/09/oct-featured.jpg?resize=1088%2C612&crop_strategy=smart');
  assert.equal(oct.summary, 'Farm, race & think your way through October’s lineup, available October 7.');
  assert.equal(jan.month, '2026-01');
  assert.deepEqual(jan.games, ['Game X', 'Game Y']);
  assert.throws(() => parsePsPlusMonthly('<rss><channel></channel></rss>'), { status: 404 });
  assert.throws(() => parsePsPlusMonthly('<html></html>'), { status: 502 });
  assert.deepEqual(splitGames('A, B and C'), ['A', 'B', 'C']);
});

test('Game Pass：sigls id 列表与商品详情', () => {
  const ids = parseSiglIds(json('gamepass-sigls.json'));
  assert.deepEqual(ids, ['9NQ9CHCTZKTJ', '9PNB3LVL07XH', '9MISSINGXXX1']);
  const items = parseProducts(json('gamepass-products.json'), ids);
  assert.deepEqual(items.map((i) => i.title), ['Avowed', 'Indiana Jones and the Great Circle']);
  assert.equal(items[0].developer, 'Obsidian Entertainment');
  assert.equal(items[0].image.wide, 'https://store-images.s-microsoft.com/image/apps.3.hero');
  assert.equal(items[0].image.tall, 'https://store-images.s-microsoft.com/image/apps.2.poster');
  assert.equal(items[0].url, 'https://www.xbox.com/zh-CN/games/store/game/9NQ9CHCTZKTJ');
  assert.throws(() => parseSiglIds({}), { status: 502 });
});

test('限免汇总：统一格式', () => {
  const epicRaw = JSON.parse(readFileSync(new URL('../fixtures/epic.json', import.meta.url)));
  const epic = normalizeEpic(parseFreeGames(epicRaw, { now: new Date('2026-09-20T00:00:00Z') }));
  assert.deepEqual(Object.keys(epic[0]), ['id', 'platform', 'title', 'url', 'image', 'originalPrice', 'endDate']);
  assert.equal(epic[0].id, 'epic:g1');
  assert.equal(epic[0].endDate, '2026-09-24T15:00:00.000Z');

  const steam = normalizeSteam(parseSteamFreeSearch(json('steam-search-free.json')));
  assert.equal(steam[0].id, 'steam:app:1172470');
  assert.equal(steam[0].endDate, null);
  const gog = normalizeGog(parseGogFree(json('gog-catalog.json')));
  assert.equal(gog[0].platform, 'gog');
});

test('限免汇总：单个平台失败时返回部分数据和 errors', async () => {
  const boom = Object.assign(new Error('上游返回 HTTP 503'), { status: 502 });
  const loaders = {
    epic: async () => [{ id: 'epic:1', platform: 'epic' }],
    steam: async () => { throw boom; },
    gog: async () => [{ id: 'gog:1', platform: 'gog' }],
  };
  const { items, errors } = await loadFreeGamesAll(['epic', 'steam', 'gog'], loaders);
  assert.deepEqual(items.map((i) => i.id), ['epic:1', 'gog:1']);
  assert.deepEqual(errors, [{ platform: 'steam', status: 502, message: '上游返回 HTTP 503' }]);
});

test('模块注册：每个路由都声明了带说明的 params', () => {
  const paths = games.flatMap((m) => m.routes.map((r) => r.path));
  for (const p of ['/api/games/free', '/api/epic/free', '/api/steam/free', '/api/steam/specials', '/api/gog/free',
    '/api/psplus/monthly', '/api/gamepass', '/api/steam/app', '/api/steam/search', '/api/steam/players']) {
    assert.ok(paths.includes(p), p);
  }
  assert.equal(new Set(paths).size, paths.length);
  for (const m of games) {
    assert.equal(m.category, 'games');
    assert.ok(m.source, m.name);
    for (const r of m.routes) {
      assert.ok(Array.isArray(r.params), r.path);
      for (const p of r.params) assert.ok(p.desc, `${r.path} ${p.name}`);
    }
  }
});

test('参数校验：非法 id / platform 返回 400', async () => {
  const route = (path) => games.flatMap((m) => m.routes).find((r) => r.path === path);
  await assert.rejects(route('/api/steam/app').handler({ query: new URLSearchParams('id=1;drop') }), { status: 400 });
  await assert.rejects(route('/api/steam/players').handler({ query: new URLSearchParams('') }), { status: 400 });
  await assert.rejects(route('/api/games/free').handler({ query: new URLSearchParams('platform=xbox') }), { status: 400 });
  await assert.rejects(route('/api/gamepass').handler({ query: new URLSearchParams('list=all') }), { status: 400 });
});

// ---------- 返回字段说明：用 fixture + mock fetch 调用真实 handler ----------

const typeOf = (v) => (v == null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// 收集 data 里每个字段路径上出现过的所有值（路径写法同 test/helpers/fields.js）
function collectValues(value, prefix = '', out = new Map()) {
  if (Array.isArray(value)) {
    for (const item of value) collectValues(item, `${prefix}[]`, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (!out.has(p)) out.set(p, []);
      out.get(p).push(v);
      collectValues(v, p, out);
    }
  }
  return out;
}

// 反向检查：fields 里的每一项都要在样例里出现过、至少有一个非 null 的值（防止字段名写错、fixture 没覆盖到可选字段），
// 并且样例里的实际类型都在声明的 type 之内
function assertFieldsCovered(route, samples) {
  const values = new Map();
  for (const s of samples) {
    for (const [p, vs] of collectValues(s)) values.set(p, [...(values.get(p) ?? []), ...vs]);
  }
  const uncovered = [];
  const wrongType = [];
  for (const f of route.fields) {
    const re = matcher(f.name);
    const vs = [...values].filter(([p]) => re.test(p)).flatMap(([, v]) => v);
    if (!vs.some((v) => v != null)) uncovered.push(f.name);
    const allowed = f.type.split('|');
    const bad = [...new Set(vs.map(typeOf))].filter((t) => !allowed.includes(t));
    if (bad.length) wrongType.push(`${f.name}（声明 ${f.type}，实际出现 ${bad.join('/')}）`);
  }
  assert.deepEqual(uncovered, [], `${route.path} 的样例没有覆盖这些字段（不存在或只有 null）：${uncovered.join(', ')}`);
  assert.deepEqual(wrongType, [], `${route.path} 的字段类型与声明不符：${wrongType.join('；')}`);
}

describe('返回字段说明：fixture + mock fetch 调用 handler', () => {
  const routes = games.flatMap((m) => m.routes);
  const routeOf = (path) => routes.find((r) => r.path === path);
  const checked = new Set();
  const realFetch = globalThis.fetch;
  const realItadKey = process.env.ITAD_API_KEY;

  // 按 URL 片段返回预置响应；响应体为数字时返回该 HTTP 状态码
  function mockFetch(table) {
    const calls = [];
    globalThis.fetch = async (url, opts = {}) => {
      calls.push({ url: String(url), opts });
      const hit = table.find(([frag]) => String(url).includes(frag));
      if (!hit) return new Response('no mock', { status: 500 });
      return typeof hit[1] === 'number' ? new Response('error', { status: hit[1] }) : new Response(hit[1]);
    };
    return calls;
  }

  const call = async (path, qs = '') => (await routeOf(path).handler({ query: new URLSearchParams(qs), params: {} })).data;

  // 同一路由可以传多份样例（如成功 / 部分失败），合起来检查覆盖度
  function check(path, ...samples) {
    const route = routeOf(path);
    for (const data of samples) assertFieldsDocumented(route, data);
    assertFieldsCovered(route, samples);
    checked.add(path);
  }

  const EPIC = ['store-site-backend-static-ipv4.ak.epicgames.com', readFileSync(new URL('../fixtures/epic.json', import.meta.url), 'utf8')];
  const STEAM_SEARCH = ['store.steampowered.com/search/results/', fixture('steam-search-free.json')];
  const STEAM_FEATURED = ['store.steampowered.com/api/featuredcategories', fixture('steam-featured.json')];
  const GOG = ['catalog.gog.com/v1/catalog', fixture('gog-catalog.json')];

  beforeEach(() => {
    cache.store.clear();
    cache.pending.clear();
    // Epic 按当前时间区分"正在免费 / 即将免费"，固定时间让 fixture 里两类都有
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-20T00:00:00Z') });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    mock.timers.reset();
    if (realItadKey === undefined) delete process.env.ITAD_API_KEY;
    else process.env.ITAD_API_KEY = realItadKey;
  });

  test('/api/games/free：全部成功与单个平台失败', async () => {
    mockFetch([EPIC, STEAM_SEARCH, STEAM_FEATURED, GOG]);
    const ok = await call('/api/games/free');
    assert.deepEqual(ok.items.map((i) => i.id), ['epic:g1', 'epic:g4', 'steam:app:1172470', 'steam:app:2215430', 'steam:sub:54321', 'gog:1207658691']);
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.items.find((i) => i.id === 'steam:app:1172470').endDate, '2025-09-24T17:00:00.000Z');

    cache.store.clear();
    mockFetch([EPIC, STEAM_SEARCH, STEAM_FEATURED, ['catalog.gog.com', 503]]);
    const partial = await call('/api/games/free', 'platform=epic,gog');
    assert.deepEqual(partial.items.map((i) => i.platform), ['epic', 'epic']);
    assert.deepEqual(partial.errors, [{ platform: 'gog', status: 502, message: '上游返回 HTTP 503' }]);

    check('/api/games/free', ok, partial);
  });

  test('/api/epic/free', async () => {
    mockFetch([EPIC]);
    const data = await call('/api/epic/free', 'locale=zh-CN&country=CN');
    assert.deepEqual(data.current.map((g) => g.id), ['g1', 'g4']);
    assert.deepEqual(data.upcoming.map((g) => g.id), ['g2']);
    check('/api/epic/free', data);
  });

  test('/api/steam/free：搜索结果 + 精选特惠补截止时间', async () => {
    mockFetch([STEAM_SEARCH, STEAM_FEATURED]);
    const data = await call('/api/steam/free');
    assert.deepEqual(data.map((i) => i.endDate), ['2025-09-24T17:00:00.000Z', null, null]);
    check('/api/steam/free', data);
  });

  test('/api/steam/specials', async () => {
    mockFetch([STEAM_FEATURED]);
    const specials = await call('/api/steam/specials');
    assert.deepEqual(specials.map((i) => `${i.type}:${i.id}`), ['app:1172470', 'app:1245620', 'sub:12345']);
    assert.equal(specials[1].originalPriceCents, 29800);
    const comingSoon = await call('/api/steam/specials', 'list=coming_soon');
    assert.equal(comingSoon[0].expiresAt, null);
    check('/api/steam/specials', specials, comingSoon);
  });

  test('/api/steam/app：未配置 ITAD 时没有 historyLow，配置后附带史低', async () => {
    delete process.env.ITAD_API_KEY;
    mockFetch([['store.steampowered.com/api/appdetails', fixture('steam-appdetails.json')]]);
    const plain = await call('/api/steam/app', 'id=1245620');
    assert.equal('historyLow' in plain, false);

    cache.store.clear();
    process.env.ITAD_API_KEY = 'test-key';
    const calls = mockFetch([
      ['store.steampowered.com/api/appdetails', fixture('steam-appdetails.json')],
      ['api.isthereanydeal.com/games/lookup/v1', fixture('itad-lookup.json')],
      ['api.isthereanydeal.com/games/overview/v2', fixture('itad-overview.json')],
    ]);
    const withItad = await call('/api/steam/app', 'id=1245620&cc=us');
    assert.equal(withItad.historyLow.lowest.price, 29.39);
    assert.equal(withItad.historyLow.current.expiry, '2026-10-02T17:00:00+00:00');
    assert.ok(calls.some((c) => c.url.includes('overview/v2') && c.url.includes('country=US')));

    check('/api/steam/app', plain, withItad);
  });

  test('/api/steam/search', async () => {
    mockFetch([['store.steampowered.com/api/storesearch', fixture('steam-storesearch.json')]]);
    const data = await call('/api/steam/search', 'q=elden');
    assert.equal(data.total, 2);
    check('/api/steam/search', data);
  });

  test('/api/steam/players', async () => {
    mockFetch([['ISteamUserStats/GetNumberOfCurrentPlayers', fixture('steam-players.json')]]);
    const data = await call('/api/steam/players', 'id=1245620');
    assert.deepEqual(data, { id: 1245620, players: 812345 });
    check('/api/steam/players', data);
  });

  test('/api/gog/free', async () => {
    mockFetch([GOG]);
    const data = await call('/api/gog/free');
    assert.deepEqual(data.map((g) => g.id), ['1207658691']);
    check('/api/gog/free', data);
  });

  test('/api/psplus/monthly', async () => {
    mockFetch([['blog.playstation.com/tag/playstation-plus/feed/', fixture('psplus-feed.xml')]]);
    const data = await call('/api/psplus/monthly');
    assert.equal(data.month, '2026-10');
    assert.deepEqual(data.history.map((h) => h.month), ['2026-01']);
    check('/api/psplus/monthly', data);
  });

  test('/api/gamepass', async () => {
    mockFetch([
      ['catalog.gamepass.com/sigls/v2', fixture('gamepass-sigls.json')],
      ['displaycatalog.mp.microsoft.com/v7.0/products', fixture('gamepass-products.json')],
    ]);
    const data = await call('/api/gamepass', 'list=leaving&market=US&lang=zh-CN');
    assert.equal(data.list, 'leaving');
    assert.equal(data.title, '即将离开');
    assert.deepEqual(data.items.map((i) => i.id), ['9NQ9CHCTZKTJ', '9PNB3LVL07XH']);
    check('/api/gamepass', data);
  });

  test('games 分类的每个非 raw 路由都做了字段校验', () => {
    const expected = routes.filter((r) => !r.raw).map((r) => r.path).sort();
    assert.deepEqual([...checked].sort(), expected);
    for (const r of routes.filter((x) => x.raw)) assert.ok(r.returns, `${r.path} 缺少 returns`);
  });
});

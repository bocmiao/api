import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../../src/apis/hot/parsers.js';
import { signWbi, getMixinKey, keysFromNav } from '../../src/apis/hot/wbi.js';
import hotModules, { loadHot, SOURCE_IDS } from '../../src/apis/hot/index.js';
import { cache } from '../../src/lib/cache.js';
import { assertFieldsDocumented, matcher } from '../helpers/fields.js';

const fx = (name) => readFileSync(new URL(`../fixtures/hot/${name}`, import.meta.url), 'utf8');
const json = (name) => JSON.parse(fx(name));

function assertShape(items) {
  items.forEach((it, i) => {
    assert.equal(it.rank, i + 1);
    assert.equal(typeof it.title, 'string');
    assert.ok(it.url === null || /^https?:\/\//.test(it.url), `url: ${it.url}`);
    assert.ok(it.hot === null || typeof it.hot === 'number');
    assert.ok(it.desc === null || typeof it.desc === 'string');
  });
}

test('parseHotNumber 识别万/亿/逗号', () => {
  assert.equal(P.parseHotNumber('1520 万热度'), 15_200_000);
  assert.equal(P.parseHotNumber('3.2亿'), 320_000_000);
  assert.equal(P.parseHotNumber('12,345'), 12345);
  assert.equal(P.parseHotNumber(88), 88);
  assert.equal(P.parseHotNumber(''), null);
  assert.equal(P.parseHotNumber('暂无'), null);
});

test('微博：过滤广告，生成搜索链接', () => {
  const items = P.parseWeibo(json('weibo.json'));
  assertShape(items);
  assert.deepEqual(items.map((i) => i.title), ['中秋节放假安排', '新款手机发布会', 'A&B 演唱会']);
  assert.equal(items[0].hot, 2489031);
  assert.equal(items[0].url, 'https://s.weibo.com/weibo?q=%23%E4%B8%AD%E7%A7%8B%E8%8A%82%E6%94%BE%E5%81%87%E5%AE%89%E6%8E%92%23');
  assert.equal(items[2].url, `https://s.weibo.com/weibo?q=${encodeURIComponent('#A&B 演唱会#')}`);
  assert.deepEqual(items[0].extra, { label: '热', category: '社会' });
  assert.equal(items[0].desc, null);
  assert.throws(() => P.parseWeibo({ ok: -100 }), { status: 502 });
});

test('知乎：移动端结构与 www 新版结构', () => {
  const items = P.parseZhihu(json('zhihu.json'));
  assertShape(items);
  assert.equal(items[0].url, 'https://www.zhihu.com/question/700000001');
  assert.equal(items[0].hot, 15_200_000);
  assert.equal(items[0].desc, '今年的发布会带来了多款新品，大家怎么看？');
  assert.equal(items[0].extra.answers, 356);
  assert.equal(items[1].desc, null);
  assert.equal(items[1].extra.cover, undefined);

  const [w] = P.parseZhihu(json('zhihu-web.json'));
  assert.equal(w.title, '新版结构的问题标题');
  assert.equal(w.url, 'https://www.zhihu.com/question/700000009');
  assert.equal(w.hot, 3_200_000);
});

test('B 站：热门、排行、风控错误', () => {
  const items = P.parseBilibili(json('bilibili-popular.json'));
  assertShape(items);
  assert.equal(items[0].url, 'https://www.bilibili.com/video/BV1xx411c7aa');
  assert.equal(items[0].hot, 2345678);
  assert.equal(items[0].desc, '百万播放');
  assert.equal(items[0].extra.author, 'UP主甲');
  assert.equal(items[1].desc, '一个关于宇宙的视频');
  assert.equal(P.parseBilibili(json('bilibili-rank.json'))[0].title, '全站第一');
  assert.throws(() => P.parseBilibili(json('bilibili-352.json')), { status: 502, message: /风控/ });
});

test('WBI 签名与官方文档示例一致', () => {
  const keys = keysFromNav({
    code: -101,
    data: {
      wbi_img: {
        img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
        sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
      },
    },
  });
  assert.equal(getMixinKey(keys.imgKey, keys.subKey), 'ea1db124af3c7062474693fa704f4ff8');
  assert.equal(
    signWbi({ foo: '114', bar: '514', zab: 1919810 }, keys, 1702204169),
    'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4',
  );
  assert.equal(keysFromNav({ data: {} }), null);
});

test('抖音：热点链接与热度', () => {
  const items = P.parseDouyin(json('douyin.json'));
  assertShape(items);
  assert.equal(items[0].title, '国庆出游攻略');
  assert.equal(items[0].url, 'https://www.douyin.com/hot/1987654');
  assert.equal(items[0].hot, 11892345);
  assert.equal(items[0].extra.cover, 'https://p3-sign.douyinpic.com/cover1.jpeg');
  assert.equal(items[1].extra.cover, undefined);
});

test('百度：解析 s-data 注释，置顶在前', () => {
  const items = P.parseBaidu(fx('baidu.html'));
  assertShape(items);
  assert.deepEqual(items.map((i) => i.title), ['置顶新闻', '全国秋粮大丰收', '新学期开学']);
  assert.equal(items[0].extra.top, true);
  assert.equal(items[1].hot, 7904562);
  assert.equal(items[1].extra.tag, '热');
  assert.equal(items[1].url, 'https://www.baidu.com/s?wd=%E5%85%A8%E5%9B%BD%E7%A7%8B%E7%B2%AE%E5%A4%A7%E4%B8%B0%E6%94%B6');
  assert.equal(items[2].url, `https://www.baidu.com/s?wd=${encodeURIComponent('新学期开学')}`);
  assert.throws(() => P.parseBaidu('<html></html>'), { status: 502 });
  // 嵌套一层 content 的变体
  const nested = `<!--s-data:${JSON.stringify({ data: { cards: [{ component: 'hotList', content: [{ content: [{ word: 'x', hotScore: '1' }] }] }] } })}-->`;
  assert.equal(P.parseBaidu(nested)[0].title, 'x');
});

test('今日头条', () => {
  const items = P.parseToutiao(json('toutiao.json'));
  assertShape(items);
  assert.equal(items[0].url, 'https://www.toutiao.com/trending/7418000000000000001/');
  assert.equal(items[0].hot, 36521478);
  assert.equal(items[0].extra.label, '热');
});

test('GitHub Trending：仓库、描述、语言、星数', () => {
  const items = P.parseGithubTrending(fx('github.html'));
  assertShape(items);
  assert.equal(items.length, 2);
  const [a, b] = items;
  assert.equal(a.title, 'owner1/cool-repo');
  assert.equal(a.url, 'https://github.com/owner1/cool-repo');
  assert.equal(a.desc, 'A cool repo for <fast> APIs & more');
  assert.equal(a.hot, 1234);
  assert.deepEqual(a.extra, { owner: 'owner1', repo: 'cool-repo', language: 'TypeScript', stars: 12345, forks: 1024, starsInPeriod: 1234 });
  assert.equal(b.title, 'org.two/no-desc_repo');
  assert.equal(b.desc, null);
  assert.equal(b.extra.language, undefined);
  assert.equal(b.extra.stars, 987);
  assert.equal(b.extra.starsInPeriod, 56);
  assert.deepEqual(P.parseGithubTrending("<div>It looks like we don’t have any trending repositories</div>"), []);
  assert.throws(() => P.parseGithubTrending('<html>blocked</html>'), { status: 502 });
});

test('V2EX', () => {
  const items = P.parseV2ex(json('v2ex.json'));
  assertShape(items);
  assert.equal(items[0].url, 'https://www.v2ex.com/t/1100001');
  assert.equal(items[0].hot, 256);
  assert.equal(items[0].desc, '好奇大家 2026 年都用什么编辑器 & 插件 欢迎讨论');
  assert.equal(items[0].extra.node, '程序员');
  assert.equal(items[1].desc, null);
});

test('Hacker News：Firebase 条目与 Algolia 兜底', () => {
  const items = P.parseHackerNewsItems(json('hn-items.json'));
  assertShape(items);
  assert.equal(items.length, 2);
  assert.equal(items[0].url, 'https://example.com/api-hub');
  assert.equal(items[0].hot, 845);
  assert.equal(items[0].extra.comments, 312);
  assert.equal(items[1].url, 'https://news.ycombinator.com/item?id=41000002');
  assert.equal(items[1].desc, "Share what you're building this month.");
  const alg = P.parseHackerNewsAlgolia(json('hn-algolia.json'));
  assert.deepEqual(alg[0], { ...items[0], extra: { ...items[0].extra } });
});

test('RSS / Atom：CDATA、实体、链接', () => {
  const it = P.parseFeed(fx('ithome.xml'));
  assertShape(it);
  assert.equal(it[0].title, '某品牌发布新款笔记本：搭载 <新一代> 处理器');
  assert.equal(it[0].desc, 'IT之家 9 月 24 日消息，某品牌今日发布新款笔记本 & 平板。');
  assert.equal(it[0].extra.time, '2026-09-24T11:30:00.000Z');
  assert.equal(it[1].title, '微软发布 Windows 更新 & 修复');
  assert.equal(it[1].desc, '本次更新修复了若干问题。');
  assert.equal(it[1].extra.time, '2026-09-24T02:00:00.000Z');

  const kr = P.parseFeed(fx('36kr.xml'));
  assert.equal(kr.length, 1);
  assert.equal(kr[0].url, 'https://36kr.com/p/3400000000000001?f=rss');
  assert.equal(kr[0].desc, '今日要闻：某公司宣布完成融资。');

  const ss = P.parseFeed(fx('sspai.xml'));
  assert.equal(ss[0].url, 'https://sspai.com/post/100001');
  assert.equal(ss[0].desc, '本文介绍几款 Mac 效率工具。');
  assert.equal(ss[0].extra.author, '少数派编辑部');

  const [a] = P.parseFeed(fx('atom.xml'));
  assert.equal(a.title, 'Hello & World');
  assert.equal(a.url, 'https://example.com/posts/1');
  assert.equal(a.desc, 'Summary text');
  assert.equal(a.extra.author, 'Alice');
  assert.equal(a.extra.time, '2026-09-24T01:02:03.000Z');

  assert.throws(() => P.parseFeed('<html>not a feed</html>'), { status: 502 });
});

// ---------- 路由（mock fetch） ----------
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  cache.store.clear();
});

function mockFetch(routes) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    for (const [pattern, body] of routes) {
      if (u.includes(pattern)) {
        if (body instanceof Error) throw body;
        return new Response(body, { status: 200, headers: { 'set-cookie': 'passport_csrf_token=abc; Path=/' } });
      }
    }
    return new Response('not found', { status: 404 });
  };
}

const routes = new Map(hotModules.flatMap((m) => m.routes.map((r) => [r.path, r])));
const call = (path, qs = '') => routes.get(path).handler({ query: new URLSearchParams(qs) });

test('每个路由都声明了带 desc 的 params，模块字段齐全', () => {
  for (const m of hotModules) {
    assert.equal(m.category, 'hot');
    assert.ok(m.source && m.title);
    for (const r of m.routes) {
      assert.ok(Array.isArray(r.params));
      for (const p of r.params) assert.ok(p.desc, `${r.path} ${p.name}`);
    }
  }
  assert.ok(routes.has('/api/hot/all') && routes.has('/api/hot/sources'));
});

test('/api/hot/weibo 返回统一结构，limit 生效且命中缓存', async () => {
  mockFetch([['weibo.com/ajax/side/hotSearch', fx('weibo.json')]]);
  const res = await call('/api/hot/weibo', 'limit=2');
  assert.equal(res.data.source, 'weibo');
  assert.equal(res.data.title, '微博热搜');
  assert.equal(res.data.items.length, 2);
  const again = await call('/api/hot/weibo');
  assert.equal(again.cached, true);
  assert.equal(again.data.items.length, 3);
});

test('参数校验', async () => {
  await assert.rejects(call('/api/hot/bilibili', 'type=x'), { status: 400 });
  await assert.rejects(call('/api/hot/github', 'since=yearly'), { status: 400 });
  await assert.rejects(call('/api/hot/github', 'language=../../x'), { status: 400 });
  await assert.rejects(call('/api/hot/news', 'source=foo'), { status: 400 });
  await assert.rejects(call('/api/hot/weibo', 'limit=0'), { status: 400 });
  await assert.rejects(call('/api/hot/all', 'sources=weibo,nope'), { status: 400 });
  await assert.rejects(loadHot('nope'), { status: 400 });
});

test('/api/hot/github 对语言编码并传 since', async () => {
  let seen;
  globalThis.fetch = async (url) => ((seen = String(url)), new Response(fx('github.html')));
  const res = await call('/api/hot/github', 'since=weekly&language=C%2B%2B');
  assert.equal(seen, 'https://github.com/trending/c%2B%2B?since=weekly');
  assert.equal(res.data.items[0].title, 'owner1/cool-repo');
});

test('/api/hot/bilibili?type=rank 走 WBI 签名', async () => {
  let seen;
  mockFetch([
    ['/x/web-interface/nav', JSON.stringify({ code: -101, data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } })],
  ]);
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('ranking/v2')) {
      seen = String(url);
      assert.equal(opts.headers.referer, 'https://www.bilibili.com/');
      return new Response(fx('bilibili-rank.json'));
    }
    return inner(url, opts);
  };
  const res = await call('/api/hot/bilibili', 'type=rank');
  assert.match(seen, /[?&]wts=\d+/);
  assert.match(seen, /&w_rid=[0-9a-f]{32}$/);
  assert.equal(res.data.title, 'B 站排行榜');
});

test('/api/hot/douyin 先取 csrf cookie', async () => {
  let cookie;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('login_guiding_strategy')) {
      return new Response('{}', { headers: { 'set-cookie': 'passport_csrf_token=tok123; Path=/; Secure' } });
    }
    cookie = opts.headers.cookie;
    return new Response(fx('douyin.json'));
  };
  const res = await call('/api/hot/douyin');
  assert.equal(cookie, 'passport_csrf_token=tok123');
  assert.equal(res.data.items[0].title, '国庆出游攻略');
});

test('/api/hot/hackernews Firebase 失败时回退 Algolia', async () => {
  mockFetch([
    ['firebaseio.com', new TypeError('fetch failed')],
    ['hn.algolia.com', fx('hn-algolia.json')],
  ]);
  const res = await call('/api/hot/hackernews');
  assert.equal(res.data.items[0].hot, 845);
});

test('/api/hot/all 部分失败时返回已成功来源与错误', async () => {
  mockFetch([
    ['weibo.com', fx('weibo.json')],
    ['api.zhihu.com', fx('zhihu.json')],
    ['top.baidu.com', new TypeError('fetch failed')],
  ]);
  const res = await call('/api/hot/all', 'sources=weibo,zhihu,baidu&limit=1');
  assert.deepEqual(res.data.sources.map((s) => s.source), ['weibo', 'zhihu']);
  assert.ok(res.data.sources.every((s) => s.items.length === 1));
  assert.deepEqual(res.data.errors.map((e) => e.source), ['baidu']);
  assert.match(res.data.errors[0].message, /无法连接/);

  globalThis.fetch = async () => new Response('x', { status: 500 });
  cache.store.clear();
  await assert.rejects(call('/api/hot/all', 'sources=baidu'), { status: 502 });
});

test('/api/hot/sources 与 /api/hot/news', async () => {
  const { data } = await call('/api/hot/sources');
  assert.deepEqual(data.map((d) => d.id), SOURCE_IDS);
  mockFetch([['sspai.com/feed', fx('sspai.xml')]]);
  const res = await call('/api/hot/news', 'source=sspai');
  assert.equal(res.data.source, 'sspai');
  assert.equal(res.data.title, '少数派');
});

// ---------- 返回字段说明 ----------
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// 除 assertFieldsDocumented 外再核对两点：每个值的实际类型与说明一致；
// 说明里的每个字段都在样例中出现过（即样例覆盖了可选字段，说明里没有写错的路径）
function checkFields(route, samples) {
  const seen = new Set();
  for (const data of samples) {
    assertFieldsDocumented(route, data);
    const visit = (value, path) => {
      if (Array.isArray(value)) return value.forEach((v) => visit(v, `${path}[]`));
      if (!value || typeof value !== 'object') return;
      for (const [k, v] of Object.entries(value)) {
        const p = path ? `${path}.${k}` : k;
        seen.add(p);
        const f = route.fields.find((x) => matcher(x.name).test(p));
        assert.ok(f.type.split('|').includes(typeOf(v)), `${route.path} ${p} 实际为 ${typeOf(v)}，说明写的是 ${f.type}`);
        visit(v, p);
      }
    };
    visit(data, '');
  }
  const unseen = route.fields.filter((f) => ![...seen].some((p) => matcher(f.name).test(p))).map((f) => f.name);
  assert.deepEqual(unseen, [], `${route.path} 的样例没有覆盖这些字段：${unseen.join(', ')}`);
}

const BILI_NAV = JSON.stringify({
  code: -101,
  data: {
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    },
  },
});

// 所有上游的样例响应
const UPSTREAM = [
  ['weibo.com/ajax/side/hotSearch', fx('weibo.json')],
  ['api.zhihu.com', fx('zhihu.json')],
  ['/x/web-interface/nav', BILI_NAV],
  ['/x/web-interface/popular', fx('bilibili-popular.json')],
  ['/x/web-interface/ranking/v2', fx('bilibili-rank.json')],
  ['login_guiding_strategy', '{}'],
  ['douyin.com/aweme', fx('douyin.json')],
  ['top.baidu.com', fx('baidu.html')],
  ['toutiao.com/hot-event', fx('toutiao.json')],
  ['github.com/trending', fx('github.html')],
  ['v2ex.com/api', fx('v2ex.json')],
  ['ithome.com/rss', fx('ithome.xml')],
  ['36kr.com/feed', fx('36kr.xml')],
  ['sspai.com/feed', fx('sspai.xml')],
  // Firebase：41000009 获取失败（404），41000003 已删除
  ['topstories.json', JSON.stringify([41000001, 41000009, 41000002, 41000003])],
  ...json('hn-items.json')
    .filter(Boolean)
    .map((it) => [`/item/${it.id}.json`, JSON.stringify(it)]),
];

// 每个路由的样例请求：[查询参数, 优先匹配的上游 mock]
const FIELD_CASES = {
  '/api/hot/weibo': [['']],
  '/api/hot/zhihu': [[''], ['', [['api.zhihu.com', fx('zhihu-web.json')]]]],
  '/api/hot/bilibili': [['type=popular'], ['type=rank']],
  '/api/hot/douyin': [['']],
  '/api/hot/baidu': [['']],
  '/api/hot/toutiao': [['']],
  '/api/hot/github': [[''], ['since=weekly&language=TypeScript']],
  '/api/hot/v2ex': [['']],
  '/api/hot/news': [['source=ithome'], ['source=36kr'], ['source=sspai']],
  '/api/hot/hackernews': [
    [''],
    ['', [['firebaseio.com', new TypeError('fetch failed')], ['hn.algolia.com', fx('hn-algolia.json')]]],
  ],
  '/api/hot/all': [
    [`sources=${SOURCE_IDS.join(',')}&limit=50`],
    ['sources=weibo,baidu', [['top.baidu.com', new TypeError('fetch failed')]]],
  ],
  '/api/hot/sources': [['']],
};

test('返回字段校验覆盖了全部热榜路由', () => {
  assert.deepEqual(Object.keys(FIELD_CASES).sort(), [...routes.keys()].sort());
});

for (const [path, cases] of Object.entries(FIELD_CASES)) {
  test(`${path} 返回字段都有说明且类型一致`, async () => {
    const samples = [];
    for (const [qs, overrides = []] of cases) {
      cache.store.clear();
      mockFetch([...overrides, ...UPSTREAM]);
      samples.push((await call(path, qs)).data);
    }
    checkFields(routes.get(path), samples);
  });
}

test('RSS：非网址链接置空，无时区的时间按北京时间解析', () => {
  const xml = `<rss><channel><item><title>A</title><guid>tag:example.com,2026:1</guid><pubDate>2026-09-24 08:00:00</pubDate></item>
    <item><title>B</title><link>https://example.com/b</link><pubDate>Thu, 24 Sep 2026 08:00:00 +0000</pubDate></item></channel></rss>`;
  const items = P.parseFeed(xml);
  assert.equal(items[0].url, null);
  assert.equal(items[0].extra?.time, '2026-09-24T00:00:00.000Z');
  assert.equal(items[1].url, 'https://example.com/b');
  assert.equal(items[1].extra?.time, '2026-09-24T08:00:00.000Z');
});

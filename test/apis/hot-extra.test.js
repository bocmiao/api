// 掘金 / CSDN / 百度贴吧热议 三个热榜来源
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../../src/apis/hot/parsers.js';
import hotModules from '../../src/apis/hot/index.js';
import { getHot, SOURCES, SOURCE_IDS } from '../../src/apis/hot/sources.js';
import { sourceFields } from '../../src/apis/hot/fields.js';
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

test('掘金：文章链接、热度、作者与计数', () => {
  const items = P.parseJuejin(json('juejin.json'));
  assertShape(items);
  assert.equal(items.length, 2, '无标题与 null 条目被跳过');
  assert.equal(items[0].url, 'https://juejin.cn/post/7418000000000000001');
  assert.equal(items[0].hot, 6823);
  assert.match(items[0].desc, /首屏加载/);
  assert.deepEqual(items[0].extra, { author: '前端小喵', like: 812, comments: 96 });
  assert.equal(items[1].desc, null);
  assert.equal(items[1].extra.comments, 0);
  assert.throws(() => P.parseJuejin({ err_no: 0, data: {} }), { status: 502, message: /掘金返回的数据格式无法识别/ });
  assert.throws(() => P.parseJuejin({ err_no: 1, err_msg: 'bad request' }), { status: 502, message: /bad request/ });
});

test('CSDN：字符串数字转换、http 链接升级、配图', () => {
  const items = P.parseCsdn(json('csdn.json'));
  assertShape(items);
  assert.equal(items.length, 2);
  assert.equal(items[0].hot, 21563);
  assert.equal(items[0].url, 'https://blog.csdn.net/cat_coder/article/details/142000001');
  assert.deepEqual(items[0].extra, { author: '程序员阿猫', comments: 58, cover: 'https://i-blog.csdnimg.cn/direct/cover1.png' });
  assert.equal(items[1].url, 'https://blog.csdn.net/py_dog/article/details/142000002');
  assert.deepEqual(items[1].extra, { author: 'py_dog', comments: 0 });
  assert.equal(items[1].desc, null);
  assert.throws(() => P.parseCsdn({ code: 200, data: null }), { status: 502, message: /CSDN返回的数据格式无法识别/ });
  assert.throws(() => P.parseCsdn({ code: 400, message: '参数错误' }), { status: 502, message: /参数错误/ });
});

test('贴吧：话题链接、讨论数、导语与创建时间', () => {
  const items = P.parseTieba(json('tieba.json'));
  assertShape(items);
  assert.equal(items.length, 2);
  assert.match(items[0].url, /^https:\/\/tieba\.baidu\.com\/hottopic\/browse\/hottopic\?topic_id=28001234/);
  assert.equal(items[0].hot, 1856432);
  assert.equal(items[0].desc, '今年国庆黄金周，你打算去哪里玩？');
  assert.equal(items[0].extra.time, new Date(1790000000 * 1000).toISOString());
  assert.equal(items[1].desc, null);
  assert.equal(items[1].extra, undefined);
  assert.equal(items[1].url, `https://tieba.baidu.com/hottopic/browse/hottopic?topic_id=28001235&topic_name=${encodeURIComponent('新赛季开赛')}`);
  assert.throws(() => P.parseTieba({ errno: 0, data: {} }), { status: 502, message: /百度贴吧返回的数据格式无法识别/ });
  assert.throws(() => P.parseTieba({ errno: 110003, errmsg: '请求过于频繁' }), { status: 502, message: /请求过于频繁/ });
});

test('贴吧：上游改为返回网页时从页面里解析话题', () => {
  const html = readFileSync(new URL('../fixtures/hot/tieba.html', import.meta.url), 'utf8');
  const items = P.parseTieba(html);
  assertShape(items);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Zuian美签被拒,369紧急出征');
  assert.equal(items[0].hot, 2553000);
  assert.match(items[0].url, /^https:\/\/tieba\.baidu\.com\/hottopic\/browse\/hottopic\?topic_id=28366389&topic_name=/);
  assert.match(items[0].desc, /Zuian/);
  assert.match(items[0].extra.cover, /^https:\/\/tiebapic\.baidu\.com\//);
  assert.equal(items[1].hot, 2328000);
  // 以 JSON 文本返回时照旧解析
  assert.equal(P.parseTieba(JSON.stringify(json('tieba.json'))).length, 2);
  assert.throws(() => P.parseTieba('<html><body>验证</body></html>'), { status: 502, message: /百度贴吧返回的数据格式无法识别/ });
});

// ---------- 注册表与字段说明（mock fetch） ----------
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  cache.store.clear();
});

const UPSTREAM = [
  ['api.juejin.cn/content_api/v1/content/article_rank', fx('juejin.json')],
  ['blog.csdn.net/phoenix/web/blog/hot-rank', fx('csdn.json')],
  ['tieba.baidu.com/hottopic/browse/topicList', fx('tieba.json')],
];

function mockFetch(routes = UPSTREAM) {
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

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// 每个值的类型与说明一致，且说明里的每个字段都在样例中出现过
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

const NEW = { juejin: '掘金热榜', csdn: 'CSDN 热榜', tieba: '百度贴吧热议' };

test('三个来源已加入注册表与 /api/hot/sources', () => {
  for (const [id, title] of Object.entries(NEW)) {
    assert.ok(SOURCE_IDS.includes(id));
    assert.equal(SOURCES[id].title, title);
  }
});

for (const [id, title] of Object.entries(NEW)) {
  test(`${id}：getHot 返回统一结构，字段都有说明且类型一致`, async () => {
    const calls = mockFetch();
    const res = await getHot(id);
    assert.equal(res.data.source, id);
    assert.equal(res.data.title, title);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].headers.referer, '带上 referer');
    checkFields({ path: `/api/hot/${id}`, fields: sourceFields(id) }, [res.data]);
    assert.equal((await getHot(id)).cached, true);
  });
}

test('/api/hot/all 包含新来源，字段说明覆盖', async () => {
  mockFetch();
  const route = hotModules.flatMap((m) => m.routes).find((r) => r.path === '/api/hot/all');
  const res = await route.handler({ query: new URLSearchParams('sources=juejin,csdn,tieba&limit=5') });
  assert.deepEqual(res.data.sources.map((s) => s.source), ['juejin', 'csdn', 'tieba']);
  assert.deepEqual(res.data.errors, []);
  assertFieldsDocumented(route, res.data);
  assert.match(route.fields.find((f) => f.name === 'sources[].source').desc, /juejin（掘金热榜）.*csdn（CSDN 热榜）.*tieba（百度贴吧热议）/);
});

test('上游格式变化时返回 502 并提示格式无法识别', async () => {
  mockFetch([
    ['api.juejin.cn', JSON.stringify({ err_no: 0, data: null })],
    ['blog.csdn.net', '<html>验证</html>'],
    ['tieba.baidu.com', JSON.stringify({ errno: 0, data: { bang_topic: null } })],
  ]);
  await assert.rejects(getHot('juejin'), { status: 502, message: /掘金返回的数据格式无法识别/ });
  await assert.rejects(getHot('csdn'), { status: 502, message: /不是合法 JSON/ });
  await assert.rejects(getHot('tieba'), { status: 502, message: /百度贴吧返回的数据格式无法识别/ });
});

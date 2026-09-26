import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cache } from '../../src/lib/cache.js';
import { assertFieldsDocumented, matcher } from '../helpers/fields.js';
import { parseRates, convert } from '../../src/apis/finance/fx.js';
import { parseQuotes, parseSearch, normalizeSymbol } from '../../src/apis/finance/stock.js';
import { parseEstimate, parseHistory } from '../../src/apis/finance/fund.js';
import { parsePrices, parseMarkets } from '../../src/apis/finance/crypto.js';
import { parseMetals } from '../../src/apis/finance/metals.js';
import finance from '../../src/apis/finance/index.js';

const fx = (name) => readFileSync(new URL(`../fixtures/finance/${name}`, import.meta.url), 'utf8');
const json = (name) => JSON.parse(fx(name));

test('模块注册：每个路由都有 params/desc、source', () => {
  const paths = finance.flatMap((m) => m.routes.map((r) => r.path));
  for (const p of ['/api/fx/rates', '/api/fx/convert', '/api/stock/quote', '/api/stock/search', '/api/fund/estimate',
    '/api/fund/history', '/api/crypto/price', '/api/crypto/markets', '/api/metals']) assert.ok(paths.includes(p), p);
  for (const m of finance) {
    assert.equal(m.category, 'finance');
    assert.ok(m.source);
    for (const r of m.routes) {
      assert.ok(Array.isArray(r.params));
      for (const p of r.params) assert.ok(p.desc, `${r.path} ${p.name}`);
    }
  }
});

test('汇率：解析与换算', () => {
  const r = parseRates(json('er-api-usd.json'));
  assert.equal(r.base, 'USD');
  assert.equal(r.rates.CNY, 7.0512);
  assert.equal(r.updatedAt, '2024-09-23T00:02:31.000Z');
  const c = convert(r, 'CNY', 100);
  assert.equal(c.result, 705.12);
  assert.throws(() => convert(r, 'XXX', 1), { status: 400 });
  assert.throws(() => parseRates({ result: 'error', 'error-type': 'unsupported-code' }), { status: 400 });
  assert.throws(() => parseRates({}), { status: 502 });
});

test('股票代码规范化', () => {
  assert.equal(normalizeSymbol('SH600519'), 'sh600519');
  assert.equal(normalizeSymbol('usaapl'), 'usAAPL');
  assert.equal(normalizeSymbol('hk00700'), 'hk00700');
  assert.equal(normalizeSymbol('us.DJI'), 'us.DJI');
  assert.equal(normalizeSymbol('usBRK.B'), 'usBRK.B');
  assert.equal(normalizeSymbol('sh60051'), null);
  assert.equal(normalizeSymbol('xx123456'), null);
  assert.equal(normalizeSymbol('sh600519"&'), null);
});

test('腾讯行情：A 股 / 港股 / 美股字段映射', () => {
  const [a, h, u, ...rest] = parseQuotes(fx('gtimg-quote.txt'));
  assert.equal(rest.length, 0, '忽略 pv_none_match');

  assert.equal(a.symbol, 'sh600519');
  assert.equal(a.name, '贵州茅台');
  assert.equal(a.code, '600519');
  assert.equal(a.price, 1488);
  assert.equal(a.prevClose, 1478.5);
  assert.equal(a.open, 1480.1);
  assert.equal(a.high, 1495);
  assert.equal(a.low, 1475.21);
  assert.equal(a.change, 9.5);
  assert.equal(a.changePercent, 0.64);
  assert.equal(a.volume, 2845600);
  assert.equal(a.amount, 4230512345);
  assert.equal(a.turnoverRate, 0.23);
  assert.equal(a.pe, 22.02);
  assert.equal(a.marketCap, 1869193000000);
  assert.equal(a.currency, 'CNY');
  assert.equal(a.time, '2024-09-23 15:00:03');

  assert.equal(h.name, '腾讯控股');
  assert.equal(h.enName, 'TENCENT');
  assert.equal(h.price, 424.6);
  assert.equal(h.change, 6.8);
  assert.equal(h.volume, 22153280);
  assert.equal(h.amount, 9376281120);
  assert.equal(h.currency, 'HKD');
  assert.equal(h.time, '2024-09-23 16:08:14');

  assert.equal(u.symbol, 'usAAPL');
  assert.equal(u.code, 'AAPL');
  assert.equal(u.name, '苹果');
  assert.equal(u.price, 226.47);
  assert.equal(u.changePercent, -0.76);
  assert.equal(u.high, 233.09);
  assert.equal(u.volume, 318679888);
  assert.equal(u.currency, 'USD');
  assert.equal(u.time, '2024-09-20 16:00:03');
  assert.equal(u.timezone, 'America/New_York');
  for (const q of [a, h, u]) for (const k of ['price', 'prevClose', 'open', 'change', 'volume', 'amount']) assert.equal(typeof q[k], 'number');
});

test('腾讯搜索：解码 unicode 并生成可查询的 symbol', () => {
  const list = parseSearch(fx('gtimg-search.txt'));
  assert.equal(list.length, 5);
  assert.deepEqual(list[0], { symbol: 'sh600519', market: 'sh', code: '600519', name: '贵州茅台', pinyin: 'gzmt', type: 'GP-A', typeName: 'A股' });
  assert.equal(list[2].symbol, 'hk00700');
  assert.equal(list[3].symbol, 'usAAPL');
  assert.equal(list[3].code, 'AAPL');
  assert.equal(list[4].symbol, null);
  assert.equal(list[4].typeName, '基金');
  assert.deepEqual(parseSearch('v_hint="N";'), []);
  assert.throws(() => parseSearch('<html>'), { status: 502 });
});

test('基金估值', () => {
  const e = parseEstimate(fx('fundgz.txt'));
  assert.equal(e.code, '161725');
  assert.equal(e.name, '招商中证白酒指数(LOF)A');
  assert.equal(e.nav, 0.6621);
  assert.equal(e.estimateNav, 0.6703);
  assert.equal(e.estimateChange, 0.0082);
  assert.equal(e.estimateChangePercent, 1.24);
  assert.equal(e.estimateTime, '2024-09-23 15:00');
  assert.throws(() => parseEstimate('jsonpgz();'), { status: 404 });
  assert.throws(() => parseEstimate('<html>404</html>'), { status: 502 });
});

test('基金历史净值', () => {
  const h = parseHistory(json('fund-lsjz.json'));
  assert.equal(h.total, 1936);
  assert.equal(h.items.length, 3);
  assert.deepEqual(h.items[0], { date: '2024-09-20', nav: 0.6621, accNav: 2.3485, changePercent: -0.45, purchaseStatus: '开放申购', redeemStatus: '开放赎回', dividend: null });
  assert.equal(h.items[1].dividend, '每份派现金0.0100元');
  assert.equal(h.items[1].purchaseStatus, '限制大额申购');
  assert.equal(h.items[2].changePercent, null);
  assert.throws(() => parseHistory({ Data: '', ErrCode: 0 }), { status: 502 });
});

test('CoinGecko 价格与市值排行', () => {
  const p = parsePrices(json('coingecko-price.json'), ['bitcoin', 'ethereum', 'nope'], ['usd', 'cny']);
  assert.deepEqual(p.notFound, ['nope']);
  assert.equal(p.coins[0].prices.usd.price, 63421);
  assert.equal(p.coins[0].prices.cny.price, 447281);
  assert.equal(p.coins[1].prices.usd.changePercent24h, -0.5432109);
  assert.equal(p.coins[0].updatedAt, '2024-09-23T09:00:00.000Z');

  const m = parseMarkets(json('coingecko-markets.json'));
  assert.equal(m[0].symbol, 'BTC');
  assert.equal(m[0].rank, 1);
  assert.equal(m[1].maxSupply, null);
  assert.equal(m[1].changePercent24h, -0.54321);
  assert.throws(() => parseMarkets({ status: { error_code: 429 } }), { status: 502 });
});

test('新浪金银价：国际 USD/oz + 国内 元/克', () => {
  const r = parseMetals(fx('sina-metals.txt'), 7.0512);
  const [gold, silver] = r.international;
  assert.equal(gold.name, '伦敦金（现货黄金）');
  assert.equal(gold.price, 2628.54);
  assert.equal(gold.prevClose, 2621.61);
  assert.equal(gold.change, 6.93);
  assert.equal(gold.changePercent, 0.26);
  assert.equal(gold.time, '2024-09-23 23:59:59');
  assert.equal(gold.cnyPerGram, 595.89);
  assert.equal(silver.price, 30.972);

  const [au, ag] = r.domestic;
  assert.equal(au.name, '黄金连续');
  assert.equal(au.price, 586.5);
  assert.equal(au.prevSettle, 584.1);
  assert.equal(au.change, 2.4);
  assert.equal(au.time, '2024-09-23 15:00:00');
  assert.equal(ag.price, 7.718);
  assert.equal(ag.unit, 'CNY/g');

  const noFx = parseMetals(fx('sina-metals.txt'));
  assert.equal(noFx.international[0].cnyPerGram, undefined);
  assert.throws(() => parseMetals('Forbidden'), { status: 502 });
});

// ---------- 返回字段说明：mock fetch 后调用 handler，校验真实 data ----------
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  cache.store.clear();
});

// 按 URL 片段返回预置响应；body 为 Error 时模拟网络失败
function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    for (const [frag, body] of Object.entries(routes)) {
      if (u.includes(frag)) {
        if (body instanceof Error) throw body;
        return new Response(body, { status: 200 });
      }
    }
    return new Response('no mock', { status: 500 });
  };
  return calls;
}

// 腾讯、新浪行情按 GBK 解码，fixture 是 UTF-8，需先转成 GBK 字节再交给 mock。
// Node 只有 GBK 解码器，这里反查 TextDecoder('gbk') 生成编码表。
let gbkTable;
function gbk(str) {
  if (!gbkTable) {
    gbkTable = new Map();
    const dec = new TextDecoder('gbk');
    for (let hi = 0x81; hi <= 0xfe; hi++) {
      for (let lo = 0x40; lo <= 0xfe; lo++) {
        if (lo === 0x7f) continue;
        const ch = dec.decode(new Uint8Array([hi, lo]));
        if (ch.length === 1 && ch !== '\ufffd' && !gbkTable.has(ch)) gbkTable.set(ch, [hi, lo]);
      }
    }
  }
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else {
      const b = gbkTable.get(ch);
      assert.ok(b, `无法用 GBK 编码：${ch}`);
      out.push(...b);
    }
  }
  return new Uint8Array(out);
}

const routeMap = new Map(finance.flatMap((m) => m.routes.map((r) => [r.path, r])));
const call = (path, qs = '') => routeMap.get(path).handler({ query: new URLSearchParams(qs), params: {} });

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
function walk(value, prefix, fn) {
  if (Array.isArray(value)) {
    for (const v of value) walk(v, `${prefix}[]`, fn);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = prefix ? `${prefix}.${k}` : k;
      fn(p, v);
      walk(v, p, fn);
    }
  }
}

// 1) 每个返回字段都有说明；2) 实际类型在说明的 type 之内；
// 3) 样例数据覆盖了说明里的每个字段，且至少出现一次非 null 值（防止说明过时、fixture 覆盖不全）
function checkFields(route, ...samples) {
  for (const s of samples) assertFieldsDocumented(route, s);
  const patterns = route.fields.map((f) => ({ f, re: matcher(f.name) }));
  const seen = new Set();
  for (const s of samples) {
    walk(s, '', (path, v) => {
      if (v === undefined) return; // JSON 输出时会被省略
      for (const { f, re } of patterns) {
        if (!re.test(path)) continue;
        assert.ok(f.type.split('|').includes(typeOf(v)), `${route.path} ${path} 实际类型为 ${typeOf(v)}，说明写的是 ${f.type}`);
        if (v !== null) seen.add(f.name);
      }
    });
  }
  const uncovered = route.fields.map((f) => f.name).filter((n) => !seen.has(n));
  assert.deepEqual(uncovered, [], `${route.path} 的样例数据没有覆盖这些字段（或始终为 null）：${uncovered.join(', ')}`);
}

test('字段说明：/api/fx/rates', async () => {
  const calls = mockFetch({ 'open.er-api.com/v6/latest/USD': fx('er-api-usd.json') });
  const all = await call('/api/fx/rates', 'base=usd');
  assert.equal(all.data.rates.CNY, 7.0512);
  const some = await call('/api/fx/rates', 'base=USD&symbols=cny,EUR,XXX');
  assert.deepEqual(some.data.rates, { CNY: 7.0512, EUR: 0.896153 });
  assert.equal(calls.length, 1, '同一基准货币命中缓存');
  checkFields(routeMap.get('/api/fx/rates'), all.data, some.data);
});

test('字段说明：/api/fx/convert', async () => {
  mockFetch({ 'open.er-api.com/v6/latest/USD': fx('er-api-usd.json') });
  const res = await call('/api/fx/convert', 'from=usd&to=cny&amount=100');
  assert.deepEqual(res.data, { from: 'USD', to: 'CNY', amount: 100, rate: 7.0512, result: 705.12, updatedAt: '2024-09-23T00:02:31.000Z' });
  checkFields(routeMap.get('/api/fx/convert'), res.data);
});

test('字段说明：/api/stock/quote（A 股 / 港股 / 美股 + 未找到）', async () => {
  const calls = mockFetch({ 'qt.gtimg.cn': gbk(fx('gtimg-quote.txt')) });
  const res = await call('/api/stock/quote', 'symbols=SH600519,hk00700,usaapl,sz000001');
  assert.match(calls[0], /q=sh600519,hk00700,usAAPL,sz000001$/);
  const [a, h, u] = res.data.quotes;
  assert.equal(a.name, '贵州茅台', 'GBK 解码正确');
  assert.deepEqual(res.data.notFound, ['sz000001']);
  // 市场差异：A 股无 enName，港股/美股无 turnoverRate
  const out = JSON.parse(JSON.stringify(res.data));
  assert.ok(!('enName' in out.quotes[0]) && 'turnoverRate' in out.quotes[0]);
  for (const q of out.quotes.slice(1)) assert.ok('enName' in q && !('turnoverRate' in q));
  assert.equal(h.enName, 'TENCENT');
  assert.equal(u.enName, 'Apple Inc.');
  assert.equal(h.marketCap, 3966883000000);
  assert.equal(u.amount, 72346754380);
  checkFields(routeMap.get('/api/stock/quote'), res.data);
});

test('字段说明：/api/stock/search', async () => {
  mockFetch({ 'smartbox.gtimg.cn': gbk(fx('gtimg-search.txt')) });
  const res = await call('/api/stock/search', 'q=茅台');
  assert.equal(res.data.length, 5);
  assert.equal(res.data[1].name, '茅台概念ETF');
  checkFields(routeMap.get('/api/stock/search'), res.data);
});

test('字段说明：/api/fund/estimate', async () => {
  const calls = mockFetch({ 'fundgz.1234567.com.cn/js/161725.js': fx('fundgz.txt') });
  const res = await call('/api/fund/estimate', 'code=161725');
  assert.equal(calls.length, 1);
  assert.equal(res.data.estimateChangePercent, 1.24);
  assert.equal(res.data.estimated, true);
  // 估值服务返回格式变了：退回最新净值，名称从基金搜索补上
  mockFetch({
    'fundgz.1234567.com.cn/js/000001.js': '<html>error</html>',
    'api.fund.eastmoney.com/f10/lsjz': fx('fund-lsjz.json'),
    'fundsuggest.eastmoney.com': JSON.stringify({ Datas: [{ CODE: '000001', NAME: '华夏成长混合' }] }),
  });
  const fb = await call('/api/fund/estimate', 'code=000001');
  assert.equal(fb.data.estimated, false);
  assert.equal(fb.data.name, '华夏成长混合');
  assert.equal(typeof fb.data.nav, 'number');
  assert.equal(fb.data.estimateNav, null);
  // 净值也取不到时报原来的错误
  mockFetch({ 'fundgz.1234567.com.cn/js/000002.js': 'jsonpgz();' });
  await assert.rejects(call('/api/fund/estimate', 'code=000002'), { status: 404 });
  checkFields(routeMap.get('/api/fund/estimate'), res.data, fb.data);
});

test('字段说明：/api/fund/history', async () => {
  const calls = mockFetch({ 'api.fund.eastmoney.com/f10/lsjz': fx('fund-lsjz.json') });
  const res = await call('/api/fund/history', 'code=161725&size=3&start=2024-09-01');
  assert.match(calls[0], /fundCode=161725&pageIndex=1&pageSize=3&startDate=2024-09-01&endDate=$/);
  assert.equal(res.data.code, '161725');
  assert.equal(res.data.items.length, 3);
  checkFields(routeMap.get('/api/fund/history'), res.data);
});

test('字段说明：/api/crypto/price', async () => {
  const calls = mockFetch({ 'api.coingecko.com/api/v3/simple/price': fx('coingecko-price.json') });
  const res = await call('/api/crypto/price', 'ids=bitcoin,ethereum,nope&vs=USD,cny');
  assert.match(calls[0], /ids=bitcoin%2Cethereum%2Cnope&vs_currencies=usd%2Ccny/);
  assert.deepEqual(res.data.notFound, ['nope']);
  assert.deepEqual(Object.keys(res.data.coins[0].prices), ['usd', 'cny']);
  checkFields(routeMap.get('/api/crypto/price'), res.data);
});

test('字段说明：/api/crypto/markets', async () => {
  mockFetch({ 'api.coingecko.com/api/v3/coins/markets': fx('coingecko-markets.json') });
  const res = await call('/api/crypto/markets', 'vs=usd&limit=2');
  assert.equal(res.data.length, 2);
  assert.equal(res.data[0].priceChange24h, 773.45);
  checkFields(routeMap.get('/api/crypto/markets'), res.data);
});

test('字段说明：/api/metals（有汇率 / 汇率不可用）', async () => {
  mockFetch({ 'hq.sinajs.cn': gbk(fx('sina-metals.txt')), 'open.er-api.com/v6/latest/USD': fx('er-api-usd.json') });
  const withFx = (await call('/api/metals')).data;
  assert.equal(withFx.usdCny, 7.0512);
  assert.equal(withFx.international[0].name, '伦敦金（现货黄金）', 'GBK 解码正确');
  assert.equal(withFx.international[0].cnyPerGram, 595.89);
  assert.equal(withFx.domestic[1].price, 7.718);

  cache.store.clear();
  mockFetch({ 'hq.sinajs.cn': gbk(fx('sina-metals.txt')), 'open.er-api.com': new TypeError('network') });
  const noFx = (await call('/api/metals')).data;
  assert.equal(noFx.usdCny, null);
  assert.ok(noFx.international.every((q) => !('cnyPerGram' in q)));
  checkFields(routeMap.get('/api/metals'), withFx, noFx);
});

test('B 股按代码前缀标注计价货币', async () => {
  const { parseQuoteFields } = await import('../../src/apis/finance/stock.js');
  const fields = (code) => ['1', 'B股', code, '1.23', '1.20', '1.21', ...Array(80).fill('')];
  assert.equal(parseQuoteFields('sh900901', fields('900901')).currency, 'USD');
  assert.equal(parseQuoteFields('sz200002', fields('200002')).currency, 'HKD');
  assert.equal(parseQuoteFields('sh600519', fields('600519')).currency, 'CNY');
});

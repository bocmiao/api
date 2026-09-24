import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.equal(h.items[2].changePercent, null);
  assert.throws(() => parseHistory({ Data: '', ErrCode: 0 }), { status: 502 });
});

test('CoinGecko 价格与市值排行', () => {
  const p = parsePrices(json('coingecko-price.json'), ['bitcoin', 'ethereum', 'nope'], ['usd', 'cny']);
  assert.deepEqual(p.notFound, ['nope']);
  assert.equal(p.coins[0].prices.usd.price, 63421);
  assert.equal(p.coins[0].prices.cny.price, 447281);
  assert.equal(p.coins[1].prices.usd.change24h, -0.5432109);
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

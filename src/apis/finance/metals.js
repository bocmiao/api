import { cache } from '../../lib/cache.js';
import { fetchText, HttpError } from '../../lib/http.js';
import { loadRates } from './fx.js';

const URL_ = 'https://hq.sinajs.cn/list=hf_XAU,hf_XAG,nf_AU0,nf_AG0';
const HEADERS = { referer: 'https://finance.sina.com.cn/' };
const OZ_GRAMS = 31.1034768;

const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const round = (n, d = 4) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

// var hq_str_hf_XAU="2628.54,,2628.36,2628.72,2631.20,2617.93,23:59:59,2621.61,2622.21,0,0,0,2024-09-23,伦敦金（现货黄金）";
export function parseSinaVars(text) {
  const out = {};
  for (const m of text.matchAll(/var hq_str_([A-Za-z0-9_]+)="([^"]*)";?/g)) out[m[1]] = m[2] ? m[2].split(',') : null;
  return out;
}

// 外盘期货/现货 hf_：0 最新价 2 买价 3 卖价 4 最高 5 最低 6 时间 7 昨收 8 今开 12 日期 13 名称
function parseHf(f) {
  const price = num(f[0]);
  const prevClose = num(f[7]);
  const change = price != null && prevClose ? round(price - prevClose) : null;
  return {
    name: f[13] || null,
    price,
    prevClose,
    open: num(f[8]),
    high: num(f[4]),
    low: num(f[5]),
    bid: num(f[2]),
    ask: num(f[3]),
    change,
    changePercent: change != null ? round((change / prevClose) * 100, 2) : null,
    time: f[12] && f[6] ? `${f[12]} ${f[6]}` : null,
  };
}

// 国内期货 nf_：0 名称 1 时间 HHmmss 2 今开 3 最高 4 最低 5 昨收 6 买价 7 卖价 8 最新价 9 均价 10 昨结算 13 持仓 14 成交量 17 日期
function parseNf(f, divisor = 1) {
  const d = (v) => (num(v) == null ? null : round(num(v) / divisor));
  const price = d(f[8]);
  const ref = d(f[10]) || d(f[5]);
  const change = price != null && ref ? round(price - ref) : null;
  const t = /^(\d{2})(\d{2})(\d{2})$/.exec(f[1] || '');
  return {
    name: f[0] || null,
    price,
    prevSettle: d(f[10]),
    prevClose: d(f[5]),
    open: d(f[2]),
    high: d(f[3]),
    low: d(f[4]),
    change,
    changePercent: change != null ? round((change / ref) * 100, 2) : null,
    volume: num(f[14]),
    openInterest: num(f[13]),
    time: f[17] && t ? `${f[17]} ${t[1]}:${t[2]}:${t[3]}` : null,
  };
}

export function parseMetals(text, usdCny = null) {
  const v = parseSinaVars(text);
  if (!Object.keys(v).length) throw new HttpError(502, '新浪行情返回的数据格式无法识别');
  const intl = (key, metal) => {
    if (!v[key] || v[key].length < 13) return null;
    const q = { metal, symbol: key, unit: 'USD/oz', timezone: 'Asia/Shanghai', ...parseHf(v[key]) };
    if (usdCny && q.price != null) q.cnyPerGram = round((q.price * usdCny) / OZ_GRAMS, 2);
    return q;
  };
  const dom = (key, metal, divisor) => {
    if (!v[key] || v[key].length < 15) return null;
    // 沪银报价单位为 元/千克，统一换算为 元/克
    return { metal, symbol: key, unit: 'CNY/g', exchange: 'SHFE', timezone: 'Asia/Shanghai', ...parseNf(v[key], divisor) };
  };
  return {
    international: [intl('hf_XAU', 'gold'), intl('hf_XAG', 'silver')].filter(Boolean),
    domestic: [dom('nf_AU0', 'gold', 1), dom('nf_AG0', 'silver', 1000)].filter(Boolean),
    usdCny,
  };
}

export default {
  name: 'metals',
  category: 'finance',
  title: '金价银价',
  description: '国际现货黄金/白银（美元/盎司）与上期所沪金/沪银主连（元/克）',
  source: '新浪财经',
  unofficial: true,
  routes: [
    {
      method: 'GET',
      path: '/api/metals',
      summary: '黄金、白银实时价格（国际 + 国内）',
      params: [],
      fields: [
        { name: 'international', type: 'array', desc: '国际现货（新浪 hf_ 行情）：伦敦金 hf_XAU、伦敦银 hf_XAG，价格单位均为 美元/盎司（金衡盎司，1 盎司 = 31.1034768 克）。上游缺少某个品种时该项不出现' },
        { name: 'international[].metal', type: 'string', desc: '品种：gold 黄金 / silver 白银' },
        { name: 'international[].symbol', type: 'string', desc: '新浪行情代码：hf_XAU（伦敦金）或 hf_XAG（伦敦银）' },
        { name: 'international[].unit', type: 'string', desc: '价格单位，固定为 USD/oz（美元/盎司）' },
        { name: 'international[].timezone', type: 'string', desc: 'time 所用时区，固定为 Asia/Shanghai（北京时间）' },
        { name: 'international[].name', type: 'string|null', desc: '新浪给出的品种名称（如 伦敦金（现货黄金））；上游为空时为 null' },
        { name: 'international[].price', type: 'number|null', desc: '最新价（美元/盎司）；上游为空时为 null' },
        { name: 'international[].prevClose', type: 'number|null', desc: '昨收价（美元/盎司）；上游为空时为 null' },
        { name: 'international[].open', type: 'number|null', desc: '今开价（美元/盎司）；上游为空时为 null' },
        { name: 'international[].high', type: 'number|null', desc: '今日最高价（美元/盎司）；上游为空时为 null' },
        { name: 'international[].low', type: 'number|null', desc: '今日最低价（美元/盎司）；上游为空时为 null' },
        { name: 'international[].bid', type: 'number|null', desc: '买价（美元/盎司）；上游为空时为 null' },
        { name: 'international[].ask', type: 'number|null', desc: '卖价（美元/盎司）；上游为空时为 null' },
        { name: 'international[].change', type: 'number|null', desc: '涨跌额（美元/盎司）= price − prevClose，保留 4 位小数；price 或 prevClose 为空时为 null' },
        { name: 'international[].changePercent', type: 'number|null', desc: '涨跌幅，百分数（0.26 表示 +0.26%），相对 prevClose，保留 2 位小数；change 为 null 时为 null' },
        { name: 'international[].time', type: 'string|null', desc: '行情时间，格式 YYYY-MM-DD HH:mm:ss，北京时间（UTC+8）；上游缺日期或时间时为 null' },
        { name: 'international[].cnyPerGram', type: 'number', desc: '按 usdCny 折算的人民币价格（元/克）= price × usdCny ÷ 31.1034768，保留 2 位小数，仅为汇率折算的参考值，不是国内市场成交价。仅在汇率获取成功（usdCny 不为 null）且 price 不为空时出现，否则不返回该字段' },
        { name: 'domestic', type: 'array', desc: '上海期货交易所（SHFE）沪金、沪银主力连续合约（新浪 nf_AU0 / nf_AG0），价格单位均为 元/克（沪银上游报价为 元/千克，已 ÷ 1000 换算为元/克）。上游缺少某个品种时该项不出现' },
        { name: 'domestic[].metal', type: 'string', desc: '品种：gold 黄金 / silver 白银' },
        { name: 'domestic[].symbol', type: 'string', desc: '新浪行情代码：nf_AU0（沪金连续）或 nf_AG0（沪银连续）' },
        { name: 'domestic[].unit', type: 'string', desc: '价格单位，固定为 CNY/g（人民币元/克）' },
        { name: 'domestic[].exchange', type: 'string', desc: '交易所，固定为 SHFE（上海期货交易所）' },
        { name: 'domestic[].timezone', type: 'string', desc: 'time 所用时区，固定为 Asia/Shanghai（北京时间）' },
        { name: 'domestic[].name', type: 'string|null', desc: '新浪给出的合约名称（如 黄金连续、白银连续）；上游为空时为 null' },
        { name: 'domestic[].price', type: 'number|null', desc: '最新价（元/克）；上游为空时为 null' },
        { name: 'domestic[].prevSettle', type: 'number|null', desc: '昨日结算价（元/克）；上游为空时为 null' },
        { name: 'domestic[].prevClose', type: 'number|null', desc: '昨日收盘价（元/克）；上游为空时为 null' },
        { name: 'domestic[].open', type: 'number|null', desc: '今开价（元/克）；上游为空时为 null' },
        { name: 'domestic[].high', type: 'number|null', desc: '今日最高价（元/克）；上游为空时为 null' },
        { name: 'domestic[].low', type: 'number|null', desc: '今日最低价（元/克）；上游为空时为 null' },
        { name: 'domestic[].change', type: 'number|null', desc: '涨跌额（元/克）= price − 昨结算价（按期货惯例以昨结算为基准；昨结算为空或为 0 时改用昨收），保留 4 位小数；无法计算时为 null' },
        { name: 'domestic[].changePercent', type: 'number|null', desc: '涨跌幅，百分数（0.41 表示 +0.41%），基准与 change 相同，保留 2 位小数；change 为 null 时为 null' },
        { name: 'domestic[].volume', type: 'number|null', desc: '成交量，单位为手，未换算（沪金 1 手 = 1000 克，沪银 1 手 = 15 千克）；上游为空时为 null' },
        { name: 'domestic[].openInterest', type: 'number|null', desc: '持仓量，单位为手；上游为空时为 null' },
        { name: 'domestic[].time', type: 'string|null', desc: '行情时间，格式 YYYY-MM-DD HH:mm:ss，北京时间（UTC+8）；上游缺日期或时间时为 null' },
        { name: 'usdCny', type: 'number|null', desc: '折算 cnyPerGram 所用的美元兑人民币汇率（1 美元 = usdCny 元人民币），来自 ExchangeRate-API 每日参考汇率（与 /api/fx/rates 相同）；汇率获取失败时为 null，此时 international[] 不含 cnyPerGram' },
      ],
      async handler() {
        return cache.wrap('metals', 60_000, async () => {
          const text = await fetchText(URL_, { encoding: 'gbk', headers: HEADERS });
          let usdCny = null;
          try {
            usdCny = (await loadRates('USD')).data.rates.CNY ?? null;
          } catch {
            // 汇率不可用时仅不提供人民币折算
          }
          return parseMetals(text, usdCny);
        });
      },
    },
  ],
};

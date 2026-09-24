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

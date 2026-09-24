import { cache } from '../../lib/cache.js';
import { fetchText, HttpError, param } from '../../lib/http.js';

const QUOTE_URL = 'https://qt.gtimg.cn/q=';
const SEARCH_URL = 'https://smartbox.gtimg.cn/s3/?v=2&t=all&c=1&q=';
const HEADERS = { referer: 'https://gu.qq.com/' };
const QUOTE_TTL = 30_000;
const SEARCH_TTL = 10 * 60_000;
const MAX_SYMBOLS = 30;

// sh600519 / sz000001 / bj430047 / hk00700 / hkHSI / usAAPL / usBRK.B / us.DJI
const SYMBOL_RE = /^(?:(?:sh|sz|bj)\d{6}|hk\d{5}|hk[A-Z]{2,8}|us\.?[A-Z][A-Z0-9.-]{0,9})$/;

export function normalizeSymbol(s) {
  const t = s.trim();
  const m = /^([a-zA-Z]{2})(.+)$/.exec(t);
  if (!m) return null;
  const prefix = m[1].toLowerCase();
  const rest = prefix === 'us' || prefix === 'hk' ? m[2].toUpperCase() : m[2];
  const sym = prefix + rest;
  return SYMBOL_RE.test(sym) ? sym : null;
}

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round = (n, d = 4) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

// 统一时间为 "YYYY-MM-DD HH:mm:ss"（交易所当地时间）
function normTime(s) {
  if (!s) return null;
  let m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  m = /^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] ?? '00'}`;
  return s;
}

const MARKETS = {
  sh: { market: 'SH', currency: 'CNY', timezone: 'Asia/Shanghai' },
  sz: { market: 'SZ', currency: 'CNY', timezone: 'Asia/Shanghai' },
  bj: { market: 'BJ', currency: 'CNY', timezone: 'Asia/Shanghai' },
  hk: { market: 'HK', currency: 'HKD', timezone: 'Asia/Hong_Kong' },
  us: { market: 'US', currency: 'USD', timezone: 'America/New_York' },
};

// 解析单条行情字段数组。字段位置（~ 分隔）：
// 通用：1 名称 2 代码 3 现价 4 昨收 5 今开 6 成交量 30 时间 31 涨跌额 32 涨跌幅% 33 最高 34 最低
// A 股：36 成交量(手) 37 成交额(万元) 38 换手率% 39 市盈率 44 流通市值(亿) 45 总市值(亿) 46 市净率
// 港股：6/36 成交量(股) 37 成交额(港元) 39 市盈率 44/45 市值(亿) 46 英文名
// 美股：35 币种 6/36 成交量(股) 37 成交额(美元) 39 市盈率 45 总市值(亿) 46 英文名
export function parseQuoteFields(symbol, f) {
  const prefix = symbol.slice(0, 2);
  const info = MARKETS[prefix];
  const price = num(f[3]);
  const prevClose = num(f[4]);
  let change = num(f[31]);
  let changePercent = num(f[32]);
  if (change == null && price != null && prevClose) change = round(price - prevClose);
  if (changePercent == null && change != null && prevClose) changePercent = round((change / prevClose) * 100, 2);

  let volume;
  let amount;
  if (prefix === 'hk' || prefix === 'us') {
    volume = num(f[36]) ?? num(f[6]);
    amount = num(f[37]);
  } else {
    const lots = num(f[36]) ?? num(f[6]);
    volume = lots == null ? null : lots * 100; // 手 → 股
    // 35 为 "现价/成交量(手)/成交额(元)"，比 37（万元）更精确
    const exact = num((f[35] || '').split('/')[2]);
    const wan = num(f[37]);
    amount = exact ?? (wan == null ? null : round(wan * 10000, 2));
  }

  const code = prefix === 'us' ? (f[2] || '').split('.')[0] || symbol.slice(2) : f[2] || symbol.slice(2);
  const ext = {};
  if (prefix !== 'hk' && prefix !== 'us') ext.turnoverRate = num(f[38]);
  const marketCap = num(f[45]);
  return {
    symbol,
    code,
    name: f[1] || null,
    enName: prefix === 'hk' || prefix === 'us' ? f[46] || null : undefined,
    market: info.market,
    currency: prefix === 'us' && /^[A-Z]{3}$/.test(f[35] || '') ? f[35] : info.currency,
    price,
    prevClose,
    open: num(f[5]),
    high: num(f[33]),
    low: num(f[34]),
    change,
    changePercent,
    volume,
    amount,
    ...ext,
    pe: num(f[39]),
    marketCap: marketCap == null ? null : round(marketCap * 1e8, 0), // 亿 → 元
    time: normTime(f[30]),
    timezone: info.timezone,
  };
}

// 原始响应：v_sh600519="1~贵州茅台~600519~...";  无效代码：v_pv_none_match="1";
export function parseQuotes(text) {
  const out = [];
  const re = /v_([A-Za-z0-9._-]+)="([^"]*)";?/g;
  for (const m of text.matchAll(re)) {
    const key = m[1];
    if (key.startsWith('pv_none_match') || key.startsWith('s_')) continue;
    const sym = normalizeSymbol(key);
    if (!sym) continue;
    const f = m[2].split('~');
    if (f.length < 35 || !f[1]) continue;
    out.push(parseQuoteFields(sym, f));
  }
  return out;
}

// smartbox：v_hint="sh~600519~贵州茅台~gzmt~GP-A^hk~..."; 无结果为 v_hint="N";
const TYPE_NAMES = {
  'GP-A': 'A股', 'GP-B': 'B股', GP: '股票', ZS: '指数', ETF: 'ETF', LOF: 'LOF', KJ: '基金', QDII: 'QDII',
  ZQ: '债券', KZZ: '可转债', FJ: '分级基金', QH: '期货',
};

const unescapeUnicode = (s) => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

export function parseSearch(text) {
  const m = /v_hint="([^"]*)"/.exec(text);
  if (!m) throw new HttpError(502, '股票搜索返回的数据格式无法识别');
  const body = m[1];
  if (!body || body === 'N') return [];
  return body.split('^').map((item) => {
    const [market, rawCode = '', name = '', pinyin = '', type = ''] = item.split('~');
    let symbol = null;
    const code = rawCode.toUpperCase();
    if (market === 'us') symbol = normalizeSymbol('us' + code.split('.')[0]);
    else if (['sh', 'sz', 'bj', 'hk'].includes(market)) symbol = normalizeSymbol(market + rawCode);
    const [baseType] = type.split('-');
    return {
      symbol,
      market,
      code: market === 'us' ? code.split('.')[0] : rawCode,
      name: unescapeUnicode(name),
      pinyin: pinyin || null,
      type,
      typeName: TYPE_NAMES[type] ?? TYPE_NAMES[baseType] ?? (type || null),
    };
  }).filter((x) => x.code);
}

export default {
  name: 'stock',
  category: 'finance',
  title: '股票行情',
  description: 'A 股 / 港股 / 美股实时行情与代码搜索',
  source: '腾讯财经 (qt.gtimg.cn)',
  unofficial: true,
  routes: [
    {
      method: 'GET',
      path: '/api/stock/quote',
      summary: '批量查询实时行情',
      params: [
        {
          name: 'symbols',
          required: true,
          desc: `股票代码，逗号分隔，最多 ${MAX_SYMBOLS} 个。前缀 sh/sz/bj（A 股 6 位）、hk（港股 5 位）、us（美股代码）`,
          example: 'sh600519,hk00700,usAAPL',
        },
      ],
      async handler({ query }) {
        const raw = param(query, 'symbols', { required: true, max: 400 });
        const list = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
        if (!list.length) throw new HttpError(400, '缺少参数 symbols');
        if (list.length > MAX_SYMBOLS) throw new HttpError(400, `symbols 最多 ${MAX_SYMBOLS} 个`);
        const symbols = list.map((s) => {
          const n = normalizeSymbol(s);
          if (!n) throw new HttpError(400, `股票代码不合法：${s}`);
          return n;
        });
        const key = symbols.join(',');
        const res = await cache.wrap(`stock:q:${key}`, QUOTE_TTL, async () => {
          const text = await fetchText(QUOTE_URL + symbols.map(encodeURIComponent).join(','), { encoding: 'gbk', headers: HEADERS });
          return parseQuotes(text);
        });
        const found = new Set(res.data.map((q) => q.symbol));
        return { ...res, data: { quotes: res.data, notFound: symbols.filter((s) => !found.has(s)) } };
      },
    },
    {
      method: 'GET',
      path: '/api/stock/search',
      summary: '按名称 / 代码 / 拼音搜索股票、指数、基金',
      params: [{ name: 'q', required: true, desc: '关键词', example: '茅台' }],
      async handler({ query }) {
        const q = param(query, 'q', { required: true, max: 20 }).trim();
        if (!q || /[\u0000-\u001f"<>]/.test(q)) throw new HttpError(400, 'q 参数不合法');
        return cache.wrap(`stock:s:${q.toLowerCase()}`, SEARCH_TTL, async () => {
          const text = await fetchText(SEARCH_URL + encodeURIComponent(q), { encoding: 'gbk', headers: HEADERS });
          return parseSearch(text);
        });
      },
    },
  ],
};

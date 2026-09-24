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
// 计价货币：B 股按代码前缀区分（沪市 900 开头为美元，深市 200 开头为港元），美股取上游币种字段
function currencyOf(prefix, code, f, info) {
  if (prefix === 'sh' && code.startsWith('900')) return 'USD';
  if (prefix === 'sz' && code.startsWith('200')) return 'HKD';
  if (prefix === 'us' && /^[A-Z]{3}$/.test(f[35] || '')) return f[35];
  return info.currency;
}

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
    currency: currencyOf(prefix, code, f, info),
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
      fields: [
        { name: 'quotes', type: 'array', desc: '查到的行情，每个代码一项，顺序同上游返回。各市场字段基本相同，差异：enName 只在港股、美股出现；turnoverRate 只在 A 股（sh/sz/bj）出现；成交额、市值的货币随市场不同（见 currency）' },
        { name: 'quotes[].symbol', type: 'string', desc: '规范化后的代码：小写市场前缀 + 代码，港股、美股代码部分为大写，如 sh600519、hk00700、usAAPL（大小写可能与请求时的写法不同）' },
        { name: 'quotes[].code', type: 'string', desc: '不带市场前缀的代码：A 股 6 位数字（如 600519），港股 5 位数字（如 00700），美股为去掉交易所后缀的代码（上游 AAPL.OQ → AAPL）' },
        { name: 'quotes[].name', type: 'string', desc: '中文简称（如 贵州茅台、腾讯控股、苹果）' },
        { name: 'quotes[].enName', type: 'string|null', desc: '英文名称（如 TENCENT、Apple Inc.）。仅港股、美股有此字段，上游为空时为 null；A 股不返回该字段' },
        { name: 'quotes[].market', type: 'string', desc: '市场：SH 上交所、SZ 深交所、BJ 北交所、HK 港股、US 美股' },
        { name: 'quotes[].currency', type: 'string', desc: '价格、成交额、市值的计价货币：A 股（sh/sz/bj）为 CNY（人民币元），其中沪市 B 股（900 开头）为 USD、深市 B 股（200 开头）为 HKD；港股为 HKD（港元）；美股取上游给出的币种（通常为 USD 美元）' },
        { name: 'quotes[].price', type: 'number|null', desc: '最新价，每股价格，单位见 currency（元/港元/美元）；上游为空时为 null' },
        { name: 'quotes[].prevClose', type: 'number|null', desc: '昨日收盘价（每股，单位见 currency）；上游为空时为 null' },
        { name: 'quotes[].open', type: 'number|null', desc: '今日开盘价（每股，单位见 currency）；上游为空时为 null' },
        { name: 'quotes[].high', type: 'number|null', desc: '今日最高价（每股，单位见 currency）；上游为空时为 null' },
        { name: 'quotes[].low', type: 'number|null', desc: '今日最低价（每股，单位见 currency）；上游为空时为 null' },
        { name: 'quotes[].change', type: 'number|null', desc: '涨跌额 = 最新价 − 昨收（每股，单位见 currency）。上游未给出时用 price − prevClose 计算（保留 4 位小数），仍无法计算时为 null' },
        { name: 'quotes[].changePercent', type: 'number|null', desc: '涨跌幅，百分数（0.64 表示 +0.64%，-0.76 表示 -0.76%）。上游未给出时按 change ÷ prevClose × 100 计算（保留 2 位小数），仍无法计算时为 null' },
        { name: 'quotes[].volume', type: 'number|null', desc: '成交量，单位统一为"股"：A 股上游单位为手，已按 1 手 = 100 股换算；港股、美股上游即为股。上游为空时为 null' },
        { name: 'quotes[].amount', type: 'number|null', desc: '成交额，单位为 currency 对应货币的"元"（不是万元）：A 股为人民币元（优先取上游精确到元的值，否则由上游的万元 × 10000 换算），港股为港元，美股为美元。上游为空时为 null' },
        { name: 'quotes[].turnoverRate', type: 'number|null', desc: '换手率，百分数（0.23 表示 0.23%）。仅 A 股有此字段，港股、美股不返回；上游为空时为 null' },
        { name: 'quotes[].pe', type: 'number|null', desc: '市盈率（倍，腾讯行情口径）；上游为空时为 null' },
        { name: 'quotes[].marketCap', type: 'number|null', desc: '总市值，单位为 currency 对应货币的"元"（A 股人民币元、港股港元、美股美元），已由上游的"亿"换算，如 1869193000000 表示 18691.93 亿元；上游为空时为 null' },
        { name: 'quotes[].time', type: 'string|null', desc: '行情时间，格式 YYYY-MM-DD HH:mm:ss，为交易所当地时间（时区见 timezone，不是 UTC）；上游为空时为 null，格式无法识别时原样返回' },
        { name: 'quotes[].timezone', type: 'string', desc: 'time 所用时区（IANA 名称）：A 股 Asia/Shanghai（UTC+8），港股 Asia/Hong_Kong（UTC+8），美股 America/New_York（美东时间，冬令时 UTC-5、夏令时 UTC-4）' },
        { name: 'notFound', type: 'array', desc: '请求了但没有查到行情的代码（字符串数组，规范化后的写法，如 sz000001），代码不存在或上游无数据时出现在这里；都查到时为空数组' },
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
      fields: [
        { name: '[].symbol', type: 'string|null', desc: '可直接传给 /api/stock/quote 的代码（如 sh600519、hk00700、usAAPL）；市场不是 sh/sz/bj/hk/us（如场外基金 jj）或代码格式不受支持时为 null' },
        { name: '[].market', type: 'string', desc: '上游市场标识（小写，原样返回），如 sh 上交所、sz 深交所、bj 北交所、hk 港股、us 美股、jj 场外基金' },
        { name: '[].code', type: 'string', desc: '代码：A 股、港股、基金原样返回（如 600519、00700、161725）；美股转为大写并去掉交易所后缀（上游 aapl.oq → AAPL）' },
        { name: '[].name', type: 'string', desc: '中文名称（已解码上游的 \\uXXXX 转义）' },
        { name: '[].pinyin', type: 'string|null', desc: '名称的拼音首字母缩写（如 gzmt）；上游为空时为 null' },
        { name: '[].type', type: 'string', desc: '上游原始类型代码，如 GP-A（A 股）、GP（股票）、ZS（指数）、ETF、KJ-LOF（LOF 基金）；上游为空时为空字符串' },
        { name: '[].typeName', type: 'string|null', desc: '类型中文名：A股、B股、股票、指数、ETF、LOF、基金、QDII、债券、可转债、分级基金、期货之一。先按完整 type 匹配，再按"-"前的部分匹配（如 KJ-LOF → 基金）；都匹配不上时返回原始 type，type 为空时为 null' },
      ],
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

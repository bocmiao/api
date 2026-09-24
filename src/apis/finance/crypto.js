import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError, param } from '../../lib/http.js';

const BASE = 'https://api.coingecko.com/api/v3';
const IDS_RE = /^[a-z0-9-]{1,64}(,[a-z0-9-]{1,64}){0,49}$/;
const VS_RE = /^[a-zA-Z]{3,5}(,[a-zA-Z]{3,5}){0,9}$/; // 大小写均可，统一转小写后请求

function headers() {
  const key = process.env.COINGECKO_API_KEY;
  return key ? { 'x-cg-demo-api-key': key } : {};
}

// simple/price：{ bitcoin: { usd, usd_market_cap, usd_24h_vol, usd_24h_change, cny, ..., last_updated_at } }
export function parsePrices(raw, ids, vs) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(502, 'CoinGecko 返回的数据格式无法识别');
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const coins = [];
  for (const id of ids) {
    const o = raw[id];
    if (!o) continue;
    const prices = {};
    for (const c of vs) {
      if (o[c] == null) continue;
      prices[c] = {
        price: n(o[c]),
        marketCap: n(o[`${c}_market_cap`]),
        volume24h: n(o[`${c}_24h_vol`]),
        changePercent24h: n(o[`${c}_24h_change`]),
      };
    }
    coins.push({ id, prices, updatedAt: o.last_updated_at ? new Date(o.last_updated_at * 1000).toISOString() : null });
  }
  return { coins, notFound: ids.filter((id) => !raw[id]) };
}

export function parseMarkets(raw) {
  if (!Array.isArray(raw)) throw new HttpError(502, 'CoinGecko 返回的数据格式无法识别');
  return raw.map((c) => ({
    id: c.id,
    symbol: c.symbol?.toUpperCase() ?? null,
    name: c.name,
    image: c.image ?? null,
    rank: c.market_cap_rank ?? null,
    price: c.current_price ?? null,
    marketCap: c.market_cap ?? null,
    volume24h: c.total_volume ?? null,
    high24h: c.high_24h ?? null,
    low24h: c.low_24h ?? null,
    priceChange24h: c.price_change_24h ?? null,
    changePercent24h: c.price_change_percentage_24h ?? null,
    circulatingSupply: c.circulating_supply ?? null,
    totalSupply: c.total_supply ?? null,
    maxSupply: c.max_supply ?? null,
    ath: c.ath ?? null,
    athDate: c.ath_date ?? null,
    updatedAt: c.last_updated ?? null,
  }));
}

export default {
  name: 'crypto',
  category: 'finance',
  title: '加密货币行情',
  description: '比特币、以太坊等加密货币价格与市值排行（可选配置 COINGECKO_API_KEY 提高限额）',
  source: 'CoinGecko',
  env: [{ name: 'COINGECKO_API_KEY', optional: true }],
  routes: [
    {
      method: 'GET',
      path: '/api/crypto/price',
      summary: '查询指定币种价格、24h 涨跌、市值',
      params: [
        { name: 'ids', required: true, default: 'bitcoin,ethereum', desc: 'CoinGecko 币种 id，逗号分隔（最多 50 个）', example: 'bitcoin,ethereum' },
        { name: 'vs', default: 'usd,cny', desc: '计价货币，逗号分隔', example: 'usd,cny' },
      ],
      fields: [
        { name: 'coins', type: 'array', desc: '查到的币种，按请求参数 ids 的顺序排列；没查到的 id 不在其中，见 notFound' },
        { name: 'coins[].id', type: 'string', desc: 'CoinGecko 币种 id（如 bitcoin、ethereum）' },
        { name: 'coins[].prices', type: 'object', desc: '按计价货币分组的行情，键为小写计价货币代码（与参数 vs 对应，如 usd、cny）；上游不支持的计价货币不会出现' },
        { name: 'coins[].prices.*', type: 'object', desc: '以该计价货币计价的行情（如 prices.usd 以美元计，prices.cny 以人民币元计）' },
        { name: 'coins[].prices.*.price', type: 'number|null', desc: '1 枚币的价格，单位为该计价货币；上游值不是有效数字时为 null' },
        { name: 'coins[].prices.*.marketCap', type: 'number|null', desc: '总市值，单位为该计价货币；上游无数据时为 null' },
        { name: 'coins[].prices.*.volume24h', type: 'number|null', desc: '近 24 小时成交额（不是成交币数），单位为该计价货币；上游无数据时为 null' },
        { name: 'coins[].prices.*.changePercent24h', type: 'number|null', desc: '近 24 小时涨跌幅，百分数（1.23 表示 +1.23%，负数表示下跌）；上游无数据时为 null' },
        { name: 'coins[].updatedAt', type: 'string|null', desc: '上游价格的最后更新时间（ISO 8601，UTC）；上游未提供时为 null' },
        { name: 'notFound', type: 'array', desc: 'CoinGecko 没有返回数据的币种 id（字符串数组，通常是 id 拼写错误或不存在）；都查到时为空数组' },
      ],
      async handler({ query }) {
        const ids = [...new Set(param(query, 'ids', { default: 'bitcoin,ethereum', pattern: IDS_RE }).split(','))];
        const vs = [...new Set(param(query, 'vs', { default: 'usd,cny', pattern: VS_RE }).toLowerCase().split(','))];
        const qs = new URLSearchParams({
          ids: ids.join(','),
          vs_currencies: vs.join(','),
          include_market_cap: 'true',
          include_24hr_vol: 'true',
          include_24hr_change: 'true',
          include_last_updated_at: 'true',
        });
        return cache.wrap(`crypto:p:${qs}`, 60_000, async () =>
          parsePrices(await fetchJSON(`${BASE}/simple/price?${qs}`, { headers: headers() }), ids, vs));
      },
    },
    {
      method: 'GET',
      path: '/api/crypto/markets',
      summary: '按市值排行的币种列表',
      params: [
        { name: 'vs', default: 'usd', desc: '计价货币', example: 'cny' },
        { name: 'limit', default: 20, desc: '条数（1~100）' },
        { name: 'page', default: 1, desc: '页码' },
      ],
      fields: [
        { name: '[].id', type: 'string', desc: 'CoinGecko 币种 id，可用作 /api/crypto/price 的 ids 参数。列表按市值从大到小排序' },
        { name: '[].symbol', type: 'string|null', desc: '币种符号，已转为大写（如 BTC、ETH）；上游缺失时为 null' },
        { name: '[].name', type: 'string', desc: '币种英文名称（如 Bitcoin）' },
        { name: '[].image', type: 'string|null', desc: '币种图标图片 URL；上游缺失时为 null' },
        { name: '[].rank', type: 'number|null', desc: '市值排名（1 为市值最大）；上游无排名时为 null' },
        { name: '[].price', type: 'number|null', desc: '当前价格，单位为参数 vs 指定的计价货币（默认 usd 即美元；vs=cny 时为人民币元，下同）；上游缺失时为 null' },
        { name: '[].marketCap', type: 'number|null', desc: '总市值（计价货币）；上游缺失时为 null' },
        { name: '[].volume24h', type: 'number|null', desc: '近 24 小时成交额（计价货币，不是成交币数）；上游缺失时为 null' },
        { name: '[].high24h', type: 'number|null', desc: '近 24 小时最高价（计价货币）；上游缺失时为 null' },
        { name: '[].low24h', type: 'number|null', desc: '近 24 小时最低价（计价货币）；上游缺失时为 null' },
        { name: '[].priceChange24h', type: 'number|null', desc: '近 24 小时价格涨跌额（计价货币，如 773.45 表示每枚上涨 773.45 美元，负数表示下跌）；上游缺失时为 null' },
        { name: '[].changePercent24h', type: 'number|null', desc: '近 24 小时涨跌幅，百分数（1.23 表示 +1.23%）；上游缺失时为 null' },
        { name: '[].circulatingSupply', type: 'number|null', desc: '流通量（枚）；上游缺失时为 null' },
        { name: '[].totalSupply', type: 'number|null', desc: '总供应量（枚）；上游缺失时为 null' },
        { name: '[].maxSupply', type: 'number|null', desc: '最大供应量（枚）；没有供应上限（如 ETH）或上游缺失时为 null' },
        { name: '[].ath', type: 'number|null', desc: '历史最高价（计价货币）；上游缺失时为 null' },
        { name: '[].athDate', type: 'string|null', desc: '创下历史最高价的时间（ISO 8601，UTC）；上游缺失时为 null' },
        { name: '[].updatedAt', type: 'string|null', desc: '上游数据的最后更新时间（ISO 8601，UTC）；上游缺失时为 null' },
      ],
      async handler({ query }) {
        const vs = param(query, 'vs', { default: 'usd', pattern: /^[a-zA-Z]{3,5}$/ }).toLowerCase();
        const limit = param(query, 'limit', { default: 20, int: true, min: 1, max: 100 });
        const page = param(query, 'page', { default: 1, int: true, min: 1, max: 100 });
        const qs = new URLSearchParams({
          vs_currency: vs, order: 'market_cap_desc', per_page: limit, page, sparkline: 'false', price_change_percentage: '24h',
        });
        return cache.wrap(`crypto:m:${qs}`, 60_000, async () =>
          parseMarkets(await fetchJSON(`${BASE}/coins/markets?${qs}`, { headers: headers() })));
      },
    },
  ],
};

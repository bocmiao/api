import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError, param } from '../../lib/http.js';

const BASE = 'https://api.coingecko.com/api/v3';
const IDS_RE = /^[a-z0-9-]{1,64}(,[a-z0-9-]{1,64}){0,49}$/;
const VS_RE = /^[a-z]{3,5}(,[a-z]{3,5}){0,9}$/;

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
        change24h: n(o[`${c}_24h_change`]),
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
    change24h: c.price_change_24h ?? null,
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

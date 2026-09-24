import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError, param } from '../../lib/http.js';

const CATALOG = 'https://catalog.gog.com/v1/catalog';
const TTL_MS = 10 * 60 * 1000;

const amount = (m) => (m?.amount != null ? Number(m.amount) : null);

// 纯函数：解析 GOG catalog 响应，只保留折后价为 0 且原价大于 0 的（限时免费，排除本来就免费的）
export function parseGogFree(raw) {
  const products = raw?.products;
  if (!Array.isArray(products)) throw new HttpError(502, 'GOG 返回的数据格式无法识别');
  return products
    .filter((p) => amount(p.price?.finalMoney) === 0 && amount(p.price?.baseMoney) > 0)
    .map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      type: p.productType ?? null,
      url: p.storeLink || `https://www.gog.com/game/${p.slug}`,
      image: p.coverHorizontal || p.coverVertical || null,
      originalPrice: p.price?.base ?? null,
      discount: p.price?.discount ?? null,
      developers: p.developers ?? [],
      genres: (p.genres ?? []).map((g) => g.name),
      releaseDate: p.releaseDate ?? null,
    }));
}

export function loadGogFree({ country = 'CN', currency = 'CNY' } = {}) {
  const qs = [
    'limit=48',
    'order=desc:trending',
    'discounted=eq:true',
    'price=between:0,0',
    'productType=in:game,pack,dlc,extras',
    'page=1',
    `countryCode=${country}`,
    'locale=zh-Hans',
    `currencyCode=${currency}`,
  ].join('&');
  return cache.wrap(`gog:free:${country}:${currency}`, TTL_MS, async () =>
    parseGogFree(await fetchJSON(`${CATALOG}?${qs}`, { headers: { referer: 'https://www.gog.com/' } })));
}

export default {
  name: 'gog',
  category: 'games',
  title: 'GOG 限免',
  description: 'GOG 商店当前限时免费（100% 折扣）的游戏',
  source: 'GOG Catalog API',
  unofficial: true,
  routes: [
    {
      method: 'GET',
      path: '/api/gog/free',
      summary: '获取 GOG 当前限时免费的游戏',
      params: [
        { name: 'country', default: 'CN', desc: '地区代码，例如 CN、US', example: 'CN' },
        { name: 'currency', default: 'CNY', desc: '货币代码，例如 CNY、USD', example: 'CNY' },
      ],
      async handler({ query }) {
        const country = param(query, 'country', { default: 'CN', pattern: /^[a-zA-Z]{2}$/ }).toUpperCase();
        const currency = param(query, 'currency', { default: 'CNY', pattern: /^[a-zA-Z]{3}$/ }).toUpperCase();
        return loadGogFree({ country, currency });
      },
    },
  ],
};

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
      fields: [
        { name: '[].id', type: 'string', desc: 'GOG 商品 ID（数字组成的字符串，如 "1207658691"）' },
        { name: '[].slug', type: 'string', desc: '商品 slug（如 the_witcher_enhanced_edition），用于拼商店链接' },
        { name: '[].title', type: 'string', desc: '商品名称，如 The Witcher: Enhanced Edition' },
        { name: '[].type', type: 'string|null', desc: '商品类型：game 游戏，pack 合集包，dlc 追加内容，extras 附加内容；上游没有给出时为 null' },
        { name: '[].url', type: 'string', desc: 'GOG 商店页面链接（上游给出的中文站链接，如 https://www.gog.com/zh/game/the_witcher_enhanced_edition）；上游没有链接时拼成 https://www.gog.com/game/<slug>' },
        { name: '[].image', type: 'string|null', desc: '封面图链接，优先横版，没有则用竖版；都没有时为 null' },
        { name: '[].originalPrice', type: 'string|null', desc: '原价，GOG 格式化好的字符串，带货币符号（货币由参数 currency 决定，如 CNY 时为 ¥68.00）；上游没有给出时为 null' },
        { name: '[].discount', type: 'string|null', desc: '折扣文本，带负号和百分号。本接口只返回限免条目，因此通常为 "-100%"；上游没有给出时为 null' },
        { name: '[].developers', type: 'array', desc: '开发商名称（字符串数组），可能为空数组' },
        { name: '[].genres', type: 'array', desc: '类型名称（字符串数组，简体中文，如 角色扮演），可能为空数组' },
        { name: '[].releaseDate', type: 'string|null', desc: '游戏原始发行日期，上游原样返回，格式为 YYYY.MM.DD（如 2007.10.26），不含时间和时区；上游没有给出时为 null' },
      ],
      async handler({ query }) {
        const country = param(query, 'country', { default: 'CN', pattern: /^[a-zA-Z]{2}$/ }).toUpperCase();
        const currency = param(query, 'currency', { default: 'CNY', pattern: /^[a-zA-Z]{3}$/ }).toUpperCase();
        return loadGogFree({ country, currency });
      },
    },
  ],
};

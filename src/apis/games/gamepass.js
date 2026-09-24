import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError, param } from '../../lib/http.js';

// Xbox 官网使用的 sigl 列表 id（非公开接口）
export const LISTS = {
  new: { id: 'f13cf6b4-57e6-4459-89df-6aec18cf0538', title: '最近加入' },
  leaving: { id: '393f05bf-e596-4ef6-9487-6d4fa0eab987', title: '即将离开' },
  coming: { id: '095bda36-f5cd-43f2-9ee1-0a72f371fb96', title: '即将加入' },
  popular: { id: 'eab7757c-ff70-45af-bfa6-79d3cfb2bf81', title: '最受欢迎' },
};
const TTL_MS = 60 * 60 * 1000;
const MAX_ITEMS = 60;

// 纯函数：sigls 返回数组，第一个元素是列表元信息（含 siglId），其余是 { id }
export function parseSiglIds(raw) {
  if (!Array.isArray(raw)) throw new HttpError(502, 'Game Pass 列表返回的数据格式无法识别');
  return raw.filter((x) => x?.id && !x.siglId).map((x) => x.id);
}

const https = (u) => (u?.startsWith('//') ? `https:${u}` : u ?? null);

function pickImage(images = [], purposes) {
  for (const p of purposes) {
    const img = images.find((i) => i.ImagePurpose === p);
    if (img) return https(img.Uri);
  }
  return https(images[0]?.Uri);
}

// 纯函数：解析 displaycatalog products 响应，按 ids 原顺序输出
export function parseProducts(raw, ids, { lang = 'zh-CN' } = {}) {
  const products = raw?.Products;
  if (!Array.isArray(products)) throw new HttpError(502, 'Microsoft 商店返回的数据格式无法识别');
  const byId = new Map(products.map((p) => [p.ProductId, p]));
  return (ids ?? products.map((p) => p.ProductId))
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((p) => {
      const lp = p.LocalizedProperties?.[0] ?? {};
      const images = lp.Images ?? [];
      return {
        id: p.ProductId,
        title: lp.ProductTitle ?? null,
        developer: lp.DeveloperName || null,
        publisher: lp.PublisherName || null,
        description: lp.ShortDescription || null,
        image: {
          wide: pickImage(images, ['SuperHeroArt', 'TitledHeroArt', 'BrandedKeyArt', 'BoxArt']),
          tall: pickImage(images, ['Poster', 'BoxArt']),
        },
        releaseDate: p.MarketProperties?.[0]?.OriginalReleaseDate ?? null,
        category: p.Properties?.Category ?? null,
        url: `https://www.xbox.com/${lang}/games/store/game/${p.ProductId}`,
      };
    });
}

async function loadList(list, market, lang) {
  const sigl = LISTS[list];
  const ids = parseSiglIds(await fetchJSON(
    `https://catalog.gamepass.com/sigls/v2?id=${sigl.id}&language=${lang.toLowerCase()}&market=${market}`,
  )).slice(0, MAX_ITEMS);
  if (!ids.length) return { list, title: sigl.title, items: [] };

  const items = [];
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const raw = await fetchJSON(
      `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${chunk.join(',')}&market=${market}&languages=${lang.toLowerCase()},neutral`,
    );
    items.push(...parseProducts(raw, chunk, { lang }));
  }
  return { list, title: sigl.title, items };
}

export default {
  name: 'gamepass',
  category: 'games',
  title: 'Xbox Game Pass',
  description: 'Xbox Game Pass 最近加入 / 即将离开的游戏',
  source: 'Xbox 官网 / Microsoft Store',
  unofficial: true,
  routes: [
    {
      method: 'GET',
      path: '/api/gamepass',
      summary: '获取 Game Pass 游戏列表：最近加入、即将离开、即将加入、最受欢迎',
      params: [
        { name: 'list', default: 'new', desc: '列表：new 最近加入 / leaving 即将离开 / coming 即将加入 / popular 最受欢迎', example: 'new' },
        { name: 'market', default: 'US', desc: '市场地区代码（Game Pass 未在中国大陆上线，默认 US），例如 US、HK、JP', example: 'HK' },
        { name: 'lang', default: 'zh-CN', desc: '语言，例如 zh-CN、zh-TW、en-US', example: 'zh-CN' },
      ],
      fields: [
        { name: 'list', type: 'string', desc: '列表 ID，与请求参数 list 相同：new 最近加入 / leaving 即将离开 / coming 即将加入 / popular 最受欢迎' },
        { name: 'title', type: 'string', desc: '列表中文名：最近加入 / 即将离开 / 即将加入 / 最受欢迎' },
        { name: 'items', type: 'array', desc: '列表中的游戏，按 Xbox 官网列表顺序，最多 60 个；Microsoft 商店查不到详情的条目会被跳过，列表为空时为空数组' },
        { name: 'items[].id', type: 'string', desc: 'Microsoft Store 商品 ID（12 位大写字母和数字，如 9NQ9CHCTZKTJ）' },
        { name: 'items[].title', type: 'string|null', desc: '游戏名称（按参数 lang 的语言，没有该语言时为商店默认语言，通常是英文）；上游缺失时为 null' },
        { name: 'items[].developer', type: 'string|null', desc: '开发商名称；上游为空时为 null' },
        { name: 'items[].publisher', type: 'string|null', desc: '发行商名称；上游为空时为 null' },
        { name: 'items[].description', type: 'string|null', desc: '商店里的简短介绍（纯文本，语言同 title）；上游为空时为 null' },
        { name: 'items[].image', type: 'object', desc: '封面图' },
        { name: 'items[].image.wide', type: 'string|null', desc: '横版大图的 https 链接，依次取 SuperHeroArt、TitledHeroArt、BrandedKeyArt、BoxArt（方形），都没有时取第一张图；商品没有任何图片时为 null' },
        { name: 'items[].image.tall', type: 'string|null', desc: '竖版海报的 https 链接，取 Poster，没有则用 BoxArt（方形），都没有时取第一张图；商品没有任何图片时为 null' },
        { name: 'items[].releaseDate', type: 'string|null', desc: '首次发行日期，ISO 8601，UTC，上游原样返回，秒后有 7 位小数（如 2024-12-09T00:00:00.0000000Z）；上游缺失时为 null' },
        { name: 'items[].category', type: 'string|null', desc: '商店主分类，上游原样返回，通常为英文（如 Action & adventure）；上游缺失时为 null' },
        { name: 'items[].url', type: 'string', desc: 'Xbox 官网商品页链接，格式为 https://www.xbox.com/<lang>/games/store/game/<id>' },
      ],
      async handler({ query }) {
        const list = param(query, 'list', { default: 'new', oneOf: Object.keys(LISTS) });
        const market = param(query, 'market', { default: 'US', pattern: /^[a-zA-Z]{2}$/ }).toUpperCase();
        const lang = param(query, 'lang', { default: 'zh-CN', pattern: /^[a-z]{2}-[A-Za-z]{2}$/ });
        return cache.wrap(`gamepass:${list}:${market}:${lang}`, TTL_MS, () => loadList(list, market, lang));
      },
    },
  ],
};

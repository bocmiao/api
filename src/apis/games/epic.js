import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError } from '../../lib/http.js';

const UPSTREAM = 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions';
const TTL_MS = 10 * 60 * 1000;
const LOCALE_RE = /^[a-z]{2}(-[A-Za-z]{2,4})?$/;
const COUNTRY_RE = /^[A-Z]{2}$/;

// 从一个 promotions 分组里取出"免费"（折后价为 0）的时间段
function freeWindows(groups = []) {
  return groups
    .flatMap((g) => g?.promotionalOffers ?? [])
    .filter((o) => o?.discountSetting?.discountPercentage === 0)
    .map((o) => ({ startDate: o.startDate, endDate: o.endDate }));
}

function pickImage(images = [], types) {
  for (const t of types) {
    const img = images.find((i) => i.type === t);
    if (img) return img.url;
  }
  return images[0]?.url ?? null;
}

function pickSlug(el) {
  const fromMappings = (list) => list?.find((m) => m.pageType === 'productHome')?.pageSlug ?? list?.[0]?.pageSlug;
  const productSlug = el.productSlug && el.productSlug !== '[]' ? el.productSlug.replace(/\/home$/, '') : null;
  return productSlug || fromMappings(el.offerMappings) || fromMappings(el.catalogNs?.mappings) || el.urlSlug || null;
}

function storeUrl(el, locale) {
  const slug = pickSlug(el);
  if (!slug) return `https://store.epicgames.com/${locale}/free-games`;
  const isBundle = el.offerType === 'BUNDLE' || el.categories?.some((c) => c.path === 'bundles');
  return `https://store.epicgames.com/${locale}/${isBundle ? 'bundles' : 'p'}/${slug}`;
}

function toGame(el, window, locale) {
  const price = el.price?.totalPrice;
  return {
    id: el.id,
    namespace: el.namespace,
    title: el.title,
    description: el.description,
    seller: el.seller?.name ?? null,
    originalPrice: price?.fmtPrice?.originalPrice ?? null,
    startDate: window.startDate,
    endDate: window.endDate,
    url: storeUrl(el, locale),
    image: {
      wide: pickImage(el.keyImages, ['OfferImageWide', 'DieselStoreFrontWide', 'featuredMedia']),
      tall: pickImage(el.keyImages, ['OfferImageTall', 'DieselStoreFrontTall', 'Thumbnail']),
    },
  };
}

// 纯函数：把 Epic 原始响应解析为 { current, upcoming }，便于测试
export function parseFreeGames(raw, { locale = 'zh-CN', now = new Date() } = {}) {
  const elements = raw?.data?.Catalog?.searchStore?.elements;
  if (!Array.isArray(elements)) throw new HttpError(502, 'Epic 返回的数据格式无法识别');

  const current = [];
  const upcoming = [];
  for (const el of elements) {
    const promos = el.promotions;
    if (!promos) continue;

    // 按时间判断而不是只看 Epic 放在哪个列表里：周四切换前后缓存的数据可能还没刷新
    const windows = [...freeWindows(promos.promotionalOffers), ...freeWindows(promos.upcomingPromotionalOffers)];
    const active = windows.find((w) => new Date(w.startDate) <= now && now < new Date(w.endDate));
    if (active) {
      current.push(toGame(el, active, locale));
      continue;
    }
    const next = windows.find((w) => new Date(w.startDate) > now);
    if (next) upcoming.push(toGame(el, next, locale));
  }

  const byStart = (a, b) => new Date(a.startDate) - new Date(b.startDate);
  return { current: current.sort(byStart), upcoming: upcoming.sort(byStart) };
}

// 缓存原始数据而不是解析结果，这样每次请求都按当前时间判断"正在免费/即将免费"
export function loadEpicRaw({ locale = 'zh-CN', country = 'CN' } = {}) {
  const url = `${UPSTREAM}?locale=${locale}&country=${country}&allowCountries=${country}`;
  return cache.wrap(`epic:${locale}:${country}`, TTL_MS, () => fetchJSON(url));
}

export async function loadEpicFree(opts = {}) {
  const res = await loadEpicRaw(opts);
  return parseFreeGames(res.data, opts);
}

export default {
  name: 'epic',
  category: 'games',
  title: 'Epic 每周免费游戏',
  description: 'Epic Games Store 每周限时免费领取的游戏',
  source: 'Epic Games Store',
  unofficial: true,
  routes: [
    {
      method: 'GET',
      path: '/api/epic/free',
      summary: '获取 Epic 当前免费领取与即将免费的游戏',
      params: [
        { name: 'locale', default: 'zh-CN', desc: '语言，例如 zh-CN、en-US', example: 'zh-CN' },
        { name: 'country', default: 'CN', desc: '地区代码，例如 CN、US', example: 'CN' },
      ],
      fields: [
        { name: 'current', type: 'array', desc: '当前正在免费领取的游戏' },
        { name: 'current[].id', type: 'string', desc: 'Epic 商品 ID' },
        { name: 'current[].namespace', type: 'string', desc: 'Epic 商品命名空间（与 id 一起唯一确定商品）' },
        { name: 'current[].title', type: 'string', desc: '游戏名称' },
        { name: 'current[].description', type: 'string|null', desc: '游戏简介' },
        { name: 'current[].seller', type: 'string|null', desc: '发行商' },
        { name: 'current[].originalPrice', type: 'string|null', desc: '原价（已按地区格式化，如 ¥88.00）' },
        { name: 'current[].startDate', type: 'string', desc: '免费开始时间（ISO 8601，UTC）' },
        { name: 'current[].endDate', type: 'string', desc: '免费截止时间（ISO 8601，UTC）' },
        { name: 'current[].url', type: 'string', desc: 'Epic 商店页面链接' },
        { name: 'current[].image', type: 'object', desc: '封面图' },
        { name: 'current[].image.wide', type: 'string|null', desc: '横版封面图链接' },
        { name: 'current[].image.tall', type: 'string|null', desc: '竖版封面图链接' },
        { name: 'upcoming', type: 'array', desc: '即将免费的游戏，每项字段与 current 相同，startDate 为开始免费的时间' },
        { name: 'upcoming[].*', type: 'string|object|null', desc: '同 current[] 中的同名字段' },
        { name: 'upcoming[].image.*', type: 'string|null', desc: '同 current[].image 中的同名字段' },
      ],
      async handler({ query }) {
        const locale = query.get('locale') || 'zh-CN';
        const country = (query.get('country') || 'CN').toUpperCase();
        if (!LOCALE_RE.test(locale)) throw new HttpError(400, 'locale 参数不合法');
        if (!COUNTRY_RE.test(country)) throw new HttpError(400, 'country 参数不合法');

        const res = await loadEpicRaw({ locale, country });
        return { ...res, data: parseFreeGames(res.data, { locale }) };
      },
    },
  ],
};

import { cache } from '../lib/cache.js';
import { fetchJSON, HttpError } from '../lib/http.js';

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

export default {
  name: 'epic',
  title: 'Epic 每周免费游戏',
  routes: [
    {
      method: 'GET',
      path: '/api/epic/free',
      summary: '获取 Epic 当前免费领取与即将免费的游戏',
      params: [
        { name: 'locale', default: 'zh-CN', desc: '语言，例如 zh-CN、en-US' },
        { name: 'country', default: 'CN', desc: '地区代码，例如 CN、US' },
      ],
      async handler({ query }) {
        const locale = query.get('locale') || 'zh-CN';
        const country = (query.get('country') || 'CN').toUpperCase();
        if (!LOCALE_RE.test(locale)) throw new HttpError(400, 'locale 参数不合法');
        if (!COUNTRY_RE.test(country)) throw new HttpError(400, 'country 参数不合法');

        const url = `${UPSTREAM}?locale=${locale}&country=${country}&allowCountries=${country}`;
        // 缓存原始数据而不是解析结果，这样每次请求都按当前时间判断"正在免费/即将免费"
        const res = await cache.wrap(`epic:${locale}:${country}`, TTL_MS, () => fetchJSON(url));
        return { ...res, data: parseFreeGames(res.data, { locale }) };
      },
    },
  ],
};

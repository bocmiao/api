import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError, param, stripTags, decodeEntities } from '../../lib/http.js';

const STORE = 'https://store.steampowered.com';
const TTL_MS = 10 * 60 * 1000;
const STORE_HEADERS = { referer: `${STORE}/`, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' };

// Steam 通用参数：地区（价格货币）与语言
export const CC_PARAM = { name: 'cc', default: 'cn', desc: '商店地区代码（决定价格货币），例如 cn、us、hk', example: 'cn' };
export const LANG_PARAM = { name: 'l', default: 'schinese', desc: '语言，例如 schinese、tchinese、english', example: 'schinese' };

export function steamLocale(query) {
  const cc = param(query, 'cc', { default: 'cn', pattern: /^[a-zA-Z]{2}$/ }).toLowerCase();
  const l = param(query, 'l', { default: 'schinese', pattern: /^[a-z_]{2,20}$/ });
  return { cc, l };
}

export function storeUrl(type, id) {
  const kind = { app: 'app', sub: 'sub', bundle: 'bundle' }[type] ?? 'app';
  return `${STORE}/${kind}/${id}/`;
}

const attr = (html, name) => {
  const m = html.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decodeEntities(m[1]) : null;
};
const inner = (html, cls) => {
  const m = html.match(new RegExp(`<(\\w+)[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</\\1>`));
  return m ? stripTags(m[2]) : null;
};

// 纯函数：解析商店搜索 infinite=1 返回的 results_html，只保留 100% 折扣（限时免费入库）的条目
export function parseSteamFreeSearch(raw) {
  const html = raw?.results_html;
  if (typeof html !== 'string') throw new HttpError(502, 'Steam 搜索返回的数据格式无法识别');

  const items = [];
  for (const row of html.split(/(?=<a\s)/)) {
    if (!/class="[^"]*search_result_row/.test(row)) continue;
    const href = attr(row, 'href') ?? '';
    const m = href.match(/\/(app|sub|bundle)\/(\d+)/);
    if (!m) continue;

    // 新版页面：discount_block data-discount="100"；旧版：<div class="col search_discount"><span>-100%</span>
    const pctText = inner(row, 'discount_pct') ?? inner(row, 'search_discount') ?? '';
    const discount = Number(attr(row, 'data-discount') ?? pctText.replace(/[^\d]/g, '')) || 0;
    if (discount !== 100) continue;

    const original = inner(row, 'discount_original_price') ?? (row.match(/<strike>([\s\S]*?)<\/strike>/)?.[1] ?? null);
    const img = attr(row, 'src');
    const [, type, id] = m;
    items.push({
      type,
      id: Number(id),
      title: inner(row, 'title'),
      url: storeUrl(type, id),
      // 搜索结果是小图 capsule_sm_120，同目录下换成 header 得到 460x215 的头图（兼容带 hash 的新路径）
      image: img && /\/apps\//.test(img) ? img.replace(/capsule_sm_120\.jpg/, 'header.jpg') : img,
      originalPrice: original ? stripTags(original) : null,
      releaseDate: inner(row, 'search_released') || null,
      discountPercent: discount,
    });
  }
  return items;
}

function formatPrice(cents, currency) {
  if (cents == null) return null;
  const symbol = { CNY: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥', HKD: 'HK$', TWD: 'NT$', KRW: '₩', RUB: '₽' }[currency];
  const amount = currency === 'JPY' || currency === 'KRW' ? Math.round(cents / 100).toLocaleString('en-US') : (cents / 100).toFixed(2);
  return symbol ? `${symbol} ${amount}` : `${amount} ${currency ?? ''}`.trim();
}

function toFeatured(it) {
  const type = it.type === 1 ? 'sub' : 'app';
  return {
    type,
    id: it.id,
    title: it.name,
    discountPercent: it.discount_percent ?? 0,
    originalPrice: formatPrice(it.original_price, it.currency),
    finalPrice: formatPrice(it.final_price, it.currency),
    originalPriceCents: it.original_price ?? null,
    finalPriceCents: it.final_price ?? null,
    currency: it.currency ?? null,
    expiresAt: it.discount_expiration ? new Date(it.discount_expiration * 1000).toISOString() : null,
    image: it.header_image || it.large_capsule_image || null,
    url: storeUrl(type, it.id),
    platforms: { windows: !!it.windows_available, mac: !!it.mac_available, linux: !!it.linux_available },
  };
}

export const FEATURED_LISTS = ['specials', 'top_sellers', 'new_releases', 'coming_soon'];

// 纯函数：解析 featuredcategories，返回指定分组；同一游戏可能重复出现，按 id 去重
export function parseFeaturedCategories(raw, list = 'specials') {
  const items = raw?.[list]?.items;
  if (!Array.isArray(items)) throw new HttpError(502, 'Steam 精选分类返回的数据格式无法识别');
  const seen = new Set();
  return items
    .filter((it) => it?.id && !seen.has(`${it.type}:${it.id}`) && seen.add(`${it.type}:${it.id}`))
    .map(toFeatured);
}

export function loadFeaturedRaw({ cc = 'cn', l = 'schinese' } = {}) {
  const url = `${STORE}/api/featuredcategories?cc=${cc}&l=${l}`;
  return cache.wrap(`steam:featured:${cc}:${l}`, TTL_MS, () => fetchJSON(url, { headers: STORE_HEADERS }));
}

async function fetchFreeSearch({ cc, l }) {
  const url = `${STORE}/search/results/?query&start=0&count=100&maxprice=free&specials=1&infinite=1&cc=${cc}&l=${l}`;
  const items = parseSteamFreeSearch(await fetchJSON(url, { headers: STORE_HEADERS }));
  // 搜索页没有截止时间，尝试从精选特惠里补上（失败不影响主结果）
  try {
    const { data } = await loadFeaturedRaw({ cc, l });
    const expiry = new Map(parseFeaturedCategories(data).map((g) => [`${g.type}:${g.id}`, g.expiresAt]));
    for (const it of items) it.endDate = expiry.get(`${it.type}:${it.id}`) ?? null;
  } catch {
    for (const it of items) it.endDate ??= null;
  }
  return items;
}

// 当前可免费入库的 Steam 游戏
export function loadSteamFree({ cc = 'cn', l = 'schinese' } = {}) {
  return cache.wrap(`steam:free:${cc}:${l}`, TTL_MS, () => fetchFreeSearch({ cc, l }));
}

export default {
  name: 'steam',
  category: 'games',
  title: 'Steam 限免与特惠',
  description: 'Steam 商店当前限时免费入库的游戏与精选特惠',
  source: 'Steam 商店',
  unofficial: true,
  routes: [
    {
      method: 'GET',
      path: '/api/steam/free',
      summary: '获取 Steam 当前限时免费（100% 折扣，可永久入库）的游戏',
      params: [CC_PARAM, LANG_PARAM],
      fields: [
        { name: '[].type', type: 'string', desc: '条目类型：app 表示单个游戏/应用，sub 表示礼包（package），bundle 表示捆绑包' },
        { name: '[].id', type: 'number', desc: 'Steam 数字 ID，含义随 type 变化：app 为 AppID，sub 为 PackageID，bundle 为 BundleID' },
        { name: '[].title', type: 'string|null', desc: '名称（语言由参数 l 决定，没有该语言时为原名）；搜索结果里缺少标题时为 null' },
        { name: '[].url', type: 'string', desc: 'Steam 商店页面链接，如 https://store.steampowered.com/app/1172470/' },
        { name: '[].image', type: 'string|null', desc: '封面图链接：app 为 460×215 头图（header.jpg）；sub、bundle 为搜索结果里的 120×45 小图。搜索结果里没有图片时为 null' },
        { name: '[].originalPrice', type: 'string|null', desc: '原价，Steam 按地区 cc 格式化好的字符串，带货币符号（如 cc=cn 时为 ¥ 58.00）；搜索结果里没有原价时为 null' },
        { name: '[].releaseDate', type: 'string|null', desc: '发行日期，Steam 按语言 l 显示的原文（如 l=schinese 时为 2020 年 11 月 5 日），不是标准日期格式，不宜直接解析；搜索结果里没有日期时（礼包常见）为 null' },
        { name: '[].discountPercent', type: 'number', desc: '折扣百分比（0~100，表示减免的比例）。本接口只返回 100% 折扣的条目，因此恒为 100' },
        { name: '[].endDate', type: 'string|null', desc: '免费截止时间，ISO 8601，UTC（如 2025-09-24T17:00:00.000Z）。搜索页不提供截止时间，只有同时出现在首页精选特惠里的条目才有值，否则为 null' },
      ],
      async handler({ query }) {
        return loadSteamFree(steamLocale(query));
      },
    },
    {
      method: 'GET',
      path: '/api/steam/specials',
      summary: '获取 Steam 首页精选特惠（折扣、原价/现价、截止时间）',
      params: [
        { name: 'list', default: 'specials', desc: '分组：specials 特惠 / top_sellers 热销 / new_releases 新品 / coming_soon 即将推出', example: 'specials' },
        CC_PARAM,
        LANG_PARAM,
      ],
      fields: [
        { name: '[].type', type: 'string', desc: '条目类型：app 表示单个游戏/应用，sub 表示礼包（package）' },
        { name: '[].id', type: 'number', desc: 'Steam 数字 ID：type 为 app 时是 AppID，为 sub 时是 PackageID' },
        { name: '[].title', type: 'string', desc: '名称（语言由参数 l 决定，没有该语言时为原名）' },
        { name: '[].discountPercent', type: 'number', desc: '折扣百分比，0~100 的整数，表示减免的比例（40 表示减 40%，即打六折；100 表示限时免费）；0 表示未打折' },
        { name: '[].originalPrice', type: 'string|null', desc: '原价，带货币符号的格式化字符串，符号与金额间有空格，如 ¥ 298.00、$ 59.99；日元、韩元不带小数，没有内置符号的货币写成"金额 货币代码"（如 12.50 CHF）。上游没有价格时为 null' },
        { name: '[].finalPrice', type: 'string|null', desc: '现价（折后价），格式同 originalPrice，如 ¥ 178.80；免费时为 ¥ 0.00 这样的 0 元字符串。上游没有价格时为 null' },
        { name: '[].originalPriceCents', type: 'number|null', desc: '原价的整数金额，为实际金额 ×100（人民币即单位为分，29800 表示 ¥298.00）。上游没有价格时为 null' },
        { name: '[].finalPriceCents', type: 'number|null', desc: '现价的整数金额，为实际金额 ×100（人民币即单位为分，17880 表示 ¥178.80，0 表示免费）。上游没有价格时为 null' },
        { name: '[].currency', type: 'string|null', desc: '货币代码（ISO 4217，如 CNY、USD），由参数 cc 决定；上游没有给出时为 null' },
        { name: '[].expiresAt', type: 'string|null', desc: '折扣截止时间，ISO 8601，UTC（如 2025-10-01T17:00:00.000Z）；未打折或上游没有给出截止时间时为 null' },
        { name: '[].image', type: 'string|null', desc: '封面图链接，优先 460×215 头图，没有则用 616×353 大图；都没有时为 null' },
        { name: '[].url', type: 'string', desc: 'Steam 商店页面链接，如 https://store.steampowered.com/app/1245620/' },
        { name: '[].platforms', type: 'object', desc: '支持的操作系统' },
        { name: '[].platforms.windows', type: 'boolean', desc: '是否支持 Windows' },
        { name: '[].platforms.mac', type: 'boolean', desc: '是否支持 macOS' },
        { name: '[].platforms.linux', type: 'boolean', desc: '是否支持 Linux / SteamOS' },
      ],
      async handler({ query }) {
        const list = param(query, 'list', { default: 'specials', oneOf: FEATURED_LISTS });
        const res = await loadFeaturedRaw(steamLocale(query));
        return { ...res, data: parseFeaturedCategories(res.data, list) };
      },
    },
  ],
};

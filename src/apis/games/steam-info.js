import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError, param, stripTags } from '../../lib/http.js';
import { CC_PARAM, LANG_PARAM, steamLocale, storeUrl } from './steam.js';

const STORE = 'https://store.steampowered.com';
const ITAD = 'https://api.isthereanydeal.com';
const ITAD_STEAM_SHOP = 61;
const HEADERS = { referer: `${STORE}/`, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' };
const APPID = { required: true, int: true, min: 1, max: 99_999_999 };

const price = (p) => p && {
  currency: p.currency,
  initial: p.initial / 100,
  final: p.final / 100,
  discountPercent: p.discount_percent ?? 0,
  initialFormatted: p.initial_formatted || p.final_formatted || null,
  finalFormatted: p.final_formatted || null,
};

// 纯函数：解析 appdetails 响应
export function parseAppDetails(raw, appid) {
  const entry = raw?.[String(appid)];
  if (!entry) throw new HttpError(502, 'Steam 返回的数据格式无法识别');
  if (!entry.success || !entry.data) throw new HttpError(404, '未找到该 Steam 应用，或当前地区不可用');
  const d = entry.data;
  return {
    id: d.steam_appid,
    type: d.type,
    name: d.name,
    isFree: !!d.is_free,
    shortDescription: stripTags(d.short_description ?? ''),
    headerImage: d.header_image ?? null,
    capsuleImage: d.capsule_image ?? null,
    website: d.website || null,
    developers: d.developers ?? [],
    publishers: d.publishers ?? [],
    price: price(d.price_overview) ?? null,
    platforms: d.platforms ?? {},
    metacritic: d.metacritic?.score ?? null,
    recommendations: d.recommendations?.total ?? null,
    genres: (d.genres ?? []).map((g) => g.description),
    categories: (d.categories ?? []).map((c) => c.description),
    releaseDate: d.release_date?.date || null,
    comingSoon: !!d.release_date?.coming_soon,
    screenshots: (d.screenshots ?? []).slice(0, 8).map((s) => s.path_full),
    supportedLanguages: d.supported_languages ? stripTags(d.supported_languages.replace(/<br>[\s\S]*$/, '')) : null,
    url: storeUrl('app', d.steam_appid),
  };
}

// 纯函数：解析 storesearch 响应
export function parseStoreSearch(raw) {
  if (!Array.isArray(raw?.items)) throw new HttpError(502, 'Steam 搜索返回的数据格式无法识别');
  return {
    total: raw.total ?? raw.items.length,
    items: raw.items.map((it) => ({
      type: it.type,
      id: it.id,
      name: it.name,
      image: it.tiny_image ?? null,
      price: it.price ? { currency: it.price.currency, initial: it.price.initial / 100, final: it.price.final / 100 } : null,
      metascore: it.metascore ? Number(it.metascore) : null,
      platforms: it.platforms ?? {},
      url: storeUrl(it.type === 'sub' ? 'sub' : 'app', it.id),
    })),
  };
}

// 纯函数：解析 GetNumberOfCurrentPlayers，result=1 为成功
export function parsePlayerCount(raw) {
  const r = raw?.response;
  if (!r) throw new HttpError(502, 'Steam 返回的数据格式无法识别');
  if (r.result !== 1 || typeof r.player_count !== 'number') throw new HttpError(404, '未找到该应用的在线人数');
  return r.player_count;
}

const itadPrice = (p) => p && { shop: p.shop?.name ?? null, price: p.price?.amount ?? null, regular: p.regular?.amount ?? null, currency: p.price?.currency ?? null, cut: p.cut ?? 0 };

// 纯函数：解析 ITAD games/overview/v2，取史低与当前最低
export function parseItadOverview(raw, gameId) {
  const p = raw?.prices?.find((x) => x.id === gameId) ?? raw?.prices?.[0];
  if (!p) return null;
  return {
    lowest: p.lowest ? { ...itadPrice(p.lowest), date: p.lowest.timestamp ?? null } : null,
    current: p.current ? { ...itadPrice(p.current), url: p.current.url ?? null, expiry: p.current.expiry ?? null } : null,
    url: p.urls?.game ?? null,
  };
}

async function loadItad(appid, country) {
  const key = process.env.ITAD_API_KEY;
  const k = encodeURIComponent(key);
  const lookup = await fetchJSON(`${ITAD}/games/lookup/v1?key=${k}&appid=${appid}`);
  if (!lookup?.found || !lookup.game?.id) return null;
  const overview = await fetchJSON(`${ITAD}/games/overview/v2?key=${k}&country=${country}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([lookup.game.id]),
  });
  return parseItadOverview(overview, lookup.game.id);
}

export async function loadAppDetails(appid, { cc = 'cn', l = 'schinese' } = {}) {
  const res = await cache.wrap(`steam:app:${appid}:${cc}:${l}`, 30 * 60_000, async () =>
    parseAppDetails(await fetchJSON(`${STORE}/api/appdetails?appids=${appid}&cc=${cc}&l=${l}`, { headers: HEADERS }), appid));
  if (!process.env.ITAD_API_KEY) return res;

  // 史低价为附加信息：ITAD 失败时不影响详情
  const country = cc.toUpperCase();
  try {
    const itad = await cache.wrap(`itad:${appid}:${country}`, 6 * 3600_000, () => loadItad(appid, country));
    return { ...res, data: { ...res.data, historyLow: itad.data } };
  } catch {
    return { ...res, data: { ...res.data, historyLow: null } };
  }
}

export default {
  name: 'steam-info',
  category: 'games',
  title: 'Steam 游戏查询',
  description: 'Steam 游戏详情、价格、搜索与实时在线人数；配置 ITAD_API_KEY 后附带史低价',
  source: 'Steam Web API / IsThereAnyDeal',
  env: [{ name: 'ITAD_API_KEY', optional: true }],
  unofficial: true,
  routes: [
    {
      method: 'GET',
      path: '/api/steam/app',
      summary: '查询 Steam 游戏详情与当前价格（配置 ITAD_API_KEY 时附带史低价）',
      params: [
        { name: 'id', required: true, desc: 'Steam AppID', example: '730' },
        CC_PARAM,
        LANG_PARAM,
      ],
      async handler({ query }) {
        const id = param(query, 'id', APPID);
        return loadAppDetails(id, steamLocale(query));
      },
    },
    {
      method: 'GET',
      path: '/api/steam/search',
      summary: '按关键词搜索 Steam 商店',
      params: [
        { name: 'q', required: true, desc: '搜索关键词', example: '艾尔登法环' },
        CC_PARAM,
        LANG_PARAM,
      ],
      async handler({ query }) {
        const q = param(query, 'q', { required: true, max: 60 }).trim();
        const { cc, l } = steamLocale(query);
        const url = `${STORE}/api/storesearch/?term=${encodeURIComponent(q)}&l=${l}&cc=${cc.toUpperCase()}`;
        return cache.wrap(`steam:search:${cc}:${l}:${q}`, 10 * 60_000, async () =>
          parseStoreSearch(await fetchJSON(url, { headers: HEADERS })));
      },
    },
    {
      method: 'GET',
      path: '/api/steam/players',
      summary: '查询 Steam 游戏当前在线人数',
      params: [{ name: 'id', required: true, desc: 'Steam AppID', example: '570' }],
      async handler({ query }) {
        const id = param(query, 'id', APPID);
        const url = `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${id}`;
        return cache.wrap(`steam:players:${id}`, 60_000, async () =>
          ({ id, players: parsePlayerCount(await fetchJSON(url)) }));
      },
    },
  ],
};

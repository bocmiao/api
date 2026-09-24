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
      fields: [
        { name: 'id', type: 'number', desc: 'Steam AppID' },
        { name: 'type', type: 'string', desc: '应用类型，上游原样返回。常见值：game 游戏，dlc 追加内容，demo 试玩版，music 原声音乐，video 视频，mod 模组，hardware 硬件' },
        { name: 'name', type: 'string', desc: '名称（语言由参数 l 决定，没有该语言时为原名）' },
        { name: 'isFree', type: 'boolean', desc: '是否为本体免费的游戏（如免费游玩的网游）。限时 100% 折扣的游戏这里仍为 false，要看 price.discountPercent' },
        { name: 'shortDescription', type: 'string', desc: '简短介绍（纯文本，已去掉 HTML 标签，语言由参数 l 决定）；没有介绍时为空字符串' },
        { name: 'headerImage', type: 'string|null', desc: '460×215 头图链接；上游没有时为 null' },
        { name: 'capsuleImage', type: 'string|null', desc: '231×87 小封面图链接；上游没有时为 null' },
        { name: 'website', type: 'string|null', desc: '游戏官网链接；开发者未填写时为 null' },
        { name: 'developers', type: 'array', desc: '开发商名称（字符串数组），可能为空数组' },
        { name: 'publishers', type: 'array', desc: '发行商名称（字符串数组），可能为空数组' },
        { name: 'price', type: 'object|null', desc: '当前地区（参数 cc）的价格；本体免费、尚未发售或该地区不可购买时为 null' },
        { name: 'price.currency', type: 'string', desc: '货币代码（ISO 4217，如 CNY、USD），由参数 cc 决定' },
        { name: 'price.initial', type: 'number', desc: '原价，单位为货币主单位（人民币即元，不是分），如 298 表示 ¥298.00' },
        { name: 'price.final', type: 'number', desc: '现价（折后价），单位为货币主单位（人民币即元，不是分），如 178.8 表示 ¥178.80；限时免费时为 0' },
        { name: 'price.discountPercent', type: 'number', desc: '折扣百分比，0~100 的整数，表示减免的比例（40 表示减 40%，即打六折）；0 表示未打折' },
        { name: 'price.initialFormatted', type: 'string|null', desc: '原价的格式化字符串，带货币符号，如 ¥ 298.00；未打折时 Steam 不给原价文本，此时与 finalFormatted 相同' },
        { name: 'price.finalFormatted', type: 'string|null', desc: '现价的格式化字符串，带货币符号，如 ¥ 178.80；上游没有给出时为 null' },
        { name: 'platforms', type: 'object', desc: '支持的操作系统；上游没有给出时为空对象 {}' },
        { name: 'platforms.windows', type: 'boolean', desc: '是否支持 Windows' },
        { name: 'platforms.mac', type: 'boolean', desc: '是否支持 macOS' },
        { name: 'platforms.linux', type: 'boolean', desc: '是否支持 Linux / SteamOS' },
        { name: 'metacritic', type: 'number|null', desc: 'Metacritic 媒体评分（0~100）；没有评分时为 null' },
        { name: 'recommendations', type: 'number|null', desc: 'Steam 用户评测总数（上游 recommendations.total）；没有数据时为 null' },
        { name: 'genres', type: 'array', desc: '游戏类型（字符串数组，语言由参数 l 决定，如 动作、角色扮演），可能为空数组' },
        { name: 'categories', type: 'array', desc: '功能分类（字符串数组，语言由参数 l 决定，如 单人、多人、Steam 成就），可能为空数组' },
        { name: 'releaseDate', type: 'string|null', desc: '发行日期，Steam 按语言 l 显示的原文（如 l=schinese 时为 2022 年 2 月 25 日），不是标准日期格式，未发售的游戏可能是"即将推出"之类的文字；上游为空时为 null' },
        { name: 'comingSoon', type: 'boolean', desc: '是否尚未发售：true 为即将推出，false 为已发售' },
        { name: 'screenshots', type: 'array', desc: '截图原图链接（字符串数组，通常为 1920×1080），最多 8 张，可能为空数组' },
        { name: 'supportedLanguages', type: 'string|null', desc: '支持的语言，逗号分隔，带 * 的表示有完整音频支持（如 英语*, 简体中文*, 日语*）；上游没有给出时为 null' },
        { name: 'url', type: 'string', desc: 'Steam 商店页面链接，如 https://store.steampowered.com/app/1245620/' },
        { name: 'historyLow', type: 'object|null', desc: 'IsThereAnyDeal（ITAD）提供的史低与全网最低价，价格货币由 cc 对应的国家决定。只有服务端配置了 ITAD_API_KEY 时才有这个字段；ITAD 查不到该游戏、没有价格数据或请求失败时为 null' },
        { name: 'historyLow.lowest', type: 'object|null', desc: '历史最低价记录；ITAD 没有记录时为 null' },
        { name: 'historyLow.lowest.shop', type: 'string|null', desc: '出现史低的商店名称，如 Steam、GreenManGaming' },
        { name: 'historyLow.lowest.price', type: 'number|null', desc: '史低价，单位为货币主单位（人民币即元，不是分），如 29.39' },
        { name: 'historyLow.lowest.regular', type: 'number|null', desc: '出现史低时该商店的原价，单位为货币主单位（人民币即元，不是分）' },
        { name: 'historyLow.lowest.currency', type: 'string|null', desc: '货币代码（ISO 4217，如 CNY、USD）' },
        { name: 'historyLow.lowest.cut', type: 'number', desc: '史低时的折扣百分比，0~100 的整数，表示减免的比例（51 表示减 51%）' },
        { name: 'historyLow.lowest.date', type: 'string|null', desc: '出现史低的时间，ISO 8601，带时区偏移，ITAD 返回 UTC（如 2025-06-26T17:00:00+00:00）；上游没有给出时为 null' },
        { name: 'historyLow.current', type: 'object|null', desc: '当前全网最低价（ITAD 收录的各商店中最便宜的一家）；ITAD 没有当前价格时为 null' },
        { name: 'historyLow.current.shop', type: 'string|null', desc: '当前最低价所在商店名称，如 Steam' },
        { name: 'historyLow.current.price', type: 'number|null', desc: '当前最低价，单位为货币主单位（人民币即元，不是分），如 35.99' },
        { name: 'historyLow.current.regular', type: 'number|null', desc: '该商店的原价，单位为货币主单位（人民币即元，不是分）' },
        { name: 'historyLow.current.currency', type: 'string|null', desc: '货币代码（ISO 4217，如 CNY、USD）' },
        { name: 'historyLow.current.cut', type: 'number', desc: '当前折扣百分比，0~100 的整数，表示减免的比例；0 表示未打折' },
        { name: 'historyLow.current.url', type: 'string|null', desc: '购买链接（ITAD 的跳转链接）；上游没有给出时为 null' },
        { name: 'historyLow.current.expiry', type: 'string|null', desc: '当前折扣截止时间，ISO 8601，带时区偏移，ITAD 返回 UTC（如 2026-10-02T17:00:00+00:00）；没有截止时间时为 null' },
        { name: 'historyLow.url', type: 'string|null', desc: 'ITAD 上该游戏的价格页面链接；上游没有给出时为 null' },
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
      fields: [
        { name: 'total', type: 'number', desc: '匹配的结果数（上游 total，上游缺失时为 items 的长度）' },
        { name: 'items', type: 'array', desc: '搜索结果，按 Steam 的相关度排序；没有结果时为空数组' },
        { name: 'items[].type', type: 'string', desc: '条目类型，上游原样返回，通常为 app（游戏/应用）；为 sub 时表示礼包（package）' },
        { name: 'items[].id', type: 'number', desc: 'Steam 数字 ID：type 为 app 时是 AppID，可用于 /api/steam/app 和 /api/steam/players' },
        { name: 'items[].name', type: 'string', desc: '名称（语言由参数 l 决定，没有该语言时为原名）' },
        { name: 'items[].image', type: 'string|null', desc: '231×87 小封面图链接；上游没有时为 null' },
        { name: 'items[].price', type: 'object|null', desc: '当前地区（参数 cc）的价格；免费游戏或该地区不可购买时为 null' },
        { name: 'items[].price.currency', type: 'string', desc: '货币代码（ISO 4217，如 CNY、USD），由参数 cc 决定' },
        { name: 'items[].price.initial', type: 'number', desc: '原价，单位为货币主单位（人民币即元，不是分），如 298 表示 ¥298.00' },
        { name: 'items[].price.final', type: 'number', desc: '现价（折后价），单位为货币主单位（人民币即元，不是分），如 178.8 表示 ¥178.80' },
        { name: 'items[].metascore', type: 'number|null', desc: 'Metacritic 媒体评分（0~100）；没有评分时为 null' },
        { name: 'items[].platforms', type: 'object', desc: '支持的操作系统；上游没有给出时为空对象 {}' },
        { name: 'items[].platforms.windows', type: 'boolean', desc: '是否支持 Windows' },
        { name: 'items[].platforms.mac', type: 'boolean', desc: '是否支持 macOS' },
        { name: 'items[].platforms.linux', type: 'boolean', desc: '是否支持 Linux / SteamOS' },
        { name: 'items[].url', type: 'string', desc: 'Steam 商店页面链接：type 为 sub 时是 /sub/<id>/，其余为 /app/<id>/' },
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
      fields: [
        { name: 'id', type: 'number', desc: '查询的 Steam AppID（即请求参数 id）' },
        { name: 'players', type: 'number', desc: '当前在线人数（Steam 官方实时统计；本接口缓存 1 分钟）' },
      ],
      async handler({ query }) {
        const id = param(query, 'id', APPID);
        const url = `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${id}`;
        return cache.wrap(`steam:players:${id}`, 60_000, async () =>
          ({ id, players: parsePlayerCount(await fetchJSON(url)) }));
      },
    },
  ],
};

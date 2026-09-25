// 苹果 App Store 应用搜索：苹果官方公开的 iTunes Search API（固定地址，不涉及用户指定的网址）。
import { HttpError, fetchJSON, param } from '../../lib/http.js';
import { cache } from '../../lib/cache.js';

export const COUNTRIES = {
  cn: '中国大陆', hk: '中国香港', tw: '中国台湾', mo: '中国澳门', us: '美国', jp: '日本', kr: '韩国', gb: '英国', sg: '新加坡', au: '澳大利亚', ca: '加拿大', de: '德国', fr: '法国',
};

const round1 = (n) => Math.round(n * 10) / 10;

export function formatApp(r) {
  const size = Number(r.fileSizeBytes);
  return {
    id: r.trackId,
    name: r.trackName ?? '',
    bundleId: r.bundleId ?? null,
    developer: r.sellerName ?? r.artistName ?? null,
    price: typeof r.price === 'number' ? r.price : null,
    formattedPrice: r.formattedPrice ?? (r.price === 0 ? '免费' : null),
    currency: r.currency ?? null,
    rating: typeof r.averageUserRating === 'number' ? round1(r.averageUserRating) : null,
    ratingCount: typeof r.userRatingCount === 'number' ? r.userRatingCount : 0,
    version: r.version ?? null,
    genre: r.primaryGenreName ?? null,
    genres: Array.isArray(r.genres) ? r.genres.map(String) : [],
    sizeMB: Number.isFinite(size) && size > 0 ? round1(size / 1048576) : null,
    minOs: r.minimumOsVersion ?? null,
    contentRating: r.contentAdvisoryRating ?? r.trackContentRating ?? null,
    releasedAt: r.releaseDate ?? null,
    updatedAt: r.currentVersionReleaseDate ?? null,
    releaseNotes: r.releaseNotes ? String(r.releaseNotes).slice(0, 500) : null,
    icon: r.artworkUrl512 ?? r.artworkUrl100 ?? r.artworkUrl60 ?? null,
    url: r.trackViewUrl ? String(r.trackViewUrl).replace(/\?uo=\d+$/, '') : null,
    description: String(r.description ?? '').slice(0, 300),
  };
}

export async function searchApps({ keyword, id, country = 'cn', limit = 10 }) {
  const url = id
    ? `https://itunes.apple.com/lookup?id=${id}&country=${country}&entity=software`
    : `https://itunes.apple.com/search?${new URLSearchParams({ term: keyword, country, entity: 'software', limit: String(limit) })}`;
  let json;
  try {
    json = await fetchJSON(url, { timeoutMs: 10_000 });
  } catch (err) {
    if (/HTTP (403|429)/.test(err.message)) throw new HttpError(503, '苹果接口调用过于频繁，请稍后再试');
    throw err;
  }
  const results = Array.isArray(json?.results) ? json.results : [];
  const list = results.filter((r) => r.wrapperType === 'software' || r.kind === 'software').slice(0, limit).map(formatApp);
  return { country, countryName: COUNTRIES[country], keyword: id ? null : keyword, total: list.length, list };
}

export default {
  name: 'appstore',
  category: 'net',
  title: '苹果应用搜索',
  description: '搜索苹果 App Store 中的 iPhone / iPad 应用，返回名称、开发者、价格、评分、版本、大小、图标和下载链接，支持多个国家和地区的商店',
  source: 'Apple iTunes Search API',
  routes: [
    {
      method: 'GET',
      path: '/api/appstore/search',
      summary: '按关键词或 App ID 搜索 App Store 应用',
      params: [
        { name: 'keyword', required: false, desc: '搜索关键词（最多 100 字）；与 id 至少传一个', example: '微信' },
        { name: 'id', required: false, desc: 'App ID（App Store 链接里 id 后面的数字），传入后精确查询，忽略 keyword', example: '414478124' },
        { name: 'country', required: false, default: 'cn', desc: `商店地区：${Object.entries(COUNTRIES).map(([k, v]) => `${k} ${v}`).join('、')}`, example: 'us' },
        { name: 'limit', required: false, default: 10, desc: '返回数量，1~50', example: 5 },
      ],
      fields: [
        { name: 'country', type: 'string', desc: '商店地区代码（如 cn）' },
        { name: 'countryName', type: 'string', desc: '商店地区中文名' },
        { name: 'keyword', type: 'string|null', desc: '搜索关键词；按 id 查询时为 null' },
        { name: 'total', type: 'number', desc: '返回的应用数量' },
        { name: 'list', type: 'array', desc: '应用列表，按苹果返回的相关度排序' },
        { name: 'list[].id', type: 'number', desc: 'App ID' },
        { name: 'list[].name', type: 'string', desc: '应用名称' },
        { name: 'list[].bundleId', type: 'string|null', desc: 'Bundle ID（如 com.tencent.xin）' },
        { name: 'list[].developer', type: 'string|null', desc: '开发者 / 销售方' },
        { name: 'list[].price', type: 'number|null', desc: '价格数值（0 为免费，单位见 currency）' },
        { name: 'list[].formattedPrice', type: 'string|null', desc: '格式化的价格，如"免费""¥6.00"' },
        { name: 'list[].currency', type: 'string|null', desc: '货币代码，如 CNY、USD' },
        { name: 'list[].rating', type: 'number|null', desc: '平均评分（满分 5，保留一位小数）；没有评分时为 null' },
        { name: 'list[].ratingCount', type: 'number', desc: '评分人数' },
        { name: 'list[].version', type: 'string|null', desc: '当前版本号' },
        { name: 'list[].genre', type: 'string|null', desc: '主分类（如 Social Networking、社交）' },
        { name: 'list[].genres', type: 'array', desc: '全部分类' },
        { name: 'list[].sizeMB', type: 'number|null', desc: '安装包大小（MB，保留一位小数）' },
        { name: 'list[].minOs', type: 'string|null', desc: '最低系统版本（如 15.0）' },
        { name: 'list[].contentRating', type: 'string|null', desc: '年龄分级（如 4+、12+）' },
        { name: 'list[].releasedAt', type: 'string|null', desc: '首次上架时间（ISO 8601）' },
        { name: 'list[].updatedAt', type: 'string|null', desc: '当前版本发布时间（ISO 8601）' },
        { name: 'list[].releaseNotes', type: 'string|null', desc: '当前版本更新说明（前 500 字）；没有时为 null' },
        { name: 'list[].icon', type: 'string|null', desc: '图标地址（512px，没有时退回 100px）' },
        { name: 'list[].url', type: 'string|null', desc: 'App Store 页面地址' },
        { name: 'list[].description', type: 'string', desc: '应用简介（前 300 字）' },
      ],
      async handler({ query }) {
        const keyword = param(query, 'keyword', { max: 100 })?.trim();
        const id = param(query, 'id', { pattern: /^\d{1,12}$/ });
        const country = param(query, 'country', { default: 'cn', oneOf: Object.keys(COUNTRIES) });
        const limit = param(query, 'limit', { default: 10, int: true, min: 1, max: 50 });
        if (!keyword && !id) throw new HttpError(400, '缺少参数 keyword（或 id）');
        const key = id ? `appstore:id:${id}:${country}` : `appstore:kw:${keyword.toLowerCase()}:${country}:${limit}`;
        return cache.wrap(key, 10 * 60_000, () => searchApps({ keyword, id, country, limit }));
      },
    },
  ],
};

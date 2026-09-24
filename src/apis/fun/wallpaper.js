import { randomBytes } from 'node:crypto';
import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError, param } from '../../lib/http.js';

const UPSTREAM = 'https://wallhaven.cc/api/v1/search';
const TTL_MS = 10 * 60_000;
const RES_RE = /^\d{3,4}x\d{3,4}$/;
const RATIO_RE = /^\d{1,2}x\d{1,2}$/;

// wallhaven categories 位掩码：general / anime / people
export const WALLPAPER_CATEGORIES = { all: '111', general: '100', anime: '010', people: '001' };

export function buildWallhavenUrl({ category = 'all', resolution, ratio, q } = {}) {
  const qs = new URLSearchParams({
    categories: WALLPAPER_CATEGORIES[category] ?? '111',
    purity: '100', // 仅 SFW
    sorting: 'random',
  });
  if (resolution) qs.set('atleast', resolution);
  if (ratio) qs.set('ratios', ratio);
  if (q) qs.set('q', q);
  return `${UPSTREAM}?${qs}`;
}

// search 响应：{ data: [{ id, url, path, purity, category, resolution, dimension_x, dimension_y, file_size, file_type, colors, thumbs }], meta }
export function parseWallhaven(raw) {
  if (!Array.isArray(raw?.data)) throw new HttpError(502, 'wallhaven 返回的数据格式无法识别');
  return raw.data
    .filter((w) => w.purity === 'sfw' && w.path)
    .map((w) => ({
      id: w.id,
      url: w.path,
      page: w.url ?? w.short_url ?? null,
      thumb: w.thumbs?.large ?? w.thumbs?.original ?? null,
      width: w.dimension_x ?? null,
      height: w.dimension_y ?? null,
      resolution: w.resolution ?? null,
      category: w.category ?? null,
      fileSize: w.file_size ?? null,
      fileType: w.file_type ?? null,
      colors: w.colors ?? [],
      source: 'wallhaven',
    }));
}

export function picsumWallpaper(resolution = '1920x1080', seed = randomBytes(6).toString('hex')) {
  const [w, h] = resolution.split('x').map(Number);
  const cw = Math.min(w, 5000);
  const ch = Math.min(h, 5000);
  return {
    id: seed,
    url: `https://picsum.photos/seed/${seed}/${cw}/${ch}`,
    page: 'https://picsum.photos/',
    thumb: `https://picsum.photos/seed/${seed}/480/270`,
    width: cw, height: ch, resolution: `${cw}x${ch}`,
    category: 'general', fileSize: null, fileType: 'image/jpeg', colors: [],
    source: 'picsum',
  };
}

export async function loadWallhaven(opts = {}) {
  return parseWallhaven(await fetchJSON(buildWallhavenUrl(opts)));
}

// 缓存一批随机结果，每次请求从中随机取一张
export async function loadRandomWallpaper(opts = {}) {
  const { source = 'wallhaven', resolution } = opts;
  if (source === 'picsum') return picsumWallpaper(resolution || '1920x1080');
  const key = `wallhaven:${opts.category ?? 'all'}:${resolution ?? ''}:${opts.ratio ?? ''}:${opts.q ?? ''}`;
  try {
    const { data } = await cache.wrap(key, TTL_MS, () => loadWallhaven(opts));
    if (data.length) return data[Math.floor(Math.random() * data.length)];
  } catch (err) {
    // 按关键词搜索时 picsum 无法替代，直接报告上游故障；否则走 picsum 兜底
    if (opts.q) throw err;
  }
  if (opts.q) throw new HttpError(404, '没有找到符合条件的壁纸');
  return picsumWallpaper(resolution || '1920x1080');
}

function readOpts(query) {
  return {
    source: param(query, 'source', { default: 'wallhaven', oneOf: ['wallhaven', 'picsum'] }),
    category: param(query, 'category', { default: 'all', oneOf: Object.keys(WALLPAPER_CATEGORIES) }),
    resolution: param(query, 'resolution', { pattern: RES_RE }),
    ratio: param(query, 'ratio', { pattern: RATIO_RE }),
    q: param(query, 'q', { max: 50 }),
  };
}

const PARAMS = [
  { name: 'source', default: 'wallhaven', desc: '图源：wallhaven（仅 SFW）或 picsum', example: 'wallhaven' },
  { name: 'category', default: 'all', desc: '分类：all / general / anime / people', example: 'anime' },
  { name: 'resolution', desc: '最低分辨率，格式 宽x高', example: '1920x1080' },
  { name: 'ratio', desc: '宽高比，例如 16x9、9x16（手机壁纸）', example: '16x9' },
  { name: 'q', desc: '关键词（英文效果更好，仅 wallhaven）', example: 'mountain' },
];

export default {
  name: 'wallpaper',
  category: 'fun',
  title: '随机壁纸',
  description: '随机高清壁纸，来自 wallhaven（仅全年龄）或 Lorem Picsum',
  source: 'wallhaven.cc / picsum.photos',
  routes: [
    {
      method: 'GET',
      path: '/api/wallpaper/random',
      summary: '随机返回一张壁纸的信息与地址',
      params: PARAMS,
      fields: [
        {
          name: 'id',
          type: 'string',
          desc: '壁纸 ID：wallhaven 为壁纸编号（如 "zyxvqy"）；picsum 为随机生成的 12 位十六进制种子，同一种子总是对应同一张图',
        },
        {
          name: 'url',
          type: 'string',
          desc: '原图链接：wallhaven 为原始文件，分辨率见 width/height；picsum 为按 width×height 生成的 JPG 图片地址',
        },
        { name: 'page', type: 'string|null', desc: '详情页：wallhaven 为 https://wallhaven.cc/w/{id}；picsum 固定为 https://picsum.photos/；上游缺失时为 null' },
        {
          name: 'thumb',
          type: 'string|null',
          desc: '缩略图链接：wallhaven 为官方预览缩略图（优先 large 规格，没有时用 original 规格，均远小于原图）；picsum 为 480×270；缺失时为 null',
        },
        { name: 'width', type: 'number|null', desc: '原图宽度（像素）；picsum 为请求的宽度（上限 5000，默认 1920）；上游缺失时为 null' },
        { name: 'height', type: 'number|null', desc: '原图高度（像素）；picsum 为请求的高度（上限 5000，默认 1080）；上游缺失时为 null' },
        { name: 'resolution', type: 'string|null', desc: '分辨率，格式 "宽x高"，如 "3840x2160"；上游缺失时为 null' },
        { name: 'category', type: 'string|null', desc: '分类：general=综合、anime=动漫、people=人物；picsum 固定为 general' },
        { name: 'fileSize', type: 'number|null', desc: '文件大小（字节）；picsum 为 null' },
        { name: 'fileType', type: 'string|null', desc: '文件 MIME 类型，如 image/jpeg、image/png；picsum 固定为 image/jpeg' },
        { name: 'colors', type: 'array', desc: '主色调，字符串数组，每项为 "#rrggbb" 格式；picsum 或上游未提供时为空数组' },
        {
          name: 'source',
          type: 'string',
          desc:
            '实际图源："wallhaven" 或 "picsum"。请求 source=picsum 时固定为 picsum；默认走 wallhaven，' +
            '若 wallhaven 请求失败或没有符合条件的结果且未传 q，会自动回退为 picsum 随机图（此时本字段为 "picsum"，category/ratio 不生效）；' +
            '传了 q 时不回退：没有结果返回 404，wallhaven 故障返回 502/504',
        },
      ],
      async handler({ query }) {
        return { data: await loadRandomWallpaper(readOpts(query)), updatedAt: new Date().toISOString() };
      },
    },
    {
      method: 'GET',
      path: '/api/wallpaper/random.jpg',
      raw: true,
      summary: '302 跳转到一张随机壁纸，可直接用作 <img> 地址',
      params: PARAMS,
      returns:
        '302 跳转到一张随机壁纸的原图地址：默认为 wallhaven 原图（仅全年龄）；source=picsum 或 wallhaven 不可用且未传 q 时，' +
        '为 picsum 随机 JPG（尺寸取 resolution，默认 1920×1080）。响应头 Cache-Control: no-store，每次请求重新随机；传了 q 但没有结果时返回 404 JSON 错误，wallhaven 故障时返回 502/504 JSON 错误',
      async handler({ query }) {
        const w = await loadRandomWallpaper(readOpts(query));
        return { status: 302, headers: { location: w.url, 'cache-control': 'no-store' }, body: '' };
      },
    },
  ],
};

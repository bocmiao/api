import { HttpError, param } from '../../lib/http.js';
import { fetchPage, decodeBody } from '../tools/webmeta.js';
import { createGate, fetchFollow, readLimited, checkTarget, toHttpError, isBlockedIP } from './common.js';
import { stripNoise, scanTags } from '../../lib/html.js';

const MAX_ICON_BYTES = 200 * 1024;
const TIMEOUT_MS = 5000;
const MAX_TRIES = 4;
const TOTAL_TIMEOUT_MS = 10_000; // 下载图标的总时限（不含抓取页面）
const DAY_MS = 86_400_000;
const gate = createGate(20);

// 图标自带的有界缓存（不用全局 cache，避免被大量不同网址撑满内存）：
// 最多 300 条、图片合计不超过 20MB，1 天过期；找不到图标的结果（null）缓存 10 分钟
const CACHE_MAX_ENTRIES = 300;
const CACHE_MAX_BYTES = 20 * 1024 * 1024;
const iconCache = new Map();
let cacheBytes = 0;
const sizeOf = (v) => v?.body?.length ?? 0;
function cacheDelete(key) {
  const e = iconCache.get(key);
  if (!e) return;
  cacheBytes -= sizeOf(e.value);
  iconCache.delete(key);
}
export function cacheGet(key) {
  const e = iconCache.get(key);
  if (!e) return undefined;
  if (e.expires < Date.now()) {
    cacheDelete(key);
    return undefined;
  }
  return e.value;
}
function cacheSet(key, value, ttl) {
  cacheDelete(key);
  iconCache.set(key, { value, expires: Date.now() + ttl });
  cacheBytes += sizeOf(value);
  while (iconCache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) cacheDelete(iconCache.keys().next().value);
}
export const clearIconCache = () => {
  iconCache.clear();
  cacheBytes = 0;
};
export const iconCacheStats = () => ({ entries: iconCache.size, bytes: cacheBytes });
export { cacheSet as _cacheSetForTest };

const absolutize = (href, base) => {
  try {
    const u = new URL(String(href).trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
};

// 从 HTML 中找出图标声明：<link rel="icon" / "shortcut icon" / "apple-touch-icon(-precomposed)">
// 返回 [{ href, rel, size }]，size 为声明的最大边长（像素），sizes="any" 或 SVG 为 Infinity，未声明为 null
export function findIcons(html, baseUrl) {
  const head = stripNoise(String(html).slice(0, 512 * 1024));
  let base = baseUrl;
  let baseSeen = false;
  const icons = [];
  for (const { name, attrs: a } of scanTags(head, ['link', 'base'])) {
    if (name === 'base') {
      if (!baseSeen && a.href) base = absolutize(a.href, baseUrl) ?? base;
      baseSeen = true;
      continue;
    }
    const rel = (a.rel ?? '').toLowerCase().split(/\s+/);
    const apple = rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed');
    if (!apple && !rel.includes('icon')) continue;
    if (!a.href) continue;
    let size = null;
    const sizes = (a.sizes ?? '').toLowerCase().slice(0, 200);
    if (sizes.includes('any')) size = Infinity;
    else {
      const dims = [...sizes.matchAll(/(\d{1,5})\s*x\s*(\d{1,5})/g)].map((d) => Math.max(Number(d[1]), Number(d[2])));
      if (dims.length) size = Math.max(...dims);
    }
    if (size == null && (/svg/i.test(a.type ?? '') || /\.svg(\?|#|$)/i.test(a.href))) size = Infinity;
    if (size == null && apple) size = 180; // apple-touch-icon 未声明尺寸时默认 180×180
    icons.push({ href: a.href, rel: apple ? 'apple-touch-icon' : 'icon', size });
  }
  return icons.map((i) => ({ ...i, href: absolutize(i.href, base) })).filter((i) => i.href);
}

// 按目标尺寸排序候选：≥ 目标的最小尺寸 → 矢量（any / SVG）→ 小于目标的从大到小 → 未声明尺寸的（rel=icon 优先）。
// 最后补上站点根目录的 /favicon.ico
export function rankIcons(icons, size, fallbackUrl) {
  const bigger = icons.filter((i) => Number.isFinite(i.size) && i.size >= size).sort((a, b) => a.size - b.size);
  const vector = icons.filter((i) => i.size === Infinity);
  const smaller = icons.filter((i) => Number.isFinite(i.size) && i.size < size).sort((a, b) => b.size - a.size);
  const unknown = icons.filter((i) => i.size == null).sort((a, b) => (a.rel === 'icon' ? 0 : 1) - (b.rel === 'icon' ? 0 : 1));
  const urls = [...bigger, ...vector, ...smaller, ...unknown].map((i) => i.href);
  if (fallbackUrl) urls.push(fallbackUrl);
  return [...new Set(urls)];
}

const IMAGE_TYPE = /^image\/[a-z0-9.+-]+$/;

// 下载单个图标：跟随跳转（每跳检查）、只接受 200 + image/* 且不超过 200KB。
// 失败返回 null；指向内网（或跳转到内网）的候选直接跳过，不会发起连接
async function downloadIcon(url, blocked, signal) {
  let r;
  try {
    r = await fetchFollow(url, {
      blocked,
      signal,
      maxRedirects: 3,
      timeoutMs: TIMEOUT_MS,
      headers: { accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5' },
    });
  } catch {
    return null;
  }
  const type = String(r.res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const declared = Number(r.res.headers['content-length']);
  if (r.res.statusCode !== 200 || !IMAGE_TYPE.test(type) || declared > MAX_ICON_BYTES) {
    r.res.destroy();
    return null;
  }
  try {
    const { body } = await readLimited(r.res, { maxBytes: MAX_ICON_BYTES, decompress: true, overflow: 'error', signal: r.signal });
    return body.length ? { url: r.url.href, type, body } : null;
  } catch {
    return null;
  }
}

// 返回 { url（图标地址）, type, body }；找不到时抛 404。blocked 仅供测试替换
export async function findFavicon(rawUrl, { size = 32, blocked = isBlockedIP } = {}) {
  let page;
  try {
    page = checkTarget(rawUrl, blocked);
  } catch (err) {
    throw toHttpError(err);
  }
  let icons = [];
  let origin = page.origin;
  try {
    const p = await fetchPage(page.href, { blocked });
    origin = new URL(p.url).origin;
    icons = findIcons(decodeBody(p.body, p.contentType), p.url);
  } catch (err) {
    // 页面本身指向内网 / 跳转到内网 / 域名无法解析时直接报错；其他情况（非 HTML、4xx 等）回退到 /favicon.ico
    if (err.status === 400) throw err;
  }
  const candidates = rankIcons(icons, size, `${origin}/favicon.ico`).slice(0, MAX_TRIES);
  const deadline = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
  for (const url of candidates) {
    if (deadline.aborted) break;
    const icon = await downloadIcon(url, blocked, deadline);
    if (icon) return icon;
  }
  throw new HttpError(404, '没有找到该网站的图标');
}

export function iconResponse(icon) {
  return {
    status: 200,
    headers: {
      'content-type': icon.type,
      'cache-control': `private, max-age=${DAY_MS / 1000}`,
      // 图标从本站域名直接返回：禁止 SVG 中的脚本与外部资源，并禁止浏览器嗅探成其他类型
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
      'x-favicon-url': icon.url,
    },
    body: icon.body,
  };
}

export default {
  name: 'favicon',
  category: 'net',
  title: '网站图标',
  description: '获取网站的 favicon 图标图片，按需要的尺寸挑选最合适的一个',
  source: '目标网站',
  routes: [
    {
      method: 'GET',
      path: '/api/favicon',
      raw: true,
      summary: '获取网站图标（直接返回图片）',
      params: [
        { name: 'url', required: true, desc: '网站地址（http / https），只允许公网地址', example: 'https://www.baidu.com' },
        { name: 'size', required: false, default: 32, desc: '期望的图标尺寸（像素，16~512），用于在多个图标中挑选最接近的', example: 64 },
      ],
      returns: '图标图片本身（Content-Type 为上游返回的 image/*，如 image/png、image/x-icon、image/vnd.microsoft.icon、image/svg+xml），不超过 200KB。'
        + '查找顺序：页面 <link rel="icon"> / apple-touch-icon 中按 size 挑选（优先不小于 size 的最小尺寸，其次矢量 SVG，再次较小的），都不可用时回退到网站根目录的 /favicon.ico。'
        + '响应带 Cache-Control: private, max-age=86400（缓存 1 天）、Content-Security-Policy: default-src \'none\'; style-src \'unsafe-inline\'（禁止 SVG 中的脚本）、X-Content-Type-Options: nosniff，'
        + '以及 X-Favicon-Url（图标的原始地址）。找不到图标时返回 HTTP 404 的 JSON 错误；网址指向内网时返回 400。',
      async handler({ query }) {
        const raw = param(query, 'url', { required: true, max: 2048 });
        const size = param(query, 'size', { default: 32, int: true, min: 16, max: 512 });
        let key;
        try {
          key = `${checkTarget(raw).href}|${size}`;
        } catch (err) {
          throw toHttpError(err);
        }
        const hit = cacheGet(key);
        if (hit === null) throw new HttpError(404, '没有找到该网站的图标');
        if (hit) return iconResponse(hit);
        try {
          const icon = await gate(() => findFavicon(raw, { size }));
          cacheSet(key, icon, DAY_MS);
          return iconResponse(icon);
        } catch (err) {
          if (err.status === 404) cacheSet(key, null, 10 * 60_000);
          throw err;
        }
      },
    },
  ],
};

import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { cache } from '../../lib/cache.js';
import { HttpError, param } from '../../lib/http.js';

const UA = 'Mozilla/5.0 (compatible; APIHubBot/1.0; +webmeta)';
const TIMEOUT_MS = 5000;
const MAX_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;

// IP 检查、安全 DNS 解析与 URL 校验已移至 src/lib/netguard.js，供推送等功能复用
export { isBlockedIP, parseIPv6, makeLookup, checkUrl } from '../../lib/netguard.js';
import { isBlockedIP, makeLookup, checkUrl } from '../../lib/netguard.js';
import { stripNoise, scanTags, asciiLower, safeDecode } from '../../lib/html.js';

function requestOnce(u, signal, blocked) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET',
      lookup: makeLookup(blocked),
      signal,
      agent: false,
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'accept-encoding': 'gzip, deflate, br',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    req.on('response', resolve);
    req.on('error', reject);
    req.end();
  });
}

function decompress(res) {
  const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(zlib.createGunzip());
  if (enc === 'deflate') return res.pipe(zlib.createInflate());
  if (enc === 'br') return res.pipe(zlib.createBrotliDecompress());
  return res;
}

// 读取至多 MAX_BYTES 字节（解压后），超出部分直接截断
function readLimited(res, signal) {
  return new Promise((resolve, reject) => {
    const stream = decompress(res);
    const chunks = [];
    let total = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      res.destroy();
      if (stream !== res) stream.destroy();
      resolve(Buffer.concat(chunks, Math.min(total, MAX_BYTES)));
    };
    stream.on('data', (c) => {
      chunks.push(c);
      total += c.length;
      if (total >= MAX_BYTES) finish();
    });
    const fail = (e) => {
      if (done) return;
      if (signal.aborted) { done = true; res.destroy(); return reject(signal.reason ?? e); }
      return chunks.length ? finish() : ((done = true), reject(e));
    };
    stream.on('end', finish);
    stream.on('error', fail);
    res.on('error', fail);
    stream.on('close', () => fail(new Error('closed')));
    signal.addEventListener('abort', () => fail(signal.reason), { once: true });
  });
}

// blocked 仅供测试替换
export async function fetchPage(rawUrl, { blocked = isBlockedIP, timeoutMs = TIMEOUT_MS } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let u = checkUrl(rawUrl, blocked);
  for (let hop = 0; ; hop++) {
    let res;
    try {
      res = await requestOnce(u, signal, blocked);
    } catch (err) {
      if (err.code === 'EBLOCKED') throw new HttpError(400, '不允许访问内网或保留地址');
      if (signal.aborted || err.name === 'AbortError' || err.name === 'TimeoutError') throw new HttpError(504, '目标网页响应超时');
      if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') throw new HttpError(400, '无法解析该域名');
      throw new HttpError(502, '无法连接目标网页');
    }
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.destroy();
      if (hop >= MAX_REDIRECTS) throw new HttpError(502, `重定向次数超过 ${MAX_REDIRECTS} 次`);
      let next;
      try {
        next = new URL(res.headers.location, u).href;
      } catch {
        throw new HttpError(502, '目标网页返回了无效的重定向地址');
      }
      u = checkUrl(next, blocked);
      continue;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      res.destroy();
      throw new HttpError(502, `目标网页返回 HTTP ${res.statusCode}`);
    }
    const type = String(res.headers['content-type'] ?? '').toLowerCase();
    if (type && !/^(text\/html|application\/xhtml\+xml)/.test(type)) {
      res.destroy();
      throw new HttpError(415, `目标不是 HTML 网页（${type.split(';')[0]}）`);
    }
    let buf;
    try {
      buf = await readLimited(res, signal);
    } catch {
      throw new HttpError(signal.aborted ? 504 : 502, signal.aborted ? '目标网页响应超时' : '读取目标网页失败');
    }
    return { url: u.href, status: res.statusCode, contentType: type, body: buf };
  }
}

// ---------- HTML 解析 ----------


export function detectCharset(contentType = '', buf) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  const head = buf.subarray(0, 4096).toString('latin1');
  const m = /<meta[^>]+charset=["']?\s*([\w-]+)/i.exec(head);
  return m ? m[1].toLowerCase() : 'utf-8';
}

export function decodeBody(buf, contentType) {
  let charset = detectCharset(contentType, buf);
  if (charset === 'gb2312') charset = 'gbk';
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

function absolutize(href, base) {
  if (!href) return null;
  try {
    const u = new URL(href.trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

// 属性值已在 parseAttrs 中解码过一次，这里只规整空白；<title> 文本需要单独解码
const clean = (s) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim() || null);

// <title> 的内容：顺序查找开始和结束标签，找不到时为 undefined
function titleOf(html) {
  const lower = asciiLower(html);
  const open = lower.indexOf('<title');
  if (open === -1) return undefined;
  const gt = lower.indexOf('>', open);
  const close = gt === -1 ? -1 : lower.indexOf('</title', gt);
  return close === -1 ? undefined : html.slice(gt + 1, close);
}

export function parseMeta(html, baseUrl) {
  // 目标网页不可信：用线性时间的扫描器，避免正则在大量未闭合标签上退化成 O(n²)
  const head = stripNoise(html.slice(0, 512 * 1024));
  const meta = {};
  const links = [];
  let base = baseUrl;
  for (const { name: kind, attrs: a } of scanTags(head, ['meta', 'link', 'base'])) {
    if (kind === 'meta') {
      const key = (a.property || a.name || a.itemprop || '').toLowerCase();
      if (key && a.content != null && !(key in meta)) meta[key] = a.content;
    } else if (kind === 'link') {
      links.push(a);
    } else if (kind === 'base' && a.href) {
      base = absolutize(a.href, baseUrl) ?? base;
    }
  }
  const titleTag = titleOf(head);

  const icons = links.filter((l) => /(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/i.test(l.rel ?? '') && l.href);
  const pick = icons.find((l) => /(^|\s)icon(\s|$)/i.test(l.rel) && !/apple/i.test(l.rel)) ?? icons[0];
  const canonical = links.find((l) => /(^|\s)canonical(\s|$)/i.test(l.rel ?? ''))?.href;

  return {
    title: clean(meta['og:title']) ?? clean(titleTag == null ? null : safeDecode(titleTag)) ?? clean(meta['twitter:title']),
    description: clean(meta.description) ?? clean(meta['og:description']) ?? clean(meta['twitter:description']),
    image: absolutize(meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src'], base),
    favicon: absolutize(pick?.href, base) ?? absolutize('/favicon.ico', baseUrl),
    siteName: clean(meta['og:site_name']) ?? clean(meta['application-name']) ?? new URL(baseUrl).hostname,
    type: clean(meta['og:type']),
    keywords: clean(meta.keywords),
    canonical: absolutize(canonical ?? meta['og:url'], base),
  };
}

// 抓取并解析网页，返回值即接口的 data；opts 透传给 fetchPage（blocked 仅供测试替换）
export async function loadWebMeta(url, opts) {
  const page = await fetchPage(url, opts);
  const html = decodeBody(page.body, page.contentType);
  return { url: page.url, ...parseMeta(html, page.url) };
}

export default {
  name: 'webmeta',
  category: 'tools',
  title: '网页信息',
  description: '抓取网页的标题、描述、分享图、图标与站点名称',
  source: '目标网页',
  routes: [
    {
      method: 'GET',
      path: '/api/webmeta',
      summary: '获取网页标题、描述、og:image、favicon 等信息',
      params: [{ name: 'url', required: true, desc: '网页地址（http / https）', example: 'https://www.baidu.com' }],
      fields: [
        { name: 'url', type: 'string', desc: '实际抓取的网页地址：跟随重定向（最多 3 次）后的最终地址，已去掉 # 及之后的部分' },
        { name: 'title', type: 'string|null', desc: '网页标题：依次取 og:title、<title>、twitter:title 中第一个非空的，已解码 HTML 实体并把连续空白合并为一个空格；都没有时为 null' },
        { name: 'description', type: 'string|null', desc: '网页描述：依次取 meta description、og:description、twitter:description 中第一个非空的；都没有时为 null' },
        { name: 'image', type: 'string|null', desc: '分享图的绝对地址：依次取 og:image、og:image:url、twitter:image、twitter:image:src 中第一个非空的值，相对地址按 <base href> 或网页地址补全；没有这些标签、取到的值为空或不是 http/https 地址时为 null' },
        { name: 'favicon', type: 'string', desc: '网站图标的绝对地址：优先取 <link rel="icon"> 或 rel="shortcut icon"，其次 apple-touch-icon；页面没有声明时为网站根目录的 /favicon.ico（不检查该文件是否存在）' },
        { name: 'siteName', type: 'string', desc: '站点名称：依次取 og:site_name、application-name；都没有时为网页的域名（如 github.com）' },
        { name: 'type', type: 'string|null', desc: 'Open Graph 类型（og:type 的原值，如 website、article）；没有声明时为 null' },
        { name: 'keywords', type: 'string|null', desc: 'meta keywords 的原文（未拆分，分隔符由网页决定，通常是英文或中文逗号）；没有声明时为 null' },
        { name: 'canonical', type: 'string|null', desc: '规范地址（绝对地址）：取 <link rel="canonical">，没有时取 og:url；都没有或不是 http/https 地址时为 null' },
      ],
      async handler({ query }) {
        const raw = param(query, 'url', { required: true, max: 2048 });
        const normalized = checkUrl(raw).href;
        return cache.wrap(`webmeta:${normalized}`, 30 * 60_000, () => loadWebMeta(normalized));
      },
    },
  ],
};

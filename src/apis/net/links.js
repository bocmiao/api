import { param } from '../../lib/http.js';
import { fetchPage, decodeBody } from '../tools/webmeta.js';
import {
  createGate, mapLimit, fetchFollow, readLimited, checkTarget, toHttpError, isBlockedIP, reasonOf, statusText, since, BLOCKED_MSG,
} from './common.js';
import { stripNoise, scanTags, textOf, asciiLower } from '../../lib/html.js';

const CONCURRENCY = 5;
const LINK_TIMEOUT_MS = 5000;
// 每次检测最多发出 50 个请求（每个还可能跳转），全局只允许少量检测同时进行
const gate = createGate(4);

const MAX_TEXT_SCAN = 4096;

// 在单调递增的位置上反复查找同一个子串：缓存上次结果，保证总扫描量是线性的
function finder(s, needle) {
  let last = -2;
  return (from) => {
    if (last === -1 || last >= from) return last;
    last = s.indexOf(needle, from);
    return last;
  };
}

// 提取页面中的 <a href> 链接：只保留 http / https，去掉 # 片段后去重，按出现顺序；页内锚点（#xxx）不算。
// 返回 [{ url, text }]，text 为锚文本（去掉标签、合并空白，最多 100 字；没有文字时取 title 或图片 alt）。
// 全程线性扫描（见 html.js），恶意构造的页面不会拖慢服务器。
export function extractLinks(html, baseUrl) {
  const clean = stripNoise(String(html));
  const lower = asciiLower(clean);
  let base = baseUrl;
  for (const b of scanTags(clean, ['base'])) {
    try {
      if (b.attrs.href) base = new URL(b.attrs.href.trim(), baseUrl).href;
    } catch { /* 忽略无效的 base */ }
    break;
  }
  const seen = new Set();
  const out = [];
  const nextClose = finder(lower, '</a');
  const nextOpen = finder(lower, '<a');
  for (const a of scanTags(clean, ['a'])) {
    const href = a.attrs.href?.trim();
    if (!href || href.startsWith('#')) continue;
    let u;
    try {
      u = new URL(href, base);
    } catch {
      continue;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    u.hash = '';
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    // 锚文本：到 </a> 或下一个 <a 为止（最多看 4KB）
    const stop = [nextClose(a.end), nextOpen(a.end)].filter((x) => x !== -1);
    const inner = clean.slice(a.end, Math.min(a.end + MAX_TEXT_SCAN, ...stop));
    let text = textOf(inner);
    if (!text) text = a.attrs.title?.trim() || ([...scanTags(inner, ['img'])].find((img) => img.attrs.alt?.trim())?.attrs.alt.trim() ?? '');
    out.push({ url: u.href, text: text.slice(0, 100) });
  }
  return out;
}

// 检查一个链接：HEAD，遇到 405 / 501 改用 GET 且只读 1KB；跟随最多 5 次跳转，每跳检查；总时限 5 秒。
// 指向内网（含跳转到内网、域名解析到内网）的链接标记为 skipped，不会建立连接
export async function checkLink(link, { blocked = isBlockedIP, timeoutMs = LINK_TIMEOUT_MS } = {}) {
  const t0 = performance.now();
  const base = { url: link.url, text: link.text };
  const skipped = (reason) => ({ ...base, status: null, statusText: null, ok: false, dead: false, skipped: true, error: reason, finalUrl: null, ms: since(t0) });
  try {
    checkTarget(link.url, blocked);
  } catch (err) {
    return skipped(err.blocked ? `${BLOCKED_MSG}，已跳过` : `${err.message}，已跳过`);
  }
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    let r = await fetchFollow(link.url, { method: 'HEAD', blocked, maxRedirects: 5, timeoutMs, signal });
    r.res.destroy();
    if (r.res.statusCode === 405 || r.res.statusCode === 501) {
      r = await fetchFollow(r.url.href, { method: 'GET', blocked, maxRedirects: 5, timeoutMs, signal });
      await readLimited(r.res, { maxBytes: 1024, signal }).catch(() => null);
    }
    const status = r.res.statusCode;
    const dead = status >= 400;
    return {
      ...base,
      status,
      statusText: statusText(status),
      ok: !dead,
      dead,
      skipped: false,
      error: dead ? `HTTP ${status} ${statusText(status)}` : null,
      finalUrl: r.url.href !== link.url ? r.url.href : null,
      ms: since(t0),
    };
  } catch (err) {
    if (err.blocked || err.code === 'EBLOCKED') return skipped(`${err.hops?.length ? '跳转目标' : '域名解析结果'}为内网或保留地址，已跳过`);
    return {
      ...base, status: null, statusText: null, ok: false, dead: true, skipped: false, error: reasonOf(signal.aborted ? { name: 'TimeoutError' } : err), finalUrl: null, ms: since(t0),
    };
  }
}

// blocked、timeoutMs 仅供测试替换
export async function checkLinks(rawUrl, { limit = 30, blocked = isBlockedIP, timeoutMs = LINK_TIMEOUT_MS } = {}) {
  try {
    checkTarget(rawUrl, blocked);
  } catch (err) {
    throw toHttpError(err);
  }
  const page = await fetchPage(rawUrl, { blocked });
  const links = extractLinks(decodeBody(page.body, page.contentType), page.url);
  const picked = links.slice(0, limit);
  const results = await mapLimit(picked, CONCURRENCY, (l) => checkLink(l, { blocked, timeoutMs }));
  return {
    url: page.url,
    found: links.length,
    summary: {
      total: results.length,
      ok: results.filter((r) => r.ok).length,
      dead: results.filter((r) => r.dead).length,
      skipped: results.filter((r) => r.skipped).length,
    },
    links: results,
  };
}

export default {
  name: 'link-check',
  category: 'net',
  title: '死链检测',
  description: '抓取网页中的链接并逐个检测是否可以访问，找出 4xx / 5xx / 无法连接的死链',
  source: '目标网页及其链接',
  routes: [
    {
      method: 'GET',
      path: '/api/links/check',
      summary: '检测网页中的死链',
      params: [
        { name: 'url', required: true, desc: '网页地址（http / https），只允许公网地址', example: 'https://example.com' },
        { name: 'limit', required: false, default: 30, desc: '最多检测的链接数，1~50（按页面中出现的顺序取前 limit 个）', example: 20 },
      ],
      fields: [
        { name: 'url', type: 'string', desc: '实际抓取的网页地址（跟随最多 3 次跳转后的地址）' },
        { name: 'found', type: 'number', desc: '页面中找到的 http / https 链接数（已去掉 # 片段并去重）' },
        { name: 'summary', type: 'object', desc: '汇总；total = ok + dead + skipped' },
        { name: 'summary.total', type: 'number', desc: '实际检测的链接数（found 与 limit 中较小的一个）' },
        { name: 'summary.ok', type: 'number', desc: '正常的链接数（状态码 < 400）' },
        { name: 'summary.dead', type: 'number', desc: '死链数（4xx、5xx 或连接失败 / 超时）' },
        { name: 'summary.skipped', type: 'number', desc: '跳过的链接数（指向内网或保留地址，未访问）' },
        { name: 'links', type: 'array', desc: '每个链接的检测结果，顺序与页面中出现的顺序一致' },
        { name: 'links[].url', type: 'string', desc: '链接的绝对地址（按 <base href> 或页面地址补全，已去掉 # 片段）' },
        { name: 'links[].text', type: 'string', desc: '锚文本（去掉标签、合并空白，最多 100 字；没有文字时取 title 或图片 alt；都没有时为空字符串）' },
        { name: 'links[].status', type: 'number|null', desc: '最终的 HTTP 状态码（跟随跳转后）；连接失败、超时或跳过时为 null' },
        { name: 'links[].statusText', type: 'string|null', desc: '状态码的中文说明（如 404 未找到）；status 为 null 时为 null' },
        { name: 'links[].ok', type: 'boolean', desc: '是否正常（状态码 < 400）' },
        { name: 'links[].dead', type: 'boolean', desc: '是否死链：状态码 ≥ 400，或连接失败、超时' },
        { name: 'links[].skipped', type: 'boolean', desc: '是否跳过：链接或其跳转目标指向内网 / 保留地址时不访问，标记为跳过（既不算正常也不算死链）' },
        { name: 'links[].error', type: 'string|null', desc: '问题说明：死链为"HTTP 404 未找到"或连接失败原因（如"连接超时""域名无法解析"），跳过时为跳过原因；正常时为 null' },
        { name: 'links[].finalUrl', type: 'string|null', desc: '发生跳转时的最终地址；没有跳转、失败或跳过时为 null' },
        { name: 'links[].ms', type: 'number', desc: '检测该链接的耗时（毫秒，保留两位小数，含跳转；单个链接最多 5 秒）' },
      ],
      async handler({ query }) {
        const url = param(query, 'url', { required: true, max: 2048 });
        const limit = param(query, 'limit', { default: 30, int: true, min: 1, max: 50 });
        return { data: await gate(() => checkLinks(url, { limit })) };
      },
    },
  ],
};

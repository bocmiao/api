// 网页正文提取 / 网页转 Markdown。抓取经过 page.js（每跳 SSRF 检查、限量、超时），解析见 readable.js（线性时间）。
import { param } from '../../lib/http.js';
import { cache } from '../../lib/cache.js';
import { parseMeta } from '../tools/webmeta.js';
import { createGate, isBlockedIP } from './common.js';
import { fetchDocument } from './page.js';
import { tokenize, langOf, extractText, toMarkdown } from './readable.js';

const MAX_BYTES = 2 * 1024 * 1024;
const HTML_TYPES = ['text/html', 'application/xhtml+xml'];
const gate = createGate(10);

export async function fetchHtml(rawUrl, { blocked = isBlockedIP } = {}) {
  return fetchDocument(rawUrl, { types: HTML_TYPES, maxBytes: MAX_BYTES, blocked });
}

function pageInfo(page) {
  const meta = parseMeta(page.text, page.finalUrl);
  return {
    url: page.finalUrl,
    status: page.status,
    title: meta.title,
    description: meta.description,
    lang: langOf(tokenize(page.text.slice(0, 64 * 1024))),
  };
}

const cut = (s, max) => (s.length > max ? s.slice(0, max) : s);

// blocked 仅供测试替换
export async function loadWebText(rawUrl, { mode = 'main', maxLength = 50_000, blocked = isBlockedIP } = {}) {
  const page = await fetchHtml(rawUrl, { blocked });
  const { text, headings, region } = extractText(page.text, { mode });
  return {
    ...pageInfo(page),
    mode,
    region,
    headings,
    length: text.length,
    truncated: text.length > maxLength || page.truncated,
    text: cut(text, maxLength),
  };
}

export async function loadWebMarkdown(rawUrl, {
  mode = 'main', maxLength = 100_000, links = true, images = true, blocked = isBlockedIP,
} = {}) {
  const page = await fetchHtml(rawUrl, { blocked });
  const info = pageInfo(page);
  let { markdown, region } = toMarkdown(page.text, page.finalUrl, { mode, links, images });
  if (info.title && !/^# /m.test(markdown)) markdown = `# ${info.title.replace(/[\\`*_[\]]/g, '\\$&')}\n\n${markdown}`.trim();
  return {
    ...info,
    mode,
    region,
    length: markdown.length,
    truncated: markdown.length > maxLength || page.truncated,
    markdown: cut(markdown, maxLength),
  };
}

const boolParam = (query, name, def) => {
  const v = param(query, name, { default: def ? 'true' : 'false', oneOf: ['true', 'false', '1', '0'] });
  return v === 'true' || v === '1';
};

const COMMON_PARAMS = [
  { name: 'url', required: true, desc: '网页地址（http / https），只允许公网地址；跟随最多 5 次跳转，每一跳都会检查', example: 'https://example.com' },
  { name: 'mode', required: false, default: 'main', desc: 'main 尽量只保留正文（优先 <article> / <main>，去掉导航、侧边栏、页脚）；all 保留整个 <body>', example: 'all' },
];

const INFO_FIELDS = [
  { name: 'url', type: 'string', desc: '最终网址（跟随跳转后）' },
  { name: 'status', type: 'number', desc: '目标网页的 HTTP 状态码（只接受 2xx）' },
  { name: 'title', type: 'string|null', desc: '网页标题（优先 og:title，其次 <title>）；没有时为 null' },
  { name: 'description', type: 'string|null', desc: '网页描述（meta description / og:description）；没有时为 null' },
  { name: 'lang', type: 'string|null', desc: '<html lang> 声明的语言（如 zh-CN）；未声明时为 null' },
  { name: 'mode', type: 'string', desc: '提取模式：main / all（与参数一致）' },
  { name: 'region', type: 'string', desc: '实际选取的区域：article（<article>）/ main（<main>、role=main 等）/ hint（id、class 像正文的容器）/ body（整个页面）' },
];

export default {
  name: 'web-content',
  category: 'net',
  title: '网页正文提取',
  description: '抓取网页并提取正文纯文本，或转换成 Markdown（保留标题、列表、链接、图片、代码块、引用和表格）；只能读取服务器直接返回的 HTML，不执行 JavaScript',
  source: '目标网页',
  routes: [
    {
      method: 'GET',
      path: '/api/web/text',
      summary: '提取网页标题、小标题和正文文字',
      params: [
        ...COMMON_PARAMS,
        { name: 'max_length', required: false, default: 50000, desc: '返回文字的最大字符数，100~200000，超出部分截断', example: 20000 },
      ],
      fields: [
        ...INFO_FIELDS,
        { name: 'headings', type: 'array', desc: '正文区域内的一至三级标题，按出现顺序，最多 200 个' },
        { name: 'headings[].level', type: 'number', desc: '标题级别：1 / 2 / 3' },
        { name: 'headings[].text', type: 'string', desc: '标题文字（最多 200 字）' },
        { name: 'length', type: 'number', desc: '提取到的文字总字符数（截断前）' },
        { name: 'truncated', type: 'boolean', desc: '文字是否超过 max_length 被截断，或网页超过 2MB 只读取了前面部分' },
        { name: 'text', type: 'string', desc: '正文纯文本：段落之间空一行，表格单元格之间用制表符分隔' },
      ],
      async handler({ query }) {
        const url = param(query, 'url', { required: true, max: 2048 });
        const mode = param(query, 'mode', { default: 'main', oneOf: ['main', 'all'] });
        const maxLength = param(query, 'max_length', { default: 50_000, int: true, min: 100, max: 200_000 });
        return cache.wrap(`web-text:${mode}:${maxLength}:${url}`, 5 * 60_000, () => gate(() => loadWebText(url, { mode, maxLength })));
      },
    },
    {
      method: 'GET',
      path: '/api/web/markdown',
      summary: '把网页正文转换成 Markdown',
      params: [
        ...COMMON_PARAMS,
        { name: 'links', required: false, default: 'true', desc: '是否保留链接地址：true / false（false 时只保留链接文字）', example: 'false' },
        { name: 'images', required: false, default: 'true', desc: '是否保留图片：true / false', example: 'false' },
        { name: 'max_length', required: false, default: 100000, desc: '返回内容的最大字符数，100~300000，超出部分截断', example: 50000 },
      ],
      fields: [
        ...INFO_FIELDS,
        { name: 'length', type: 'number', desc: 'Markdown 总字符数（截断前）' },
        { name: 'truncated', type: 'boolean', desc: '是否超过 max_length 被截断，或网页超过 2MB 只读取了前面部分' },
        { name: 'markdown', type: 'string', desc: 'Markdown 内容；链接和图片已转为绝对地址；正文没有一级标题时在开头补上网页标题' },
      ],
      async handler({ query }) {
        const url = param(query, 'url', { required: true, max: 2048 });
        const mode = param(query, 'mode', { default: 'main', oneOf: ['main', 'all'] });
        const links = boolParam(query, 'links', true);
        const images = boolParam(query, 'images', true);
        const maxLength = param(query, 'max_length', { default: 100_000, int: true, min: 100, max: 300_000 });
        return cache.wrap(`web-md:${mode}:${links}:${images}:${maxLength}:${url}`, 5 * 60_000, () => gate(() => loadWebMarkdown(url, {
          mode, maxLength, links, images,
        })));
      },
    },
  ],
};

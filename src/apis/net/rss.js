// RSS / Atom 订阅源转 JSON。
// 订阅源内容不可信：XML 解析器是手写的线性扫描器（只用 indexOf 顺序向前查找，找不到结尾就停止），
// 不展开 DTD / 外部实体（不存在 XXE 与"十亿笑声"），只解码 XML 预定义实体和数字实体；并限制元素数量与嵌套深度。
import { HttpError, param } from '../../lib/http.js';
import { cache } from '../../lib/cache.js';
import { scanTags, stripNoise } from '../../lib/html.js';
import { createGate, isBlockedIP } from './common.js';
import { fetchDocument } from './page.js';

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_NODES = 100_000;
const MAX_DEPTH = 64;
const SUMMARY_LEN = 300;
const CONTENT_LEN = 20_000;
const gate = createGate(10);

// ---------- 实体解码（单次扫描，不会重复解码 &amp;lt;） ----------

const NAMED = {
  lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', times: '×', laquo: '«', raquo: '»', bull: '•', deg: '°', yen: '¥', euro: '€',
};

export function decodeXmlEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,7});/g, (m, body) => {
    if (body[0] === '#') {
      const n = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : m;
    }
    return NAMED[body] ?? NAMED[body.toLowerCase()] ?? m;
  });
}

// ---------- XML 解析 ----------

const isNameStart = (c) => /[A-Za-z_:À-￿]/.test(c);

// 找到标签结束的 '>'，跳过引号内的内容；找不到返回 -1
function tagEnd(s, from) {
  let i = from;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 62) return i; // >
    if (c === 34 || c === 39) { // " '
      const close = s.indexOf(c === 34 ? '"' : "'", i + 1);
      if (close === -1) return -1;
      i = close + 1;
      continue;
    }
    i++;
  }
  return -1;
}

// XML 属性：name="value" / name='value'；名称保留原样转小写
function xmlAttrs(tag) {
  const attrs = {};
  const n = tag.length;
  let i = 0;
  while (i < n && !/\s/.test(tag[i])) i++;
  while (i < n) {
    while (i < n && /[\s/]/.test(tag[i])) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && !/[\s=/]/.test(tag[i])) i++;
    const name = tag.slice(start, i).toLowerCase();
    while (i < n && /\s/.test(tag[i])) i++;
    if (tag[i] !== '=') {
      if (name && !(name in attrs)) attrs[name] = '';
      continue;
    }
    i++;
    while (i < n && /\s/.test(tag[i])) i++;
    const q = tag[i];
    let value;
    if (q === '"' || q === "'") {
      const close = tag.indexOf(q, i + 1);
      const end = close === -1 ? n : close;
      value = tag.slice(i + 1, end);
      i = end + 1;
    } else {
      const s = i;
      while (i < n && !/\s/.test(tag[i])) i++;
      value = tag.slice(s, i);
    }
    if (name && !(name in attrs)) attrs[name] = decodeXmlEntities(value);
  }
  return attrs;
}

// 解析成元素树：{ name（小写、含前缀）, attrs, children（元素）, text（直接文本，已解码，CDATA 原样） }。
// 不合法的结构尽量容错：多余的结束标签忽略，未闭合的元素在文件结尾自动闭合。
export function parseXml(xml) {
  const s = String(xml).replace(/^﻿/, '');
  const root = { name: '#document', attrs: {}, children: [], parts: [] };
  const stack = [root];
  let nodes = 0;
  let i = 0;
  const n = s.length;
  const top = () => stack[stack.length - 1];
  while (i < n) {
    const lt = s.indexOf('<', i);
    const textEnd = lt === -1 ? n : lt;
    if (textEnd > i && stack.length > 1) top().parts.push(decodeXmlEntities(s.slice(i, textEnd)));
    if (lt === -1) break;
    if (s.startsWith('<![CDATA[', lt)) {
      const end = s.indexOf(']]>', lt + 9);
      const stop = end === -1 ? n : end;
      if (stack.length > 1) top().parts.push(s.slice(lt + 9, stop));
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    if (s.startsWith('<?', lt)) {
      const end = s.indexOf('?>', lt + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    if (s.startsWith('<!', lt)) {
      // DOCTYPE：内部子集 [...] 直接跳过，不解析也不展开其中的实体
      const gt = s.indexOf('>', lt);
      const bracket = s.indexOf('[', lt);
      if (bracket !== -1 && (gt === -1 || bracket < gt)) {
        const close = s.indexOf(']', bracket);
        const end = close === -1 ? -1 : s.indexOf('>', close);
        if (end === -1) break;
        i = end + 1;
      } else {
        if (gt === -1) break;
        i = gt + 1;
      }
      continue;
    }
    if (s[lt + 1] === '/') {
      const gt = s.indexOf('>', lt);
      if (gt === -1) break;
      const name = s.slice(lt + 2, gt).trim().toLowerCase();
      // 找到最近的同名元素并闭合（深度有上限，因此是常数时间）
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      i = gt + 1;
      continue;
    }
    if (!isNameStart(s[lt + 1] ?? '')) {
      if (stack.length > 1) top().parts.push('<');
      i = lt + 1;
      continue;
    }
    const gt = tagEnd(s, lt + 1);
    if (gt === -1) break;
    const raw = s.slice(lt + 1, gt);
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const m = /^[^\s/>]+/.exec(body);
    i = gt + 1;
    if (!m) continue;
    if (++nodes > MAX_NODES) break;
    const el = { name: m[0].toLowerCase(), attrs: xmlAttrs(body), children: [], parts: [] };
    top().children.push(el);
    if (!selfClosing && stack.length < MAX_DEPTH) stack.push(el);
  }
  finalize(root);
  return root;
}

function finalize(root) {
  const todo = [root];
  while (todo.length) {
    const el = todo.pop();
    el.text = el.parts.join('');
    delete el.parts;
    todo.push(...el.children);
  }
}

// ---------- 订阅源解释 ----------

const local = (name) => name.slice(name.indexOf(':') + 1);
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function toIso(v) {
  const s = clean(v);
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function absolute(href, base) {
  const h = clean(href);
  if (!h) return null;
  try {
    const u = new URL(h, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

const INLINE_TAGS = new Set(['a', 'abbr', 'b', 'bdi', 'cite', 'code', 'em', 'font', 'i', 'kbd', 'mark', 'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'u', 'time']);

// HTML 片段 → 纯文本（线性扫描）：只去掉形如 <tag ...> / </tag> 的标签，孤立的 "<"（如 a < b）保留
export function htmlText(html) {
  if (!html.includes('<')) return clean(decodeXmlEntities(html));
  const s = stripNoise(html);
  const parts = [];
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt === -1) {
      parts.push(s.slice(i));
      break;
    }
    parts.push(s.slice(i, lt));
    const c = s[lt + 1] ?? '';
    const gt = /[A-Za-z/]/.test(c) ? s.indexOf('>', lt) : -1;
    if (gt === -1) {
      parts.push('<');
      i = lt + 1;
      continue;
    }
    const name = /^\/?([a-z0-9]+)/i.exec(s.slice(lt + 1, Math.min(gt, lt + 12)))?.[1]?.toLowerCase();
    parts.push(INLINE_TAGS.has(name) ? '' : ' ');
    i = gt + 1;
  }
  return clean(decodeXmlEntities(parts.join('')));
}

function childBy(el, pred) {
  return el.children.find(pred) ?? null;
}

// 按完整名称（含前缀）找子元素
const child = (el, ...names) => {
  for (const n of names) {
    const c = childBy(el, (x) => x.name === n);
    if (c) return c;
  }
  return null;
};
const childText = (el, ...names) => child(el, ...names)?.text ?? '';

// Atom 元素（可能带前缀，如 atom:link）：按本地名匹配
const aChild = (el, name) => childBy(el, (x) => local(x.name) === name);
const aChildren = (el, name) => el.children.filter((x) => local(x.name) === name);

function atomLink(el, base) {
  const links = aChildren(el, 'link');
  const alt = links.find((l) => !l.attrs.rel || l.attrs.rel === 'alternate') ?? links[0];
  return absolute(alt?.attrs.href ?? alt?.text, base);
}

// Atom 的 text 构造：type="xhtml" 时内容是子元素，这里退化成它们的文本
const atomText = (el) => {
  if (!el) return '';
  if (el.attrs.type === 'xhtml') return collectText(el);
  return el.text;
};

function collectText(el) {
  const out = [];
  const todo = [el];
  while (todo.length) {
    const x = todo.pop();
    out.push(x.text);
    for (let k = x.children.length - 1; k >= 0; k--) todo.push(x.children[k]);
  }
  return out.join(' ');
}

function summaryOf(html) {
  const t = htmlText(html);
  return t.length > SUMMARY_LEN ? `${t.slice(0, SUMMARY_LEN)}…` : t;
}

// 解析后的元素树 → { format, feed, items }；不是订阅源返回 null
export function interpretFeed(doc, baseUrl, { limit = 20, includeContent = false } = {}) {
  const top = doc.children.find((c) => ['rss', 'rdf', 'feed'].includes(local(c.name)));
  if (!top) return null;
  const kind = local(top.name);
  if (kind === 'feed') return interpretAtom(top, baseUrl, { limit, includeContent });
  const channel = child(top, 'channel') ?? childBy(top, (x) => local(x.name) === 'channel');
  if (!channel) return null;
  // RSS 2.0 的 item 在 channel 里；RSS 1.0（RDF）的 item 与 channel 同级
  const rawItems = kind === 'rss' ? channel.children.filter((x) => x.name === 'item') : top.children.filter((x) => local(x.name) === 'item');
  const feedLink = absolute(childText(channel, 'link'), baseUrl) ?? atomLink(channel, baseUrl);
  const base = feedLink ?? baseUrl;
  const items = rawItems.slice(0, limit).map((it) => {
    const content = childText(it, 'content:encoded');
    const description = childText(it, 'description');
    const enclosure = child(it, 'enclosure');
    const guid = clean(childText(it, 'guid')) || clean(it.attrs['rdf:about']) || null;
    let link = absolute(childText(it, 'link'), base);
    if (!link && guid && child(it, 'guid')?.attrs.ispermalink !== 'false') link = absolute(guid, base);
    return {
      title: htmlText(childText(it, 'title')),
      link,
      author: clean(childText(it, 'dc:creator', 'author', 'itunes:author')) || null,
      published: toIso(childText(it, 'pubdate', 'dc:date', 'published', 'updated')),
      summary: summaryOf(description || content),
      categories: [...new Set(it.children.filter((x) => x.name === 'category' || x.name === 'dc:subject').map((x) => clean(x.text)).filter(Boolean))],
      guid,
      enclosure: enclosure?.attrs.url ? { url: absolute(enclosure.attrs.url, base), type: enclosure.attrs.type || null, length: Number(enclosure.attrs.length) || null } : null,
      ...(includeContent ? { content: (content || description).slice(0, CONTENT_LEN) } : {}),
    };
  });
  const image = child(channel, 'image') ?? childBy(top, (x) => x.name === 'image');
  return {
    format: kind === 'rss' ? 'rss' : 'rdf',
    version: kind === 'rss' ? top.attrs.version || null : '1.0',
    feed: {
      title: htmlText(childText(channel, 'title')),
      description: htmlText(childText(channel, 'description')),
      link: feedLink,
      language: clean(childText(channel, 'language', 'dc:language')) || null,
      updated: toIso(childText(channel, 'lastbuilddate', 'pubdate', 'dc:date')) ?? items[0]?.published ?? null,
      image: absolute(image ? childText(image, 'url') || image.attrs['rdf:resource'] : childText(channel, 'itunes:image') || child(channel, 'itunes:image')?.attrs.href, base),
    },
    total: rawItems.length,
    items,
  };
}

function interpretAtom(top, baseUrl, { limit, includeContent }) {
  const base = absolute(top.attrs['xml:base'], baseUrl) ?? baseUrl;
  const entries = aChildren(top, 'entry');
  const feedLink = atomLink(top, base);
  const items = entries.slice(0, limit).map((e) => {
    const content = atomText(aChild(e, 'content'));
    const summary = atomText(aChild(e, 'summary'));
    const author = aChild(e, 'author') ?? aChild(top, 'author');
    const enc = aChildren(e, 'link').find((l) => l.attrs.rel === 'enclosure');
    return {
      title: htmlText(atomText(aChild(e, 'title'))),
      link: atomLink(e, base),
      author: author ? clean(aChild(author, 'name')?.text ?? author.text) || null : null,
      published: toIso(aChild(e, 'published')?.text ?? aChild(e, 'updated')?.text),
      summary: summaryOf(summary || content),
      categories: [...new Set(aChildren(e, 'category').map((c) => clean(c.attrs.label || c.attrs.term)).filter(Boolean))],
      guid: clean(aChild(e, 'id')?.text) || null,
      enclosure: enc?.attrs.href ? { url: absolute(enc.attrs.href, base), type: enc.attrs.type || null, length: Number(enc.attrs.length) || null } : null,
      ...(includeContent ? { content: (content || summary).slice(0, CONTENT_LEN) } : {}),
    };
  });
  return {
    format: 'atom',
    version: '1.0',
    feed: {
      title: htmlText(atomText(aChild(top, 'title'))),
      description: htmlText(atomText(aChild(top, 'subtitle'))),
      link: feedLink,
      language: clean(top.attrs['xml:lang']) || null,
      updated: toIso(aChild(top, 'updated')?.text) ?? items[0]?.published ?? null,
      image: absolute(aChild(top, 'logo')?.text || aChild(top, 'icon')?.text, base),
    },
    total: entries.length,
    items,
  };
}

// 网页里声明的订阅源：<link rel="alternate" type="application/rss+xml" href="...">
export function discoverFeed(html, baseUrl) {
  for (const { attrs } of scanTags(stripNoise(html.slice(0, 512 * 1024)), ['link'])) {
    if (!/(^|\s)alternate(\s|$)/i.test(attrs.rel ?? '')) continue;
    if (!/application\/(rss|atom)\+xml|application\/rdf\+xml/i.test(attrs.type ?? '')) continue;
    const u = absolute(attrs.href, baseUrl);
    if (u) return u;
  }
  return null;
}

const looksHtml = (type, text) => /html/.test(type) || /^\s*(<!doctype html|<html)/i.test(text.slice(0, 1024));

const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.5, */*;q=0.1';

// blocked 仅供测试替换
export async function loadFeed(rawUrl, { limit = 20, includeContent = false, blocked = isBlockedIP } = {}) {
  let page = await fetchDocument(rawUrl, { accept: FEED_ACCEPT, maxBytes: MAX_BYTES, blocked });
  const requested = page.url;
  let discovered = false;
  if (looksHtml(page.contentType, page.text)) {
    const feedUrl = discoverFeed(page.text, page.finalUrl);
    if (!feedUrl) throw new HttpError(422, '这是普通网页，且页面中没有声明 RSS / Atom 订阅源');
    page = await fetchDocument(feedUrl, { accept: FEED_ACCEPT, maxBytes: MAX_BYTES, blocked });
    discovered = true;
  }
  const parsed = interpretFeed(parseXml(page.text), page.finalUrl, { limit, includeContent });
  if (!parsed) throw new HttpError(422, '不是有效的 RSS / Atom 订阅源');
  return {
    url: requested,
    feedUrl: page.finalUrl,
    discovered,
    format: parsed.format,
    version: parsed.version,
    feed: parsed.feed,
    total: parsed.total,
    truncated: page.truncated,
    items: parsed.items,
  };
}

const ITEM_FIELDS = [
  { name: 'items[].title', type: 'string', desc: '标题（纯文本）' },
  { name: 'items[].link', type: 'string|null', desc: '文章链接（绝对地址）；没有时为 null' },
  { name: 'items[].author', type: 'string|null', desc: '作者（dc:creator / author / Atom 的 author.name）；没有时为 null' },
  { name: 'items[].published', type: 'string|null', desc: '发布时间（ISO 8601，UTC）；取 pubDate / dc:date / published / updated，无法解析时为 null' },
  { name: 'items[].summary', type: 'string', desc: '纯文本摘要（去掉 HTML 标签，最多 300 字，超出以 … 结尾）' },
  { name: 'items[].categories', type: 'array', desc: '分类 / 标签（去重）' },
  { name: 'items[].guid', type: 'string|null', desc: '唯一标识（RSS guid / Atom id）；没有时为 null' },
  { name: 'items[].enclosure', type: 'object|null', desc: '附件（播客音频等）；没有时为 null' },
  { name: 'items[].enclosure.url', type: 'string|null', desc: '附件地址（绝对地址）' },
  { name: 'items[].enclosure.type', type: 'string|null', desc: '附件 MIME 类型，如 audio/mpeg；未声明时为 null' },
  { name: 'items[].enclosure.length', type: 'number|null', desc: '附件大小（字节）；未声明或为 0 时为 null' },
  { name: 'items[].content', type: 'string', desc: '正文 HTML 原文（content:encoded / Atom content，没有时用 description / summary；最多 20000 字符）。仅 content=true 时返回' },
];

export default {
  name: 'rss',
  category: 'net',
  title: 'RSS 转 JSON',
  description: '把 RSS 2.0 / RSS 1.0 / Atom 订阅源解析成统一的 JSON；传入普通网页时自动查找页面声明的订阅源',
  source: '目标订阅源',
  routes: [
    {
      method: 'GET',
      path: '/api/rss',
      summary: '解析 RSS / Atom 订阅源',
      params: [
        { name: 'url', required: true, desc: '订阅源地址，或声明了订阅源的网页地址（http / https，只允许公网地址）', example: 'https://github.blog/feed/' },
        { name: 'limit', required: false, default: 20, desc: '最多返回的条目数，1~100', example: 10 },
        { name: 'content', required: false, default: 'false', desc: '是否返回正文 HTML：true / false', example: 'true' },
      ],
      fields: [
        { name: 'url', type: 'string', desc: '请求的地址（规范化后）' },
        { name: 'feedUrl', type: 'string', desc: '实际解析的订阅源地址（跟随跳转后；自动发现时为页面声明的地址）' },
        { name: 'discovered', type: 'boolean', desc: '是否由网页 <link rel="alternate"> 自动发现的订阅源' },
        { name: 'format', type: 'string', desc: '订阅源格式：rss（RSS 2.0 / 0.9x）/ rdf（RSS 1.0）/ atom' },
        { name: 'version', type: 'string|null', desc: '版本号（RSS 取 version 属性，如 2.0；RDF、Atom 为 1.0）；未声明时为 null' },
        { name: 'feed', type: 'object', desc: '订阅源信息' },
        { name: 'feed.title', type: 'string', desc: '订阅源标题' },
        { name: 'feed.description', type: 'string', desc: '订阅源描述（RSS description / Atom subtitle，纯文本）；没有时为空字符串' },
        { name: 'feed.link', type: 'string|null', desc: '网站地址；没有时为 null' },
        { name: 'feed.language', type: 'string|null', desc: '语言（如 zh-CN）；未声明时为 null' },
        { name: 'feed.updated', type: 'string|null', desc: '最后更新时间（ISO 8601）；未声明时取第一条的发布时间，仍没有则为 null' },
        { name: 'feed.image', type: 'string|null', desc: '订阅源图标 / Logo 地址；没有时为 null' },
        { name: 'total', type: 'number', desc: '订阅源中的条目总数（limit 截取前）' },
        { name: 'truncated', type: 'boolean', desc: '订阅源是否超过 3MB 被截断（截断时只解析到已读取的部分）' },
        { name: 'items', type: 'array', desc: '条目列表，按订阅源中的顺序，最多 limit 条' },
        ...ITEM_FIELDS,
      ],
      async handler({ query }) {
        const url = param(query, 'url', { required: true, max: 2048 });
        const limit = param(query, 'limit', { default: 20, int: true, min: 1, max: 100 });
        const includeContent = param(query, 'content', { default: 'false', oneOf: ['true', 'false', '1', '0'] });
        const inc = includeContent === 'true' || includeContent === '1';
        return cache.wrap(`rss:${url}:${limit}:${inc}`, 5 * 60_000, () => gate(() => loadFeed(url, { limit, includeContent: inc })));
      },
    },
  ],
};

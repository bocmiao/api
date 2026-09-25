// 网页正文提取与 HTML → Markdown 转换（零依赖、线性时间）。
// 网页内容不可信：先用 html.js 的 stripNoise 去掉注释和脚本，再用 indexOf 顺序切分标签；
// 元素配对用"每种标签一个栈"，嵌套深度有上限；所有查找都只向前推进，恶意构造的页面不会退化成 O(n²)。
import { stripNoise, parseAttrs, asciiLower, safeDecode } from '../../lib/html.js';

const MAX_TAG = 8192;
const MAX_FRAMES = 64;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'center', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'html', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
  'summary', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'ul', 'caption', 'menu',
]);
// 任何模式下都不输出内容的元素（非正文控件、嵌入对象）
const ALWAYS_SKIP = new Set(['svg', 'math', 'iframe', 'canvas', 'object', 'embed', 'video', 'audio', 'select', 'button', 'input', 'head', 'title', 'dialog', 'map']);
// main 模式额外跳过的页面框架
const CHROME = new Set(['nav', 'aside', 'footer', 'menu']);

// ---------- 切分 ----------

// 返回 tokens：{ type: 'text', text } / { type: 'open', name, attrs } / { type: 'close', name }
export function tokenize(rawHtml) {
  const html = stripNoise(String(rawHtml));
  const lower = asciiLower(html);
  const tokens = [];
  const n = html.length;
  let i = 0;
  const pushText = (s) => { if (s) tokens.push({ type: 'text', text: s }); };
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      pushText(html.slice(i));
      break;
    }
    pushText(html.slice(i, lt));
    const c = lower.charCodeAt(lt + 1);
    const isLetter = c >= 97 && c <= 122;
    if (c === 47 /* / */ || isLetter || c === 33 /* ! */ || c === 63 /* ? */) {
      const gt = lower.indexOf('>', lt + 1);
      if (gt === -1) break; // 之后再也没有 '>'：按浏览器行为丢弃剩余内容
      i = gt + 1;
      if (c === 33 || c === 63 || gt - lt > MAX_TAG) continue; // <!DOCTYPE>、<?xml?>、超长标签
      if (c === 47) {
        const m = /^[a-z][a-z0-9-]*/.exec(lower.slice(lt + 2, Math.min(gt, lt + 40)));
        if (m) tokens.push({ type: 'close', name: m[0] });
        continue;
      }
      const m = /^[a-z][a-z0-9-]*/.exec(lower.slice(lt + 1, Math.min(gt, lt + 40)));
      const name = m[0];
      tokens.push({ type: 'open', name, attrs: parseAttrs(html.slice(lt, gt + 1)), selfClosing: VOID.has(name) });
      continue;
    }
    pushText('<');
    i = lt + 1;
  }
  return tokens;
}

// 为每个开始标签找到对应的结束标签下标（每种标签一个栈，线性时间）；没有结束标签的为 -1
export function pairUp(tokens) {
  const pair = new Int32Array(tokens.length).fill(-1);
  const stacks = new Map();
  tokens.forEach((t, i) => {
    if (t.type === 'open' && !t.selfClosing) {
      if (!stacks.has(t.name)) stacks.set(t.name, []);
      stacks.get(t.name).push(i);
    } else if (t.type === 'close') {
      const s = stacks.get(t.name);
      if (s?.length) pair[s.pop()] = i;
    }
  });
  return pair;
}

// ---------- 正文区域 ----------

const MAIN_HINT = /(^|[\s_-])(article|post|entry|content|main|story)[\s_-]*(body|content|text)?($|[\s_-])/i;

// 选出正文区域 [start, end)。main 模式：优先内容最多的 <article>（不少于 <main> 的一半），其次 <main> / role=main /
// itemprop=articleBody，最后是 <body>；all 模式：<body>（没有时为整个文档）
export function selectRegion(tokens, pair, mode = 'main') {
  const prefix = new Float64Array(tokens.length + 1);
  tokens.forEach((t, i) => { prefix[i + 1] = prefix[i] + (t.type === 'text' ? t.text.trim().length : 0); });
  const lenOf = (o) => prefix[pair[o]] - prefix[o];
  let body = null;
  let bestArticle = null;
  let bestMain = null;
  let bestHint = null;
  tokens.forEach((t, i) => {
    if (t.type !== 'open' || pair[i] === -1) return;
    const cand = { start: i, end: pair[i] + 1, len: lenOf(i) };
    if (t.name === 'body' && !body) body = cand;
    if (t.name === 'article') { if (!bestArticle || cand.len > bestArticle.len) bestArticle = cand; return; }
    const a = t.attrs;
    if (t.name === 'main' || a.role === 'main' || /articlebody/i.test(a.itemprop ?? '')) {
      if (!bestMain || cand.len > bestMain.len) bestMain = cand;
      return;
    }
    if ((t.name === 'div' || t.name === 'section') && (MAIN_HINT.test(a.id ?? '') || MAIN_HINT.test(a.class ?? ''))) {
      if (!bestHint || cand.len > bestHint.len) bestHint = cand;
    }
  });
  const whole = { start: 0, end: tokens.length, len: prefix[tokens.length] };
  const root = body ?? whole;
  if (mode !== 'main') return { ...root, kind: 'body' };
  const enough = (c) => c && c.len >= 140;
  if (enough(bestArticle) && (!bestMain || bestArticle.len >= bestMain.len * 0.5)) return { ...bestArticle, kind: 'article' };
  if (enough(bestMain)) return { ...bestMain, kind: 'main' };
  if (enough(bestHint) && bestHint.len >= root.len * 0.3) return { ...bestHint, kind: 'hint' };
  return { ...root, kind: 'body' };
}

// 按区域和模式遍历 token，跳过需要忽略的元素（整段跳到它的结束标签之后）
function* walk(tokens, pair, region, mode) {
  for (let i = region.start; i < region.end; i++) {
    const t = tokens[i];
    if (t.type === 'open') {
      const skip = ALWAYS_SKIP.has(t.name) || 'hidden' in t.attrs || t.attrs['aria-hidden'] === 'true'
        || (mode === 'main' && (CHROME.has(t.name) || (t.name === 'header' && region.kind === 'body')));
      if (skip) {
        if (pair[i] !== -1 && pair[i] < region.end) i = pair[i];
        continue;
      }
    }
    yield t;
  }
}

const collapse = (s) => s.replace(/[\s ]+/g, ' ');

// ---------- 纯文本 ----------

// 返回 { text, headings }：段落之间空一行；<br> 换行；表格单元格之间用制表符
export function renderText(tokens, pair, region, mode) {
  const out = [];
  const headings = [];
  let heading = null;
  let pre = 0;
  for (const t of walk(tokens, pair, region, mode)) {
    if (t.type === 'text') {
      const s = safeDecode(t.text);
      const v = pre ? s : collapse(s);
      out.push(v);
      if (heading) heading.parts.push(v);
      continue;
    }
    const { name } = t;
    if (t.type === 'open') {
      if (name === 'br') out.push('\n');
      else if (name === 'td' || name === 'th') out.push('\t');
      else if (BLOCK.has(name)) out.push('\n\n');
      if (name === 'pre') pre++;
      if (/^h[1-3]$/.test(name)) heading = { level: Number(name[1]), parts: [] };
    } else {
      if (BLOCK.has(name)) out.push('\n\n');
      if (name === 'pre' && pre) pre--;
      if (heading && name === `h${heading.level}`) {
        const text = collapse(heading.parts.join('')).trim();
        if (text && headings.length < 200) headings.push({ level: heading.level, text: text.slice(0, 200) });
        heading = null;
      }
    }
  }
  const lines = out.join('').split('\n').map((l) => l.replace(/[ \t]+/g, (m) => (m.includes('\t') ? '\t' : ' ')).trim());
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, headings };
}

// ---------- Markdown ----------

const escapeMd = (s) => s.replace(/[\\`*_[\]]/g, '\\$&');

function absUrl(href, base, { allowMailto = false } = {}) {
  const h = String(href ?? '').trim();
  if (!h) return null;
  try {
    const u = new URL(h, base);
    if (u.protocol === 'http:' || u.protocol === 'https:' || (allowMailto && u.protocol === 'mailto:')) return u.href.replace(/[()\s]/g, (c) => encodeURIComponent(c));
    return null;
  } catch {
    return null;
  }
}

const INLINE_MARK = { strong: '**', b: '**', em: '*', i: '*', del: '~~', s: '~~', strike: '~~' };

// 渲染成 Markdown：标题、段落、列表（含嵌套与有序编号）、链接、图片、粗体/斜体/删除线、行内代码、代码块、引用、表格、分隔线。
// options.links=false 时链接只保留文字；options.images=false 时不输出图片
export function renderMarkdown(tokens, pair, region, mode, baseUrl, { links = true, images = true } = {}) {
  let base = baseUrl;
  for (const t of tokens) {
    if (t.type === 'open' && t.name === 'base' && t.attrs.href) {
      base = absUrl(t.attrs.href, baseUrl) ?? baseUrl;
      break;
    }
  }
  // 帧：需要先收集内容再整体输出的元素（链接、强调、代码、引用、代码块、表格单元格、标题）
  const frames = [{ kind: 'root', parts: [] }];
  const cur = () => frames[frames.length - 1];
  const emit = (s) => cur().parts.push(s);
  const lists = [];
  const tables = [];
  let pre = 0;
  let code = 0;
  const inCell = () => frames.some((f) => f.kind === 'cell');

  const open = (kind, extra = {}) => {
    if (frames.length >= MAX_FRAMES) return false;
    frames.push({ kind, parts: [], ...extra });
    return true;
  };
  // 关闭最近的某类帧；中间未闭合的帧按原样并入上一级。找不到时返回 null
  const close = (kind) => {
    let k = frames.length - 1;
    while (k > 0 && frames[k].kind !== kind) k--;
    if (k === 0) return null;
    while (frames.length - 1 > k) {
      const f = frames.pop();
      finish(f);
    }
    return frames.pop();
  };
  const finish = (f) => {
    const content = f.parts.join('');
    switch (f.kind) {
      case 'mark': {
        const inner = content.trim();
        if (inner) emit(`${content.startsWith(' ') ? ' ' : ''}${f.mark}${inner}${f.mark}${content.endsWith(' ') ? ' ' : ''}`);
        break;
      }
      case 'code': {
        const inner = collapse(content).trim();
        if (inner) {
          const tick = inner.includes('`') ? '``' : '`';
          emit(`${tick}${tick.length > 1 ? ' ' : ''}${inner}${tick.length > 1 ? ' ' : ''}${tick}`);
        }
        break;
      }
      case 'link': {
        const inner = collapse(content).trim();
        if (!inner) break;
        emit(f.href && links ? `[${inner}](${f.href})` : inner);
        break;
      }
      case 'heading': {
        const inner = collapse(content.replace(/\n/g, ' ')).trim();
        if (inner) emit(`\n\n${'#'.repeat(f.level)} ${inner}\n\n`);
        break;
      }
      case 'quote': {
        const inner = tidy(content);
        if (inner) emit(`\n\n${inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')}\n\n`);
        break;
      }
      case 'pre': {
        const inner = content.replace(/^\n/, '').replace(/\s+$/, '');
        let longest = 0;
        let run = 0;
        for (const ch of inner) {
          run = ch === '`' ? run + 1 : 0;
          if (run > longest) longest = run;
        }
        const fence = '`'.repeat(Math.max(3, longest + 1));
        emit(`\n\n${fence}${f.lang ?? ''}\n${inner}\n${fence}\n\n`);
        break;
      }
      case 'cell': {
        const table = tables[tables.length - 1];
        const text = collapse(content).trim().replace(/\|/g, '\\|');
        if (table) {
          if (!table.row) table.row = [];
          table.row.push(text);
          if (f.header) table.headerRow ??= table.rows.length;
        } else emit(text);
        break;
      }
      default:
        emit(content);
    }
  };
  const endRow = () => {
    const table = tables[tables.length - 1];
    if (table?.row) {
      table.rows.push(table.row);
      table.row = null;
    }
  };
  const renderTable = (table) => {
    const rows = table.rows.filter((r) => r.length);
    if (!rows.length) return '';
    const cols = Math.min(50, Math.max(...rows.map((r) => r.length)));
    const pad = (r) => Array.from({ length: cols }, (_, k) => r[k] ?? '');
    const line = (r) => `| ${pad(r).join(' | ')} |`;
    const [head, ...rest] = rows;
    return `\n\n${[line(head), `| ${Array(cols).fill('---').join(' | ')} |`, ...rest.map(line)].join('\n')}\n\n`;
  };

  for (const t of walk(tokens, pair, region, mode)) {
    if (t.type === 'text') {
      const s = safeDecode(t.text);
      emit(pre ? s : code ? collapse(s) : escapeMd(collapse(s)));
      continue;
    }
    const { name, attrs } = t;
    if (t.type === 'open') {
      if (pre) {
        if (name === 'br') emit('\n');
        else if (name === 'code' && !cur().lang) {
          const lang = /(?:lang|language)-([\w+#.-]{1,30})/.exec(attrs.class ?? '')?.[1];
          if (lang && cur().kind === 'pre') cur().lang = lang;
        }
        continue;
      }
      if (/^h[1-6]$/.test(name)) { if (!open('heading', { level: Number(name[1]) })) emit(' '); continue; }
      if (INLINE_MARK[name]) { open('mark', { mark: INLINE_MARK[name] }); continue; }
      switch (name) {
        case 'br': emit(inCell() || frames.some((f) => f.kind === 'heading') ? ' ' : '\\\n'); break;
        case 'hr': emit('\n\n---\n\n'); break;
        case 'a': open('link', { href: absUrl(attrs.href, base, { allowMailto: true }) }); break;
        case 'code': if (open('code')) code++; break;
        case 'pre': if (open('pre', { lang: /(?:lang|language)-([\w+#.-]{1,30})/.exec(attrs.class ?? '')?.[1] })) pre++; break;
        case 'blockquote': open('quote'); break;
        case 'img': {
          if (!images) break;
          const src = absUrl(attrs.src || attrs['data-src'] || attrs['data-original'], base);
          if (src) emit(`![${escapeMd(collapse(attrs.alt ?? '').trim())}](${src})`);
          break;
        }
        case 'ul':
        case 'ol':
          if (lists.length < 16) lists.push({ ordered: name === 'ol', n: Math.max(0, Number.parseInt(attrs.start, 10) || 1) });
          if (lists.length === 1) emit('\n\n');
          break;
        case 'li': {
          const l = lists[lists.length - 1];
          const indent = '   '.repeat(Math.max(0, lists.length - 1));
          emit(`\n${indent}${l?.ordered ? `${l.n++}. ` : '- '}`);
          break;
        }
        case 'table':
          if (tables.length < 8) tables.push({ rows: [], row: null });
          break;
        case 'tr':
          if (frames[frames.length - 1].kind === 'cell') finish(frames.pop());
          endRow();
          break;
        case 'td':
        case 'th':
          if (cur().kind === 'cell') finish(frames.pop());
          open('cell', { header: name === 'th' });
          break;
        default:
          if (BLOCK.has(name)) emit(lists.length ? ' ' : '\n\n');
      }
      continue;
    }
    // 结束标签
    if (pre && name !== 'pre') continue;
    if (/^h[1-6]$/.test(name)) { const f = close('heading'); if (f) finish(f); continue; }
    if (INLINE_MARK[name]) { const f = close('mark'); if (f) finish(f); continue; }
    switch (name) {
      case 'a': { const f = close('link'); if (f) finish(f); break; }
      case 'code': { const f = close('code'); if (f) { code = Math.max(0, code - 1); finish(f); } break; }
      case 'pre': { const f = close('pre'); if (f) { pre = Math.max(0, pre - 1); finish(f); } break; }
      case 'blockquote': { const f = close('quote'); if (f) finish(f); break; }
      case 'ul':
      case 'ol':
        lists.pop();
        if (!lists.length) emit('\n\n');
        break;
      case 'td':
      case 'th': { const f = close('cell'); if (f) finish(f); break; }
      case 'tr': endRow(); break;
      case 'table': {
        if (cur().kind === 'cell') finish(frames.pop());
        endRow();
        const table = tables.pop();
        if (table) emit(renderTable(table));
        break;
      }
      default:
        if (BLOCK.has(name) && name !== 'li') emit(lists.length ? ' ' : '\n\n');
    }
  }
  while (frames.length > 1) finish(frames.pop());
  while (tables.length) emit(renderTable(tables.pop()));
  return tidy(frames[0].parts.join(''));
}

// 整理空白：代码块内保持原样；其他行去掉行尾空白、合并连续空格、非列表行去掉行首空白；最多保留一个空行
function tidy(md) {
  const out = [];
  let fence = null;
  let blank = 0;
  for (const raw of md.split('\n')) {
    if (fence) {
      out.push(raw);
      if (raw.trim() === fence) fence = null;
      continue;
    }
    const m = /^\s*(`{3,})/.exec(raw);
    if (m) {
      fence = m[1];
      blank = 0;
      out.push(raw.trim());
      continue;
    }
    let line = raw.replace(/[ \t]+$/, '');
    const listItem = /^( *)([-*]|\d+\.) /.exec(line);
    line = listItem ? listItem[1] + line.slice(listItem[1].length).replace(/ {2,}/g, ' ') : line.trim().replace(/ {2,}/g, ' ');
    if (/^([-*]|\d+\.)$/.test(line.trim())) continue; // 空列表项
    if (!line) {
      if (++blank > 1 || !out.length) continue;
    } else blank = 0;
    out.push(line);
  }
  return out.join('\n').trim();
}

// ---------- 入口 ----------

export function extractText(html, { mode = 'main' } = {}) {
  const tokens = tokenize(html);
  const pair = pairUp(tokens);
  const region = selectRegion(tokens, pair, mode);
  return { ...renderText(tokens, pair, region, mode), region: region.kind };
}

export function toMarkdown(html, baseUrl, { mode = 'main', links = true, images = true } = {}) {
  const tokens = tokenize(html);
  const pair = pairUp(tokens);
  const region = selectRegion(tokens, pair, mode);
  return { markdown: renderMarkdown(tokens, pair, region, mode, baseUrl, { links, images }), region: region.kind };
}

// <html lang="...">
export function langOf(tokens) {
  const t = tokens.find((x) => x.type === 'open' && x.name === 'html');
  return t?.attrs.lang?.trim() || null;
}

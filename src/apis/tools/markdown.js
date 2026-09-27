import { HttpError, param, decodeEntities } from '../../lib/http.js';
import { bodyParams, truthy } from './inputs.js';

// Markdown 转 HTML：实现 CommonMark 常用子集 + GFM 表格 / 删除线 / 任务列表 / 网址自动链接。
// 安全：
// 1. sanitize=true（默认）时所有原始 HTML 都被转义；
// 2. 无论是否 sanitize，链接和图片地址只允许 http / https / mailto 和相对地址（javascript:、data:、vbscript: 等一律丢弃）；
// 3. 链接统一加 rel="noopener noreferrer"；
// 4. 不用可能灾难性回溯的正则：行内解析是线性扫描 + 分隔符栈（CommonMark 的 process emphasis 算法，带 openers_bottom 优化），
//    容器嵌套深度有上限，输入最多 500 KB。

export const MAX_INPUT = 500 * 1024;
const MAX_NEST = 32;
const MAX_PAREN = 32;

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ESC_MAP[c]);

// ---------------- 链接地址过滤 ----------------

// 只允许 http / https / mailto 和相对地址。先去掉浏览器会忽略的空白和控制字符再判断协议，防 java\tscript: 之类绕过
export function safeUrl(raw) {
  const url = raw.trim();
  const probe = url.replace(/[\x00-\x20\x7f]/g, '');
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(probe);
  if (scheme) {
    if (!/^(?:https?|mailto)$/i.test(scheme[1])) return null;
  } else if (/^[^/?#]*:/.test(probe)) {
    return null;
  }
  // 地址里的空白、引号、尖括号等转成百分号编码；& 在输出属性时转义
  return url.replace(/[\x00-\x20\x7f"'<>`\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

// ---------------- 行内解析 ----------------

const PUNCT_RE = /[\p{P}\p{S}]/u;
const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const isWs = (c) => c === undefined || /\s/.test(c);
const isPunct = (c) => c !== undefined && PUNCT_RE.test(c);

const AUTOLINK_RE = /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/y;
const EMAIL_RE = /<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/y;
const BARE_URL_RE = /(?:https?:\/\/|www\.)[^\s<]*/y;
const ENTITY_RE = /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/y;
const HTML_TAG_RE = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/y;

class Inline {
  constructor(src, opts) {
    this.src = src;
    this.opts = opts;
    this.pos = 0;
    this.nodes = [];
    this.delims = null; // 分隔符栈顶（双向链表）
    this.brackets = []; // [ 与 ![ 的栈
    this.inactiveBelow = 0; // 栈中下标小于它的普通 [ 都已失效（链接里不能再套链接）
    this.buf = '';
    // 预先扫描所有反引号串的位置，按长度分组，查找配对时指针只前进不回退（线性时间）
    this.ticks = new Map();
    const re = /`+/g;
    let m;
    while ((m = re.exec(src))) {
      const list = this.ticks.get(m[0].length) ?? [];
      list.push(m.index);
      this.ticks.set(m[0].length, list);
    }
    this.tickPtr = new Map();
  }

  flush() {
    if (this.buf) {
      this.nodes.push({ html: escapeHtml(this.buf), open: [], close: [] });
      this.buf = '';
    }
  }

  push(html) {
    this.flush();
    const node = { html, open: [], close: [] };
    this.nodes.push(node);
    return node;
  }

  parse() {
    const s = this.src;
    while (this.pos < s.length) {
      const c = s[this.pos];
      switch (c) {
        case '\\': this.backslash(); break;
        case '`': this.codeSpan(); break;
        case '*': case '_': case '~': this.delimRun(c); break;
        case '[': this.openBracket(false); break;
        case '!':
          if (s[this.pos + 1] === '[') this.openBracket(true);
          else { this.buf += c; this.pos++; }
          break;
        case ']': this.closeBracket(); break;
        case '<': this.angle(); break;
        case '&': this.entity(); break;
        case '\n': this.newline(); break;
        case 'h': case 'w': this.bareUrl(); break;
        default: {
          // 普通字符批量读入，直到下一个特殊字符
          let j = this.pos + 1;
          while (j < s.length && !'\\`*_~[!]<&\nhw'.includes(s[j])) j++;
          this.buf += s.slice(this.pos, j);
          this.pos = j;
        }
      }
    }
    this.flush();
    this.processEmphasis(null);
    return this.render();
  }

  backslash() {
    const n = this.src[this.pos + 1];
    if (n === '\n') {
      this.push('<br />\n');
      this.pos += 2;
      this.skipLeadingSpaces();
    } else if (n !== undefined && ASCII_PUNCT.includes(n)) {
      this.buf += n;
      this.pos += 2;
    } else {
      this.buf += '\\';
      this.pos++;
    }
  }

  skipLeadingSpaces() {
    while (this.src[this.pos] === ' ' || this.src[this.pos] === '\t') this.pos++;
  }

  newline() {
    // 行尾两个以上空格为硬换行，否则为软换行
    let n = 0;
    let k = this.buf.length;
    while (k > 0 && this.buf[k - 1] === ' ') { k--; n++; }
    if (n) this.buf = this.buf.slice(0, k);
    if (n >= 2) this.push('<br />\n');
    else {
      // 每行结束就把缓冲写成节点，缓冲区只保存当前行，避免长段落反复复制
      this.buf += '\n';
      this.flush();
    }
    this.pos++;
    this.skipLeadingSpaces();
  }

  codeSpan() {
    const s = this.src;
    let j = this.pos;
    while (s[j] === '`') j++;
    const len = j - this.pos;
    const list = this.ticks.get(len) ?? [];
    let p = this.tickPtr.get(len) ?? 0;
    while (p < list.length && list[p] < j) p++;
    this.tickPtr.set(len, p);
    if (p >= list.length) {
      // 没有配对的反引号串：原样输出
      this.buf += s.slice(this.pos, j);
      this.pos = j;
      return;
    }
    const end = list[p];
    let code = s.slice(j, end).replace(/\n/g, ' ');
    if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim() !== '') code = code.slice(1, -1);
    this.push(`<code>${escapeHtml(code)}</code>`);
    this.pos = end + len;
  }

  delimRun(c) {
    const s = this.src;
    let j = this.pos;
    while (s[j] === c) j++;
    const count = j - this.pos;
    const before = this.pos === 0 ? undefined : s[this.pos - 1];
    const after = s[j];
    const leftFlanking = !isWs(after) && (!isPunct(after) || isWs(before) || isPunct(before));
    const rightFlanking = !isWs(before) && (!isPunct(before) || isWs(after) || isPunct(after));
    let canOpen = leftFlanking;
    let canClose = rightFlanking;
    if (c === '_') {
      canOpen = leftFlanking && (!rightFlanking || isPunct(before));
      canClose = rightFlanking && (!leftFlanking || isPunct(after));
    }
    if (c === '~' && count > 2) { canOpen = false; canClose = false; }
    const node = this.push(escapeHtml(s.slice(this.pos, j)));
    node.text = s.slice(this.pos, j);
    this.pos = j;
    if (canOpen || canClose) {
      const d = { char: c, count, orig: count, canOpen, canClose, node, prev: this.delims, next: null };
      if (this.delims) this.delims.next = d;
      this.delims = d;
    }
  }

  removeDelim(d) {
    if (d.prev) d.prev.next = d.next;
    if (d.next) d.next.prev = d.prev;
    else this.delims = d.prev;
  }

  // CommonMark 的 process emphasis：处理 bottom 之上的所有分隔符
  processEmphasis(bottom) {
    const openersBottom = new Map();
    if (!this.delims || this.delims === bottom) return;
    // 找到 bottom 之上的第一个分隔符
    let closer = this.delims;
    while (closer.prev && closer.prev !== bottom) closer = closer.prev;
    while (closer) {
      if (!closer.canClose) { closer = closer.next; continue; }
      const key = closer.char === '~' ? `~${closer.count}` : `${closer.char}${closer.canOpen ? 1 : 0}${closer.orig % 3}`;
      const limit = openersBottom.get(key) ?? bottom;
      let opener = closer.prev;
      let found = false;
      while (opener && opener !== bottom && opener !== limit) {
        if (opener.char === closer.char && opener.canOpen) {
          if (closer.char === '~') {
            if (opener.count === closer.count) { found = true; break; }
          } else {
            const odd = (closer.canOpen || opener.canClose) && closer.orig % 3 !== 0 && (opener.orig + closer.orig) % 3 === 0;
            if (!odd) { found = true; break; }
          }
        }
        opener = opener.prev;
      }
      if (!found) {
        openersBottom.set(key, closer.prev);
        const next = closer.next;
        if (!closer.canOpen) this.removeDelim(closer);
        closer = next;
        continue;
      }
      let use;
      let tag;
      if (closer.char === '~') { use = closer.count; tag = 'del'; }
      else { use = closer.count >= 2 && opener.count >= 2 ? 2 : 1; tag = use === 2 ? 'strong' : 'em'; }
      opener.count -= use;
      closer.count -= use;
      opener.node.text = opener.node.text.slice(0, opener.count);
      opener.node.html = escapeHtml(opener.node.text);
      closer.node.text = closer.node.text.slice(use);
      closer.node.html = escapeHtml(closer.node.text);
      opener.node.open.unshift(`<${tag}>`);
      closer.node.close.push(`</${tag}>`);
      // 移除 opener 与 closer 之间的分隔符
      let d = closer.prev;
      while (d && d !== opener) { const p = d.prev; this.removeDelim(d); d = p; }
      if (opener.count === 0) this.removeDelim(opener);
      if (closer.count === 0) {
        const next = closer.next;
        this.removeDelim(closer);
        closer = next;
      }
    }
    // 清掉 bottom 之上剩余的分隔符
    while (this.delims && this.delims !== bottom) this.removeDelim(this.delims);
  }

  openBracket(image) {
    const node = this.push(image ? '![' : '[');
    node.text = image ? '![' : '[';
    // links：栈中到它为止（含）普通 [ 的个数，用于 O(1) 判断当前是否处在链接文字里
    const below = this.brackets[this.brackets.length - 1]?.links ?? 0;
    this.brackets.push({ node, image, delims: this.delims, index: this.nodes.length - 1, links: below + (image ? 0 : 1) });
    this.pos += image ? 2 : 1;
  }

  closeBracket() {
    this.pos++;
    const opener = this.brackets.pop();
    if (!opener) { this.buf += ']'; return; }
    const stackIndex = this.brackets.length;
    const inactive = !opener.image && stackIndex < this.inactiveBelow;
    // 弹出后新压入的 [ 会占用这个下标，失效范围不能覆盖它
    if (this.inactiveBelow > stackIndex) this.inactiveBelow = stackIndex;
    if (inactive) { this.buf += ']'; return; }
    const dest = this.linkTail();
    if (!dest) { this.buf += ']'; return; }
    this.flush();
    // 先处理链接文字内部的强调
    this.processEmphasis(opener.delims);
    const inner = this.nodes.slice(opener.index + 1);
    const url = safeUrl(dest.url);
    const title = dest.title == null ? '' : ` title="${escapeHtml(dest.title)}"`;
    if (opener.image) {
      const alt = inner.map((n) => n.text ?? decodeEntities(n.html.replace(/<[^<>]*>/g, ''))).join('');
      this.nodes.length = opener.index;
      this.push(url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}"${title} />` : escapeHtml(alt));
    } else {
      opener.node.html = '';
      opener.node.text = '';
      const closeNode = this.push('');
      if (url) {
        opener.node.open.push(`<a href="${escapeHtml(url)}"${title} rel="noopener noreferrer">`);
        closeNode.close.push('</a>');
      }
      // 链接里不能再套链接：之前的普通 [ 全部失效
      this.inactiveBelow = stackIndex;
    }
  }

  // 解析 ](url "title") 的 (…) 部分；失败返回 null，pos 不变
  linkTail() {
    const s = this.src;
    let j = this.pos;
    if (s[j] !== '(') return null;
    j++;
    const skipWs = () => { while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++; };
    skipWs();
    let url = '';
    if (s[j] === '<') {
      j++;
      const start = j;
      while (j < s.length && s[j] !== '>' && s[j] !== '<' && s[j] !== '\n') {
        if (s[j] === '\\' && j + 1 < s.length) j++;
        j++;
      }
      if (s[j] !== '>') return null;
      url = s.slice(start, j);
      j++;
    } else {
      const start = j;
      let depth = 0;
      while (j < s.length) {
        const ch = s[j];
        if (ch === '\\' && j + 1 < s.length && ASCII_PUNCT.includes(s[j + 1])) { j += 2; continue; }
        if (ch === '(') { depth++; if (depth > MAX_PAREN) return null; }
        else if (ch === ')') { if (depth === 0) break; depth--; }
        else if (ch.charCodeAt(0) <= 32) break;
        j++;
      }
      if (depth !== 0) return null;
      url = s.slice(start, j);
    }
    const afterUrl = j;
    skipWs();
    let title = null;
    const q = s[j];
    if ((q === '"' || q === "'" || q === '(') && j > afterUrl) {
      const close = q === '(' ? ')' : q;
      j++;
      const start = j;
      while (j < s.length && s[j] !== close) {
        if (s[j] === '\\' && j + 1 < s.length) j++;
        j++;
      }
      if (s[j] !== close) return null;
      title = unescapeMd(s.slice(start, j));
      j++;
      skipWs();
    }
    if (s[j] !== ')') return null;
    this.pos = j + 1;
    return { url: unescapeMd(url), title };
  }

  angle() {
    const s = this.src;
    AUTOLINK_RE.lastIndex = this.pos;
    let m = AUTOLINK_RE.exec(s);
    if (m && !this.inLink()) {
      const url = safeUrl(m[1]);
      if (url) {
        this.push(`<a href="${escapeHtml(url)}" rel="noopener noreferrer">${escapeHtml(m[1])}</a>`);
        this.pos += m[0].length;
        return;
      }
    }
    EMAIL_RE.lastIndex = this.pos;
    m = EMAIL_RE.exec(s);
    if (m && !this.inLink()) {
      this.push(`<a href="mailto:${escapeHtml(m[1])}" rel="noopener noreferrer">${escapeHtml(m[1])}</a>`);
      this.pos += m[0].length;
      return;
    }
    if (!this.opts.sanitize) {
      // HTML 注释：先用最后一个 --> 的位置快速排除，找不到结尾时不再逐个扫描（避免平方复杂度）
      if (s.startsWith('<!--', this.pos)) {
        this.lastCommentEnd ??= s.lastIndexOf('-->');
        const end = this.lastCommentEnd > this.pos ? s.indexOf('-->', this.pos + 4) : -1;
        if (end >= 0) {
          this.push(s.slice(this.pos, end + 3));
          this.pos = end + 3;
          return;
        }
      }
      HTML_TAG_RE.lastIndex = this.pos;
      m = HTML_TAG_RE.exec(s);
      if (m) {
        this.push(m[0]);
        this.pos += m[0].length;
        return;
      }
    }
    this.buf += '<';
    this.pos++;
  }

  // 当前是否处在尚有效的链接文字 [ … 里（链接里不再生成自动链接，避免 <a> 嵌套）
  inLink() {
    const top = this.brackets[this.brackets.length - 1];
    if (!top) return false;
    const dead = this.inactiveBelow > 0 ? this.brackets[this.inactiveBelow - 1].links : 0;
    return top.links - dead > 0;
  }

  entity() {
    ENTITY_RE.lastIndex = this.pos;
    const m = ENTITY_RE.exec(this.src);
    if (m) {
      // 实体原样保留（只是字符引用，不会形成标签）
      this.flush();
      this.push(m[0]).text = decodeEntities(m[0]);
      this.pos += m[0].length;
    } else {
      this.buf += '&';
      this.pos++;
    }
  }

  // GFM 扩展自动链接：http(s):// 或 www. 开头，前面须为行首、空白或 ( * _ ~
  bareUrl() {
    const s = this.src;
    const prev = this.pos === 0 ? undefined : s[this.pos - 1];
    if ((prev === undefined || /[\s(*_~]/.test(prev)) && !this.inLink()) {
      BARE_URL_RE.lastIndex = this.pos;
      const m = BARE_URL_RE.exec(s);
      if (m) {
        // 去掉末尾的标点；多余的右括号不算网址的一部分（逐字符判断，线性时间）
        const raw = m[0];
        let open = 0;
        let close = 0;
        for (const ch of raw) { if (ch === '(') open++; else if (ch === ')') close++; }
        let e = raw.length;
        for (;;) {
          const ch = raw[e - 1];
          if (e > 0 && '?!.,:*_~\'";'.includes(ch)) e--;
          else if (ch === ')' && open < close) { e--; close--; }
          else break;
        }
        const text = raw.slice(0, e);
        const host = text.replace(/^https?:\/\//, '').replace(/^www\./, '');
        if (/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+/.test(host) || (text.startsWith('http') && /^[a-zA-Z0-9-]+/.test(host))) {
          const url = safeUrl(text.startsWith('www.') ? `http://${text}` : text);
          if (url) {
            this.push(`<a href="${escapeHtml(url)}" rel="noopener noreferrer">${escapeHtml(text)}</a>`);
            this.pos += text.length;
            return;
          }
        }
      }
    }
    this.buf += s[this.pos];
    this.pos++;
  }

  render() {
    let out = '';
    for (const n of this.nodes) out += n.close.join('') + n.html + n.open.join('');
    return out;
  }
}

function unescapeMd(s) {
  let out = '';
  for (let j = 0; j < s.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ASCII_PUNCT.includes(s[j + 1])) { out += s[j + 1]; j++; }
    else out += s[j];
  }
  return out;
}

export function renderInline(text, opts = { sanitize: true }) {
  return new Inline(text, opts).parse();
}

// ---------------- 块级解析 ----------------

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const ATX_RE = /^ {0,3}(#{1,6})(?=[ \t]|$)/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const QUOTE_RE = /^ {0,3}>/;
const LIST_RE = /^( {0,3})([-+*]|[0-9]{1,9}[.)])(?=[ \t]|$)/;
// 原始 HTML 块（仅 sanitize=false）：注释或块级标签开头，或整行只有一个完整标签
const HTML_BLOCK_RE = /^ {0,3}(?:<!--|<\/?(?:address|article|aside|blockquote|body|details|dialog|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hr|html|iframe|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul|script|style)(?=[\s/>]|$))/i;
const HTML_LINE_RE = /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>[ \t]*$/;
const isBlankLine = (l) => l.trim() === '';

// Tab 展开为空格（按 4 列对齐），只处理行首空白部分，避免影响正文
function expandTabs(line) {
  if (!line.includes('\t')) return line;
  let out = '';
  let col = 0;
  let j = 0;
  for (; j < line.length; j++) {
    const ch = line[j];
    if (ch === '\t') { const n = 4 - (col % 4); out += ' '.repeat(n); col += n; }
    else if (ch === ' ') { out += ' '; col++; }
    else break;
  }
  return out + line.slice(j);
}

const leadingSpaces = (l) => { let n = 0; while (l.charCodeAt(n) === 32) n++; return n; };

function parseListMarker(line) {
  const m = LIST_RE.exec(line);
  if (!m) return null;
  const indent = m[1].length;
  const marker = m[2];
  const after = line.slice(indent + marker.length);
  const blank = after.trim() === '';
  let spaces = leadingSpaces(after);
  if (blank) spaces = 1;
  else if (spaces > 4) spaces = 1; // 后面是缩进代码块时，内容从标记后 1 格算
  const ordered = /\d/.test(marker[0]);
  return {
    ordered,
    bullet: ordered ? marker[marker.length - 1] : marker,
    start: ordered ? Number(marker.slice(0, -1)) : null,
    width: indent + marker.length + spaces,
    content: blank ? '' : after.slice(spaces),
    blank,
  };
}

// 表格分隔行 | --- | :---: |，返回每列对齐方式；不是分隔行返回 null
function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let j = 0; j < t.length; j++) {
    if (t[j] === '\\' && t[j + 1] === '|') { cur += '|'; j++; }
    else if (t[j] === '|') { cells.push(cur.trim()); cur = ''; }
    else cur += t[j];
  }
  cells.push(cur.trim());
  return cells;
}

function delimiterRow(line) {
  if (!line.includes('-')) return null;
  const cells = splitRow(line);
  const aligns = [];
  for (const c of cells) {
    if (!/^:?-+:?$/.test(c)) return null;
    aligns.push(c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null);
  }
  return aligns;
}

class Blocks {
  constructor(opts) {
    this.opts = opts;
  }

  // 该行是否会打断段落（开始新的块）
  interrupts(line, depth) {
    if (FENCE_RE.test(line) || ATX_RE.test(line) || HR_RE.test(line)) return true;
    if (depth < MAX_NEST && QUOTE_RE.test(line)) return true;
    if (!this.opts.sanitize && HTML_BLOCK_RE.test(line)) return true;
    if (depth < MAX_NEST) {
      const li = parseListMarker(line);
      if (li && !li.blank && (!li.ordered || li.start === 1)) return true;
    }
    return false;
  }

  // 解析一组行，返回块节点数组；每个节点带 blankBefore（前面是否有空行，用于判断松散列表）
  parse(lines, depth) {
    const nodes = [];
    let para = [];
    let blank = false;
    const add = (node) => { node.blankBefore = blank; nodes.push(node); blank = false; };
    const endPara = () => {
      if (para.length) {
        add({ type: 'paragraph', text: para.map((l) => l.replace(/^[ \t]+/, '')).join('\n').replace(/[ \t]+$/, '') });
        para = [];
      }
    };
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (isBlankLine(line)) { endPara(); blank = true; i++; continue; }
      const ind = leadingSpaces(line);

      // 缩进代码块（不能打断段落）
      if (ind >= 4 && !para.length) {
        const buf = [];
        while (i < lines.length && (isBlankLine(lines[i]) || leadingSpaces(lines[i]) >= 4)) buf.push(lines[i++].slice(4));
        while (buf.length && isBlankLine(buf[buf.length - 1])) buf.pop();
        add({ type: 'code', lang: '', text: `${buf.join('\n')}\n` });
        continue;
      }

      // Setext 标题：段落后面跟 === 或 ---
      if (para.length && SETEXT_RE.test(line)) {
        const level = line.trim()[0] === '=' ? 1 : 2;
        add({ type: 'heading', level, text: para.map((l) => l.trim()).join('\n') });
        para = [];
        i++;
        continue;
      }

      // 围栏代码块
      const fence = FENCE_RE.exec(line);
      if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) {
        endPara();
        const fi = fence[1].length;
        const mark = fence[2];
        const lang = fence[3].trim().split(/\s+/)[0].replace(/[^\w#+.-]/g, '');
        const buf = [];
        i++;
        while (i < lines.length) {
          const l = lines[i];
          const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l);
          if (close && close[1][0] === mark[0] && close[1].length >= mark.length) { i++; break; }
          buf.push(l.slice(Math.min(fi, leadingSpaces(l))));
          i++;
        }
        add({ type: 'code', lang, text: buf.length ? `${buf.join('\n')}\n` : '' });
        continue;
      }

      // ATX 标题
      const atx = ATX_RE.exec(line);
      if (atx) {
        endPara();
        let text = line.slice(atx[0].length).trim();
        // 去掉结尾的 #（前面须为空格）
        let e = text.length;
        while (e > 0 && text[e - 1] === '#') e--;
        if (e === 0) text = '';
        else if (e < text.length && (text[e - 1] === ' ' || text[e - 1] === '\t')) text = text.slice(0, e).trim();
        add({ type: 'heading', level: atx[1].length, text });
        i++;
        continue;
      }

      // 分隔线
      if (HR_RE.test(line)) {
        endPara();
        add({ type: 'hr' });
        i++;
        continue;
      }

      // 引用
      if (depth < MAX_NEST && QUOTE_RE.test(line)) {
        endPara();
        const buf = [];
        while (i < lines.length) {
          const l = lines[i];
          if (QUOTE_RE.test(l)) {
            let rest = l.slice(l.indexOf('>') + 1);
            if (rest[0] === ' ') rest = rest.slice(1);
            buf.push(rest);
            i++;
          } else if (!isBlankLine(l) && buf.length && !isBlankLine(buf[buf.length - 1]) && !this.interrupts(l, depth)) {
            buf.push(l); // 懒惰续行
            i++;
          } else break;
        }
        add({ type: 'quote', children: this.parse(buf, depth + 1) });
        continue;
      }

      // 列表
      const li = depth < MAX_NEST ? parseListMarker(line) : null;
      if (li && !(para.length && (li.blank || (li.ordered && li.start !== 1)))) {
        endPara();
        const list = { type: 'list', ordered: li.ordered, start: li.start, items: [], loose: false };
        let marker = li;
        let gapBefore = false;
        while (marker) {
          const itemLines = [marker.content];
          i++;
          let lastBlank = marker.blank;
          let blanksInside = false;
          let hasContent = !marker.blank;
          while (i < lines.length) {
            const l = lines[i];
            if (isBlankLine(l)) {
              // 空项后紧跟空行：列表项结束
              if (itemLines.length === 1 && marker.blank) break;
              itemLines.push('');
              lastBlank = true;
              i++;
              continue;
            }
            if (leadingSpaces(l) >= marker.width) {
              if (lastBlank && hasContent) blanksInside = true;
              itemLines.push(l.slice(marker.width));
              lastBlank = false;
              hasContent = true;
              i++;
              continue;
            }
            if (!lastBlank && !this.interrupts(l, depth) && !parseListMarker(l) && itemLines[itemLines.length - 1] !== '') {
              itemLines.push(l); // 懒惰续行
              i++;
              continue;
            }
            break;
          }
          // 末尾空行不属于本项
          let trailing = 0;
          while (itemLines.length > 1 && itemLines[itemLines.length - 1] === '') { itemLines.pop(); trailing++; }
          let first = itemLines[0];
          let task = null;
          const tm = /^\[([ xX])\](?:[ \t]+|$)/.exec(first);
          if (tm) { task = tm[1] !== ' '; first = first.slice(tm[0].length); itemLines[0] = first; }
          const children = this.parse(itemLines, depth + 1);
          if (blanksInside && children.some((c, k) => k > 0 && c.blankBefore)) list.loose = true;
          if (gapBefore) list.loose = true;
          list.items.push({ task, children });
          // 下一项：同类型的列表标记
          const next = i < lines.length ? parseListMarker(lines[i]) : null;
          if (next && next.ordered === list.ordered && next.bullet === li.bullet && leadingSpaces(lines[i]) < marker.width) {
            gapBefore = trailing > 0;
            marker = next;
          } else {
            marker = null;
          }
        }
        add(list);
        continue;
      }

      // 原始 HTML 块（仅 sanitize=false）
      if (!this.opts.sanitize && (HTML_BLOCK_RE.test(line) || (!para.length && HTML_LINE_RE.test(line)))) {
        endPara();
        const buf = [];
        while (i < lines.length && !isBlankLine(lines[i])) buf.push(lines[i++]);
        add({ type: 'html', text: buf.join('\n') });
        continue;
      }

      // 表格：表头行 + 分隔行
      if (!para.length && line.includes('|') && i + 1 < lines.length) {
        const aligns = delimiterRow(lines[i + 1]);
        const head = aligns ? splitRow(line) : null;
        if (aligns && head.length === aligns.length) {
          const rows = [];
          i += 2;
          while (i < lines.length && !isBlankLine(lines[i]) && !this.interrupts(lines[i], depth)) {
            const cells = splitRow(lines[i]);
            rows.push(aligns.map((_, k) => cells[k] ?? ''));
            i++;
          }
          add({ type: 'table', aligns, head, rows });
          continue;
        }
      }

      // 段落（遇到能打断段落的块时结束）
      if (para.length && this.interrupts(line, depth)) endPara();
      para.push(line);
      i++;
    }
    endPara();
    return nodes;
  }
}

// ---------------- 渲染 ----------------

class Renderer {
  constructor(opts) {
    this.opts = opts;
    this.toc = [];
    this.ids = new Map();
  }

  inline(text) { return renderInline(text, this.opts); }

  slug(text) {
    let base = text.toLowerCase().trim()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    if (!base) base = 'section';
    const n = this.ids.get(base) ?? 0;
    this.ids.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  }

  blocks(nodes, tight = false) {
    return nodes.map((n) => this.block(n, tight)).join('\n');
  }

  block(n, tight) {
    switch (n.type) {
      case 'paragraph': return tight ? this.inline(n.text) : `<p>${this.inline(n.text)}</p>`;
      case 'heading': {
        const html = this.inline(n.text);
        const text = decodeEntities(html.replace(/<[^<>]*>/g, '')).trim();
        const id = this.slug(text);
        this.toc.push({ level: n.level, text, id });
        return `<h${n.level} id="${escapeHtml(id)}">${html}</h${n.level}>`;
      }
      case 'code': {
        const cls = n.lang ? ` class="language-${escapeHtml(n.lang)}"` : '';
        return `<pre><code${cls}>${escapeHtml(n.text)}</code></pre>`;
      }
      case 'hr': return '<hr />';
      case 'quote': return `<blockquote>\n${this.blocks(n.children)}\n</blockquote>`;
      case 'html': return n.text;
      case 'table': {
        const attr = (k) => (n.aligns[k] ? ` style="text-align:${n.aligns[k]}"` : '');
        const head = n.head.map((c, k) => `<th${attr(k)}>${this.inline(c)}</th>`).join('');
        const body = n.rows.map((r) => `<tr>${r.map((c, k) => `<td${attr(k)}>${this.inline(c)}</td>`).join('')}</tr>`).join('\n');
        return `<table>\n<thead>\n<tr>${head}</tr>\n</thead>${body ? `\n<tbody>\n${body}\n</tbody>` : ''}\n</table>`;
      }
      case 'list': {
        const tag = n.ordered ? 'ol' : 'ul';
        const start = n.ordered && n.start !== 1 ? ` start="${n.start}"` : '';
        const items = n.items.map((it) => {
          const box = it.task === null ? '' : `<input type="checkbox" disabled${it.task ? ' checked' : ''} /> `;
          const cls = it.task === null ? '' : ' class="task-list-item"';
          if (!it.children.length) return `<li${cls}>${box}</li>`;
          // 紧凑列表：首段不包 <p>，直接跟在 <li> 后面（每个子节点只渲染一次，目录不会重复）
          if (!n.loose && it.children[0].type === 'paragraph') {
            const [firstChild, ...rest] = it.children;
            const tail = rest.length ? `\n${this.blocks(rest, true)}\n` : '';
            return `<li${cls}>${box}${this.inline(firstChild.text)}${tail}</li>`;
          }
          return `<li${cls}>${box}\n${this.blocks(it.children, !n.loose)}\n</li>`;
        }).join('\n');
        return `<${tag}${start}>\n${items}\n</${tag}>`;
      }
      default: return '';
    }
  }
}

// 字数：汉字 + 英文单词 + 数字串（与文本统计接口口径一致）
function countWords(text) {
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const words = (text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? []).length;
  const nums = (text.match(/\d+(?:\.\d+)?/g) ?? []).length;
  return han + words + nums;
}

export function markdownToHtml(src, { sanitize = true } = {}) {
  if (Buffer.byteLength(src, 'utf8') > MAX_INPUT) throw new HttpError(400, `text 过大（最多 ${MAX_INPUT / 1024} KB）`);
  const opts = { sanitize };
  const lines = src.replace(/\r\n?/g, '\n').replace(/\u0000/g, '\uFFFD').split('\n').map(expandTabs);
  const nodes = new Blocks(opts).parse(lines, 0);
  const r = new Renderer(opts);
  const body = r.blocks(nodes);
  const html = body ? `${body}\n` : '';
  const plain = decodeEntities(html.replace(/<[^<>]*>/g, ' '));
  return {
    html,
    toc: r.toc,
    words: countWords(plain),
    characters: [...plain.replace(/\s/g, '')].length,
  };
}

// ---------------- 路由 ----------------

const EXAMPLE = '# 标题\n\n这是 **粗体**、*斜体*、~~删除线~~ 和 `代码`，[链接](https://example.com)。\n\n- [x] 已完成\n- [ ] 未完成\n\n| 名称 | 数量 |\n| :--- | ---: |\n| 苹果 | 3 |\n';

export default {
  name: 'markdown',
  category: 'tools',
  title: 'Markdown 转 HTML',
  description: 'Markdown 渲染为 HTML（CommonMark 常用语法 + GFM 表格、任务列表、删除线），默认过滤原始 HTML 和危险链接，并生成目录',
  source: '本地计算',
  routes: [
    {
      method: 'POST',
      path: '/api/tools/markdown',
      summary: 'Markdown 转 HTML，附标题目录和字数（POST JSON 请求体）',
      params: [
        { name: 'text', in: 'body', required: true, desc: `Markdown 文本，最多 ${MAX_INPUT / 1024} KB（经 HTTP 调用时受请求体 100KB 上限限制）`, example: EXAMPLE },
        { name: 'sanitize', in: 'body', default: 'true', desc: '是否转义原始 HTML：true（默认，推荐）把 <script> 等 HTML 原样显示为文本；false 保留原始 HTML（仅用于可信内容）。无论哪种，链接和图片都只允许 http / https / mailto 和相对地址', example: 'true' },
      ],
      fields: [
        { name: 'html', type: 'string', desc: 'HTML 片段（不含 <html>/<body>）。标题带 id；代码块为 <pre><code class="language-xxx">；链接带 rel="noopener noreferrer"；任务列表项为 <li class="task-list-item"> 内含禁用的复选框；表格对齐写在 style="text-align:…"；不安全的链接只保留文字' },
        { name: 'toc', type: 'array', desc: '标题目录，按出现顺序' },
        { name: 'toc[].level', type: 'number', desc: '标题级别 1~6' },
        { name: 'toc[].text', type: 'string', desc: '标题纯文本' },
        { name: 'toc[].id', type: 'string', desc: '标题的 id（小写，空格换成 -，去掉标点，保留中文；重名时依次加 -1、-2），可用于 #锚点' },
        { name: 'words', type: 'number', desc: '渲染后正文的字数（汉字数 + 英文单词数 + 数字串数）' },
        { name: 'characters', type: 'number', desc: '渲染后正文的字符数（不含空白）' },
      ],
      async handler({ body }) {
        const input = bodyParams(body);
        const text = param(input, 'text', { default: '', max: MAX_INPUT });
        if (input.get('text') == null) throw new HttpError(400, '缺少参数 text');
        const sanitize = truthy(param(input, 'sanitize', { default: 'true', oneOf: ['0', '1', 'true', 'false'] }));
        return { data: markdownToHtml(text, { sanitize }) };
      },
    },
  ],
};

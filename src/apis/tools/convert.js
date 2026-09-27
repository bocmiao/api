import { HttpError, param } from '../../lib/http.js';
import { bodyParams, truthy } from './inputs.js';

// 格式转换：JSON / YAML / CSV 互转。
// YAML 只实现常用子集（YAML 1.2 核心模式）：块映射、块序列、普通 / 单引号 / 双引号标量、数字、布尔、null、注释、
// 简单的行内 [a, b] / {a: 1}、| 与 > 多行文本。锚点 &、别名 *、标签 !、复杂键 ?、多文档、指令 % 一律报 400，
// 既避免实现不完整导致的静默出错，也从根上杜绝“别名炸弹”（billion laughs）。

export const MAX_INPUT = 1024 * 1024;
export const MAX_DEPTH = 100;
const FORMATS = ['json', 'yaml', 'csv'];

const fail = (msg) => { throw new HttpError(400, msg); };

// 定义属性时不走 __proto__ 等 setter，防原型污染
function setKey(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

// ---------------- YAML 标量 ----------------

const INT_RE = /^[-+]?[0-9]+$/;
const FLOAT_RE = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/;

// 普通（不带引号）标量按 YAML 1.2 核心模式识别类型
export function resolvePlain(s) {
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (INT_RE.test(s)) {
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : s;
  }
  if (/^0x[0-9a-fA-F]+$/.test(s)) {
    const n = Number.parseInt(s.slice(2), 16);
    return Number.isSafeInteger(n) ? n : s;
  }
  if (/^0o[0-7]+$/.test(s)) {
    const n = Number.parseInt(s.slice(2), 8);
    return Number.isSafeInteger(n) ? n : s;
  }
  if (FLOAT_RE.test(s)) return Number(s);
  if (/^[-+]?\.(?:inf|Inf|INF)$/.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^\.(?:nan|NaN|NAN)$/.test(s)) return NaN;
  return s;
}

// 文档开始 / 结束标记
const DOC_MARK = /^(?:---|\.\.\.)(?:\s|$)/;

const ESCAPES = { 0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029' };

// ---------------- YAML 解析 ----------------

class YamlParser {
  constructor(src) {
    this.lines = src.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
    // 文本末尾的换行不产生额外的空行（否则 |+ 块会多出一个换行）
    if (this.lines.length > 1 && this.lines[this.lines.length - 1] === '') this.lines.pop();
    this.i = 0;
  }

  err(msg, line = this.i) { fail(`YAML 第 ${Math.min(line, this.lines.length - 1) + 1} 行：${msg}`); }

  // 行首缩进（只允许空格；Tab 缩进在 YAML 中非法）
  indent(line) {
    let n = 0;
    while (line.charCodeAt(n) === 32) n++;
    if (line[n] === '\t' && line.slice(n).trim() !== '') this.err('缩进不能使用 Tab，请改用空格');
    return n;
  }

  isBlank(line) {
    const t = line.trim();
    return t === '' || t[0] === '#';
  }

  skipBlank() {
    while (this.i < this.lines.length && this.isBlank(this.lines[this.i])) this.i++;
  }

  eof() { return this.i >= this.lines.length; }

  parseDocument() {
    this.skipBlank();
    // 文档开始标记 ---（可选，只允许一个）；%YAML 等指令不支持
    if (!this.eof() && this.lines[this.i].startsWith('%')) this.err('不支持 % 指令');
    if (!this.eof() && /^---(?:\s|$)/.test(this.lines[this.i])) {
      const rest = this.lines[this.i].slice(3);
      if (this.isBlank(rest)) this.i++;
      else this.lines[this.i] = `   ${rest}`;
    }
    const value = this.parseBlock(0, 0);
    this.skipBlank();
    if (!this.eof()) {
      const line = this.lines[this.i];
      if (/^---(?:\s|$)/.test(line)) this.err('不支持多文档（多个 ---）');
      if (/^\.\.\.(?:\s|$)/.test(line)) {
        this.i++;
        this.skipBlank();
        if (this.eof()) return value;
        this.err('不支持多文档');
      }
      this.err('无法解析，请检查缩进和格式');
    }
    return value;
  }

  // 检查节点开头的不支持的语法
  checkIndicator(text) {
    const c = text[0];
    if (c === '&') this.err('不支持锚点（&）');
    if (c === '*') this.err('不支持别名（*）');
    if (c === '!') this.err('不支持标签（!）');
    if (c === '?' && (text.length === 1 || text[1] === ' ')) this.err('不支持复杂键（?）');
    if (c === '@' || c === '`') this.err(`${c} 是 YAML 保留字符，不能作为普通文本开头，请加引号`);
  }

  // 解析缩进 ≥ minIndent 的一个节点；parentIndent 是父节点的缩进（块文本的内容须比它缩进更多）
  parseBlock(minIndent, depth, parentIndent = minIndent - 1) {
    if (depth > MAX_DEPTH) this.err(`嵌套层级超过 ${MAX_DEPTH}`);
    this.skipBlank();
    if (this.eof()) return null;
    const line = this.lines[this.i];
    const ind = this.indent(line);
    if (ind < minIndent) return null;
    const content = line.slice(ind);
    if (content === '-' || content.startsWith('- ')) return this.parseSeq(ind, depth);
    this.checkIndicator(content);
    if (this.keyEnd(content) >= 0) return this.parseMap(ind, depth);
    const start = this.i;
    this.i++;
    return this.parseInline(content, parentIndent, depth, start);
  }

  // 找映射键后的冒号位置（冒号后须为空格或行尾）；不是键行时返回 -1。按字符扫描，线性时间
  keyEnd(content) {
    const c = content[0];
    if (c === '[' || c === '{') return -1;
    let j = 0;
    if (c === '"' || c === "'") {
      j = 1;
      while (j < content.length) {
        if (c === '"' && content[j] === '\\') j += 2;
        else if (content[j] === c) {
          if (c === "'" && content[j + 1] === "'") j += 2;
          else break;
        } else j++;
      }
      if (j >= content.length) return -1;
      j++;
      while (content[j] === ' ') j++;
      return content[j] === ':' && (j + 1 === content.length || content[j + 1] === ' ' || content[j + 1] === '\t') ? j : -1;
    }
    for (; j < content.length; j++) {
      const ch = content[j];
      if (ch === '#' && j > 0 && (content[j - 1] === ' ' || content[j - 1] === '\t')) return -1;
      if (ch === ':' && (j + 1 === content.length || content[j + 1] === ' ' || content[j + 1] === '\t')) return j;
    }
    return -1;
  }

  parseKey(raw, lineNo) {
    const t = raw.trim();
    if (t === '') this.err('键不能为空', lineNo);
    if (t[0] === '"' || t[0] === "'") return this.unquote(t, lineNo);
    this.checkIndicator(t);
    if (t[0] === '[' || t[0] === '{') this.err('不支持集合作为键', lineNo);
    return t;
  }

  parseSeq(ind, depth) {
    const arr = [];
    for (;;) {
      this.skipBlank();
      if (this.eof()) break;
      const line = this.lines[this.i];
      if (DOC_MARK.test(line)) break;
      const cur = this.indent(line);
      if (cur < ind) break;
      if (cur > ind) this.err('缩进不一致');
      const content = line.slice(ind);
      if (!(content === '-' || content.startsWith('- '))) break;
      const rest = content.slice(1);
      if (this.isBlank(rest)) {
        this.i++;
        this.skipBlank();
        arr.push(!this.eof() && this.indent(this.lines[this.i]) > ind ? this.parseBlock(ind + 1, depth + 1, ind) : null);
      } else {
        // 把 "- " 换成空格，条目内容就成了缩进更深的普通节点（支持 - a: 1 与 - - x 这类紧凑写法）
        this.lines[this.i] = ' '.repeat(ind + 1) + rest;
        arr.push(this.parseBlock(ind + 1, depth + 1, ind));
      }
    }
    return arr;
  }

  parseMap(ind, depth) {
    const obj = {};
    const seen = new Set();
    for (;;) {
      this.skipBlank();
      if (this.eof()) break;
      const line = this.lines[this.i];
      if (DOC_MARK.test(line)) break;
      const cur = this.indent(line);
      if (cur < ind) break;
      if (cur > ind) this.err('缩进不一致');
      const content = line.slice(ind);
      if (content === '-' || content.startsWith('- ')) this.err('此处不能出现序列项（- ），请检查缩进');
      this.checkIndicator(content);
      const colon = this.keyEnd(content);
      if (colon < 0) this.err('应为 键: 值 格式');
      const lineNo = this.i;
      const key = this.parseKey(content.slice(0, colon), lineNo);
      if (seen.has(key)) this.err(`重复的键：${key}`);
      seen.add(key);
      const rest = content.slice(colon + 1).trim();
      this.i++;
      let value;
      if (this.isBlank(rest)) {
        this.skipBlank();
        if (this.eof()) value = null;
        else {
          const next = this.lines[this.i];
          const ni = this.indent(next);
          const nc = next.slice(ni);
          if (ni > ind) value = this.parseBlock(ind + 1, depth + 1, ind);
          else if (ni === ind && (nc === '-' || nc.startsWith('- '))) value = this.parseSeq(ind, depth + 1);
          else value = null;
        }
      } else {
        value = this.parseInline(rest, ind, depth + 1, lineNo);
      }
      setKey(obj, key, value);
    }
    return obj;
  }

  // 解析一行中已去掉缩进的值（后续行可能是它的延续）。this.i 已指向下一行
  parseInline(text, parentIndent, depth, lineNo) {
    if (depth > MAX_DEPTH) this.err(`嵌套层级超过 ${MAX_DEPTH}`, lineNo);
    this.checkIndicator(text);
    const c = text[0];
    if (text === '-' || text.startsWith('- ')) this.err('序列项（- ）须另起一行书写', lineNo);
    if (c === '|' || c === '>') return this.parseBlockScalar(text, parentIndent, lineNo);
    if (c === '"' || c === "'") {
      const raw = this.gatherQuoted(text, c, lineNo);
      return this.unquote(raw, lineNo);
    }
    if (c === '[' || c === '{') {
      const raw = this.gatherFlow(text, lineNo);
      const p = new FlowParser(raw, this, lineNo, depth);
      const v = p.parseValue();
      p.ws();
      if (p.pos < raw.length) this.err('行内集合后面有多余内容', lineNo);
      return v;
    }
    // 普通标量：可以跨行，后续缩进更深的行折叠为空格，空行变成换行
    let s = stripComment(text);
    if (/: |:$/.test(s)) this.err('普通文本中不能出现“冒号 + 空格”或以冒号结尾，如需请加引号', lineNo);
    let blanks = 0;
    while (!this.eof()) {
      const line = this.lines[this.i];
      if (line.trim() === '') { blanks++; this.i++; continue; }
      const ni = this.indent(line);
      if (ni <= parentIndent || line.trim().startsWith('#')) break;
      const t = stripComment(line.slice(ni));
      if (this.keyEnd(t) >= 0 || t === '-' || t.startsWith('- ')) this.err('缩进错误：多行文本中出现了 键: 值 或序列项');
      s += blanks ? '\n'.repeat(blanks) + t : ` ${t}`;
      blanks = 0;
      this.i++;
    }
    // 退回多吃掉的空行
    this.i -= blanks;
    return resolvePlain(s);
  }

  // 引号字符串可能跨行：把后续行拼进来，直到出现匹配的结束引号
  gatherQuoted(text, q, lineNo) {
    // 逐行扫描结束引号（引号内的转义和 '' 不会跨行），最后再拼接，避免长字符串反复扫描
    const parts = [];
    let seg = text;
    let from = 1;
    for (;;) {
      const end = findQuoteEnd(seg, q, from);
      if (end >= 0) {
        if (!this.isBlank(seg.slice(end + 1))) this.err('引号字符串后面有多余内容', lineNo);
        parts.push(seg.slice(0, end + 1));
        return parts.join('\n');
      }
      parts.push(seg);
      if (this.eof()) this.err('引号没有闭合', lineNo);
      seg = this.lines[this.i++];
      from = 0;
    }
  }

  // 行内集合可能跨行：拼接到括号配平为止（跳过引号内部和注释）
  gatherFlow(text, lineNo) {
    let raw = '';
    let depth = 0;
    let q = null;
    let line = text;
    for (;;) {
      let out = '';
      for (let j = 0; j < line.length; j++) {
        const ch = line[j];
        if (q) {
          if (q === '"' && ch === '\\') { out += ch + (line[j + 1] ?? ''); j++; continue; }
          if (ch === q) {
            if (q === "'" && line[j + 1] === "'") { out += "''"; j++; continue; }
            q = null;
          }
          out += ch;
          continue;
        }
        if (ch === '#' && (j === 0 || line[j - 1] === ' ' || line[j - 1] === '\t')) break;
        if (ch === '"' || ch === "'") q = ch;
        else if (ch === '[' || ch === '{') {
          depth++;
          if (depth > MAX_DEPTH) this.err(`嵌套层级超过 ${MAX_DEPTH}`, lineNo);
        } else if (ch === ']' || ch === '}') depth--;
        out += ch;
      }
      raw += (raw ? '\n' : '') + out;
      if (depth <= 0 && !q) return raw;
      if (this.eof()) this.err('行内集合的括号没有闭合', lineNo);
      line = this.lines[this.i++];
    }
  }

  unquote(raw, lineNo) {
    const q = raw[0];
    const end = findQuoteEnd(raw, q);
    if (end < 0) this.err('引号没有闭合', lineNo);
    if (end !== raw.length - 1) this.err('引号字符串后面有多余内容', lineNo);
    const body = raw.slice(1, end);
    // 用数组收集输出；ws 记录末尾有几个原样写入的空白（转义得到的空白不算），折行时去掉
    const out = [];
    let ws = 0;
    const put = (c, literal = false) => {
      out.push(c);
      ws = literal && (c === ' ' || c === '\t') ? ws + 1 : 0;
    };
    for (let j = 0; j < body.length; j++) {
      const ch = body[j];
      if (ch === '\n') {
        // 跨行折叠：去掉行尾和下一行开头的空白；单个换行变空格，空行变换行
        out.length -= ws;
        ws = 0;
        let breaks = 0;
        while (j < body.length && (body[j] === '\n' || body[j] === ' ' || body[j] === '\t')) {
          if (body[j] === '\n') breaks++;
          j++;
        }
        j--;
        put(breaks > 1 ? '\n'.repeat(breaks - 1) : ' ');
        continue;
      }
      if (q === "'") {
        if (ch === "'") j++;
        put(ch, true);
        continue;
      }
      if (ch !== '\\') { put(ch, true); continue; }
      const e = body[++j];
      if (e === '\n') {
        // 行尾反斜杠：续行，不插入空格
        while (body[j + 1] === ' ' || body[j + 1] === '\t') j++;
        continue;
      }
      if (Object.hasOwn(ESCAPES, e)) { put(ESCAPES[e]); continue; }
      const len = { x: 2, u: 4, U: 8 }[e];
      const hex = len ? body.slice(j + 1, j + 1 + len) : '';
      if (!len || !new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) this.err(`无效的转义序列 \\${e ?? ''}`, lineNo);
      const cp = Number.parseInt(hex, 16);
      if (cp > 0x10ffff) this.err(`无效的 Unicode 码点 \\${e}${hex}`, lineNo);
      put(String.fromCodePoint(cp));
      j += len;
    }
    return out.join('');
  }

  // | 保留换行；> 折叠换行。支持 -（去掉末尾换行）/ +（保留全部末尾换行）和缩进指示数字
  parseBlockScalar(header, parentIndent, lineNo) {
    const h = stripComment(header);
    const m = /^([|>])([1-9])?([-+])?$/.exec(h) ?? /^([|>])([-+])?([1-9])?$/.exec(h);
    if (!m) this.err('多行文本标记只能是 | 或 >，后面可跟 - / + 和缩进数字', lineNo);
    const folded = m[1] === '>';
    const digit = [m[2], m[3]].find((x) => /^[1-9]$/.test(x ?? ''));
    const chomp = [m[2], m[3]].find((x) => x === '-' || x === '+') ?? '';
    let contentIndent = digit ? Math.max(parentIndent, 0) + Number(digit) : -1;
    const body = [];
    while (!this.eof()) {
      const line = this.lines[this.i];
      if (line.trim() === '') { body.push(''); this.i++; continue; }
      let n = 0;
      while (line.charCodeAt(n) === 32) n++;
      if (contentIndent < 0) {
        if (n <= parentIndent) break;
        contentIndent = n;
      }
      if (n < contentIndent) break;
      body.push(line.slice(contentIndent));
      this.i++;
    }
    // 末尾空行属于“结尾换行”，由 chomp 决定去留；多吃掉的空行退回给后续解析（不影响结果）
    let trailing = 0;
    while (body.length && body[body.length - 1] === '') { body.pop(); trailing++; }
    let text;
    if (!folded) text = body.join('\n');
    else {
      text = '';
      let pendingBlank = 0;
      let last = null;
      for (const l of body) {
        if (l === '') { pendingBlank++; continue; }
        const more = l[0] === ' ' || l[0] === '\t';
        if (last === null) text += '\n'.repeat(pendingBlank) + l;
        else if (!more && last === 'normal') text += (pendingBlank ? '\n'.repeat(pendingBlank) : ' ') + l;
        else text += `\n${'\n'.repeat(pendingBlank)}${l}`;
        pendingBlank = 0;
        last = more ? 'more' : 'normal';
      }
    }
    if (!body.length) return chomp === '+' ? '\n'.repeat(trailing) : '';
    if (chomp === '-') return text;
    if (chomp === '+') return `${text}\n${'\n'.repeat(trailing)}`;
    return `${text}\n`;
  }
}

// 找引号字符串的结束位置（raw[0] 为开引号）
function findQuoteEnd(raw, q, from = 1) {
  for (let j = from; j < raw.length; j++) {
    const ch = raw[j];
    if (q === '"' && ch === '\\') { j++; continue; }
    if (ch === q) {
      if (q === "'" && raw[j + 1] === "'") { j++; continue; }
      return j;
    }
  }
  return -1;
}

// 去掉普通标量后面的注释（# 前须有空白）和首尾空白
function stripComment(s) {
  for (let j = 0; j < s.length; j++) {
    if (s[j] === '#' && (j === 0 || s[j - 1] === ' ' || s[j - 1] === '\t')) return s.slice(0, j).trim();
  }
  return s.trim();
}

// 行内集合 [a, b] / {a: 1, b: [x]}
class FlowParser {
  constructor(src, yaml, lineNo, depth) {
    this.s = src;
    this.pos = 0;
    this.yaml = yaml;
    this.lineNo = lineNo;
    this.depth = depth;
  }

  err(msg) { this.yaml.err(`行内集合：${msg}`, this.lineNo); }

  ws() { while (this.pos < this.s.length && /\s/.test(this.s[this.pos])) this.pos++; }

  parseValue(inFlow = false) {
    this.ws();
    const c = this.s[this.pos];
    if (c === '[') return this.parseList();
    if (c === '{') return this.parseObj();
    if (c === '"' || c === "'") {
      const end = findQuoteEnd(this.s.slice(this.pos), c);
      if (end < 0) this.err('引号没有闭合');
      const raw = this.s.slice(this.pos, this.pos + end + 1);
      this.pos += end + 1;
      return this.yaml.unquote(raw, this.lineNo);
    }
    if (c === undefined) this.err('意外结束');
    this.yaml.checkIndicator(this.s.slice(this.pos));
    // 普通标量：到 , ] } 或 “: ” 为止
    const start = this.pos;
    while (this.pos < this.s.length) {
      const ch = this.s[this.pos];
      if (ch === ',' || ch === ']' || ch === '}' || ch === '[' || ch === '{') break;
      if (ch === ':' && inFlow && (this.pos + 1 >= this.s.length || /[\s,\]}]/.test(this.s[this.pos + 1]))) break;
      this.pos++;
    }
    return resolvePlain(this.s.slice(start, this.pos).replace(/\s+/g, ' ').trim());
  }

  enter() {
    this.depth++;
    if (this.depth > MAX_DEPTH) this.err(`嵌套层级超过 ${MAX_DEPTH}`);
    this.pos++;
  }

  parseList() {
    this.enter();
    const arr = [];
    for (;;) {
      this.ws();
      if (this.s[this.pos] === ']') { this.pos++; break; }
      arr.push(this.parseValue(true));
      this.ws();
      const ch = this.s[this.pos];
      if (ch === ':') this.err('不支持在 [ ] 中写 键: 值');
      if (ch === ',') { this.pos++; continue; }
      if (ch === ']') { this.pos++; break; }
      this.err('缺少逗号或 ]');
    }
    this.depth--;
    return arr;
  }

  parseObj() {
    this.enter();
    const obj = {};
    const seen = new Set();
    for (;;) {
      this.ws();
      if (this.s[this.pos] === '}') { this.pos++; break; }
      const c = this.s[this.pos];
      if (c === '[' || c === '{') this.err('不支持集合作为键');
      const k = this.parseValue(true);
      const key = k === null ? '' : String(k);
      this.ws();
      let value = null;
      if (this.s[this.pos] === ':') {
        this.pos++;
        this.ws();
        if (this.s[this.pos] !== ',' && this.s[this.pos] !== '}') value = this.parseValue(true);
      }
      if (seen.has(key)) this.err(`重复的键：${key}`);
      seen.add(key);
      setKey(obj, key, value);
      this.ws();
      const ch = this.s[this.pos];
      if (ch === ',') { this.pos++; continue; }
      if (ch === '}') { this.pos++; break; }
      this.err('缺少逗号或 }');
    }
    this.depth--;
    return obj;
  }
}

export function parseYaml(src) {
  return new YamlParser(src).parseDocument();
}

// ---------------- YAML 输出 ----------------

// 普通标量写法会被读成别的类型、或含特殊字符时，需要加引号
const YAML11_WORDS = /^(?:y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF)$/;
function plainSafe(s) {
  if (s === '' || s !== s.trim()) return false;
  if (/[\x00-\x1f\x7f\u0085\u2028\u2029\uFEFF]/.test(s)) return false;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return false;
  if (/: |:$| #/.test(s)) return false;
  if (/^(?:---|\.\.\.)/.test(s)) return false;
  if (YAML11_WORDS.test(s)) return false;
  return resolvePlain(s) === s;
}

function yamlString(s) {
  if (plainSafe(s)) return s;
  // 多行文本用 | 块，更易读；首行以空白开头或含控制字符时仍用双引号
  if (s.includes('\n') && !/^[ \t\n]/.test(s) && !/[\x00-\x08\x0b-\x1f\x7f\u0085\u2028\u2029\uFEFF]/.test(s) && !/[ \t]\n|[ \t]$/.test(s)) {
    const m = /\n*$/.exec(s)[0].length;
    const chomp = m === 0 ? '-' : m === 1 ? '' : '+';
    const body = m ? s.slice(0, -m) : s;
    // 内容行相对所在行缩进 2 格，外层的缩进由 yamlLines 统一加上
    const lines = body.split('\n').map((l) => (l === '' ? '' : `  ${l}`));
    if (chomp === '+') for (let k = 1; k < m; k++) lines.push('');
    return `|${chomp}\n${lines.join('\n')}`;
  }
  return JSON.stringify(s);
}

function yamlScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return '.nan';
    if (!Number.isFinite(v)) return v > 0 ? '.inf' : '-.inf';
    return String(v);
  }
  return yamlString(String(v));
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// 返回 YAML 文本行（不含父级缩进，由上层统一加）
function yamlLines(v) {
  if (Array.isArray(v)) {
    if (!v.length) return ['[]'];
    const out = [];
    for (const item of v) {
      if ((Array.isArray(item) && item.length) || (isPlainObject(item) && Object.keys(item).length)) {
        const sub = yamlLines(item);
        out.push(`- ${sub[0]}`, ...sub.slice(1).map((l) => (l === '' ? '' : `  ${l}`)));
      } else {
        out.push(...`- ${inlineValue(item)}`.split('\n'));
      }
    }
    return out;
  }
  if (isPlainObject(v)) {
    const keys = Object.keys(v);
    if (!keys.length) return ['{}'];
    const out = [];
    for (const k of keys) {
      const key = plainSafe(k) ? k : JSON.stringify(k);
      const item = v[k];
      if (Array.isArray(item) && item.length) {
        out.push(`${key}:`, ...yamlLines(item).map((l) => (l === '' ? '' : `  ${l}`)));
      } else if (isPlainObject(item) && Object.keys(item).length) {
        out.push(`${key}:`, ...yamlLines(item).map((l) => (l === '' ? '' : `  ${l}`)));
      } else {
        out.push(...`${key}: ${inlineValue(item)}`.split('\n'));
      }
    }
    return out;
  }
  return yamlScalar(v).split('\n');
}

// 写在 “键: ” 或 “- ” 后面的值：空集合写成 [] / {}，其余为标量
function inlineValue(v) {
  if (Array.isArray(v)) return '[]';
  if (isPlainObject(v)) return '{}';
  return yamlScalar(v);
}

export function toYaml(value) {
  return `${yamlLines(value).join('\n')}\n`;
}

// ---------------- CSV ----------------

// RFC 4180：字段可用双引号包裹，引号内 "" 表示一个引号，可含分隔符和换行
export function parseCsv(text, delimiter = ',') {
  const s = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let quoted = false;
  let hadQuote = false;
  let lineNo = 1;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => {
    endField();
    // 空行（只有一个空字段且没有引号）跳过
    if (!(row.length === 1 && row[0] === '' && !hadQuote)) rows.push(row);
    row = [];
    hadQuote = false;
  };
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false;
        i++;
        // 结束引号后只能是分隔符、换行或结尾
        if (i < s.length && s[i] !== delimiter && s[i] !== '\n' && s[i] !== '\r') fail(`CSV 第 ${lineNo} 行：引号字段结束后出现多余字符`);
        continue;
      }
      if (ch === '\n') lineNo++;
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') { quoted = true; hadQuote = true; i++; continue; }
    if (ch === delimiter) { endField(); i++; continue; }
    if (ch === '\r' || ch === '\n') {
      endRow();
      i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1;
      lineNo++;
      continue;
    }
    field += ch;
    i++;
  }
  if (quoted) fail('CSV 引号没有闭合');
  if (field !== '' || row.length || hadQuote) endRow();
  return rows;
}

// 表头：空名用 column序号，重名加 _2、_3
function headerNames(row) {
  const used = new Set();
  return row.map((h, idx) => {
    let name = h.trim() || `column${idx + 1}`;
    if (used.has(name)) {
      let n = 2;
      while (used.has(`${name}_${n}`)) n++;
      name = `${name}_${n}`;
    }
    used.add(name);
    return name;
  });
}

export function csvToValue(text, { delimiter = ',', header = true } = {}) {
  const rows = parseCsv(text, delimiter);
  if (!header) return rows;
  if (!rows.length) return [];
  const names = headerNames(rows[0]);
  return rows.slice(1).map((r) => {
    const obj = {};
    names.forEach((n, k) => setKey(obj, n, r[k] ?? ''));
    for (let k = names.length; k < r.length; k++) {
      let n = `column${k + 1}`;
      while (Object.hasOwn(obj, n)) n += '_';
      setKey(obj, n, r[k]);
    }
    return obj;
  });
}

function csvCell(v, delimiter) {
  let s;
  if (v === null || v === undefined) s = '';
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  if (s.includes(delimiter) || /["\r\n]/.test(s) || s !== s.trim()) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function valueToCsv(value, { delimiter = ',', header = true } = {}) {
  let v = value;
  if (isPlainObject(v)) v = [v];
  if (!Array.isArray(v)) fail('转为 CSV 时，数据须为数组（对象数组或二维数组）或单个对象');
  // 只有一列且为空时写成 ""，否则读回时会被当成空行跳过
  const line = (cells) => cells.map((c) => csvCell(c, delimiter)).join(delimiter) || '""';
  if (!v.length) return '';
  if (v.every(Array.isArray)) return `${v.map(line).join('\n')}\n`;
  if (v.every(isPlainObject)) {
    // 表头取所有对象键的并集，按首次出现的顺序
    const keys = [];
    const seen = new Set();
    for (const o of v) for (const k of Object.keys(o)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
    const out = v.map((o) => line(keys.map((k) => (Object.hasOwn(o, k) ? o[k] : ''))));
    if (header) out.unshift(line(keys));
    return `${out.join('\n')}\n`;
  }
  if (v.every((x) => x === null || typeof x !== 'object')) {
    const out = v.map((x) => line([x]));
    if (header) out.unshift('value');
    return `${out.join('\n')}\n`;
  }
  return fail('转为 CSV 时，数组元素须全部为对象、全部为数组或全部为简单值，不能混用');
}

// ---------------- 转换 ----------------

// 统计嵌套深度（迭代，不会爆栈）
export function depthOf(value) {
  let max = 0;
  const stack = [[value, 0]];
  while (stack.length) {
    const [v, d] = stack.pop();
    if (v !== null && typeof v === 'object') {
      const nd = d + 1;
      if (nd > max) max = nd;
      if (nd > MAX_DEPTH) return nd;
      for (const x of Object.values(v)) stack.push([x, nd]);
    }
  }
  return max;
}

function parseDelimiter(d) {
  if (d == null || d === '') return ',';
  if (d === 'tab' || d === '\\t' || d === '\t') return '\t';
  if ([',', ';', '|'].includes(d)) return d;
  return fail('delimiter 只能是 , ; | 或 tab');
}

export function convertFormat(input, { from, to, delimiter = ',', header = true, indent = 2 } = {}) {
  if (!FORMATS.includes(from)) fail(`from 只能是 ${FORMATS.join(' / ')}`);
  if (!FORMATS.includes(to)) fail(`to 只能是 ${FORMATS.join(' / ')}`);
  const inputBytes = Buffer.byteLength(input, 'utf8');
  if (inputBytes > MAX_INPUT) fail(`input 过大（最多 ${MAX_INPUT / 1024 / 1024} MB）`);
  const delim = parseDelimiter(delimiter);
  let value;
  if (from === 'json') {
    try {
      value = JSON.parse(input);
    } catch (err) {
      fail(`JSON 格式错误：${err.message}`);
    }
  } else if (from === 'yaml') value = parseYaml(input);
  else value = csvToValue(input, { delimiter: delim, header });
  if (depthOf(value) > MAX_DEPTH) fail(`嵌套层级超过 ${MAX_DEPTH}`);

  let output;
  if (to === 'json') {
    // JSON 不能表示 NaN / Infinity（YAML 的 .nan / .inf），JSON.stringify 会写成 null
    output = JSON.stringify(value, null, indent);
  } else if (to === 'yaml') output = toYaml(value);
  else output = valueToCsv(value, { delimiter: delim, header });
  return {
    from,
    to,
    output,
    rootType: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
    inputBytes,
    outputBytes: Buffer.byteLength(output, 'utf8'),
  };
}

// ---------------- 路由 ----------------

export default {
  name: 'format-convert',
  category: 'tools',
  title: '格式转换',
  description: 'JSON / YAML / CSV 互相转换：支持 YAML 常用语法（不含锚点、别名、标签）和带引号、换行的 CSV',
  source: '本地计算',
  routes: [
    {
      method: 'POST',
      path: '/api/tools/convert',
      summary: 'JSON / YAML / CSV 互转（POST JSON 请求体）',
      params: [
        { name: 'input', in: 'body', required: true, desc: `要转换的文本，最多 ${MAX_INPUT / 1024 / 1024} MB（经 HTTP 调用时受请求体 100KB 上限限制），嵌套不超过 ${MAX_DEPTH} 层`, example: 'name: 张三\nage: 18\ntags:\n  - a\n  - b\n' },
        { name: 'from', in: 'body', required: true, desc: '输入格式：json / yaml / csv', example: 'yaml' },
        { name: 'to', in: 'body', required: true, desc: '输出格式：json / yaml / csv（可与 from 相同，用于格式化）', example: 'json' },
        { name: 'delimiter', in: 'body', default: ',', desc: 'CSV 分隔符：, ; | 或 tab', example: ',' },
        { name: 'header', in: 'body', default: 'true', desc: 'CSV 是否有表头：读取时为 true 则首行作为键、每行转成对象，false 则每行转成数组；输出对象数组时控制是否写表头。true / false', example: 'true' },
        { name: 'indent', in: 'body', default: '2', desc: '输出 JSON 的缩进：0（压缩）/ 2 / 4；YAML 固定 2 空格缩进', example: '2' },
      ],
      fields: [
        { name: 'from', type: 'string', desc: '输入格式' },
        { name: 'to', type: 'string', desc: '输出格式' },
        { name: 'output', type: 'string', desc: '转换结果文本。YAML / CSV 以换行结尾；CSV 换行用 \\n，含分隔符、引号、换行或首尾空白的字段加双引号；嵌套的对象或数组以 JSON 文本写入单元格。CSV 读入的值都是字符串，不做类型推断' },
        { name: 'rootType', type: 'string', desc: '解析出的数据顶层类型：object / array / string / number / boolean / null' },
        { name: 'inputBytes', type: 'number', desc: '输入的 UTF-8 字节数' },
        { name: 'outputBytes', type: 'number', desc: '输出的 UTF-8 字节数' },
      ],
      async handler({ body }) {
        const input = bodyParams(body);
        const text = param(input, 'input', { required: true, max: MAX_INPUT });
        const from = param(input, 'from', { required: true, oneOf: FORMATS });
        const to = param(input, 'to', { required: true, oneOf: FORMATS });
        const delimiter = param(input, 'delimiter', { default: ',', max: 3 });
        const header = truthy(param(input, 'header', { default: 'true', oneOf: ['0', '1', 'true', 'false'] }));
        const indent = Number(param(input, 'indent', { default: '2', oneOf: ['0', '2', '4'] }));
        return { data: convertFormat(text, { from, to, delimiter, header, indent }) };
      },
    },
  ],
};

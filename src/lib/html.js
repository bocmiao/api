// 线性时间的 HTML 扫描工具。
// 目标网页由调用者指定，内容不可信：像 /<a\b[^>]*>/、/<!--[\s\S]*?-->/ 这类正则遇到大量"没有结尾"的标签时会退化成 O(n²)，
// 1MB 的恶意页面就能卡住事件循环几分钟。这里全部用 indexOf 顺序扫描，找不到结尾就停止，保证 O(n)。
import { decodeEntities } from './http.js';

// 只把 ASCII 大写字母转小写，保证下标与原字符串一一对应（toLowerCase 可能改变长度）
export const asciiLower = (s) => s.replace(/[A-Z]+/g, (x) => x.toLowerCase());

// decodeEntities 遇到超出范围的数字实体（如 &#99999999999;）会抛 RangeError，这里退回原文
export function safeDecode(s) {
  try {
    return decodeEntities(s);
  } catch {
    return s;
  }
}

const RAW_TEXT = /<(script|style|template|textarea|noscript)\b/y;

// 去掉注释和 script / style / template / textarea / noscript 的内容；没有结尾的注释或脚本按浏览器行为吞掉后面全部内容
export function stripNoise(html) {
  const lower = asciiLower(html);
  const parts = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      parts.push(html.slice(i));
      break;
    }
    parts.push(html.slice(i, lt));
    if (lower.startsWith('<!--', lt)) {
      const end = lower.indexOf('-->', lt + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    RAW_TEXT.lastIndex = lt;
    const m = RAW_TEXT.exec(lower);
    if (m) {
      const close = lower.indexOf(`</${m[1]}`, lt + m[0].length);
      if (close === -1) break;
      const gt = lower.indexOf('>', close);
      i = gt === -1 ? html.length : gt + 1;
      continue;
    }
    parts.push('<');
    i = lt + 1;
  }
  return parts.join('');
}

// 按顺序找出指定名称的开始标签：{ name, start, end, attrs }。
// 超过 maxTagLength 的标签跳过（正常标签不会这么长），某个位置之后再也没有 '>' 时直接结束
export function* scanTags(html, names, { maxTagLength = 8192 } = {}) {
  const lower = asciiLower(html);
  const re = new RegExp(`<(${names.join('|')})(?=[\\s/>])`, 'g');
  let m;
  while ((m = re.exec(lower))) {
    const gt = lower.indexOf('>', m.index);
    if (gt === -1) return;
    re.lastIndex = gt + 1;
    if (gt - m.index > maxTagLength) continue;
    yield { name: m[1], start: m.index, end: gt + 1, attrs: parseAttrs(html.slice(m.index, gt + 1)) };
  }
}

const isSpace = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';

// 解析一个开始标签的属性（手写状态机，线性时间）；同名属性以第一个为准，属性名转小写，值已解码 HTML 实体
export function parseAttrs(tag) {
  const attrs = {};
  const n = tag.length;
  let i = 1;
  while (i < n && !isSpace(tag[i]) && tag[i] !== '>' && tag[i] !== '/') i++; // 跳过标签名
  while (i < n) {
    while (i < n && (isSpace(tag[i]) || tag[i] === '/')) i++;
    if (i >= n || tag[i] === '>') break;
    const nameStart = i;
    while (i < n && !isSpace(tag[i]) && tag[i] !== '=' && tag[i] !== '>' && tag[i] !== '/') i++;
    const name = tag.slice(nameStart, i).toLowerCase();
    if (!name) {
      i++;
      continue;
    }
    while (i < n && isSpace(tag[i])) i++;
    let value = '';
    if (tag[i] === '=') {
      i++;
      while (i < n && isSpace(tag[i])) i++;
      const q = tag[i];
      if (q === '"' || q === "'") {
        const close = tag.indexOf(q, i + 1);
        const end = close === -1 ? n : close;
        value = tag.slice(i + 1, end);
        i = end + 1;
      } else {
        const start = i;
        while (i < n && !isSpace(tag[i]) && tag[i] !== '>') i++;
        value = tag.slice(start, i);
      }
    }
    if (!(name in attrs)) attrs[name] = safeDecode(value);
  }
  return attrs;
}

// 去掉标签后的纯文本（解码实体、合并空白）；遇到没有 '>' 的 '<' 时丢弃其后内容
export function textOf(fragment) {
  const parts = [];
  let i = 0;
  while (i < fragment.length) {
    const lt = fragment.indexOf('<', i);
    if (lt === -1) {
      parts.push(fragment.slice(i));
      break;
    }
    parts.push(fragment.slice(i, lt));
    const gt = fragment.indexOf('>', lt);
    if (gt === -1) break;
    i = gt + 1;
  }
  return safeDecode(parts.join('')).replace(/\s+/g, ' ').trim();
}

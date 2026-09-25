import { HttpError, param } from '../../lib/http.js';

// ---------------- 进制转换 ----------------

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const PREFIX = { 2: /^0b/, 8: /^0o/, 16: /^0x/ };

export function parseRadix(text, base) {
  let s = String(text ?? '').trim().toLowerCase().replace(/[\s_]/g, '');
  const neg = s.startsWith('-');
  if (neg || s.startsWith('+')) s = s.slice(1);
  if (PREFIX[base]) s = s.replace(PREFIX[base], '');
  if (!s) throw new HttpError(400, 'value 不能为空');
  const b = BigInt(base);
  let n = 0n;
  for (const ch of s) {
    const d = DIGITS.indexOf(ch);
    if (d < 0 || d >= base) throw new HttpError(400, `“${ch}” 不是 ${base} 进制的合法数字`);
    n = n * b + BigInt(d);
  }
  return neg ? -n : n;
}

export function convertRadix(value, from, to) {
  const n = parseRadix(value, from);
  return {
    input: value,
    from,
    to: to ?? null,
    result: to ? n.toString(to) : null,
    binary: n.toString(2),
    octal: n.toString(8),
    decimal: n.toString(10),
    hex: n.toString(16),
  };
}

// ---------------- Unicode ----------------

const UNICODE_FORMATS = ['u', 'u-brace', 'html-hex', 'html-dec', 'codepoint'];
const hex = (n, w = 4) => n.toString(16).toUpperCase().padStart(w, '0');

function encodeChar(ch, format) {
  const cp = ch.codePointAt(0);
  switch (format) {
    case 'u-brace': return `\\u{${cp.toString(16)}}`;
    case 'html-hex': return `&#x${hex(cp, 1)};`;
    case 'html-dec': return `&#${cp};`;
    case 'codepoint': return `U+${hex(cp)}`;
    default: {
      // 超出 BMP 的字符（如 emoji）用 UTF-16 代理对表示，与 JSON / JavaScript 一致
      let out = '';
      for (let i = 0; i < ch.length; i++) out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, '0')}`;
      return out;
    }
  }
}

const fromCp = (n, raw) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : raw);

export function unicodeConvert(text, action, format = 'u', mode = 'non-ascii') {
  if (action === 'encode') {
    const chars = [...text];
    const parts = chars.map((ch) => (mode === 'non-ascii' && ch.codePointAt(0) < 128 ? ch : encodeChar(ch, format)));
    return { action, format, result: format === 'codepoint' && mode === 'all' ? parts.join(' ') : parts.join(''), chars: chars.length };
  }
  // 解码：自动识别所有写法，可以混在一起；😀 这样的代理对会拼回一个字符
  // 单次扫描替换，避免解出来的字符（如 & → &）被当成下一种写法再解一次
  const result = text.replace(
    /\\u\{([0-9a-fA-F]{1,6})\}|((?:\\u[0-9a-fA-F]{4})+)|&#x([0-9a-fA-F]{1,6});|&#(\d{1,7});|U\+([0-9a-fA-F]{4,6})(?:[ \t]+(?=U\+[0-9a-fA-F]{4}))?/g,
    (m, brace, seq, hx, dec, cp) => {
      if (brace) return fromCp(parseInt(brace, 16), m);
      if (seq) return seq.split('\\u').slice(1).map((h) => String.fromCharCode(parseInt(h, 16))).join('');
      if (hx) return fromCp(parseInt(hx, 16), m);
      if (dec) return fromCp(Number(dec), m);
      return fromCp(parseInt(cp, 16), m);
    },
  );
  return { action, format: 'auto', result, chars: [...result].length };
}

// ---------------- 经典密码 ----------------

const MORSE = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---',
  K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-',
  U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--', '/': '-..-.', '(': '-.--.', ')': '-.--.-',
  '&': '.-...', ':': '---...', ';': '-.-.-.', '=': '-...-', '+': '.-.-.', '-': '-....-', _: '..--.-', '"': '.-..-.', '@': '.--.-.',
};
const MORSE_REV = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));

const morseEncode = (t) => t.trim().toUpperCase().split(/\s+/).filter(Boolean)
  .map((w) => [...w].map((c) => MORSE[c] ?? '?').join(' ')).join(' / ');
const morseDecode = (t) => t.replace(/[·•]/g, '.').replace(/[_—–]/g, '-').trim().split(/\s*\/\s*|\s{3,}/)
  .map((w) => w.split(/\s+/).filter(Boolean).map((s) => MORSE_REV[s] ?? '?').join('')).join(' ').trim();

const BACON = Object.fromEntries([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((c, i) => [c, i.toString(2).padStart(5, '0').replace(/0/g, 'A').replace(/1/g, 'B')]));
const BACON_REV = Object.fromEntries(Object.entries(BACON).map(([k, v]) => [v, k]));
const baconEncode = (t) => [...t.toUpperCase()].filter((c) => BACON[c]).map((c) => BACON[c]).join(' ');
function baconDecode(t) {
  const bits = t.toUpperCase().replace(/[^AB]/g, '');
  if (!bits.length || bits.length % 5) throw new HttpError(400, '培根密码解码：A/B 字符总数须为 5 的倍数');
  return bits.match(/.{5}/g).map((g) => BACON_REV[g] ?? '?').join('');
}

const shiftLetters = (t, s) => t.replace(/[a-z]/gi, (c) => {
  const base = c <= 'Z' ? 65 : 97;
  return String.fromCharCode((((c.charCodeAt(0) - base + s) % 26) + 26) % 26 + base);
});
const atbash = (t) => t.replace(/[a-z]/gi, (c) => {
  const base = c <= 'Z' ? 65 : 97;
  return String.fromCharCode(base + 25 - (c.charCodeAt(0) - base));
});
const rot47 = (t) => t.replace(/[!-~]/g, (c) => String.fromCharCode(33 + ((c.charCodeAt(0) - 33 + 47) % 94)));

function vigenere(t, keyword, sign) {
  const k = String(keyword ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!k) throw new HttpError(400, '维吉尼亚密码需要 keyword 参数（英文字母）');
  let i = 0;
  return t.replace(/[a-z]/gi, (c) => shiftLetters(c, sign * (k.charCodeAt(i++ % k.length) - 65)));
}

// 栅栏密码（W 型 / Z 字形）：按之字形依次写到 rails 行，再逐行读出
function railPattern(len, rails) {
  const rows = [];
  const cycle = 2 * (rails - 1);
  for (let i = 0; i < len; i++) {
    const p = i % cycle;
    rows.push(p < rails ? p : cycle - p);
  }
  return rows;
}
function railEncode(t, rails) {
  const chars = [...t];
  if (rails < 2 || rails >= chars.length) return t;
  const rows = railPattern(chars.length, rails);
  return Array.from({ length: rails }, (_, r) => chars.filter((_, i) => rows[i] === r).join('')).join('');
}
function railDecode(t, rails) {
  const chars = [...t];
  if (rails < 2 || rails >= chars.length) return t;
  const rows = railPattern(chars.length, rails);
  const order = rows.map((r, i) => [r, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  order.forEach(([, i], k) => { out[i] = chars[k]; });
  return out.join('');
}

export const CIPHERS = {
  caesar: { name: '凯撒密码', encode: (t, o) => shiftLetters(t, o.shift), decode: (t, o) => shiftLetters(t, -o.shift) },
  rot13: { name: 'ROT13', encode: (t) => shiftLetters(t, 13), decode: (t) => shiftLetters(t, 13) },
  rot47: { name: 'ROT47', encode: rot47, decode: rot47 },
  atbash: { name: '埃特巴什码', encode: atbash, decode: atbash },
  vigenere: { name: '维吉尼亚密码', encode: (t, o) => vigenere(t, o.keyword, 1), decode: (t, o) => vigenere(t, o.keyword, -1) },
  railfence: { name: '栅栏密码', encode: (t, o) => railEncode(t, o.rails), decode: (t, o) => railDecode(t, o.rails) },
  morse: { name: '摩斯电码', encode: morseEncode, decode: morseDecode },
  bacon: { name: '培根密码', encode: baconEncode, decode: baconDecode },
};

export function runCipher(method, action, text, opts = {}) {
  const m = CIPHERS[method];
  const o = { shift: 3, rails: 2, ...opts };
  return { method, methodName: m.name, action, result: m[action](text, o) };
}

export default {
  name: 'codec',
  category: 'tools',
  title: '进制 / Unicode / 经典密码',
  description: '任意进制（2~36）大数转换，Unicode 转义编解码，凯撒、ROT13、维吉尼亚、栅栏、摩斯电码等经典密码',
  source: '本地计算',
  routes: [
    {
      method: 'GET',
      path: '/api/tools/radix',
      summary: '进制转换（2~36 进制，支持任意长度的大整数和负数）',
      params: [
        { name: 'value', required: true, desc: '要转换的整数，最多 1000 个字符；可带 - 号，空格和下划线会被忽略；from 为 2 / 8 / 16 时可带 0b / 0o / 0x 前缀；字母不区分大小写', example: 'ff' },
        { name: 'from', default: '10', desc: '原始进制（2~36）', example: '16' },
        { name: 'to', required: false, desc: '目标进制（2~36）；不传时 result 为 null，只返回 2 / 8 / 10 / 16 进制', example: '36' },
      ],
      fields: [
        { name: 'input', type: 'string', desc: '请求参数 value 的原文' },
        { name: 'from', type: 'number', desc: '原始进制' },
        { name: 'to', type: 'number|null', desc: '目标进制；没传 to 时为 null' },
        { name: 'result', type: 'string|null', desc: '转换为目标进制的结果（小写字母，负数带 - 号，不带前缀）；没传 to 时为 null' },
        { name: 'binary', type: 'string', desc: '二进制结果（不带 0b 前缀）' },
        { name: 'octal', type: 'string', desc: '八进制结果（不带 0o 前缀）' },
        { name: 'decimal', type: 'string', desc: '十进制结果（字符串，大数不丢精度）' },
        { name: 'hex', type: 'string', desc: '十六进制结果（小写，不带 0x 前缀）' },
      ],
      async handler({ query }) {
        const value = param(query, 'value', { required: true, max: 1000 });
        const from = param(query, 'from', { default: 10, int: true, min: 2, max: 36 });
        const to = param(query, 'to', { int: true, min: 2, max: 36 });
        return { data: convertRadix(value, from, to) };
      },
    },
    {
      method: 'GET',
      path: '/api/tools/unicode',
      summary: 'Unicode 转义编解码：\\uXXXX、\\u{XXXX}、&#xXXXX;、&#DDDD;、U+XXXX',
      params: [
        { name: 'text', required: true, desc: '编码时为原文；解码时为含转义序列的文本（几种写法可以混用），最多 10000 个字符', example: '你好😀' },
        { name: 'action', default: 'encode', desc: 'encode 编码 / decode 解码', example: 'encode' },
        { name: 'format', default: 'u', desc: '编码格式（仅 encode）：u 为 \\uXXXX（超出 BMP 的字符写成 UTF-16 代理对，与 JSON 一致）；u-brace 为 \\u{XXXX}（ES6）；html-hex 为 &#xXXXX;；html-dec 为 &#DDDD;；codepoint 为 U+XXXX', example: 'html-hex' },
        { name: 'mode', default: 'non-ascii', desc: '编码范围（仅 encode）：non-ascii 只转非 ASCII 字符；all 全部转换', example: 'all' },
      ],
      fields: [
        { name: 'action', type: 'string', desc: '执行的操作：encode 或 decode' },
        { name: 'format', type: 'string', desc: '使用的编码格式：u / u-brace / html-hex / html-dec / codepoint；decode 时固定为 auto（自动识别全部写法）' },
        { name: 'result', type: 'string', desc: '转换结果。encode 且 format=codepoint、mode=all 时各码点用空格分隔；decode 时超出 Unicode 范围的序列保留原文' },
        { name: 'chars', type: 'number', desc: '字符数（按 Unicode 码点计，emoji 算 1 个）：encode 时为原文的字符数，decode 时为结果的字符数' },
      ],
      async handler({ query }) {
        const text = param(query, 'text', { required: true, max: 10_000 });
        const action = param(query, 'action', { default: 'encode', oneOf: ['encode', 'decode'] });
        const format = param(query, 'format', { default: 'u', oneOf: UNICODE_FORMATS });
        const mode = param(query, 'mode', { default: 'non-ascii', oneOf: ['non-ascii', 'all'] });
        return { data: unicodeConvert(text, action, format, mode) };
      },
    },
    {
      method: 'GET',
      path: '/api/tools/cipher',
      summary: '经典密码编解码：凯撒、ROT13、ROT47、埃特巴什、维吉尼亚、栅栏、摩斯电码、培根',
      params: [
        { name: 'text', required: true, desc: '要处理的文本，最多 5000 个字符', example: 'Hello World' },
        { name: 'method', default: 'caesar', desc: `方式：${Object.entries(CIPHERS).map(([k, v]) => `${k} ${v.name}`).join('、')}`, example: 'morse' },
        { name: 'action', default: 'encode', desc: 'encode 加密（编码）/ decode 解密（解码）', example: 'encode' },
        { name: 'shift', default: '3', desc: '位移量（-25~25），仅 caesar 使用', example: '5' },
        { name: 'keyword', required: false, desc: '密钥单词（只取其中的英文字母），vigenere 必填', example: 'LEMON' },
        { name: 'rails', default: '2', desc: '栏数（2~20），仅 railfence 使用', example: '3' },
      ],
      fields: [
        { name: 'method', type: 'string', desc: '使用的方式，与请求参数 method 相同' },
        { name: 'methodName', type: 'string', desc: '方式的中文名，如 凯撒密码、摩斯电码' },
        { name: 'action', type: 'string', desc: '执行的操作：encode 或 decode' },
        {
          name: 'result',
          type: 'string',
          desc: '转换结果。凯撒 / ROT13 / 埃特巴什 / 维吉尼亚只变换英文字母（保留大小写），其他字符原样保留（维吉尼亚遇到非字母时不消耗密钥）；'
            + 'ROT47 变换全部可见 ASCII 字符；栅栏密码按之字形排列所有字符（含空格）；'
            + '摩斯电码字母之间用空格、单词之间用 / 分隔，无法表示的字符编码为 ?；培根密码只处理英文字母，每个字母 5 位 A/B 用空格分隔',
        },
      ],
      async handler({ query }) {
        const text = param(query, 'text', { required: true, max: 5000 });
        const method = param(query, 'method', { default: 'caesar', oneOf: Object.keys(CIPHERS) });
        const action = param(query, 'action', { default: 'encode', oneOf: ['encode', 'decode'] });
        const shift = param(query, 'shift', { default: 3, int: true, min: -25, max: 25 });
        const keyword = param(query, 'keyword', { max: 100 });
        const rails = param(query, 'rails', { default: 2, int: true, min: 2, max: 20 });
        return { data: runCipher(method, action, text, { shift, keyword, rails }) };
      },
    },
  ],
};

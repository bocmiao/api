import { deflateSync } from 'node:zlib';
import { HttpError, param } from '../../lib/http.js';
import { crc32 } from './qrcode.js';

// ---------- Code 128（ISO/IEC 15417） ----------

// 符号 0~105 的条空宽度（条、空交替，从条开始，每个符号共 11 个模块），106 为终止符（13 个模块）
export const CODE128_PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
const START_B = 104;
const START_C = 105;
const CODE_B = 100; // 在 C 字符集中切换到 B
const CODE_C = 99; // 在 B 字符集中切换到 C
const STOP = 106;

const digitRun = (s, i) => {
  let n = 0;
  while (i + n < s.length && s.charCodeAt(i + n) >= 48 && s.charCodeAt(i + n) <= 57) n++;
  return n;
};

// 自动选择字符集：连续数字较多时用 C（两位一个符号），其余用 B（ASCII 32~126）。
// 返回 { codes（含起始符与校验符，不含终止符）, checksum }
export function encodeCode128(text) {
  const s = String(text ?? '');
  if (!s.length) throw new HttpError(400, 'text 不能为空');
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 32 || c > 126) throw new HttpError(400, `Code 128 只支持 ASCII 可打印字符（空格到 ~），不支持「${ch}」`);
  }
  const codes = [];
  let i = 0;
  const first = digitRun(s, 0);
  let set = first >= 4 || (first === 2 && s.length === 2) ? 'C' : 'B';
  codes.push(set === 'C' ? START_C : START_B);
  while (i < s.length) {
    if (set === 'C') {
      if (digitRun(s, i) >= 2) {
        codes.push(Number(s.slice(i, i + 2)));
        i += 2;
        continue;
      }
      codes.push(CODE_B);
      set = 'B';
      continue;
    }
    // B：后面还有 ≥6 位连续数字，或 ≥4 位且一直到结尾，切到 C 更短；奇数位时先用 B 编一位
    const run = digitRun(s, i);
    if (run >= 6 || (run >= 4 && i + run === s.length)) {
      if (run % 2) { codes.push(s.charCodeAt(i) - 32); i++; }
      codes.push(CODE_C);
      set = 'C';
      continue;
    }
    codes.push(s.charCodeAt(i) - 32);
    i++;
  }
  const checksum = codes.reduce((sum, v, k) => sum + v * (k || 1), 0) % 103;
  codes.push(checksum);
  return { codes, checksum };
}

// 条空宽度串 → 模块数组（1 为条）
const widthsToModules = (widths, out = []) => {
  [...widths].forEach((w, k) => { for (let n = 0; n < Number(w); n++) out.push(k % 2 ? 0 : 1); });
  return out;
};

export function code128Modules(text) {
  const { codes } = encodeCode128(text);
  const modules = [];
  for (const c of [...codes, STOP]) widthsToModules(CODE128_PATTERNS[c], modules);
  return modules;
}

// ---------- EAN-13 / EAN-8 ----------

const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_R = EAN_L.map((p) => [...p].map((b) => (b === '1' ? '0' : '1')).join(''));
const EAN_G = EAN_R.map((p) => [...p].reverse().join(''));
// EAN-13 首位数字决定左侧 6 位用 L 还是 G 编码
const EAN13_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

// 校验位：从右往左（不含校验位），奇数位 ×3、偶数位 ×1，求和后补足到 10 的倍数
export function eanCheckDigit(digits) {
  let sum = 0;
  [...digits].reverse().forEach((d, k) => { sum += Number(d) * (k % 2 ? 1 : 3); });
  return (10 - (sum % 10)) % 10;
}

// 补全或校验 EAN 码，返回完整数字串
export function normalizeEan(text, length) {
  const s = String(text ?? '').trim();
  const name = length === 13 ? 'EAN-13' : 'EAN-8';
  if (!/^\d+$/.test(s) || (s.length !== length && s.length !== length - 1)) {
    throw new HttpError(400, `${name} 须为 ${length - 1} 位数字（自动补校验位）或 ${length} 位数字（含校验位）`);
  }
  const body = s.slice(0, length - 1);
  const check = eanCheckDigit(body);
  if (s.length === length && Number(s[length - 1]) !== check) {
    throw new HttpError(400, `${name} 校验位错误：${body} 的校验位应为 ${check}，实际为 ${s[length - 1]}`);
  }
  return body + check;
}

// 返回 { modules, guards }：guards 为护线（起始、中间、终止）所在的模块下标，用于把护线画长
export function eanModules(code) {
  let bits = '';
  const guards = new Set();
  const guard = (g) => { for (let k = 0; k < g.length; k++) guards.add(bits.length + k); bits += g; };
  if (code.length === 13) {
    const parity = EAN13_PARITY[Number(code[0])];
    guard('101');
    for (let k = 0; k < 6; k++) bits += (parity[k] === 'L' ? EAN_L : EAN_G)[Number(code[k + 1])];
    guard('01010');
    for (let k = 7; k < 13; k++) bits += EAN_R[Number(code[k])];
    guard('101');
  } else {
    guard('101');
    for (let k = 0; k < 4; k++) bits += EAN_L[Number(code[k])];
    guard('01010');
    for (let k = 4; k < 8; k++) bits += EAN_R[Number(code[k])];
    guard('101');
  }
  return { modules: [...bits].map(Number), guards };
}

export const TYPES = ['code128', 'ean13', 'ean8'];

// 统一入口：返回 { type, text（人读文本）, modules, guards }
export function encodeBarcode(text, type = 'code128') {
  if (type === 'code128') return { type, text: String(text), modules: code128Modules(text), guards: new Set() };
  if (type === 'ean13' || type === 'ean8') {
    const code = normalizeEan(text, type === 'ean13' ? 13 : 8);
    return { type, text: code, ...eanModules(code) };
  }
  throw new HttpError(400, `type 只能是 ${TYPES.join(' / ')}`);
}

// ---------- 输出 ----------

const escapeXml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// 版面：条高 height 像素，模块宽 scale 像素，左右各留 margin 个模块，上下各留 margin 个模块（最多 10 个模块）
function layout(code, { scale, height, margin, showText }) {
  const vpad = Math.min(margin, 10) * scale;
  const fontSize = Math.max(10, Math.round(scale * 7));
  const textH = showText ? Math.round(fontSize * 1.2) : 0;
  const width = (code.modules.length + margin * 2) * scale;
  return { vpad, fontSize, textH, width, total: vpad * 2 + height + textH };
}

export function toBarcodeSVG(code, { scale = 2, height = 80, margin = 10, showText = true } = {}) {
  const { vpad, fontSize, textH, width, total } = layout(code, { scale, height, margin, showText });
  const isEan = code.type !== 'code128';
  const guardExtra = showText && isEan ? Math.round(fontSize / 2) : 0;
  let rects = '';
  const m = code.modules;
  for (let x = 0; x < m.length;) {
    if (!m[x]) { x++; continue; }
    const start = x;
    while (x < m.length && m[x] && code.guards.has(x) === code.guards.has(start)) x++;
    const h = height + (code.guards.has(start) ? guardExtra : 0);
    rects += `<rect x="${(start + margin) * scale}" y="${vpad}" width="${(x - start) * scale}" height="${h}"/>`;
  }
  let text = '';
  if (showText) {
    const y = vpad + height + textH - Math.round(fontSize * 0.2);
    const t = (s, cx, anchor = 'middle') => `<text x="${cx}" y="${y}" text-anchor="${anchor}">${escapeXml(s)}</text>`;
    const at = (module) => (module + margin) * scale;
    if (code.type === 'ean13') {
      text = t(code.text[0], at(-1), 'end') + t(code.text.slice(1, 7), at(3 + 21)) + t(code.text.slice(7), at(50 + 21));
    } else if (code.type === 'ean8') {
      text = t(code.text.slice(0, 4), at(3 + 14)) + t(code.text.slice(4), at(3 + 28 + 5 + 14));
    } else {
      text = t(code.text, width / 2);
    }
    text = `<g font-family="monospace" font-size="${fontSize}" fill="#000000">${text}</g>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${total}" viewBox="0 0 ${width} ${total}" shape-rendering="crispEdges">`
    + `<rect width="100%" height="100%" fill="#ffffff"/><g fill="#000000">${rects}</g>${text}</svg>`;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// 1 位灰度 PNG；PNG 不绘制文字（服务端没有字体），需要人读文本请用 SVG
export function toBarcodePNG(code, { scale = 2, height = 80, margin = 10 } = {}) {
  const { vpad, width, total } = layout(code, { scale, height, margin, showText: false });
  const rowBytes = Math.ceil(width / 8);
  const barRow = Buffer.alloc(rowBytes + 1);
  const blankRow = Buffer.alloc(rowBytes + 1, 0xff);
  blankRow[0] = 0;
  for (let px = 0; px < width; px++) {
    const mx = Math.floor(px / scale) - margin;
    if (!(mx >= 0 && mx < code.modules.length && code.modules[mx])) barRow[1 + (px >> 3)] |= 0x80 >> (px & 7);
  }
  const rows = [];
  for (let y = 0; y < total; y++) rows.push(y >= vpad && y < vpad + height ? barRow : blankRow);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(total, 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export const MAX_TEXT = 80;

export default {
  name: 'barcode',
  category: 'tools',
  title: '条形码生成',
  description: '生成一维条形码图片，支持 Code 128（自动切换 B/C 字符集）、EAN-13、EAN-8（自动计算或校验校验位），输出 SVG / PNG',
  source: '本地生成',
  routes: [
    {
      method: 'GET',
      path: '/api/barcode',
      summary: '生成条形码图片（直接返回 SVG 或 PNG）',
      raw: true,
      returns: '直接返回图片，不是 JSON。format=svg（默认）时 Content-Type 为 image/svg+xml; charset=utf-8，响应体是 SVG 文本，'
        + '每根条是一个 <rect>，showText=true 时条下方有人读文本（EAN 按标准分组排列、护线加长）；format=png 时 Content-Type 为 image/png，'
        + '响应体是 1 位黑白 PNG（不含文字）。图片宽 =（模块数 + 2×margin）× scale 像素，高 = 条高 height + 上下各 min(margin,10)×scale 像素（+ SVG 文字行高）。'
        + 'EAN 传 12/7 位时自动补校验位，传 13/8 位时校验，不对返回 400。响应头带 Cache-Control: private, max-age=86400。'
        + '缺少 text、字符不支持或参数不合法时返回 HTTP 400 和 JSON 错误 { code, message, data: null }。',
      params: [
        { name: 'text', required: true, desc: `条码内容，最多 ${MAX_TEXT} 个字符。code128 支持 ASCII 可打印字符；ean13 为 12 或 13 位数字；ean8 为 7 或 8 位数字`, example: '6901234567892' },
        { name: 'type', default: 'code128', desc: '码制：code128 / ean13 / ean8', example: 'ean13' },
        { name: 'format', default: 'svg', desc: '输出格式 svg / png（PNG 不含文字）', example: 'svg' },
        { name: 'height', default: '80', desc: '条高（像素，20~400）', example: '80' },
        { name: 'scale', default: '2', desc: '单个模块（最窄条）的宽度（像素，1~10）', example: '2' },
        { name: 'margin', default: '10', desc: '左右静区宽度（模块数，0~40）；EAN 标准建议不少于 9~11 个模块', example: '10' },
        { name: 'showText', default: 'true', desc: '是否在条码下方显示人读文本（仅 SVG）：true / false', example: 'true' },
      ],
      async handler({ query }) {
        const text = param(query, 'text', { required: true, max: MAX_TEXT });
        const type = param(query, 'type', { default: 'code128', oneOf: TYPES });
        const format = param(query, 'format', { default: 'svg', oneOf: ['svg', 'png'] });
        const height = param(query, 'height', { default: 80, int: true, min: 20, max: 400 });
        const scale = param(query, 'scale', { default: 2, int: true, min: 1, max: 10 });
        const margin = param(query, 'margin', { default: 10, int: true, min: 0, max: 40 });
        const showText = param(query, 'showText', { default: 'true', oneOf: ['true', 'false', '1', '0'] });
        const code = encodeBarcode(text, type);
        const headers = { 'cache-control': 'private, max-age=86400' };
        if (format === 'png') {
          return { status: 200, headers: { ...headers, 'content-type': 'image/png' }, body: toBarcodePNG(code, { scale, height, margin }) };
        }
        const svg = toBarcodeSVG(code, { scale, height, margin, showText: showText === 'true' || showText === '1' });
        return { status: 200, headers: { ...headers, 'content-type': 'image/svg+xml; charset=utf-8' }, body: svg };
      },
    },
  ],
};

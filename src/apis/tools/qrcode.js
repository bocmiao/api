import { deflateSync } from 'node:zlib';
import { HttpError, param } from '../../lib/http.js';

// ---------- QR 编码器（字节模式，ISO/IEC 18004） ----------

const ECL = { L: 0, M: 1, Q: 2, H: 3 };
const ECL_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

// 下标 [ecl][version]
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

// GF(2^8)，本原多项式 x^8+x^4+x^3+x^2+1 (0x11D)
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

// 生成多项式 (x-α^0)(x-α^1)...(x-α^(n-1))，高次系数在前，省略首项 1
export function rsGenerator(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

export function rsEncode(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i], factor);
  }
  return rem;
}

function numRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

export function numDataCodewords(ver, ecc) {
  const e = ECL[ecc];
  return Math.floor(numRawDataModules(ver) / 8) - ECC_PER_BLOCK[e][ver] * NUM_BLOCKS[e][ver];
}

export function alignmentPositions(ver) {
  if (ver === 1) return [];
  const size = ver * 4 + 17;
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// 15 位格式信息（已异或 0x5412），bit14 为最高位
export function formatBits(ecc, mask) {
  const data = (ECL_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

// 18 位版本信息（版本 7 起）
export function versionBits(ver) {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}

const charCountBits = (ver) => (ver <= 9 ? 8 : 16);

export function pickVersion(byteLen, ecc) {
  for (let ver = 1; ver <= 40; ver++) {
    if (4 + charCountBits(ver) + byteLen * 8 <= numDataCodewords(ver, ecc) * 8) return ver;
  }
  return -1;
}

// 生成数据码字（模式指示 + 字符计数 + 数据 + 终止符 + 填充）
export function encodeData(bytes, ver, ecc) {
  const capBits = numDataCodewords(ver, ecc) * 8;
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, charCountBits(ver));
  for (const b of bytes) push(b, 8);
  if (bits.length > capBits) throw new Error('data too long');
  push(0, Math.min(4, capBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    out.push(b);
  }
  for (let pad = 0xec; out.length < capBits / 8; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

// 分块、计算纠错码并交错
export function addEccAndInterleave(data, ver, ecc) {
  const e = ECL[ecc];
  const numBlocks = NUM_BLOCKS[e][ver];
  const eccLen = ECC_PER_BLOCK[e][ver];
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
  const numShort = numBlocks - (rawCodewords % numBlocks);
  const shortLen = Math.floor(rawCodewords / numBlocks);

  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ec = rsEncode(dat, eccLen);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ec));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) result.push(block[i]);
    });
  }
  return result;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Matrix {
  constructor(ver) {
    this.size = ver * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Uint8Array(this.size));
    this.isFunction = Array.from({ length: this.size }, () => new Uint8Array(this.size));
  }

  setFn(x, y, dark) {
    this.modules[y][x] = dark ? 1 : 0;
    this.isFunction[y][x] = 1;
  }
}

function drawFunctionPatterns(m, ver) {
  const n = m.size;
  for (let i = 0; i < n; i++) {
    m.setFn(6, i, i % 2 === 0);
    m.setFn(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < n && y >= 0 && y < n) m.setFn(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const pos = alignmentPositions(ver);
  const last = pos.length - 1;
  for (let i = 0; i <= last; i++) {
    for (let j = 0; j <= last; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) m.setFn(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  drawFormat(m, 'L', 0);
  if (ver >= 7) {
    const bits = versionBits(ver);
    for (let i = 0; i < 18; i++) {
      const bit = (bits >>> i) & 1;
      const a = n - 11 + (i % 3);
      const b = Math.floor(i / 3);
      m.setFn(a, b, bit);
      m.setFn(b, a, bit);
    }
  }
}

function drawFormat(m, ecc, mask) {
  const n = m.size;
  const bits = formatBits(ecc, mask);
  const bit = (i) => (bits >>> i) & 1;
  for (let i = 0; i <= 5; i++) m.setFn(8, i, bit(i));
  m.setFn(8, 7, bit(6));
  m.setFn(8, 8, bit(7));
  m.setFn(7, 8, bit(8));
  for (let i = 9; i < 15; i++) m.setFn(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) m.setFn(n - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) m.setFn(8, n - 15 + i, bit(i));
  m.setFn(8, n - 8, 1);
}

function drawCodewords(m, codewords) {
  const n = m.size;
  let i = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = upward ? n - 1 - vert : vert;
        if (!m.isFunction[y][x] && i < codewords.length * 8) {
          m.modules[y][x] = (codewords[i >>> 3] >>> (7 - (i & 7))) & 1;
          i++;
        }
      }
    }
  }
}

function applyMask(m, mask) {
  const fn = MASKS[mask];
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.isFunction[y][x] && fn(x, y)) m.modules[y][x] ^= 1;
    }
  }
}

// 罚分规则 N1~N4；N3 把静区视为浅色
export function penalty(modules) {
  const n = modules.length;
  let score = 0;
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(modules[i]);
    lines.push(Array.from({ length: n }, (_, k) => modules[k][i]));
  }
  for (const line of lines) {
    let run = 1;
    for (let k = 1; k <= n; k++) {
      if (k < n && line[k] === line[k - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    const padded = [0, 0, 0, 0, ...line, 0, 0, 0, 0];
    for (let k = 0; k + 11 <= padded.length; k++) {
      let v = 0;
      for (let t = 0; t < 11; t++) v = (v << 1) | padded[k + t];
      if (v === 0x5d0 || v === 0x05d) score += 40;
    }
  }
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
    }
  }
  let dark = 0;
  for (const row of modules) for (const c of row) dark += c;
  const total = n * n;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  score += Math.max(0, k) * 10;
  return score;
}

// 返回 { version, ecc, mask, size, modules }，modules[y][x] 为 1 表示深色
export function encodeQR(input, { ecc = 'M', mask = -1, version } = {}) {
  if (!(ecc in ECL)) throw new Error('bad ecc');
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  const ver = version ?? pickVersion(bytes.length, ecc);
  if (ver < 1) throw new Error('data too long');
  const codewords = addEccAndInterleave(encodeData(bytes, ver, ecc), ver, ecc);
  const m = new Matrix(ver);
  drawFunctionPatterns(m, ver);
  drawCodewords(m, codewords);

  let best = mask;
  if (best < 0) {
    let minScore = Infinity;
    for (let k = 0; k < 8; k++) {
      applyMask(m, k);
      drawFormat(m, ecc, k);
      const s = penalty(m.modules);
      if (s < minScore) { minScore = s; best = k; }
      applyMask(m, k);
    }
  }
  applyMask(m, best);
  drawFormat(m, ecc, best);
  return { version: ver, ecc, mask: best, size: m.size, modules: m.modules.map((r) => Array.from(r)) };
}

// ---------- 输出 ----------

export function toSVG(qr, { scale = 10, margin = 4, fg = '#000000', bg = '#ffffff' } = {}) {
  const dim = qr.size + margin * 2;
  let path = '';
  qr.modules.forEach((row, y) => {
    let x = 0;
    while (x < qr.size) {
      if (!row[x]) { x++; continue; }
      const start = x;
      while (x < qr.size && row[x]) x++;
      path += `M${start + margin} ${y + margin}h${x - start}v1h${start - x}z`;
    }
  });
  const px = dim * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">`
    + `<rect width="100%" height="100%" fill="${bg}"/><path fill="${fg}" d="${path}"/></svg>`;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// 1 位灰度 PNG
export function toPNG(qr, { scale = 10, margin = 4 } = {}) {
  const dim = (qr.size + margin * 2) * scale;
  const rowBytes = Math.ceil(dim / 8);
  const raw = Buffer.alloc((rowBytes + 1) * dim);
  for (let py = 0; py < dim; py++) {
    const off = py * (rowBytes + 1);
    raw[off] = 0;
    const my = Math.floor(py / scale) - margin;
    for (let px = 0; px < dim; px++) {
      const mx = Math.floor(px / scale) - margin;
      const dark = my >= 0 && my < qr.size && mx >= 0 && mx < qr.size && qr.modules[my][mx];
      if (!dark) raw[off + 1 + (px >> 3)] |= 0x80 >> (px & 7);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(dim, 0);
  ihdr.writeUInt32BE(dim, 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const MAX_TEXT = 1000;

export default {
  name: 'qrcode',
  category: 'tools',
  title: '二维码生成',
  description: '把文本或网址生成二维码图片，支持 SVG / PNG、纠错等级与边距',
  source: '本地生成',
  routes: [
    {
      method: 'GET',
      path: '/api/qrcode',
      summary: '生成二维码图片（直接返回 SVG 或 PNG）',
      raw: true,
      returns: '直接返回图片，不是 JSON。format=svg（默认）时 Content-Type 为 image/svg+xml; charset=utf-8，响应体是 SVG 文本'
        + '（width/height 为像素边长，viewBox 以模块为单位，可无损缩放）；format=png 时 Content-Type 为 image/png，响应体是 1 位黑白 PNG 二进制。'
        + '图片为白底黑码的正方形，四周留 margin 个模块宽的空白；实际边长 =（模块数 + 2×margin）× floor(size ÷（模块数 + 2×margin)) 像素，'
        + '通常略小于或等于 size；内容很长、模块数 + 2×margin 超过 size 时按每模块 1 像素输出，边长会大于 size。'
        + '响应头带 Cache-Control: public, max-age=86400。缺少 text、参数不合法或内容过长时返回 HTTP 400 和 JSON 错误 { code, message, data: null }。',
      params: [
        { name: 'text', required: true, desc: `二维码内容，最多 ${MAX_TEXT} 个字符`, example: 'https://example.com' },
        { name: 'size', default: '300', desc: '图片边长（像素，64~1024，按模块取整）', example: '300' },
        { name: 'margin', default: '4', desc: '静区宽度（模块数，0~10）', example: '4' },
        { name: 'format', default: 'svg', desc: '输出格式 svg / png', example: 'png' },
        { name: 'ecc', default: 'M', desc: '纠错等级 L / M / Q / H', example: 'M' },
      ],
      async handler({ query }) {
        const text = param(query, 'text', { required: true, max: MAX_TEXT });
        const size = param(query, 'size', { default: 300, int: true, min: 64, max: 1024 });
        const margin = param(query, 'margin', { default: 4, int: true, min: 0, max: 10 });
        const format = param(query, 'format', { default: 'svg', oneOf: ['svg', 'png'] });
        const ecc = param(query, 'ecc', { default: 'M', oneOf: ['L', 'M', 'Q', 'H'] });

        let qr;
        try {
          qr = encodeQR(text, { ecc });
        } catch {
          throw new HttpError(400, '内容过长，无法生成二维码（可降低纠错等级）');
        }
        const scale = Math.max(1, Math.floor(size / (qr.size + margin * 2)));
        const headers = { 'cache-control': 'public, max-age=86400' };
        if (format === 'png') {
          return { status: 200, headers: { ...headers, 'content-type': 'image/png' }, body: toPNG(qr, { scale, margin }) };
        }
        return { status: 200, headers: { ...headers, 'content-type': 'image/svg+xml; charset=utf-8' }, body: toSVG(qr, { scale, margin }) };
      },
    },
  ],
};

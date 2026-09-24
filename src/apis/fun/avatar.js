import { HttpError, param } from '../../lib/http.js';
import { sha256, seededRandom, randomSeed } from './seeded.js';

export const AVATAR_STYLES = ['identicon', 'initials', 'pixel'];
const HEX6 = /^#?([0-9a-fA-F]{6})$/;
const FONT = "system-ui, -apple-system, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif";

export const escapeXml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// 严格校验 6 位 hex 色值，返回 #RRGGBB；不合法抛 400。颜色只经过这里才会进入 SVG
export function parseHexColor(raw) {
  const m = HEX6.exec(String(raw ?? ''));
  if (!m) throw new HttpError(400, 'bg 须为 6 位十六进制色值，如 ff8800 或 #ff8800');
  return `#${m[1].toUpperCase()}`;
}

export function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

// 由种子哈希得到主色：色相 0~359，饱和度 50~69%，亮度 42~57%
export function seedColor(seed) {
  const b = sha256(`avatar-color|${seed}`);
  return hslToHex(b.readUInt16BE(0) % 360, 50 + (b[2] % 20), 42 + (b[3] % 16));
}

// 深色背景用白字，浅色背景用深色字（按相对亮度判断）
export function textColorOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#333333' : '#FFFFFF';
}

// 取种子的第一个字（按字素切分，支持中文和 emoji）；去掉 XML 不允许的字符、控制符与格式符
export function initialOf(seed) {
  const clean = String(seed ?? '')
    .replace(/[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu, '')
    .trim();
  const first = new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(clean)[Symbol.iterator]().next().value?.segment;
  return first ? first.toLocaleUpperCase('en-US') : '?';
}

const svg = (size, view, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${view} ${view}" shape-rendering="crispEdges">${body}</svg>`;
const cell = (x, y, color, w = 1) => `<rect x="${x}" y="${y}" width="${w}" height="${w}" fill="${color}"/>`;

// GitHub 风格：5×5 格子左右对称，左 3 列由哈希位决定，四周留半格空白
export function identicon(seed, size, bg) {
  const b = sha256(`avatar-identicon|${seed}`);
  const color = seedColor(seed);
  const on = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 3; col++) if (b[4 + row * 3 + col] % 2 === 0) on.push([row, col]);
  }
  if (!on.length) on.push([2, 2]);
  const cells = [];
  for (const [row, col] of on) {
    for (const c of new Set([col, 4 - col])) cells.push(cell(1 + c * 2, 1 + row * 2, color, 2));
  }
  return svg(size, 12, `<rect width="12" height="12" fill="${bg ?? '#F0F0F0'}"/>${cells.join('')}`);
}

// 首字头像：哈希色背景（或指定 bg）+ 居中的第一个字
export function initials(seed, size, bg) {
  const fill = bg ?? seedColor(seed);
  const text = escapeXml(initialOf(seed));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">`
    + `<rect width="100" height="100" fill="${fill}"/>`
    + `<text x="50" y="50" dy="0.35em" text-anchor="middle" font-family="${FONT}" font-size="46" font-weight="600" fill="${textColorOn(fill)}">${text}</text>`
    + '</svg>';
}

// 8×8 像素小怪物：左右对称的身体、一对眼睛，偶尔带嘴巴，四周留 1 格空白
export function pixelMonster(seed, size, bg) {
  const r = seededRandom(`avatar-pixel|${seed}`);
  const hue = Math.floor(r() * 360);
  const body = hslToHex(hue, 55 + Math.floor(r() * 20), 50 + Math.floor(r() * 8));
  const dark = hslToHex(hue, 45, 25);
  const back = bg ?? hslToHex(hue, 40, 94);
  const grid = Array.from({ length: 8 }, () => Array(4).fill(false));
  // 越靠中间、越靠身体中部，填充概率越高
  const colP = [0.3, 0.55, 0.8, 0.95];
  const rowP = [0.35, 0.7, 0.95, 0.95, 0.9, 0.85, 0.6, 0.45];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 4; x++) grid[y][x] = r() < colP[x] * rowP[y];
  const eyeRow = 2 + Math.floor(r() * 2);
  for (let y = eyeRow - 1; y <= eyeRow + 1; y++) for (let x = 1; x < 4; x++) grid[y][x] = true;
  const mouth = r() < 0.6 && eyeRow + 2 < 8;
  if (mouth) grid[eyeRow + 2][3] = true;

  const cells = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 4; x++) {
      if (!grid[y][x]) continue;
      let color = body;
      if (y === eyeRow && x === 2) color = '#1F1F1F';
      if (mouth && y === eyeRow + 2 && x === 3) color = dark;
      cells.push(cell(1 + x, 1 + y, color), cell(1 + 7 - x, 1 + y, color));
    }
  }
  return svg(size, 10, `<rect width="10" height="10" fill="${back}"/>${cells.join('')}`);
}

export function renderAvatar({ seed, style = 'identicon', size = 128, bg = null }) {
  if (!AVATAR_STYLES.includes(style)) throw new HttpError(400, `style 只能是 ${AVATAR_STYLES.join(' / ')}`);
  if (!Number.isInteger(size) || size < 32 || size > 512) throw new HttpError(400, 'size 须为 32~512 之间的整数');
  const color = bg == null ? null : parseHexColor(bg);
  const s = String(seed);
  if (style === 'initials') return initials(s, size, color);
  if (style === 'pixel') return pixelMonster(s, size, color);
  return identicon(s, size, color);
}

export default {
  name: 'avatar',
  category: 'fun',
  title: '随机头像',
  description: '按种子生成 SVG 头像：GitHub 风格对称格子、首字头像（支持中文）、8×8 像素小怪物',
  source: '本地生成',
  routes: [
    {
      method: 'GET',
      path: '/api/avatar',
      summary: '生成 SVG 头像（直接返回图片）',
      raw: true,
      returns: '直接返回 SVG 图片，不是 JSON。Content-Type 为 image/svg+xml; charset=utf-8，响应体是 SVG 文本，width/height 等于 size，可无损缩放。'
        + 'style=identicon：GitHub 风格 5×5 左右对称格子，主色由 seed 哈希决定，默认浅灰（#F0F0F0）背景，四周留半格空白；'
        + 'style=initials：显示 seed 的第一个字（中文、emoji 按一个字处理，英文转大写；为空时显示“?”），背景为 seed 哈希色，文字按背景深浅自动用白色或深灰；'
        + 'style=pixel：8×8 左右对称的像素小怪物，带一对眼睛，部分带嘴巴，颜色由 seed 决定，默认背景为同色系浅色。'
        + '同一 seed + 参数永远得到同一张图，此时响应头带 Cache-Control: public, max-age=86400；不传 seed 时随机生成，Cache-Control: no-store，'
        + '并在响应头 X-Avatar-Seed 中返回本次使用的随机 seed，可用它再次生成同一张图。'
        + 'seed 不会原样写入 SVG：文字经过 XML 转义，颜色只接受 6 位 hex。参数不合法时返回 HTTP 400 和 JSON 错误 { code, message, data: null }。',
      params: [
        { name: 'seed', required: false, desc: '种子，最多 64 个字符；同一 seed 结果固定，不传则随机。initials 风格显示它的第一个字', example: '小明' },
        { name: 'style', required: false, default: 'identicon', desc: '风格：identicon（对称格子）/ initials（首字）/ pixel（像素小怪物）', example: 'pixel' },
        { name: 'size', required: false, default: '128', desc: '图片边长（像素），32~512 的整数', example: '256' },
        { name: 'bg', required: false, desc: '背景色，6 位十六进制色值，可带 #（URL 中写作 %23）；不传时各风格使用默认背景', example: 'ffeecc' },
      ],
      async handler({ query }) {
        const given = param(query, 'seed', { max: 64 });
        const style = param(query, 'style', { default: 'identicon', oneOf: AVATAR_STYLES });
        const size = param(query, 'size', { default: 128, int: true, min: 32, max: 512 });
        // 具体格式由 renderAvatar → parseHexColor 严格校验，给出明确的错误提示
        const bg = param(query, 'bg', { max: 20 }) ?? null;
        const seed = given ?? randomSeed();
        const headers = {
          'content-type': 'image/svg+xml; charset=utf-8',
          'x-content-type-options': 'nosniff',
          // 直接在浏览器打开 SVG 时也禁止脚本和外部资源
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
          'cache-control': given == null ? 'no-store' : 'public, max-age=86400',
        };
        // 只回传服务端生成的随机 seed（纯 hex），不把用户输入写进响应头
        if (given == null) headers['x-avatar-seed'] = seed;
        return { status: 200, headers, body: renderAvatar({ seed, style, size, bg }) };
      },
    },
  ],
};

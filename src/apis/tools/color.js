import { randomInt } from 'node:crypto';
import { HttpError, param } from '../../lib/http.js';

const round = (n, d = 1) => {
  const f = 10 ** d;
  const v = Math.round(n * f) / f;
  return Object.is(v, -0) ? 0 : v;
};
const bad = (msg) => new HttpError(400, msg);

// ---------------- 解析 ----------------
const NUM = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;

function num(s, what) {
  if (!NUM.test(s)) throw bad(`${what} 不是合法的数字：${s}`);
  return Number(s);
}

// rgb 分量：0~255 或 0%~100%
function channel(s) {
  const v = s.endsWith('%') ? (num(s.slice(0, -1), 'rgb 分量') * 255) / 100 : num(s, 'rgb 分量');
  if (v < 0 || v > 255) throw bad('rgb 分量须在 0~255（或 0%~100%）之间');
  return v;
}

function alphaOf(s) {
  const v = s.endsWith('%') ? num(s.slice(0, -1), 'alpha') / 100 : num(s, 'alpha');
  if (v < 0 || v > 1) throw bad('alpha 须在 0~1（或 0%~100%）之间');
  return v;
}

function percent(s, what) {
  const v = num(s.replace(/%$/, ''), what);
  if (v < 0 || v > 100) throw bad(`${what}须在 0%~100% 之间`);
  return v;
}

function hue(s) {
  const m = /^(.+?)(deg|turn|rad|grad)?$/.exec(s);
  const v = num(m[1], '色相');
  const deg = { turn: v * 360, rad: (v * 180) / Math.PI, grad: v * 0.9 }[m[2]] ?? v;
  return ((deg % 360) + 360) % 360;
}

// 支持逗号写法 rgb(1, 2, 3) / rgba(1, 2, 3, 0.5) 与 CSS Color 4 空格写法 rgb(1 2 3 / 50%)
function args(body) {
  const [main, alpha, extra] = body.split('/');
  if (extra !== undefined) return null;
  const comma = main.includes(',');
  if (comma && alpha !== undefined) return null;
  const parts = (comma ? main.split(',') : main.trim().split(/\s+/)).map((s) => s.trim());
  if (alpha !== undefined) parts.push(alpha.trim());
  return parts.some((p) => p === '') ? null : parts;
}

export function hslToRgb(h, s, l) {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n) => lig - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/**
 * 识别颜色字符串：#fff、#ffff、#ffffff、#ffffffaa（# 可省略）、rgb()/rgba()、hsl()/hsla()
 * 返回 { format, r, g, b, a, hsl? }，r/g/b 为 0~255 整数，a 为 0~1
 */
export function parseColor(input) {
  const s = String(input ?? '').trim().toLowerCase();
  let m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (m) {
    let h = m[1];
    const format = `hex${h.length}`;
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { format, r, g, b, a };
  }
  m = /^(rgba?|hsla?)\((.*)\)$/.exec(s);
  if (!m) throw bad('无法识别的颜色格式，支持 #fff、#ffffff、#ffffffaa、rgb(…)、rgba(…)、hsl(…)、hsla(…)');
  const parts = args(m[2]);
  if (!parts || (parts.length !== 3 && parts.length !== 4)) throw bad(`${m[1]}(…) 须有 3 个分量，可再加 1 个 alpha`);
  const a = parts.length === 4 ? alphaOf(parts[3]) : 1;
  if (m[1].startsWith('rgb')) {
    const [r, g, b] = parts.slice(0, 3).map(channel).map(Math.round);
    return { format: m[1], r, g, b, a };
  }
  const h = hue(parts[0]);
  const sat = percent(parts[1], '饱和度');
  const lig = percent(parts[2], '亮度');
  const [r, g, b] = hslToRgb(h, sat, lig).map(Math.round);
  return { format: m[1], r, g, b, a, hsl: { h, s: sat, l: lig } };
}

// ---------------- 转换 ----------------
export function rgbToHsl(r, g, b) {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: s * 100, l: l * 100 };
}

export function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const { h } = rgbToHsl(r, g, b);
  return { h, s: max ? ((max - min) / max) * 100 : 0, v: (max / 255) * 100 };
}

export function rgbToCmyk(r, g, b) {
  const k = 1 - Math.max(r, g, b) / 255;
  if (k === 1) return { c: 0, m: 0, y: 0, k: 100 };
  const f = (x) => ((1 - x / 255 - k) / (1 - k)) * 100;
  return { c: f(r), m: f(g), y: f(b), k: k * 100 };
}

// WCAG 2.x 相对亮度
export function relativeLuminance(r, g, b) {
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export const contrastRatio = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

const hex2 = (n) => n.toString(16).padStart(2, '0');
const toHex = (r, g, b) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const hslCss = ({ h, s, l }) => `hsl(${round(h)}, ${round(s)}%, ${round(l)}%)`;

export function convertColor(input) {
  const c = parseColor(input);
  const { r, g, b } = c;
  const a = round(c.a, 3);
  const hslRaw = c.hsl ?? rgbToHsl(r, g, b);
  const hsl = { h: round(hslRaw.h), s: round(hslRaw.s), l: round(hslRaw.l) };
  const hsv = rgbToHsv(r, g, b);
  const cmyk = rgbToCmyk(r, g, b);
  const lum = relativeLuminance(r, g, b);
  const white = contrastRatio(lum, 1);
  const black = contrastRatio(lum, 0);
  return {
    input: String(input).trim(),
    format: c.format,
    hex: toHex(r, g, b),
    hex8: `${toHex(r, g, b)}${hex2(Math.round(c.a * 255))}`,
    alpha: a,
    rgb: { r, g, b, css: `rgb(${r}, ${g}, ${b})` },
    rgba: `rgba(${r}, ${g}, ${b}, ${a})`,
    hsl: { ...hsl, css: hslCss(hsl) },
    hsla: `hsla(${round(hsl.h)}, ${round(hsl.s)}%, ${round(hsl.l)}%, ${a})`,
    hsv: { h: round(hsv.h), s: round(hsv.s), v: round(hsv.v) },
    cmyk: { c: round(cmyk.c), m: round(cmyk.m), y: round(cmyk.y), k: round(cmyk.k) },
    brightness: round((r * 299 + g * 587 + b * 114) / 1000),
    luminance: round(lum, 4),
    contrast: { white: round(white, 2), black: round(black, 2) },
    textColor: black >= white ? 'black' : 'white',
  };
}

// ---------------- 随机 ----------------
export function randomColor(format = 'hex') {
  const n = randomInt(0x1000000);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
  const hex = toHex(r, g, b);
  const lum = relativeLuminance(r, g, b);
  const value = format === 'rgb' ? `rgb(${r}, ${g}, ${b})` : format === 'hsl' ? hslCss(rgbToHsl(r, g, b)) : hex;
  return { value, hex, textColor: contrastRatio(lum, 0) >= contrastRatio(lum, 1) ? 'black' : 'white' };
}

const TEXT_COLOR_DESC = '建议在该颜色背景上使用的文字颜色：black（黑字）或 white（白字），取与背景对比度（WCAG）更高的一个';

export default {
  name: 'color',
  category: 'tools',
  title: '颜色工具',
  description: '随机颜色；HEX / RGB / HSL 互转，附 HSV、CMYK、亮度与 WCAG 对比度',
  source: '本地计算',
  routes: [
    {
      method: 'GET',
      path: '/api/color/random',
      summary: '生成随机颜色',
      params: [
        { name: 'count', required: false, default: '1', desc: '数量（1~100）', example: '5' },
        { name: 'format', required: false, default: 'hex', desc: 'value 的格式：hex / rgb / hsl', example: 'rgb' },
      ],
      fields: [
        { name: '[]', type: 'object', desc: 'data 是数组，长度等于 count；每项是一个在 RGB 空间均匀随机的不透明颜色' },
        { name: '[].value', type: 'string', desc: '按 format 输出的颜色：hex 为 #rrggbb（小写），rgb 为 rgb(r, g, b)（0~255 整数），hsl 为 hsl(h, s%, l%)（色相 0~360 度，饱和度和亮度为百分比，保留 1 位小数）' },
        { name: '[].hex', type: 'string', desc: '同一颜色的十六进制写法 #rrggbb（小写），不论 format 为何都会返回' },
        { name: '[].textColor', type: 'string', desc: TEXT_COLOR_DESC },
      ],
      async handler({ query }) {
        const count = param(query, 'count', { default: 1, int: true, min: 1, max: 100 });
        const format = param(query, 'format', { default: 'hex', oneOf: ['hex', 'rgb', 'hsl'] });
        return { data: Array.from({ length: count }, () => randomColor(format)) };
      },
    },
    {
      method: 'GET',
      path: '/api/color/convert',
      summary: '颜色格式转换与对比度计算',
      params: [
        {
          name: 'value',
          required: true,
          desc: '颜色，自动识别：#fff、#ffff、#ffffff、#ffffffaa（# 在网址中要写成 %23，也可以省略 #）、rgb(255, 0, 0)、rgba(255, 0, 0, 0.5)、rgb(255 0 0 / 50%)、hsl(210, 100%, 50%)、hsla(…)；分量可用百分比，色相可带 deg/turn/rad/grad 单位',
          example: 'rgb(30, 144, 255)',
        },
      ],
      fields: [
        { name: 'input', type: 'string', desc: '请求参数 value 去掉首尾空白后的原文' },
        { name: 'format', type: 'string', desc: '识别出的输入格式：hex3（#rgb）、hex4（#rgba）、hex6（#rrggbb）、hex8（#rrggbbaa）、rgb、rgba、hsl、hsla（按函数名区分，rgb() 里也可以带 alpha）' },
        { name: 'hex', type: 'string', desc: '十六进制颜色 #rrggbb（小写，不含透明度）' },
        { name: 'hex8', type: 'string', desc: '带透明度的十六进制颜色 #rrggbbaa（小写），不透明时末两位为 ff' },
        { name: 'alpha', type: 'number', desc: '不透明度 0~1（保留 3 位小数），输入没有透明度时为 1' },
        { name: 'rgb', type: 'object', desc: 'RGB 表示（hsl 输入换算后四舍五入为整数）' },
        { name: 'rgb.r', type: 'number', desc: '红色分量，0~255 整数' },
        { name: 'rgb.g', type: 'number', desc: '绿色分量，0~255 整数' },
        { name: 'rgb.b', type: 'number', desc: '蓝色分量，0~255 整数' },
        { name: 'rgb.css', type: 'string', desc: 'CSS 写法，如 rgb(30, 144, 255)（不含透明度）' },
        { name: 'rgba', type: 'string', desc: '带透明度的 CSS 写法，如 rgba(30, 144, 255, 0.5)' },
        { name: 'hsl', type: 'object', desc: 'HSL 表示；输入是 hsl/hsla 时直接沿用输入值（色相规整到 0~360），否则由 RGB 换算' },
        { name: 'hsl.h', type: 'number', desc: '色相，0~360 度（不含 360），保留 1 位小数；灰色（无彩色）为 0' },
        { name: 'hsl.s', type: 'number', desc: '饱和度，0~100（百分比），保留 1 位小数' },
        { name: 'hsl.l', type: 'number', desc: '亮度（lightness），0~100（百分比），保留 1 位小数' },
        { name: 'hsl.css', type: 'string', desc: 'CSS 写法，如 hsl(209.6, 100%, 55.9%)（不含透明度）' },
        { name: 'hsla', type: 'string', desc: '带透明度的 CSS 写法，如 hsla(209.6, 100%, 55.9%, 0.5)' },
        { name: 'hsv', type: 'object', desc: 'HSV（HSB）表示，由 RGB 换算' },
        { name: 'hsv.h', type: 'number', desc: '色相，0~360 度（不含 360），保留 1 位小数' },
        { name: 'hsv.s', type: 'number', desc: '饱和度，0~100（百分比），保留 1 位小数' },
        { name: 'hsv.v', type: 'number', desc: '明度（value/brightness），0~100（百分比），保留 1 位小数' },
        { name: 'cmyk', type: 'object', desc: 'CMYK 表示（按简单公式由 RGB 换算，不含印刷色彩管理，仅供参考）' },
        { name: 'cmyk.c', type: 'number', desc: '青色，0~100（百分比），保留 1 位小数' },
        { name: 'cmyk.m', type: 'number', desc: '品红，0~100（百分比），保留 1 位小数' },
        { name: 'cmyk.y', type: 'number', desc: '黄色，0~100（百分比），保留 1 位小数' },
        { name: 'cmyk.k', type: 'number', desc: '黑色，0~100（百分比），保留 1 位小数' },
        { name: 'brightness', type: 'number', desc: '感知亮度，0~255，保留 1 位小数，公式 (299R + 587G + 114B) / 1000（W3C 可访问性评估建议的 YIQ 亮度）；一般大于 128 算浅色' },
        { name: 'luminance', type: 'number', desc: 'WCAG 2.x 相对亮度，0（纯黑）~1（纯白），保留 4 位小数；按不透明颜色计算，忽略 alpha' },
        { name: 'contrast', type: 'object', desc: '与白色、黑色的 WCAG 对比度（1~21，保留 2 位小数；正文文字 ≥ 4.5 达到 AA 级，≥ 7 达到 AAA 级）；按不透明颜色计算，忽略 alpha' },
        { name: 'contrast.white', type: 'number', desc: '与白色（#ffffff）的对比度' },
        { name: 'contrast.black', type: 'number', desc: '与黑色（#000000）的对比度' },
        { name: 'textColor', type: 'string', desc: TEXT_COLOR_DESC },
      ],
      async handler({ query }) {
        return { data: convertColor(param(query, 'value', { required: true, max: 100 })) };
      },
    },
  ],
};

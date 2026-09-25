import { createHash } from 'node:crypto';
import { HttpError, param } from '../../lib/http.js';
import { escapeXml, textWidth } from './ipcard.js';

const SANS = "system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei','Noto Sans CJK SC',sans-serif";
const SERIF = "'Songti SC','SimSun','Noto Serif CJK SC','Source Han Serif SC',serif";

// 只接受 3 / 6 位十六进制（可带 #），输出统一带 #，保证不会把任意字符串拼进属性
export function hexColor(value, name) {
  const v = String(value).trim().replace(/^#/, '').toLowerCase();
  if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/.test(v)) throw new HttpError(400, `${name} 须为 3 或 6 位十六进制颜色，如 e5e7eb`);
  return `#${v}`;
}

const svgResponse = (body, maxAge = 86400) => ({
  status: 200,
  headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': `private, max-age=${maxAge}` },
  body,
});

// 同一张图多次内联到页面时 id 不冲突；取内容哈希而不是随机数，相同参数输出相同，便于缓存
const uid = (...parts) => createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 8);

// ---------------- 占位图 ----------------

export function renderPlaceholder({ width, height, text, bg = '#e5e7eb', color = '#6b7280', fontSize }) {
  const label = text ?? `${width} × ${height}`;
  const units = textWidth(label, 1) || 1;
  const size = fontSize ?? Math.max(6, Math.round(Math.min(height / 4, (width * 0.8) / units)));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(label)}">`
    + `<rect width="${width}" height="${height}" fill="${bg}"/>`
    + `<text x="50%" y="50%" font-family="${escapeXml(SANS)}" font-size="${size}" font-weight="600" fill="${color}" text-anchor="middle" dominant-baseline="central">${escapeXml(label)}</text>`
    + '</svg>';
}

// ---------------- 徽章 ----------------

export const BADGE_COLORS = {
  brightgreen: '#4c1', green: '#97ca00', yellowgreen: '#a4a61d', yellow: '#dfb317', orange: '#fe7d37', red: '#e05d44', blue: '#007ec6',
  lightgrey: '#9f9f9f', grey: '#555', purple: '#8b5cf6', pink: '#ec4899', black: '#1f2937',
  success: '#4c1', important: '#fe7d37', critical: '#e05d44', informational: '#007ec6', inactive: '#9f9f9f',
};

function badgeColor(value, name) {
  const key = String(value).trim().toLowerCase();
  if (BADGE_COLORS[key]) return BADGE_COLORS[key];
  if (/^#?([0-9a-f]{3}|[0-9a-f]{6})$/.test(key)) return hexColor(key, name);
  throw new HttpError(400, `${name} 须为十六进制颜色，或 ${Object.keys(BADGE_COLORS).join(' / ')}`);
}

// 按 11px Verdana 估算宽度；再用 textLength 把文字压到这个宽度，换字体也不会溢出
function badgeTextWidth(s) {
  let w = 0;
  for (const ch of s) {
    if (ch.codePointAt(0) >= 0x2e80) w += 11.5;
    else if ("ijl.,:;'|!I[]() ".includes(ch)) w += 3.8;
    else if ('mwMW@%'.includes(ch)) w += 10.4;
    else if (/[A-Z]/.test(ch)) w += 7.8;
    else w += 6.7;
  }
  return Math.ceil(w);
}

export function renderBadge({ label = '', message, color = '#4c1', labelColor = '#555', style = 'flat' }) {
  const left = label.trim();
  const right = message.trim();
  const lw = left ? badgeTextWidth(left) + 12 : 0;
  const rw = badgeTextWidth(right) + 12;
  const total = lw + rw;
  const flat = style === 'flat';
  const id = uid(left, right, color, labelColor, style);
  const title = escapeXml(left ? `${left}: ${right}` : right);
  const text = (value, x, w) => {
    const attrs = `x="${x * 10}" textLength="${(w - 12) * 10}" transform="scale(.1)"`;
    return (flat ? `<text ${attrs} y="150" fill="#010101" fill-opacity=".3" aria-hidden="true">${escapeXml(value)}</text>` : '')
      + `<text ${attrs} y="140" fill="#fff">${escapeXml(value)}</text>`;
  };
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${title}">`,
    `<title>${title}</title>`,
    flat ? `<linearGradient id="s${id}" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>` : '',
    `<clipPath id="r${id}"><rect width="${total}" height="20" rx="${flat ? 3 : 0}" fill="#fff"/></clipPath>`,
    `<g clip-path="url(#r${id})">`,
    left ? `<rect width="${lw}" height="20" fill="${labelColor}"/>` : '',
    `<rect x="${lw}" width="${rw}" height="20" fill="${color}"/>`,
    flat ? `<rect width="${total}" height="20" fill="url(#s${id})"/>` : '',
    '</g>',
    `<g fill="#fff" text-anchor="middle" font-family="${escapeXml("Verdana,Geneva,'DejaVu Sans','PingFang SC','Microsoft YaHei',sans-serif")}" text-rendering="geometricPrecision" font-size="110">`,
    left ? text(left, lw / 2, lw) : '',
    text(right, lw + rw / 2, rw),
    '</g></svg>',
  ].join('');
}

// ---------------- 文字转图片 ----------------

export const TEXT_STYLES = {
  simple: { background: '#ffffff', color: '#1f2937', font: SANS },
  dark: { background: '#111827', color: '#f3f4f6', font: SANS },
  paper: { background: '#fbf6ea', color: '#3f3a33', font: SERIF },
};
const MAX_LINES = 80;

// 没有排版引擎，按估算宽度折行：全角字符 1em，半角约 0.55em
export function wrapLines(text, size, maxWidth) {
  const lines = [];
  for (const para of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = '';
    let w = 0;
    for (const ch of para) {
      const cw = ch.codePointAt(0) >= 0x2e80 ? size : size * 0.55;
      if (w + cw > maxWidth && line) {
        lines.push(line);
        line = '';
        w = 0;
      }
      line += ch;
      w += cw;
    }
    lines.push(line);
  }
  return lines;
}

export function renderTextImage({ text, style = 'simple', fontSize = 32, width = 800, align = 'left', bg, color }) {
  const theme = TEXT_STYLES[style];
  const padding = Math.max(32, Math.round(fontSize * 1.25));
  const lines = wrapLines(text.replace(/\t/g, '    '), fontSize, width - padding * 2);
  if (lines.length > MAX_LINES) throw new HttpError(400, `文字换行后超过 ${MAX_LINES} 行，请减少文字、调小字号或加大宽度`);
  const lineHeight = Math.round(fontSize * 1.6);
  const height = padding * 2 + lines.length * lineHeight;
  const x = align === 'center' ? width / 2 : padding;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${bg ?? theme.background}"/>`,
    `<g font-family="${escapeXml(theme.font)}" font-size="${fontSize}" fill="${color ?? theme.color}" text-anchor="${align === 'center' ? 'middle' : 'start'}">`,
    ...lines.map((line, i) => `<text x="${x}" y="${padding + i * lineHeight + Math.round(fontSize * 1.05)}" xml:space="preserve">${escapeXml(line)}</text>`),
    '</g></svg>',
  ].join('');
}

export default {
  name: 'svg-image',
  category: 'tools',
  title: '占位图 / 徽章 / 文字图片',
  description: '生成 SVG 占位图、shields 风格徽章、文字转图片，可直接写进 <img> 的 src',
  source: '本地计算',
  routes: [
    {
      method: 'GET',
      path: '/api/placeholder',
      summary: '占位图（SVG）：指定宽高、文字和颜色',
      raw: true,
      params: [
        { name: 'width', default: '600', desc: '宽度（像素，1~4000）', example: '300' },
        { name: 'height', default: '400', desc: '高度（像素，1~4000）', example: '200' },
        { name: 'text', required: false, desc: '显示的文字，最多 60 个字符；不传时显示“宽 × 高”', example: 'Banner' },
        { name: 'bg', default: 'e5e7eb', desc: '背景色，3 或 6 位十六进制（可带 #，网址中 # 需写成 %23）', example: 'dbeafe' },
        { name: 'color', default: '6b7280', desc: '文字颜色，3 或 6 位十六进制', example: '1e40af' },
        { name: 'fontSize', required: false, desc: '字号（像素，6~400）；不传时按图片尺寸和文字长度自动计算', example: '40' },
      ],
      returns: 'SVG 图片（Content-Type: image/svg+xml; charset=utf-8，Cache-Control: private, max-age=86400，相同参数输出相同）。'
        + '尺寸为 width×height 像素，纯色背景，文字水平垂直居中、加粗；文字经过 XML 转义。文字由浏览器用系统字体渲染（无衬线字体，含中文字体回退）。'
        + '参数不合法时返回 JSON 格式的 400 错误',
      async handler({ query }) {
        const width = param(query, 'width', { default: 600, int: true, min: 1, max: 4000 });
        const height = param(query, 'height', { default: 400, int: true, min: 1, max: 4000 });
        const text = param(query, 'text', { max: 60 });
        const bg = hexColor(param(query, 'bg', { default: 'e5e7eb', max: 7 }), 'bg');
        const color = hexColor(param(query, 'color', { default: '6b7280', max: 7 }), 'color');
        const fontSize = param(query, 'fontSize', { int: true, min: 6, max: 400 });
        return svgResponse(renderPlaceholder({ width, height, text, bg, color, fontSize }));
      },
    },
    {
      method: 'GET',
      path: '/api/badge',
      summary: '徽章（SVG，shields.io 风格）：“标签 | 内容”，可用于 README',
      raw: true,
      params: [
        { name: 'message', required: true, desc: '右侧内容，最多 60 个字符', example: 'passing' },
        { name: 'label', required: false, desc: '左侧标签，最多 60 个字符；不传则只显示右侧', example: 'build' },
        { name: 'color', default: 'brightgreen', desc: `右侧底色：十六进制，或 ${Object.keys(BADGE_COLORS).join(' / ')}`, example: 'blue' },
        { name: 'labelColor', default: 'grey', desc: '左侧底色，取值同 color', example: '555' },
        { name: 'style', default: 'flat', desc: 'flat 圆角带渐变 / flat-square 直角纯色', example: 'flat-square' },
      ],
      returns: 'SVG 图片（Content-Type: image/svg+xml; charset=utf-8，Cache-Control: private, max-age=3600），高 20 像素，宽度按文字自动计算。'
        + '左侧为 label（灰底），右侧为 message（color 底色），白色 Verdana 11px 文字，flat 风格带文字阴影和渐变高光；'
        + '文字经过 XML 转义，并用 textLength 限定宽度，换字体也不会溢出。带 <title> 与 aria-label，屏幕阅读器可读。参数不合法时返回 JSON 格式的 400 错误',
      async handler({ query }) {
        const message = param(query, 'message', { required: true, max: 60 });
        const label = param(query, 'label', { default: '', max: 60 });
        const color = badgeColor(param(query, 'color', { default: 'brightgreen', max: 20 }), 'color');
        const labelColor = badgeColor(param(query, 'labelColor', { default: 'grey', max: 20 }), 'labelColor');
        const style = param(query, 'style', { default: 'flat', oneOf: ['flat', 'flat-square'] });
        if (!message.trim()) throw new HttpError(400, 'message 不能为空');
        return svgResponse(renderBadge({ label, message, color, labelColor, style }), 3600);
      },
    },
    {
      method: 'GET',
      path: '/api/text-image',
      summary: '文字转图片（SVG）：自动换行，简约 / 深色 / 纸张三种样式',
      raw: true,
      params: [
        { name: 'text', required: true, desc: '文字内容，最多 1000 个字符，可用换行符（%0A）分段', example: '白日依山尽，黄河入海流。\n欲穷千里目，更上一层楼。' },
        { name: 'style', default: 'simple', desc: 'simple 白底 / dark 深色 / paper 纸张（衬线字体）', example: 'paper' },
        { name: 'fontSize', default: '32', desc: '字号（像素，12~120）', example: '36' },
        { name: 'width', default: '800', desc: '图片宽度（像素，200~1600），高度按内容自动计算', example: '720' },
        { name: 'align', default: 'left', desc: '对齐：left 左对齐 / center 居中', example: 'center' },
        { name: 'bg', required: false, desc: '自定义背景色（十六进制），覆盖样式默认值', example: 'fff7ed' },
        { name: 'color', required: false, desc: '自定义文字颜色（十六进制），覆盖样式默认值', example: '7c2d12' },
      ],
      returns: `SVG 图片（Content-Type: image/svg+xml; charset=utf-8，Cache-Control: private, max-age=86400）。宽度为 width，高度 = 上下边距 + 行数 × 1.6 倍字号；`
        + `按估算字宽自动折行（全角字符 1 个字宽、半角约 0.55 个），换行后最多 ${MAX_LINES} 行，超过返回 400。`
        + '每行一个 <text>，文字经过 XML 转义并保留空格；文字由查看者的浏览器用系统字体渲染（服务器不需要安装字体），不同系统的实际字宽略有差异。参数不合法时返回 JSON 格式的 400 错误',
      async handler({ query }) {
        const text = param(query, 'text', { required: true, max: 1000 });
        if (!text.trim()) throw new HttpError(400, 'text 不能为空');
        const style = param(query, 'style', { default: 'simple', oneOf: Object.keys(TEXT_STYLES) });
        const fontSize = param(query, 'fontSize', { default: 32, int: true, min: 12, max: 120 });
        const width = param(query, 'width', { default: 800, int: true, min: 200, max: 1600 });
        const align = param(query, 'align', { default: 'left', oneOf: ['left', 'center'] });
        const bgRaw = param(query, 'bg', { max: 7 });
        const colorRaw = param(query, 'color', { max: 7 });
        return svgResponse(renderTextImage({
          text, style, fontSize, width, align,
          bg: bgRaw && hexColor(bgRaw, 'bg'),
          color: colorRaw && hexColor(colorRaw, 'color'),
        }));
      },
    },
  ],
};

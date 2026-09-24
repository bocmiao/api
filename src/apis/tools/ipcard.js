import { param } from '../../lib/http.js';
import { parseUA, browserLabel, osLabel } from '../../lib/ua.js';
import { normalizeIp } from '../life/ip.js';
import { lookupLocation } from './visitor.js';

// ---------------- 文本安全与排版 ----------------
// XML 转义；同时去掉 XML 1.0 不允许的控制字符，孤立的代理项替换为 U+FFFD，保证 SVG 始终是合法 XML
export function escapeXml(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// 估算文字宽度（像素）：中日韩字符按 1em，其余按 0.6em 左右
export function textWidth(s, size, mono = false) {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0x2e80) w += 1;
    else if (mono) w += 0.62;
    else if (/[A-Z0-9mwMW@%]/.test(ch)) w += 0.66;
    else if (/[il.,:;'|! ]/.test(ch)) w += 0.32;
    else w += 0.55;
  }
  return w * size;
}

// 超出宽度时截断并加省略号（先截断再转义，避免切断实体）
export function fit(s, maxWidth, size, mono = false) {
  const str = String(s ?? '');
  if (textWidth(str, size, mono) <= maxWidth) return str;
  let out = '';
  for (const ch of str) {
    if (textWidth(`${out}${ch}…`, size, mono) > maxWidth) break;
    out += ch;
  }
  return `${out}…`;
}

// ---------------- 时间与问候 ----------------
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const GREETINGS = [
  [5, '夜深了', ['早点休息，明天见', '熬夜伤身，放下手机吧', '星星都睡了，你也快睡吧']],
  [8, '早上好', ['新的一天，元气满满', '吃好早餐，好好开始', '今天也要闪闪发光']],
  [11, '上午好', ['专注的样子很酷', '喝杯水，继续加油', '今天的效率一定很高']],
  [13, '中午好', ['记得按时吃午饭', '午休一下，下午更有精神', '吃饱了才有力气']],
  [18, '下午好', ['来杯下午茶吧', '伸个懒腰，放松一下', '离下班又近了一点']],
  [23, '晚上好', ['辛苦了，好好犒劳自己', '愿你今晚有个好梦', '放下工作，享受生活']],
  [24, '夜深了', ['早点休息，明天见', '熬夜伤身，放下手机吧', '今天的你已经很棒了']],
];

// 取某时区的年月日、时、星期；时区无效时按北京时间
export function localParts(now, timeZone = 'Asia/Shanghai') {
  try {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23', weekday: 'short',
    });
    const p = Object.fromEntries(f.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
    if (wd >= 0) return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour) % 24, weekday: WEEKDAYS[wd] };
  } catch {
    // 时区名无效
  }
  if (timeZone !== 'Asia/Shanghai') return localParts(now);
  const d = new Date(now + 8 * 3600_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), weekday: WEEKDAYS[d.getUTCDay()] };
}

export function greetingFor(hour, rand = Math.random) {
  const [, title, lines] = GREETINGS.find(([end]) => hour < end);
  return { title, line: lines[Math.floor(rand() * lines.length)] };
}

// ---------------- 图标（14×14，描边） ----------------
const ICONS = {
  pin: '<path d="M7 13s-4.5-4.1-4.5-7.4a4.5 4.5 0 0 1 9 0C11.5 8.9 7 13 7 13z"/><circle cx="7" cy="5.6" r="1.6"/>',
  monitor: '<rect x="1" y="2" width="12" height="8.5" rx="1.5"/><path d="M5 13h4M7 10.5V13"/>',
  globe: '<circle cx="7" cy="7" r="6"/><path d="M1 7h12M7 1c1.9 1.7 2.8 3.7 2.8 6S8.9 11.3 7 13M7 1C5.1 2.7 4.2 4.7 4.2 7S5.1 11.3 7 13"/>',
  calendar: '<rect x="1.5" y="2.5" width="11" height="10" rx="1.5"/><path d="M1.5 6h11M4.5 1v3M9.5 1v3"/>',
};
const icon = (name, x, y, color) => `<g transform="translate(${x} ${y})" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</g>`;

const THEMES = {
  light: {
    bg: ['#ffffff', '#eef2ff'], border: '#e0e7ff', blob: '#c7d2fe', blobOpacity: 0.45,
    title: '#1e293b', sub: '#64748b', ip: '#4f46e5', label: '#6366f1', labelBg: '#e0e7ff',
    accent: ['#6366f1', '#ec4899'], divider: '#e2e8f0', icon: '#6366f1', text: '#334155',
  },
  dark: {
    bg: ['#0f172a', '#1e1b4b'], border: '#312e81', blob: '#4338ca', blobOpacity: 0.3,
    title: '#f1f5f9', sub: '#94a3b8', ip: '#a5b4fc', label: '#c7d2fe', labelBg: '#312e81',
    accent: ['#818cf8', '#f472b6'], divider: '#334155', icon: '#a5b4fc', text: '#cbd5e1',
  },
};

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Source Han Sans SC', 'WenQuanYi Micro Hei', 'WenQuanYi Zen Hei', sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', 'DejaVu Sans Mono', monospace";

// 未识别的客户端显示 UA 的第一个产品标识（如 MyApp/1.2 → MyApp 1.2），这部分完全来自请求头，必须转义
function productToken(ua) {
  const token = String(ua ?? '').trim().split(/\s+/)[0] ?? '';
  return !token || /^Mozilla\//i.test(token) ? null : token.replace('/', ' ');
}

export const WIDTH = 480;
export const HEIGHT = 160;

/**
 * 纯函数：生成签名档 SVG。所有插入的文本都经过 fit 截断 + escapeXml 转义。
 * @param {{ ip: string|null, location: string|null, ua: string, theme?: 'light'|'dark', now?: number, timeZone?: string, rand?: () => number }} o
 */
export function renderIpCard({ ip, location, ua, theme = 'light', now = Date.now(), timeZone, rand = Math.random }) {
  const t = THEMES[theme] ?? THEMES.light;
  const p = parseUA(ua);
  const lp = localParts(now, timeZone);
  const greet = greetingFor(lp.hour, rand);

  const dateText = `${lp.year}年${lp.month}月${lp.day}日 ${lp.weekday}`;
  const dateW = textWidth(dateText, 12);
  const dateX = WIDTH - 24;
  const titleMax = dateX - dateW - 20 - 16 - 96;

  const ipText = ip || '未知';
  const ipX = 128;
  const ipMax = WIDTH - 24 - ipX;
  const ipSize = Math.max(12, Math.min(22, Math.floor(ipMax / (Math.max(ipText.length, 1) * 0.62))));

  const cols = [
    ['pin', location || '未知', 24, 130],
    ['monitor', osLabel(p) ?? '未知', 184, 100],
    ['globe', browserLabel(p) ?? productToken(ua) ?? '未知', 314, WIDTH - 24 - 334],
  ];
  const esc = (s, max, size, mono) => escapeXml(fit(s, max, size, mono));
  // 多张卡片内联到同一页面时 id 不能冲突
  const id = `c${Math.floor(rand() * 1e9).toString(36)}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${esc(`${greet.title}，你的 IP 是 ${ipText}`, 1000, 12)}">
<defs>
<linearGradient id="${id}-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.bg[0]}"/><stop offset="1" stop-color="${t.bg[1]}"/></linearGradient>
<linearGradient id="${id}-accent" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.accent[0]}"/><stop offset="1" stop-color="${t.accent[1]}"/></linearGradient>
<clipPath id="${id}-clip"><rect width="${WIDTH}" height="${HEIGHT}" rx="16"/></clipPath>
</defs>
<g clip-path="url(#${id}-clip)">
<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#${id}-bg)"/>
<circle cx="${WIDTH - 30}" cy="-10" r="90" fill="${t.blob}" opacity="${t.blobOpacity}"/>
<circle cx="${WIDTH - 110}" cy="${HEIGHT + 40}" r="70" fill="${t.blob}" opacity="${t.blobOpacity * 0.6}"/>
<rect x="0" y="0" width="5" height="${HEIGHT}" fill="url(#${id}-accent)"/>
</g>
<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" rx="15.5" fill="none" stroke="${t.border}"/>
<g transform="translate(52 62)">
<circle r="28" fill="url(#${id}-accent)"/>
<path d="M-12,-1 L-13,-14 L-5,-8.5 Q0,-10.5 5,-8.5 L13,-14 L12,-1 Q12.5,11 0,11.5 Q-12.5,11 -12,-1 Z" fill="#ffffff"/>
<circle cx="-5" cy="0" r="1.9" fill="${t.accent[0]}"/><circle cx="5" cy="0" r="1.9" fill="${t.accent[0]}"/>
<path d="M-1.6,4 L1.6,4 L0,5.8 Z" fill="${t.accent[1]}"/>
<path d="M-7,5.5 L-17,4 M-7,8 L-17,9 M7,5.5 L17,4 M7,8 L17,9" stroke="#ffffff" stroke-width="1.1" stroke-linecap="round"/>
</g>
<g font-family="${FONT}">
<text x="96" y="44" font-size="18" font-weight="700" fill="${t.title}">${esc(`${greet.title}，朋友！`, titleMax, 18)}</text>
<text x="96" y="64" font-size="12" fill="${t.sub}">${esc(greet.line, WIDTH - 24 - 96, 12)}</text>
${icon('calendar', dateX - dateW - 18, 32, t.icon)}
<text x="${dateX}" y="44" font-size="12" text-anchor="end" fill="${t.sub}">${escapeXml(dateText)}</text>
<rect x="96" y="76" width="26" height="18" rx="5" fill="${t.labelBg}"/>
<text x="109" y="89" font-size="11" font-weight="700" text-anchor="middle" fill="${t.label}">IP</text>
<text x="${ipX}" y="92" font-size="${ipSize}" font-weight="700" font-family="${MONO}" fill="${t.ip}">${esc(ipText, ipMax, ipSize, true)}</text>
<line x1="24" y1="110" x2="${WIDTH - 24}" y2="110" stroke="${t.divider}"/>
${cols.map(([name, text, x, max]) => `${icon(name, x, 124, t.icon)}<text x="${x + 20}" y="135" font-size="13" fill="${t.text}">${esc(text, max, 13)}</text>`).join('\n')}
</g>
</svg>`;
}

export default {
  name: 'ipcard',
  category: 'tools',
  title: 'IP 签名档',
  description: '生成显示访问者 IP、归属地、系统、浏览器和日期问候的 SVG 签名图片，可嵌入论坛签名或网页',
  source: '本地生成 + ip-api.com（归属地）',
  routes: [
    {
      method: 'GET',
      path: '/api/ipcard',
      summary: 'IP 签名档图片（SVG）',
      raw: true,
      params: [
        { name: 'theme', required: false, default: 'light', desc: '主题：light（浅色）/ dark（深色）', example: 'dark' },
      ],
      returns: 'SVG 图片（Content-Type: image/svg+xml; charset=utf-8，Cache-Control: no-store，每次访问实时生成），尺寸 480×160，圆角卡片、渐变背景。'
        + '内容：按访问者所在时区（取不到归属地时按北京时间）的问候语（早上好/上午好/中午好/下午好/晚上好/夜深了）和一句随机寄语，'
        + '日期（YYYY年M月D日 星期X），访问者 IP，归属地（如 "中国 广东 深圳"，内网 IP、查询失败或 3 秒未返回时显示 "未知"），'
        + '操作系统（如 Windows 10/11）和浏览器（如 Chrome 128，未识别时显示 UA 的第一个产品标识）。所有文字都经过 XML 转义，过长时截断加省略号。'
        + '注意：通过图片代理（如 GitHub Camo、部分论坛的图片缓存）加载时，显示的是代理服务器的 IP 和 UA',
      async handler({ query, ip, req }) {
        const theme = param(query, 'theme', { default: 'light', oneOf: ['light', 'dark'] });
        const ua = String(req?.headers?.['user-agent'] ?? '').slice(0, 2000);
        const n = normalizeIp(ip ?? '') || null;
        const info = await lookupLocation(n);
        const svg = renderIpCard({ ip: n, location: info?.location || null, ua, theme, timeZone: info?.timezone || undefined });
        return {
          status: 200,
          headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' },
          body: svg,
        };
      },
    },
  ],
};

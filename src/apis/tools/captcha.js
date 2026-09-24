import { randomBytes, randomInt } from 'node:crypto';
import { HttpError, param } from '../../lib/http.js';

// ---------------- 笔画字体 ----------------
// 字形画成 <path>，SVG 源码里不出现 <text>，不能直接读出答案。
// 每个字形是若干笔画：点之间用空格分隔，笔画之间用 | 分隔；
// 前缀 ~ 表示平滑曲线（Catmull-Rom），@ 表示闭合的平滑曲线，否则为折线。
// 西文字形在 10×16 的格子里，中文字形在 16×16 的格子里，y 轴向下。
const ASCII = {
  0: '@5,1 8.5,3 9.5,8 8.5,13 5,15 1.5,13 0.5,8 1.5,3',
  1: '2,4 5.5,1 5.5,15|2.5,15 8.5,15',
  2: '~1,4.5 3,1.6 6.5,1.2 9,3.5 8.6,7 1,15|1,15 9.5,15',
  3: '~1,3 4,1 7.5,1.5 8.5,4.5 6.5,7.2 4,7.5|~4,7.5 7.5,8 9.3,11 7.5,14.5 4,15 1,13.5',
  4: '7,15 7,1 0.5,11 10,11',
  5: '9,1 2,1 1.5,7|~1.5,7 5,6 8.5,7.5 9.5,11 8,14.3 4.5,15.2 1,13.5',
  6: '~8.5,2 5.5,1 2.5,2.5 1,7 1,11 2.5,14.3 5.5,15 8.5,13.5 9.3,10.5 8,8 5.5,7.3 2.5,8 1,10.5',
  7: '0.5,1 9.5,1 4,15',
  8: '@5,1 8,2.5 8,5.5 5,7.5 2,5.5 2,2.5|@5,7.5 8.8,9.8 8.8,13 5,15 1.2,13 1.2,9.8',
  9: '~1.5,14 4.5,15 7.5,13.5 9,9 9,5 7.5,1.7 4.5,1 1.5,2.5 0.7,5.5 2,8 4.5,8.7 7.5,8 9,5.5',
  A: '0.5,15 5,1 9.5,15|2.3,10 7.7,10',
  B: '1,1 1,15|~1,1 6,1 8.5,2.5 8.5,5.8 6,7.5 1,7.5|~1,7.5 6.5,7.5 9.3,9.5 9.3,13 6.5,15 1,15',
  C: '~9,3 6.5,1 3.5,1.2 1.2,4 0.8,8 1.2,12 3.5,14.8 6.5,15 9,13',
  D: '1,1 1,15|~1,1 5,1 8.5,3.5 9.5,8 8.5,12.5 5,15 1,15',
  E: '9,1 1,1 1,15 9,15|1,8 7,8',
  F: '9,1 1,1 1,15|1,8 7,8',
  G: '~9,3 6.5,1 3.5,1.2 1.2,4 0.8,8 1.2,12 3.5,14.8 6.5,15 9,13.5 9,9|5.5,9 9,9',
  H: '1,1 1,15|9,1 9,15|1,8 9,8',
  J: '4.5,1 9.5,1|~8,1 8,11 6.8,14.3 4.3,15 1.8,14 1,11.5',
  K: '1,1 1,15|9,1 1,9.5|3.8,7 9.5,15',
  L: '1,1 1,15 9,15',
  M: '0.5,15 1,1 5,11 9,1 9.5,15',
  N: '1,15 1,1 9,15 9,1',
  P: '1,15 1,1|~1,1 6,1 8.8,2.8 9,5.5 6.5,8.3 1,8.3',
  Q: '@5,1 8.5,3 9.5,8 8.5,13 5,15 1.5,13 0.5,8 1.5,3|6,11 9.8,15.5',
  R: '1,15 1,1|~1,1 6,1 8.8,2.8 9,5.5 6.5,8.3 1,8.3|5,8.3 9.5,15',
  S: '~9,3 6.5,1.1 3.5,1.1 1.2,3 1.5,5.8 5,7.8 8.5,9.8 9,12.8 6.5,14.9 3.5,14.9 0.8,13',
  T: '0.5,1 9.5,1|5,1 5,15',
  U: '~1,1 1,10.5 2,13.8 5,15 8,13.8 9,10.5 9,1',
  V: '0.5,1 5,15 9.5,1',
  W: '0,1 2.5,15 5,5 7.5,15 10,1',
  X: '1,1 9,15|9,1 1,15',
  Y: '0.5,1 5,8 9.5,1|5,8 5,15',
  Z: '1,1 9,1 1,15 9,15',
  '+': '5,4 5,13|1,8.5 9,8.5',
  '-': '1.5,8.5 8.5,8.5',
  '×': '2,5 8,12|8,5 2,12',
  '=': '1,6 9,6|1,11 9,11',
  '?': '~1.2,4 3,1.5 5.5,1 8.2,2.5 8.5,5.5 6.5,7.8 5,9.5 5,11|5,14 5,14.6',
};

const CJK = {
  一: '~1,8.5 8,8 15,8.3',
  二: '3.5,4 12.5,3.8|1,12.5 15,12.3',
  三: '3,2.5 13,2.3|4,8 12,7.8|1.5,14 14.5,13.8',
  四: '1.5,2.5 1.5,14.5|1.5,2.5 14.5,2.5 14.5,14.5|1.5,13.5 14.5,13.5|~6,2.5 6,6 5.5,8.5 4,10|10,2.5 10,8.5 12,9',
  五: '2.5,2 13.5,2|7.5,2 5.5,14|3.5,7.5 12,7.5 11.5,14|1,14.5 15,14.5',
  六: '7.5,1 9,3.5|1.5,5.5 14.5,5.5|~6,8.5 5,11.5 2.5,14.5|10,8.5 13.5,14',
  七: '1.5,8 14.5,6|~6,1.5 6,11 7,14 10,14.5 14.5,14.5 14.5,12',
  八: '~6.5,3 6,8 4.5,11.5 1.5,14.5|~9.5,3 10.5,8 12.5,11.5 15,14',
  九: '~7,1.5 7,6 5.5,11 2,15|~2,5.5 11,5.5 11,12 12,14.5 14.5,14.5 15,12',
  十: '1,8.5 15,8.5|8,1 8,15.5',
  加: '~1,5.5 8,5.5 8,11 7.5,14 6,15|~4.5,1.5 4.5,7 3.5,11 1,14.5|10,5.5 10,13.5|10,5.5 15,5.5 15,13.5|10,13 15,13',
  减: '1,3 3,5|1,13 3.2,9.5|5.5,4 15,4|~6.5,4 6.5,10 5.5,14|~11,1 11.5,7 13,11.5 15.5,14.5 15.5,12|13.5,1.5 14.8,2.8|7.5,6.5 10.5,6.5|7.8,8.5 7.8,12|7.8,8.5 10.5,8.5 10.5,12|7.8,11.8 10.5,11.8',
  乘: '~12,1 8,2.2 4,2.8|1.5,5 14.5,5|8,2.5 8,15.5|3,8 5.5,8|5.5,6.5 5.5,11|10.5,6.5 10.5,11|10.5,8 13,7.5|~7.5,10 5,13 1.5,15|~8.5,10 11,13 15,15',
  等: '~4.5,0.8 3.5,2.5 1.5,4.5|3,2.3 7.5,2.3|5,3 6.2,4.5|~11.5,0.8 10.5,2.5 8.5,4.5|10,2.3 15,2.3|12,3 13.2,4.5|4,6.5 12,6.5|8,5 8,9|2,9 14,9|2.5,11.5 14.5,11.5|~11.5,9.5 11.5,15 10.5,15.5 9,14.8|5.5,12.8 7,14.3',
  于: '3,3 13,3|1,8.5 15,8.5|~8,3 8,14.5 7.3,15.5 5.5,14.8',
  '？': '~3.2,4 5,1.5 7.5,1 10.2,2.5 10.5,5.5 8.5,7.8 7,9.5 7,11|7,14 7,14.6',
};

function compile(spec, width) {
  return {
    width,
    strokes: spec.split('|').map((s) => {
      const smooth = s[0] === '~' || s[0] === '@';
      const closed = s[0] === '@';
      const pts = s.replace(/^[~@]/, '').trim().split(/\s+/).map((p) => p.split(',').map(Number));
      return { smooth, closed, pts };
    }),
  };
}

export const GLYPHS = Object.fromEntries([
  ...Object.entries(ASCII).map(([k, v]) => [k, compile(v, 10)]),
  ...Object.entries(CJK).map(([k, v]) => [k, compile(v, 16)]),
]);

// ---------------- 题目 ----------------
export const TYPES = ['alnum', 'number', 'math', 'chinese_math'];
// 去掉易混淆的 0 O 1 I
const ALNUM = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '0123456789';
const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const pickFrom = (s) => s[randomInt(s.length)];

// 返回 { chars: 要画的字形, answer: 标准答案（小写） }
export function makeChallenge(type, length = 4) {
  if (type === 'alnum' || type === 'number') {
    const set = type === 'alnum' ? ALNUM : DIGITS;
    const chars = Array.from({ length }, () => pickFrom(set));
    return { chars, answer: chars.join('').toLowerCase() };
  }
  const op = ['+', '-', '×'][randomInt(3)];
  let a;
  let b;
  if (type === 'math') {
    if (op === '×') [a, b] = [randomInt(1, 10), randomInt(1, 10)];
    else [a, b] = [randomInt(1, 21), randomInt(1, 21)];
  } else if (op === '×') [a, b] = [randomInt(1, 10), randomInt(1, 10)];
  else [a, b] = [randomInt(1, 11), randomInt(1, 11)];
  if (op === '-' && a < b) [a, b] = [b, a];
  const answer = String(op === '+' ? a + b : op === '-' ? a - b : a * b);
  if (type === 'math') return { chars: [...`${a}${op}${b}=?`], answer };
  const word = { '+': '加', '-': '减', '×': '乘' }[op];
  return { chars: [CN_NUM[a], word, CN_NUM[b], '等', '于', '？'], answer };
}

// ---------------- 渲染 ----------------
const rand = (min, max) => min + Math.random() * (max - min);
const f1 = (n) => (Math.round(n * 10) / 10).toString();
// 输出十六进制颜色（部分 SVG 渲染器不支持 hsl()）
function hsl(h, sPct, lPct) {
  const s = sPct / 100;
  const l = lPct / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const c = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return `#${[c(0), c(8), c(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
const shuffle = (arr) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

// Catmull-Rom 样条转三次贝塞尔
function smoothPath(pts, closed) {
  const n = pts.length;
  const at = (i) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  let d = `M${f1(pts[0][0])} ${f1(pts[0][1])}`;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${f1(c1[0])} ${f1(c1[1])} ${f1(c2[0])} ${f1(c2[1])} ${f1(p2[0])} ${f1(p2[1])}`;
  }
  return d;
}
const linePath = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${f1(p[0])} ${f1(p[1])}`).join('');

// 把笔画随机拆段、反向，打乱笔画结构，防止按"几笔几点"对照字形表识别
function splitStroke(stroke) {
  const { smooth, closed } = stroke;
  let { pts } = stroke;
  if (closed) return [stroke];
  if (!smooth && pts.length === 2 && Math.random() < 0.5) {
    const t = rand(0.3, 0.7);
    const mid = [pts[0][0] + (pts[1][0] - pts[0][0]) * t, pts[0][1] + (pts[1][1] - pts[0][1]) * t];
    pts = [pts[0], mid, pts[1]];
  }
  const parts = [];
  if (pts.length >= 3 && Math.random() < 0.5) {
    const k = 1 + Math.floor(Math.random() * (pts.length - 2));
    parts.push(pts.slice(0, k + 1), pts.slice(k));
  } else parts.push(pts);
  return parts.map((p) => ({ smooth: smooth && p.length > 2, closed: false, pts: Math.random() < 0.5 ? [...p].reverse() : p }));
}

export function renderCaptcha(chars) {
  const H = 50;
  const pad = rand(10, 16);
  let x = pad;
  const glyphPaths = [];
  for (const ch of chars) {
    const g = GLYPHS[ch];
    if (!g) throw new Error(`no glyph: ${ch}`);
    const cjk = g.width === 16;
    const scale = (cjk ? 1.7 : 1.85) * rand(0.9, 1.1);
    const angle = (rand(-1, 1) * (cjk ? 15 : 25) * Math.PI) / 180;
    const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
    const w = g.width * scale;
    const cx = x + w / 2;
    const cy = H / 2 + rand(-4, 4);
    const tf = ([px, py]) => {
      const jx = (px + rand(-0.35, 0.35) - g.width / 2) * scale;
      const jy = (py + rand(-0.35, 0.35) - 8) * scale;
      return [cx + jx * cos - jy * sin, cy + jx * sin + jy * cos];
    };
    const d = shuffle(g.strokes.flatMap(splitStroke))
      .map((s) => {
        const pts = s.pts.map(tf);
        return s.smooth ? smoothPath(pts, s.closed) : linePath(pts);
      })
      .join('');
    const color = hsl(rand(0, 360), rand(45, 75), rand(22, 38));
    glyphPaths.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${f1(rand(2.2, 3))}" stroke-linecap="round" stroke-linejoin="round"/>`);
    x += w + rand(0, 3);
  }
  const W = Math.ceil(x + pad);

  const noise = [];
  for (let i = 0; i < 3; i++) {
    const y0 = rand(8, H - 8);
    const d = `M${f1(rand(0, W * 0.15))} ${f1(y0)}C${f1(rand(W * 0.2, W * 0.45))} ${f1(rand(0, H))} ${f1(rand(W * 0.55, W * 0.8))} ${f1(rand(0, H))} ${f1(rand(W * 0.85, W))} ${f1(rand(8, H - 8))}`;
    const color = hsl(rand(0, 360), rand(40, 70), rand(35, 55));
    noise.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${f1(rand(1, 2))}" stroke-linecap="round" opacity="${f1(rand(0.6, 0.9))}"/>`);
  }
  const dots = Math.round(W / 4);
  for (let i = 0; i < dots; i++) {
    const color = hsl(rand(0, 360), rand(30, 70), rand(30, 70));
    noise.push(`<circle cx="${f1(rand(0, W))}" cy="${f1(rand(0, H))}" r="${f1(rand(0.6, 1.6))}" fill="${color}" opacity="${f1(rand(0.5, 0.9))}"/>`);
  }
  const bg = `<rect width="${W}" height="${H}" rx="6" fill="${hsl(rand(0, 360), 45, 95)}"/>`;
  // 字形与干扰元素交错、打乱先后顺序
  const body = shuffle([...glyphPaths, ...noise]).join('');
  return {
    width: W,
    height: H,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${bg}${body}</svg>`,
  };
}

// ---------------- 答案存储 ----------------
export const TTL_MS = 2 * 60_000;
export const MAX_ENTRIES = 20_000;
// 过期后仍保留一段时间，这期间校验返回 expired 而不是 not_found；之后由定时清理删除
export const EXPIRED_GRACE_MS = 10 * 60_000;
export const SWEEP_INTERVAL_MS = 60_000;

const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
// 把 "八"、"十二"、"二十一"、"八十一" 这类中文数字转成阿拉伯数字（0~99），不是中文数字时原样返回
export function chineseToNumber(s) {
  const m = /^([一二两三四五六七八九])?(十)?([一二三四五六七八九])?$/.exec(s);
  if (Object.hasOwn(CN_DIGIT, s)) return String(CN_DIGIT[s]);
  if (!m || !m[2]) return s;
  return String((m[1] ? CN_DIGIT[m[1]] : 1) * 10 + (m[3] ? CN_DIGIT[m[3]] : 0));
}

export function normalizeAnswer(answer, type) {
  const s = String(answer ?? '').normalize('NFKC').trim().toLowerCase();
  return type === 'math' || type === 'chinese_math' ? chineseToNumber(s) : s;
}

export class CaptchaStore {
  constructor({ ttlMs = TTL_MS, max = MAX_ENTRIES, graceMs = EXPIRED_GRACE_MS, now = () => Date.now() } = {}) {
    Object.assign(this, { ttlMs, max, graceMs, now });
    this.map = new Map();
  }

  get size() {
    return this.map.size;
  }

  add(answer, type) {
    // Map 保持插入顺序，第一个键就是最旧的
    while (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    const token = randomBytes(18).toString('base64url');
    this.map.set(token, { answer, type, expiresAt: this.now() + this.ttlMs });
    return token;
  }

  // 每个 token 只能校验一次：无论对错、是否过期，校验后都删除
  verify(token, answer) {
    const entry = this.map.get(token);
    if (!entry) return { valid: false, reason: 'not_found' };
    this.map.delete(token);
    if (this.now() >= entry.expiresAt) return { valid: false, reason: 'expired' };
    if (normalizeAnswer(answer, entry.type) !== entry.answer) return { valid: false, reason: 'wrong' };
    return { valid: true, reason: 'ok' };
  }

  // 删除过期超过 graceMs 的条目。所有条目有效期相同，插入顺序就是过期顺序，遇到未到期的即可停止
  sweep() {
    const cutoff = this.now() - this.graceMs;
    let removed = 0;
    for (const [token, entry] of this.map) {
      if (entry.expiresAt > cutoff) break;
      this.map.delete(token);
      removed++;
    }
    return removed;
  }
}

export const store = new CaptchaStore();
setInterval(() => store.sweep(), SWEEP_INTERVAL_MS).unref();

export function createCaptcha(type, length, s = store) {
  const { chars, answer } = makeChallenge(type, length);
  const { svg } = renderCaptcha(chars);
  return {
    token: s.add(answer, type),
    image: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
    type,
    expiresIn: s.ttlMs / 1000,
  };
}

export default {
  name: 'captcha',
  category: 'tools',
  title: '图形验证码',
  description: '生成 SVG 图形验证码（字母数字、纯数字、算术题、中文算术题），服务端校验，一次有效',
  source: '本地生成',
  routes: [
    {
      method: 'GET',
      path: '/api/captcha',
      summary: '生成图形验证码（SVG，2 分钟内有效）',
      params: [
        { name: 'type', required: false, default: 'alnum', desc: '类型：alnum（字母数字）、number（纯数字）、math（算术题，如 3+5=?）、chinese_math（中文算术题，如 三加五等于？）', example: 'math' },
        { name: 'length', required: false, default: '4', desc: '字符个数（4~8），只对 alnum 和 number 生效', example: '5' },
      ],
      fields: [
        { name: 'token', type: 'string', desc: '验证码凭证（24 个字符，URL 安全的 Base64），校验时原样传给 /api/captcha/verify 的 token 参数' },
        {
          name: 'image',
          type: 'string',
          desc: '验证码图片，data URI 格式：data:image/svg+xml;base64,<SVG 的 Base64>，可直接用作 <img src>。'
            + '高 50 像素，宽度随字符数变化（约 100~230 像素）；字形用路径绘制（不含 <text> 元素），带随机旋转、偏移、干扰线和噪点',
        },
        { name: 'type', type: 'string', desc: '验证码类型，与请求参数 type 相同：alnum（4~8 位大写字母和数字，不含易混淆的 0、O、1、I）、number（4~8 位数字）、math（两个数的加、减、乘法，答案为非负整数）、chinese_math（中文数字一~十的加减乘，答案为非负整数）' },
        { name: 'expiresIn', type: 'number', desc: '有效期（秒），固定为 120；过期后校验返回 expired' },
      ],
      async handler({ query }) {
        const type = param(query, 'type', { default: 'alnum', oneOf: TYPES });
        const length = param(query, 'length', { default: 4, int: true, min: 4, max: 8 });
        return { data: createCaptcha(type, length) };
      },
    },
    {
      method: 'GET',
      path: '/api/captcha/verify',
      summary: '校验验证码（每个 token 只能校验一次）',
      params: [
        { name: 'token', required: true, desc: '生成验证码时返回的 token', example: 'mZ3xQ0v9b1TqT2c8y5LwKk7A' },
        { name: 'answer', required: true, desc: '用户输入的答案，忽略大小写和首尾空格；算术题填计算结果，也可以写中文数字（如 八）', example: 'A7K9' },
      ],
      fields: [
        { name: 'valid', type: 'boolean', desc: '是否通过校验：只有 reason 为 ok 时为 true' },
        {
          name: 'reason',
          type: 'string',
          desc: '结果原因：ok（答案正确）、wrong（答案错误）、expired（已超过 2 分钟有效期）、not_found（token 不存在：已经校验过、写错了、'
            + '过期超过 10 分钟已被清理，或服务重启、验证码总数超过 20000 条被淘汰）。无论结果如何，token 校验一次后即作废',
        },
      ],
      async handler({ query }) {
        const token = param(query, 'token', { required: true, max: 64 });
        const answer = param(query, 'answer', { required: true, max: 32 });
        return { data: store.verify(token, answer) };
      },
    },
  ],
};

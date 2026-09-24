import { HttpError, param } from '../../lib/http.js';

// 农历数据表 1900–2100：低 4 位闰月月份，bit4..15 为 12 个月大小（1=30 天），bit16 为闰月大小
const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2, // 1900
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977, // 1910
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970, // 1920
  0x06566, 0x0d4a0, 0x0ea50, 0x16a95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950, // 1930
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557, // 1940
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0, // 1950
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0, // 1960
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6, // 1970
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570, // 1980
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0, // 1990
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, // 2000
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930, // 2010
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530, // 2020
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45, // 2030
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0, // 2040
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0, // 2050
  0x092e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4, // 2060
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0, // 2070
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160, // 2080
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252, // 2090
  0x0d520, // 2100
];

export const GAN = '甲乙丙丁戊己庚辛壬癸';
export const ZHI = '子丑寅卯辰巳午未申酉戌亥';
export const ANIMALS = '鼠牛虎兔龙蛇马羊猴鸡狗猪';
const MONTH_NAMES = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
const DAY_TENS = ['初', '十', '廿', '三'];
const DIGITS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

// 从小寒开始（太阳黄经 285°），每 15° 一个
export const SOLAR_TERMS = [
  '小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨', '立夏', '小满', '芒种', '夏至',
  '小暑', '大暑', '立秋', '处暑', '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至',
];

const DAY_MS = 86_400_000;
const BASE_UTC = Date.UTC(1900, 0, 31); // 1900 年正月初一
const MIN_UTC = BASE_UTC;
const MAX_UTC = Date.UTC(2100, 11, 31);

const leapMonth = (y) => LUNAR_INFO[y - 1900] & 0xf;
const leapDays = (y) => (leapMonth(y) ? (LUNAR_INFO[y - 1900] & 0x10000 ? 30 : 29) : 0);
const monthDays = (y, m) => (LUNAR_INFO[y - 1900] & (0x10000 >> m) ? 30 : 29);
function yearDays(y) {
  let sum = 348;
  for (let i = 0x8000; i > 0x8; i >>= 1) if (LUNAR_INFO[y - 1900] & i) sum += 1;
  return sum + leapDays(y);
}

export const lunarMonthName = (m, isLeap = false) => `${isLeap ? '闰' : ''}${MONTH_NAMES[m - 1]}月`;
export function lunarDayName(d) {
  if (d === 10) return '初十';
  if (d === 20) return '二十';
  if (d === 30) return '三十';
  return DAY_TENS[Math.floor(d / 10)] + DIGITS[(d - 1) % 10];
}
const ganzhi = (i) => GAN[((i % 60) + 60) % 10] + ZHI[((i % 60) + 60) % 12];

// 解析 YYYY-MM-DD → UTC 零点毫秒（只用作"日历日"，与时区无关）
export function parseDate(s) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s ?? '');
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t;
}
export const fmtDate = (t) => new Date(t).toISOString().slice(0, 10);
// 北京时间的"今天"
export const todayBeijing = (now = Date.now()) => fmtDate(Math.floor((now + 8 * 3600_000) / DAY_MS) * DAY_MS);

// 公历 → 农历
export function solarToLunar(t) {
  if (t < MIN_UTC || t > MAX_UTC) throw new HttpError(400, '仅支持 1900-01-31 至 2100-12-31');
  let offset = Math.round((t - BASE_UTC) / DAY_MS);
  let year = 1900;
  for (; year < 2101; year++) {
    const n = yearDays(year);
    if (offset < n) break;
    offset -= n;
  }
  const leap = leapMonth(year);
  let month = 1;
  let isLeap = false;
  for (;;) {
    const n = isLeap ? leapDays(year) : monthDays(year, month);
    if (offset < n) break;
    offset -= n;
    if (leap === month && !isLeap) isLeap = true;
    else {
      isLeap = false;
      month += 1;
    }
  }
  const days = isLeap ? leapDays(year) : monthDays(year, month);
  return { year, month, day: offset + 1, isLeap, monthDays: days, leapMonth: leap };
}

// ---- 节气：按太阳视黄经（VSOP87 截断）求解，误差在 1 分钟量级 ----
function deltaT(y) {
  let t;
  if (y < 1920) { t = y - 1900; return -2.79 + 1.494119 * t - 0.0598939 * t ** 2 + 0.0061966 * t ** 3 - 0.000197 * t ** 4; }
  if (y < 1941) { t = y - 1920; return 21.2 + 0.84493 * t - 0.0761 * t ** 2 + 0.0020936 * t ** 3; }
  if (y < 1961) { t = y - 1950; return 29.07 + 0.407 * t - t ** 2 / 233 + t ** 3 / 2547; }
  if (y < 1986) { t = y - 1975; return 45.45 + 1.067 * t - t ** 2 / 260 - t ** 3 / 718; }
  if (y < 2005) {
    t = y - 2000;
    return 63.86 + 0.3345 * t - 0.060374 * t ** 2 + 0.0017275 * t ** 3 + 0.000651814 * t ** 4 + 0.00002373599 * t ** 5;
  }
  if (y < 2050) { t = y - 2000; return 62.92 + 0.32217 * t + 0.005589 * t ** 2; }
  return -20 + 32 * ((y - 1820) / 100) ** 2 - 0.5628 * (2150 - y);
}
const rad = (d) => (d * Math.PI) / 180;
// VSOP87 地球日心黄经截断项（Meeus 表 32.A），[A, B, C]，单位 1e-8 弧度，τ 为儒略千年
const VSOP_L = [
  [[175347046, 0, 0], [3341656, 4.6692568, 6283.07585], [34894, 4.6261, 12566.1517], [3497, 2.7441, 5753.3849],
    [3418, 2.8289, 3.5231], [3136, 3.6277, 77713.7715], [2676, 4.4181, 7860.4194], [2343, 6.1352, 3930.2097],
    [1324, 0.7425, 11506.7698], [1273, 2.0371, 529.691], [1199, 1.1096, 1577.3435], [990, 5.233, 5884.927],
    [902, 2.045, 26.298], [857, 3.508, 398.149], [780, 1.179, 5223.694], [753, 2.533, 5507.553],
    [505, 4.583, 18849.228], [492, 4.205, 775.523], [357, 2.92, 0.067], [317, 5.849, 11790.629],
    [284, 1.899, 796.298], [271, 0.315, 10977.079], [243, 0.345, 5486.778], [206, 4.806, 2544.314],
    [205, 1.869, 5573.143], [202, 2.458, 6069.777], [156, 0.833, 213.299], [132, 3.411, 2942.463],
    [126, 1.083, 20.775], [115, 0.645, 0.98], [103, 0.636, 4694.003], [102, 0.976, 15720.839],
    [102, 4.267, 7.114], [99, 6.21, 2146.17], [98, 0.68, 155.42], [86, 5.98, 161000.69], [85, 1.3, 6275.96],
    [85, 3.67, 71430.7], [80, 1.81, 17260.15], [79, 3.04, 12036.46], [75, 1.76, 5088.63], [74, 3.5, 3154.69],
    [74, 4.68, 801.82], [70, 0.83, 9437.76], [62, 3.98, 8827.39], [61, 1.82, 7084.9], [57, 2.78, 6286.6],
    [56, 4.39, 14143.5], [56, 3.47, 6279.55], [52, 0.19, 12139.55], [52, 1.33, 1748.02], [51, 0.28, 5856.48],
    [49, 0.49, 1194.45], [41, 5.37, 8429.24], [41, 2.4, 19651.05], [39, 6.17, 10447.39], [37, 6.04, 10213.29],
    [37, 2.57, 1059.38], [36, 1.71, 2352.87], [36, 1.78, 6812.77], [33, 0.59, 17789.85], [30, 0.44, 83996.85],
    [30, 2.74, 1349.87], [25, 3.16, 4690.48]],
  [[628331966747, 0, 0], [206059, 2.678235, 6283.07585], [4303, 2.6351, 12566.1517], [425, 1.59, 3.523],
    [119, 5.796, 26.298], [109, 2.966, 1577.344], [93, 2.59, 18849.23], [72, 1.14, 529.69], [68, 1.87, 398.15],
    [67, 4.41, 5507.55], [59, 2.89, 5223.69], [56, 2.17, 155.42], [45, 0.4, 796.3], [36, 0.47, 775.52],
    [29, 2.65, 7.11], [21, 5.34, 0.98], [19, 1.85, 5486.78], [19, 4.97, 213.3], [17, 2.99, 6275.96],
    [16, 0.03, 2544.31], [16, 1.43, 2146.17], [15, 1.21, 10977.08], [12, 2.83, 1748.02], [12, 3.26, 5088.63],
    [12, 5.27, 1194.45], [12, 2.08, 4694], [11, 0.77, 553.57], [10, 1.3, 6286.6], [10, 4.24, 1349.87],
    [9, 2.7, 242.73], [9, 5.64, 951.72], [8, 5.3, 2352.87], [6, 2.65, 9437.76], [6, 4.67, 4690.48]],
  [[52919, 0, 0], [8720, 1.0721, 6283.0758], [309, 0.867, 12566.152], [27, 0.05, 3.52], [16, 5.19, 26.3],
    [16, 3.68, 155.42], [10, 0.76, 18849.23], [9, 2.06, 77713.77], [7, 0.83, 775.52], [5, 4.66, 1577.34],
    [4, 1.03, 7.11], [4, 3.44, 5573.14], [3, 5.14, 796.3], [3, 6.05, 5507.55], [3, 1.19, 242.73],
    [3, 6.12, 529.69], [3, 0.31, 398.15], [3, 2.28, 553.57], [2, 4.38, 5223.69], [2, 3.75, 0.98]],
  [[289, 5.844, 6283.076], [35, 0, 0], [17, 5.49, 12566.15], [3, 5.2, 155.42], [1, 4.72, 3.52],
    [1, 5.3, 18849.23], [1, 5.97, 242.73]],
  [[114, 3.142, 0], [8, 4.13, 6283.08], [1, 3.84, 12566.15]],
  [[1, 3.14, 0]],
];
// 太阳视黄经（度）：VSOP87 截断 + FK5 修正 + 章动 + 光行差，精度约 1″
function sunLongitude(jde) {
  const T = (jde - 2451545) / 36525;
  const tau = T / 10;
  let L = 0;
  for (let i = VSOP_L.length - 1; i >= 0; i--) {
    let s = 0;
    for (const [A, B, C] of VSOP_L[i]) s += A * Math.cos(B + C * tau);
    L = L * tau + s;
  }
  L = (L / 1e8) * (180 / Math.PI) + 180; // 日心 → 地心
  const Ls = rad(280.4665 + 36000.7698 * T);
  const Lm = rad(218.3165 + 481267.8813 * T);
  const omega = rad(125.04452 - 1934.136261 * T);
  const nutation = -17.2 * Math.sin(omega) - 1.32 * Math.sin(2 * Ls) - 0.23 * Math.sin(2 * Lm) + 0.21 * Math.sin(2 * omega);
  const lambda = L + (-0.09033 + nutation - 20.4898) / 3600;
  return ((lambda % 360) + 360) % 360;
}

const termCache = new Map();
// 返回某年第 k 个节气（0=小寒）的北京时间时刻（毫秒，UTC 基准）
export function solarTermTime(year, k) {
  const key = year * 100 + k;
  if (termCache.has(key)) return termCache.get(key);
  const target = (285 + 15 * k) % 360;
  const dt = deltaT(year) / 86400;
  // 初值：1 月 6 日 + k * 15.22 天
  let jd = (Date.UTC(year, 0, 6) / DAY_MS + 2440587.5) + k * 15.2184;
  for (let i = 0; i < 8; i++) {
    let diff = target - sunLongitude(jd + dt);
    diff = ((diff + 540) % 360) - 180;
    jd += (diff / 360) * 365.2422;
    if (Math.abs(diff) < 1e-7) break;
  }
  const ms = (jd - 2440587.5) * DAY_MS + 8 * 3600_000;
  termCache.set(key, ms);
  return ms;
}
// 节气当天（北京时间日历日，UTC 零点毫秒）
export const solarTermDay = (year, k) => Math.floor(solarTermTime(year, k) / DAY_MS) * DAY_MS;

// 返回 t 当天的节气，以及此前最近/此后最近的节气
export function solarTermsAround(t) {
  const year = new Date(t).getUTCFullYear();
  const list = [];
  for (const y of [year - 1, year, year + 1]) {
    for (let k = 0; k < 24; k++) list.push({ name: SOLAR_TERMS[k], day: solarTermDay(y, k), time: solarTermTime(y, k) });
  }
  const today = list.find((x) => x.day === t) ?? null;
  const prev = list.filter((x) => x.day <= t).at(-1);
  const next = list.find((x) => x.day > t);
  const toOut = (x) => x && { name: x.name, date: fmtDate(x.day), time: new Date(x.time).toISOString().slice(0, 16).replace('T', ' ') };
  return { today: today?.name ?? null, current: toOut(prev), next: next && { ...toOut(next), days: Math.round((next.day - t) / DAY_MS) } };
}

// ---- 干支 ----
export function ganzhiOf(t, lunar = solarToLunar(t)) {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const dayIdx = Math.round(t / DAY_MS) + 25567 + 10; // 1970-01-01 起算，0=甲子
  // 月柱以"节"为界：公历 m 月的节是第 2*(m-1) 个节气（小寒、立春、惊蛰…）
  const jie = solarTermDay(y, 2 * (m - 1));
  const monthIdx = (y - 1900) * 12 + m + 11 + (t >= jie ? 1 : 0);
  return {
    year: ganzhi(lunar.year - 4), // 按农历年（正月初一）换年
    month: ganzhi(monthIdx),
    day: ganzhi(dayIdx),
    monthZhi: ((monthIdx % 12) + 12) % 12,
    dayZhi: ((dayIdx % 12) + 12) % 12,
  };
}

// ---- 节日 ----
const LUNAR_FESTIVALS = {
  '1-1': '春节', '1-15': '元宵节', '2-2': '龙抬头', '5-5': '端午节', '7-7': '七夕节',
  '7-15': '中元节', '8-15': '中秋节', '9-9': '重阳节', '12-8': '腊八节', '12-23': '北方小年', '12-24': '南方小年',
};
const SOLAR_FESTIVALS = {
  '1-1': '元旦', '2-14': '情人节', '3-8': '妇女节', '3-12': '植树节', '4-1': '愚人节', '5-1': '劳动节',
  '5-4': '青年节', '6-1': '儿童节', '7-1': '建党节', '8-1': '建军节', '9-10': '教师节', '10-1': '国庆节',
  '12-24': '平安夜', '12-25': '圣诞节',
};
function festivalsOf(t, lunar, termToday) {
  const d = new Date(t);
  const out = [];
  const s = SOLAR_FESTIVALS[`${d.getUTCMonth() + 1}-${d.getUTCDate()}`];
  if (s) out.push(s);
  if (!lunar.isLeap) {
    const l = LUNAR_FESTIVALS[`${lunar.month}-${lunar.day}`];
    if (l) out.push(l);
    if (lunar.month === 12 && lunar.day === lunar.monthDays) out.push('除夕');
  }
  if (termToday === '清明') out.push('清明节');
  // 母亲节：5 月第 2 个周日；父亲节：6 月第 3 个周日
  const wd = d.getUTCDay();
  const nth = Math.ceil(d.getUTCDate() / 7);
  if (wd === 0 && d.getUTCMonth() === 4 && nth === 2) out.push('母亲节');
  if (wd === 0 && d.getUTCMonth() === 5 && nth === 3) out.push('父亲节');
  return out;
}

// ---- 建除十二值与宜忌（通书常用简化对照） ----
const JIANCHU = [
  { name: '建', yi: ['出行', '上任', '会友', '求职', '祭祀'], ji: ['动土', '开仓', '掘井', '乘船'] },
  { name: '除', yi: ['除服', '疗病', '祭祀', '沐浴', '扫舍'], ji: ['嫁娶', '远行', '赴任'] },
  { name: '满', yi: ['祭祀', '祈福', '开市', '交易', '立券', '纳财'], ji: ['栽种', '安葬', '赴任', '求医'] },
  { name: '平', yi: ['修饰垣墙', '平治道涂', '祭祀'], ji: ['开渠', '栽种', '嫁娶', '移徙'] },
  { name: '定', yi: ['祭祀', '祈福', '嫁娶', '造屋', '纳畜', '入学'], ji: ['诉讼', '出行', '交涉'] },
  { name: '执', yi: ['祭祀', '祈福', '捕捉', '纳采', '立券'], ji: ['开市', '出行', '移徙', '开仓'] },
  { name: '破', yi: ['破屋坏垣', '求医治病'], ji: ['嫁娶', '开市', '出行', '动土', '立券'] },
  { name: '危', yi: ['祭祀', '祈福', '安床', '结网'], ji: ['登山', '乘船', '出行', '嫁娶'] },
  { name: '成', yi: ['嫁娶', '开市', '入学', '出行', '移徙', '立券'], ji: ['诉讼'] },
  { name: '收', yi: ['纳财', '捕捉', '纳畜', '入学', '收养'], ji: ['出行', '安葬', '开市'] },
  { name: '开', yi: ['开市', '祭祀', '入学', '嫁娶', '出行', '求职'], ji: ['安葬', '动土', '伐木'] },
  { name: '闭', yi: ['筑堤', '补垣', '塞穴', '安葬'], ji: ['开市', '出行', '求医', '动土', '嫁娶'] },
];
const SHA = ['南', '东', '北', '西']; // 申子辰煞南、巳酉丑煞东、寅午戌煞北、亥卯未煞西，按日支 %4

export function almanacOf(gz) {
  const jc = JIANCHU[(gz.dayZhi - gz.monthZhi + 12) % 12];
  const chongZhi = (gz.dayZhi + 6) % 12;
  return {
    jianchu: jc.name,
    yi: jc.yi,
    ji: jc.ji,
    chong: `冲${ANIMALS[chongZhi]}`,
    sha: `煞${SHA[gz.dayZhi % 4]}`,
  };
}

const yearDigits = (y) => String(y).replace(/\d/g, (c) => '〇一二三四五六七八九'[c]);

// 完整农历/黄历信息
export function getLunarInfo(dateStr) {
  const t = parseDate(dateStr);
  if (t == null) throw new HttpError(400, 'date 格式应为 YYYY-MM-DD');
  const lunar = solarToLunar(t);
  const gz = ganzhiOf(t, lunar);
  const zodiac = ANIMALS[(((lunar.year - 4) % 12) + 12) % 12];
  const terms = solarTermsAround(t);
  const monthName = lunarMonthName(lunar.month, lunar.isLeap);
  const dayName = lunarDayName(lunar.day);
  return {
    date: fmtDate(t),
    weekday: WEEKDAYS[new Date(t).getUTCDay()],
    lunar: {
      year: lunar.year,
      month: lunar.month,
      day: lunar.day,
      isLeap: lunar.isLeap,
      monthName,
      dayName,
      monthDays: lunar.monthDays,
      text: `${yearDigits(lunar.year)}年${monthName}${dayName}`,
    },
    ganzhi: { year: gz.year, month: gz.month, day: gz.day },
    zodiac,
    yearName: `${gz.year}${zodiac}年`,
    solarTerm: terms,
    festivals: festivalsOf(t, lunar, terms.today),
    almanac: almanacOf(gz),
  };
}

export default {
  name: 'lunar',
  category: 'life',
  title: '农历黄历',
  description: '农历、干支、生肖、二十四节气、传统节日与每日宜忌（本地计算）',
  source: '本地计算（农历表 1900–2100 + 天文算法节气）',
  routes: [
    {
      method: 'GET',
      path: '/api/lunar',
      summary: '查询某天的农历、干支、节气、节日与宜忌',
      params: [
        { name: 'date', required: false, desc: '公历日期 YYYY-MM-DD，默认今天（北京时间）', example: '2026-02-17' },
      ],
      fields: [
        { name: 'date', type: 'string', desc: '公历日期，YYYY-MM-DD（月、日补足两位）' },
        { name: 'weekday', type: 'string', desc: '星期几，如 星期四' },
        { name: 'lunar', type: 'object', desc: '农历日期' },
        { name: 'lunar.year', type: 'number', desc: '农历年，用公历纪年数字表示，以正月初一换年（如 2026-02-16 除夕仍属 2025 年）' },
        { name: 'lunar.month', type: 'number', desc: '农历月份数字 1–12；闰月时为被闰的月份（如闰二月为 2），需结合 isLeap 判断' },
        { name: 'lunar.day', type: 'number', desc: '农历日 1–30' },
        { name: 'lunar.isLeap', type: 'boolean', desc: '当月是否为闰月' },
        { name: 'lunar.monthName', type: 'string', desc: '农历月中文名：正月、二月……十月、冬月（十一月）、腊月（十二月），闰月前加"闰"（如 闰二月）' },
        { name: 'lunar.dayName', type: 'string', desc: '农历日中文名：初一……初十、十一……二十、廿一……廿九、三十' },
        { name: 'lunar.monthDays', type: 'number', desc: '本农历月的天数：29（小月）或 30（大月）' },
        { name: 'lunar.text', type: 'string', desc: '完整的中文农历日期，如 二〇二六年正月初一' },
        { name: 'ganzhi', type: 'object', desc: '干支纪法：十天干（甲乙丙丁戊己庚辛壬癸）与十二地支（子丑寅卯辰巳午未申酉戌亥）依次相配，60 个一循环' },
        { name: 'ganzhi.year', type: 'string', desc: '年干支（年柱），如 丙午；以农历正月初一换年，不是以立春换年' },
        { name: 'ganzhi.month', type: 'string', desc: '月干支（月柱），如 庚寅；以十二"节"（立春、惊蛰、清明、立夏、芒种、小暑、立秋、白露、寒露、立冬、大雪、小寒）的交节日换月，而不是以农历初一换月' },
        { name: 'ganzhi.day', type: 'string', desc: '日干支（日柱），如 戊午' },
        { name: 'zodiac', type: 'string', desc: '生肖（鼠牛虎兔龙蛇马羊猴鸡狗猪之一），按农历年，正月初一换' },
        { name: 'yearName', type: 'string', desc: '年份名称：年干支 + 生肖 + 年，如 丙午马年' },
        { name: 'solarTerm', type: 'object', desc: '二十四节气信息（按天文算法计算太阳黄经，北京时间，交节时刻误差约 1 分钟）' },
        { name: 'solarTerm.today', type: 'string|null', desc: '当天交节的节气名称（如 秋分）；当天不是节气时为 null' },
        { name: 'solarTerm.current', type: 'object', desc: '当前所处的节气，即当天或之前最近一次交节的节气' },
        { name: 'solarTerm.current.name', type: 'string', desc: '节气名称' },
        { name: 'solarTerm.current.date', type: 'string', desc: '交节日期，YYYY-MM-DD（北京时间）' },
        { name: 'solarTerm.current.time', type: 'string', desc: '交节时刻，YYYY-MM-DD HH:mm（北京时间 UTC+8）' },
        { name: 'solarTerm.next', type: 'object', desc: '下一个节气（交节日期晚于当天）' },
        { name: 'solarTerm.next.name', type: 'string', desc: '节气名称' },
        { name: 'solarTerm.next.date', type: 'string', desc: '交节日期，YYYY-MM-DD（北京时间）' },
        { name: 'solarTerm.next.time', type: 'string', desc: '交节时刻，YYYY-MM-DD HH:mm（北京时间 UTC+8）' },
        { name: 'solarTerm.next.days', type: 'number', desc: '距下一个节气还有几天' },
        { name: 'festivals', type: 'array', desc: '当天的节日名称（字符串数组），依次为公历节日（元旦、情人节、妇女节、植树节、愚人节、劳动节、青年节、儿童节、建党节、建军节、教师节、国庆节、平安夜、圣诞节）、农历节日（春节、元宵节、龙抬头、端午节、七夕节、中元节、中秋节、重阳节、腊八节、北方小年、南方小年、除夕；闰月不计）、清明节（清明节气当天）、母亲节（5 月第二个周日）、父亲节（6 月第三个周日）。没有节日时为空数组' },
        { name: 'almanac', type: 'object', desc: '黄历宜忌（按通书建除十二值的简化对照推算，仅供民俗参考）' },
        { name: 'almanac.jianchu', type: 'string', desc: '建除十二值（建、除、满、平、定、执、破、危、成、收、开、闭之一），由月支与日支推算：日支与月支相同为"建"，依次顺推' },
        { name: 'almanac.yi', type: 'array', desc: '宜：适合做的事（字符串数组，如 祭祀、祈福、开市），由建除值决定' },
        { name: 'almanac.ji', type: 'array', desc: '忌：不宜做的事（字符串数组，如 动土、出行），由建除值决定' },
        { name: 'almanac.chong', type: 'string', desc: '冲：与当日日支相冲（地支相隔 6 位）的生肖，如 冲狗' },
        { name: 'almanac.sha', type: 'string', desc: '煞：当日煞方，煞东/煞南/煞西/煞北之一（申子辰日煞南、巳酉丑日煞东、寅午戌日煞北、亥卯未日煞西）' },
      ],
      async handler({ query }) {
        const date = param(query, 'date', { default: todayBeijing(), pattern: /^\d{4}-\d{1,2}-\d{1,2}$/ });
        return { data: getLunarInfo(date) };
      },
    },
  ],
};

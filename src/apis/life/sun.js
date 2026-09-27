import { HttpError, param } from '../../lib/http.js';
import { num, round } from './calc-util.js';
import { parseDate } from './lunar.js';
import { DAY_MS, WEEKDAYS, zoneOrThrow, zonedParts, zoneOffset, fmtOffset, fmtYMD, fmtHM, localIso } from './tz-util.js';

const RAD = Math.PI / 180;
const sin = (d) => Math.sin(d * RAD);
const cos = (d) => Math.cos(d * RAD);
const norm360 = (d) => ((d % 360) + 360) % 360;
const toJD = (ms) => ms / DAY_MS + 2440587.5;
const fromJD = (jd) => (jd - 2440587.5) * DAY_MS;
const DATE_RE = /^\d{4}-\d{1,2}-\d{1,2}$/;
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

// ---------------- 太阳（NOAA 太阳位置算法） ----------------

// 某一时刻（UTC 毫秒）的太阳赤纬（度）与时差（分钟）
export function solarPosition(ms) {
  const T = (toJD(ms) - 2451545) / 36525;
  const L0 = norm360(280.46646 + T * (36000.76983 + T * 0.0003032));
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = sin(M) * (1.914602 - T * (0.004817 + 0.000014 * T)) + sin(2 * M) * (0.019993 - 0.000101 * T) + sin(3 * M) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * sin(omega);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * cos(omega);
  const decl = Math.asin(sin(eps) * sin(lambda)) / RAD;
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eqTime = 4 / RAD * (y * sin(2 * L0) - 2 * e * sin(M) + 4 * e * y * sin(M) * cos(2 * L0)
    - 0.5 * y * y * sin(4 * L0) - 1.25 * e * e * sin(2 * M));
  return { decl, eqTime };
}

// 太阳中天（真太阳时正午）时刻：dayUtc 为该日 UTC 零点
function solarNoon(dayUtc, lon) {
  let t = dayUtc + (720 - 4 * lon) * 60_000;
  for (let i = 0; i < 3; i++) t = dayUtc + (720 - 4 * lon - solarPosition(t).eqTime) * 60_000;
  return t;
}

// 太阳高度到达 altitude（度）的时刻；rising=true 为上升（日出侧）。
// 返回 { ms } 或 { ms: null, reason: 'above' | 'below' }（全天都高于/低于该高度）
function sunEvent(noon, lat, lon, altitude, rising) {
  let t = noon;
  for (let i = 0; i < 5; i++) {
    const { decl } = solarPosition(t);
    const cosH = (sin(altitude) - sin(lat) * sin(decl)) / (cos(lat) * cos(decl));
    if (cosH < -1) return { ms: null, reason: 'above' };
    if (cosH > 1) return { ms: null, reason: 'below' };
    const H = Math.acos(cosH) / RAD;
    // 以事件时刻附近的太阳位置重新求中天，再加减时角
    const dayUtc = Math.floor(t / DAY_MS) * DAY_MS;
    let n = solarNoon(dayUtc, lon);
    if (Math.abs(n - noon) > DAY_MS / 2) n = noon;
    t = n + (rising ? -1 : 1) * H * 4 * 60_000;
  }
  return { ms: t };
}

const SUNRISE_ALT = -0.833; // 考虑大气折射与太阳视半径
const CIVIL_ALT = -6;

// 计算某地某日（该时区的日历日）的日出日落
export function computeSun({ lat, lon, date, tz = 'Asia/Shanghai' }) {
  const t = parseDate(date);
  if (t == null) throw new HttpError(400, 'date 不是有效日期（格式 YYYY-MM-DD）');
  const d = new Date(t);
  const target = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  // 以 UTC 日为基准求中天，再按时区校正到正确的本地日期
  let noon = solarNoon(t, lon);
  for (let i = 0, base = t; i < 2; i++) {
    const p = zonedParts(noon, tz);
    const diff = Math.round((Date.UTC(p.year, p.month - 1, p.day) - t) / DAY_MS);
    if (diff === 0) break;
    base -= diff * DAY_MS;
    noon = solarNoon(base, lon);
  }
  const rise = sunEvent(noon, lat, lon, SUNRISE_ALT, true);
  const set = sunEvent(noon, lat, lon, SUNRISE_ALT, false);
  const dawn = sunEvent(noon, lat, lon, CIVIL_ALT, true);
  const dusk = sunEvent(noon, lat, lon, CIVIL_ALT, false);
  const { decl } = solarPosition(noon);
  let status = 'normal';
  if (rise.reason === 'above') status = 'polar_day';
  else if (rise.reason === 'below') status = 'polar_night';
  const dayMinutes = status === 'polar_day' ? 1440 : status === 'polar_night' ? 0 : Math.round((set.ms - rise.ms) / 60_000);
  const local = (ms) => (ms == null ? null : fmtHM(zonedParts(ms, tz)));
  const iso = (ms) => (ms == null ? null : localIso(ms, tz));
  return {
    date: fmtYMD(target),
    weekday: WEEKDAYS[d.getUTCDay()],
    lat,
    lon,
    tz,
    utcOffset: fmtOffset(zoneOffset(noon, tz)),
    status,
    statusText: { normal: '正常日出日落', polar_day: '极昼（太阳全天不落）', polar_night: '极夜（太阳全天不升）' }[status],
    sunrise: local(rise.ms),
    sunset: local(set.ms),
    solarNoon: local(noon),
    civilDawn: local(dawn.ms),
    civilDusk: local(dusk.ms),
    dayLength: `${Math.floor(dayMinutes / 60)} 小时 ${dayMinutes % 60} 分`,
    dayLengthMinutes: dayMinutes,
    noonAltitude: round(90 - Math.abs(lat - decl), 2),
    iso: {
      sunrise: iso(rise.ms),
      sunset: iso(set.ms),
      solarNoon: iso(noon),
      civilDawn: iso(dawn.ms),
      civilDusk: iso(dusk.ms),
    },
  };
}

// ---------------- 月亮（Meeus《天文算法》第 48、49 章） ----------------

export const SYNODIC_MONTH = 29.530588861;

// ΔT（TT − UT，秒）的粗略多项式，足够月相时刻精确到分钟
function deltaT(year) {
  const t = year - 2000;
  if (year >= 2005 && year < 2050) return 62.92 + 0.32217 * t + 0.005589 * t * t;
  if (year >= 1986 && year < 2005) return 63.86 + 0.3345 * t - 0.060374 * t ** 2 + 0.0017275 * t ** 3 + 0.000651814 * t ** 4 + 0.00002373599 * t ** 5;
  if (year >= 1961 && year < 1986) { const u = year - 1975; return 45.45 + 1.067 * u - u * u / 260 - u ** 3 / 718; }
  if (year >= 1941 && year < 1961) { const u = year - 1950; return 29.07 + 0.407 * u - u * u / 233 + u ** 3 / 2547; }
  if (year >= 1920 && year < 1941) { const u = year - 1920; return 21.2 + 0.84493 * u - 0.0761 * u * u + 0.0020936 * u ** 3; }
  if (year >= 1900 && year < 1920) { const u = year - 1900; return -2.79 + 1.494119 * u - 0.0598939 * u * u + 0.0061966 * u ** 3 - 0.000197 * u ** 4; }
  const u = (year - 1820) / 100;
  return -20 + 32 * u * u - 0.5628 * (2150 - year);
}

// 第 k 个月相的真实时刻（UTC 毫秒）。k 为整数=新月，+0.25 上弦，+0.5 满月，+0.75 下弦
export function moonPhaseTime(k) {
  const T = k / 1236.85;
  let jde = 2451550.09766 + 29.530588861 * k + 0.00015437 * T * T - 0.00000015 * T ** 3 + 0.00000000073 * T ** 4;
  const E = 1 - 0.002516 * T - 0.0000074 * T * T;
  const M = 2.5534 + 29.1053567 * k - 0.0000014 * T * T - 0.00000011 * T ** 3;
  const Mp = 201.5643 + 385.81693528 * k + 0.0107582 * T * T + 0.00001238 * T ** 3 - 0.000000058 * T ** 4;
  const F = 160.7108 + 390.67050284 * k - 0.0016118 * T * T - 0.00000227 * T ** 3 + 0.000000011 * T ** 4;
  const O = 124.7746 - 1.56375588 * k + 0.0020672 * T * T + 0.00000215 * T ** 3;
  const frac = ((k % 1) + 1) % 1;
  let c;
  if (frac === 0 || frac === 0.5) {
    const full = frac === 0.5;
    c = (full ? -0.40614 : -0.4072) * sin(Mp) + (full ? 0.17302 : 0.17241) * E * sin(M)
      + (full ? 0.01614 : 0.01608) * sin(2 * Mp) + (full ? 0.01043 : 0.01039) * sin(2 * F)
      + (full ? 0.00734 : 0.00739) * E * sin(Mp - M) - (full ? 0.00515 : 0.00514) * E * sin(Mp + M)
      + (full ? 0.00209 : 0.00208) * E * E * sin(2 * M) - 0.00111 * sin(Mp - 2 * F) - 0.00057 * sin(Mp + 2 * F)
      + 0.00056 * E * sin(2 * Mp + M) - 0.00042 * sin(3 * Mp) + 0.00042 * E * sin(M + 2 * F)
      + 0.00038 * E * sin(M - 2 * F) - 0.00024 * E * sin(2 * Mp - M) - 0.00017 * sin(O)
      - 0.00007 * sin(Mp + 2 * M) + 0.00004 * sin(2 * Mp - 2 * F) + 0.00004 * sin(3 * M)
      + 0.00003 * sin(Mp + M - 2 * F) + 0.00003 * sin(2 * Mp + 2 * F) - 0.00003 * sin(Mp + M + 2 * F)
      + 0.00003 * sin(Mp - M + 2 * F) - 0.00002 * sin(Mp - M - 2 * F) - 0.00002 * sin(3 * Mp + M)
      + 0.00002 * sin(4 * Mp);
  } else {
    c = -0.62801 * sin(Mp) + 0.17172 * E * sin(M) - 0.01183 * E * sin(Mp + M) + 0.00862 * sin(2 * Mp)
      + 0.00804 * sin(2 * F) + 0.00454 * E * sin(Mp - M) + 0.00204 * E * E * sin(2 * M)
      - 0.0018 * sin(Mp - 2 * F) - 0.0007 * sin(Mp + 2 * F) - 0.0004 * sin(3 * Mp)
      - 0.00034 * E * sin(2 * Mp - M) + 0.00032 * E * sin(M + 2 * F) + 0.00032 * E * sin(M - 2 * F)
      - 0.00028 * E * E * sin(Mp + 2 * M) + 0.00027 * E * sin(2 * Mp + M) - 0.00017 * sin(O)
      - 0.00005 * sin(Mp - M - 2 * F) + 0.00004 * sin(2 * Mp + 2 * F) - 0.00004 * sin(Mp + M + 2 * F)
      + 0.00004 * sin(Mp - 2 * M) + 0.00003 * sin(Mp + M - 2 * F) + 0.00003 * sin(3 * M)
      + 0.00002 * sin(2 * Mp - 2 * F) + 0.00002 * sin(Mp - M + 2 * F) - 0.00002 * sin(3 * Mp + M);
    const W = 0.00306 - 0.00038 * E * cos(M) + 0.00026 * cos(Mp) - 0.00002 * cos(Mp - M) + 0.00002 * cos(Mp + M) + 0.00002 * cos(2 * F);
    c += frac === 0.25 ? W : -W;
  }
  jde += c;
  // 行星摄动附加项
  const A = [
    [299.77 + 0.107408 * k - 0.009173 * T * T, 0.000325], [251.88 + 0.016321 * k, 0.000165], [251.83 + 26.651886 * k, 0.000164],
    [349.42 + 36.412478 * k, 0.000126], [84.66 + 18.206239 * k, 0.00011], [141.74 + 53.303771 * k, 0.000062],
    [207.14 + 2.453732 * k, 0.00006], [154.84 + 7.30686 * k, 0.000056], [34.52 + 27.261239 * k, 0.000047],
    [207.19 + 0.121824 * k, 0.000042], [291.34 + 1.844379 * k, 0.00004], [161.72 + 24.198154 * k, 0.000037],
    [239.56 + 25.513099 * k, 0.000035], [331.55 + 3.592518 * k, 0.000023],
  ];
  for (const [a, w] of A) jde += w * sin(a);
  const year = 2000 + k / 12.3685;
  return fromJD(jde) - deltaT(year) * 1000;
}

// 某时刻之前最近的一个新月的 k
function prevNewMoonK(ms) {
  let k = Math.floor((ms - Date.UTC(2000, 0, 6, 18, 14)) / (SYNODIC_MONTH * DAY_MS));
  while (moonPhaseTime(k) > ms) k--;
  while (moonPhaseTime(k + 1) <= ms) k++;
  return k;
}

// 某时刻的月面照亮比例（0–1）与是否渐盈（Meeus 第 48 章简化公式）
export function moonIllumination(ms) {
  const T = (toJD(ms) - 2451545) / 36525;
  const D = norm360(297.8501921 + 445267.1114034 * T - 0.0018819 * T * T);
  const M = norm360(357.5291092 + 35999.0502909 * T - 0.0001536 * T * T);
  const Mp = norm360(134.9633964 + 477198.8675055 * T + 0.0087414 * T * T);
  const i = 180 - D - 6.289 * sin(Mp) + 2.1 * sin(M) - 1.274 * sin(2 * D - Mp) - 0.658 * sin(2 * D) - 0.214 * sin(2 * Mp) - 0.11 * sin(D);
  return { fraction: (1 + cos(i)) / 2, waxing: D < 180 };
}

const PHASES = {
  new: '新月', waxingCrescent: '蛾眉月', firstQuarter: '上弦月', waxingGibbous: '盈凸月',
  full: '满月', waningGibbous: '亏凸月', lastQuarter: '下弦月', waningCrescent: '残月',
};
const PRINCIPAL = ['new', 'firstQuarter', 'full', 'lastQuarter'];
const BETWEEN = ['waxingCrescent', 'waxingGibbous', 'waningGibbous', 'waningCrescent'];

// 月相：at 为计算时刻（UTC 毫秒），tz 用于判断"当天"是否恰逢朔/上弦/望/下弦
export function moonPhase(at, tz = 'Asia/Shanghai') {
  const k0 = prevNewMoonK(at);
  const events = [];
  for (let k = k0 - 1; k <= k0 + 2; k++) for (let q = 0; q < 4; q++) events.push({ q, ms: moonPhaseTime(k + q / 4) });
  const p = zonedParts(at, tz);
  const ymd = fmtYMD(p);
  const sameDay = events.find((e) => fmtYMD(zonedParts(e.ms, tz)) === ymd);
  let key;
  if (sameDay) key = PRINCIPAL[sameDay.q];
  else key = BETWEEN[events.filter((e) => e.ms <= at).at(-1).q];
  const prevNew = moonPhaseTime(k0);
  const nextNew = events.find((e) => e.q === 0 && e.ms > at).ms;
  const nextFull = events.find((e) => e.q === 2 && e.ms > at).ms;
  const { fraction, waxing } = moonIllumination(at);
  const fmt = (ms) => ({ date: fmtYMD(zonedParts(ms, tz)), time: fmtHM(zonedParts(ms, tz)), iso: localIso(ms, tz), days: round((ms - at) / DAY_MS, 1) });
  return {
    phase: PHASES[key],
    phaseKey: key,
    illumination: round(fraction * 100, 1),
    waxing,
    age: round((at - prevNew) / DAY_MS, 1),
    lastNewMoon: { date: fmtYMD(zonedParts(prevNew, tz)), time: fmtHM(zonedParts(prevNew, tz)), iso: localIso(prevNew, tz) },
    nextNewMoon: fmt(nextNew),
    nextFullMoon: fmt(nextFull),
  };
}

// ---------------- 参数与路由 ----------------

function readCommon(query) {
  const lat = num(query, 'lat', { required: true, min: -90, max: 90, unit: '纬度，北纬为正' });
  const lon = num(query, 'lon', { required: true, min: -180, max: 180, unit: '经度，东经为正' });
  const tz = zoneOrThrow(param(query, 'tz', { default: 'Asia/Shanghai', max: 64 }));
  const date = param(query, 'date', { pattern: DATE_RE });
  return { lat, lon, tz, date };
}

function checkDate(date) {
  const t = parseDate(date);
  if (t == null) throw new HttpError(400, 'date 不是有效日期（格式 YYYY-MM-DD）');
  const y = new Date(t).getUTCFullYear();
  if (y < MIN_YEAR || y > MAX_YEAR) throw new HttpError(400, `date 超出范围（${MIN_YEAR}–${MAX_YEAR} 年）`);
  return t;
}

const todayIn = (tz, now = Date.now()) => fmtYMD(zonedParts(now, tz));

const MOON_FIELDS = (prefix) => [
  { name: `${prefix}phase`, type: 'string', desc: '月相名称：新月、蛾眉月、上弦月、盈凸月、满月、亏凸月、下弦月、残月（当天恰逢朔/上弦/望/下弦时刻时为新月/上弦月/满月/下弦月）' },
  { name: `${prefix}phaseKey`, type: 'string', desc: '月相英文键：new / waxingCrescent / firstQuarter / waxingGibbous / full / waningGibbous / lastQuarter / waningCrescent' },
  { name: `${prefix}illumination`, type: 'number', desc: '月面被照亮的比例（%），0 为新月、100 为满月' },
  { name: `${prefix}waxing`, type: 'boolean', desc: 'true 为渐盈（新月→满月），false 为渐亏（满月→新月）' },
  { name: `${prefix}age`, type: 'number', desc: '月龄：距上一次新月（朔）的天数，保留 1 位小数' },
  { name: `${prefix}lastNewMoon`, type: 'object', desc: '上一次新月（朔）时刻' },
  { name: `${prefix}lastNewMoon.date`, type: 'string', desc: '本地日期 YYYY-MM-DD' },
  { name: `${prefix}lastNewMoon.time`, type: 'string', desc: '本地时刻 HH:mm' },
  { name: `${prefix}lastNewMoon.iso`, type: 'string', desc: '带时区偏移的 ISO 8601 时间' },
  { name: `${prefix}nextNewMoon`, type: 'object', desc: '下一次新月（朔）' },
  { name: `${prefix}nextNewMoon.date`, type: 'string', desc: '本地日期 YYYY-MM-DD' },
  { name: `${prefix}nextNewMoon.time`, type: 'string', desc: '本地时刻 HH:mm' },
  { name: `${prefix}nextNewMoon.iso`, type: 'string', desc: '带时区偏移的 ISO 8601 时间' },
  { name: `${prefix}nextNewMoon.days`, type: 'number', desc: '距今还有多少天（1 位小数）' },
  { name: `${prefix}nextFullMoon`, type: 'object', desc: '下一次满月（望）' },
  { name: `${prefix}nextFullMoon.date`, type: 'string', desc: '本地日期 YYYY-MM-DD' },
  { name: `${prefix}nextFullMoon.time`, type: 'string', desc: '本地时刻 HH:mm' },
  { name: `${prefix}nextFullMoon.iso`, type: 'string', desc: '带时区偏移的 ISO 8601 时间' },
  { name: `${prefix}nextFullMoon.days`, type: 'number', desc: '距今还有多少天（1 位小数）' },
];

const COMMON_PARAMS = [
  { name: 'lat', required: true, desc: '纬度 -90~90，北纬为正', example: '31.23' },
  { name: 'lon', required: true, desc: '经度 -180~180，东经为正', example: '121.47' },
  { name: 'date', required: false, desc: '日期 YYYY-MM-DD（1900–2100），默认该时区的今天', example: '2026-06-21' },
  { name: 'tz', required: false, default: 'Asia/Shanghai', desc: 'IANA 时区名，输出时间按该时区显示', example: 'Asia/Shanghai' },
];

export default {
  name: 'sun',
  category: 'life',
  title: '日出日落与月相',
  description: '按经纬度计算日出、日落、正午、民用晨昏蒙影与白昼时长，以及月相、月面亮度和下次满月/新月（本地天文计算）',
  source: '本地计算（NOAA 太阳位置算法 + Meeus《天文算法》月相）',
  routes: [
    {
      method: 'GET',
      path: '/api/sun',
      summary: '某地某日的日出日落、白昼时长与月相',
      params: COMMON_PARAMS,
      fields: [
        { name: 'date', type: 'string', desc: '日期 YYYY-MM-DD（所选时区的日历日）' },
        { name: 'weekday', type: 'string', desc: '星期几，如 星期日' },
        { name: 'lat', type: 'number', desc: '纬度' },
        { name: 'lon', type: 'number', desc: '经度' },
        { name: 'tz', type: 'string', desc: '时区（IANA 名）' },
        { name: 'utcOffset', type: 'string', desc: '当天该时区相对 UTC 的偏移，如 +08:00' },
        { name: 'status', type: 'string', desc: '日照状态：normal（正常）、polar_day（极昼，全天不落）、polar_night（极夜，全天不升）' },
        { name: 'statusText', type: 'string', desc: '日照状态的中文说明' },
        { name: 'sunrise', type: 'string|null', desc: '日出时间 HH:mm（本地时间，太阳上缘升出地平线，已计大气折射）；极昼/极夜时为 null' },
        { name: 'sunset', type: 'string|null', desc: '日落时间 HH:mm；极昼/极夜时为 null' },
        { name: 'solarNoon', type: 'string', desc: '正午（太阳中天、高度最高）时间 HH:mm' },
        { name: 'civilDawn', type: 'string|null', desc: '民用晨光始（太阳高度 -6°，天开始亮）HH:mm；高纬度夏季整夜不暗或极夜全天不到 -6° 时为 null' },
        { name: 'civilDusk', type: 'string|null', desc: '民用昏影终（太阳高度 -6°，天基本黑）HH:mm；无此现象时为 null' },
        { name: 'dayLength', type: 'string', desc: '白昼时长中文，如 14 小时 50 分' },
        { name: 'dayLengthMinutes', type: 'number', desc: '白昼时长（分钟），极昼为 1440，极夜为 0' },
        { name: 'noonAltitude', type: 'number', desc: '正午太阳高度角（度，未计折射），负数表示正午太阳仍在地平线下' },
        { name: 'iso', type: 'object', desc: '上述时刻的完整 ISO 8601 时间（带时区偏移）' },
        { name: 'iso.sunrise', type: 'string|null', desc: '日出' },
        { name: 'iso.sunset', type: 'string|null', desc: '日落' },
        { name: 'iso.solarNoon', type: 'string', desc: '正午' },
        { name: 'iso.civilDawn', type: 'string|null', desc: '民用晨光始' },
        { name: 'iso.civilDusk', type: 'string|null', desc: '民用昏影终' },
        { name: 'moon', type: 'object', desc: '月相（按当天本地 12:00 计算；不传 date 时按当前时刻）' },
        ...MOON_FIELDS('moon.'),
      ],
      async handler({ query }) {
        const { lat, lon, tz, date } = readCommon(query);
        const day = date ?? todayIn(tz);
        checkDate(day);
        const sun = computeSun({ lat, lon, date: day, tz });
        const at = date ? noonOf(day, tz) : Date.now();
        return { data: { ...sun, moon: moonPhase(at, tz) } };
      },
    },
    {
      method: 'GET',
      path: '/api/moon',
      summary: '月相、月面亮度、月龄与下次满月/新月',
      params: [
        { name: 'date', required: false, desc: '日期 YYYY-MM-DD（1900–2100），按当天本地 12:00 计算；默认当前时刻', example: '2026-09-26' },
        { name: 'tz', required: false, default: 'Asia/Shanghai', desc: 'IANA 时区名，决定"当天"的范围与输出时间', example: 'Asia/Shanghai' },
      ],
      fields: [
        { name: 'date', type: 'string', desc: '日期 YYYY-MM-DD（所选时区）' },
        { name: 'tz', type: 'string', desc: '时区（IANA 名）' },
        ...MOON_FIELDS(''),
      ],
      async handler({ query }) {
        const tz = zoneOrThrow(param(query, 'tz', { default: 'Asia/Shanghai', max: 64 }));
        const date = param(query, 'date', { pattern: DATE_RE });
        if (date) checkDate(date);
        const at = date ? noonOf(date, tz) : Date.now();
        return { data: { date: fmtYMD(zonedParts(at, tz)), tz, ...moonPhase(at, tz) } };
      },
    },
  ],
};

// 某时区某日本地 12:00 对应的 UTC 毫秒
function noonOf(date, tz) {
  const t = parseDate(date);
  return t + 12 * 3600_000 - zoneOffset(t + 12 * 3600_000, tz) * 60_000;
}

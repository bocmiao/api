import { HttpError, param } from '../../lib/http.js';
import { WEEKDAYS, normalizeZone, zonedParts, zoneOffset, fmtOffset, isDST, fmtYMD, fmtHM, fmtHMS, localIso, zonedToUtc } from './tz-util.js';

const DAY_MS = 86_400_000;
const MAX_ZONES = 20;
export const DEFAULT_ZONES = ['Asia/Shanghai', 'Asia/Tokyo', 'Europe/London', 'America/New_York', 'America/Los_Angeles'];

// 常用城市中文名 ↔ 时区
const CITIES = [
  ['北京', 'Asia/Shanghai'], ['上海', 'Asia/Shanghai'], ['中国', 'Asia/Shanghai'], ['香港', 'Asia/Hong_Kong'], ['澳门', 'Asia/Macau'],
  ['台北', 'Asia/Taipei'], ['东京', 'Asia/Tokyo'], ['日本', 'Asia/Tokyo'], ['首尔', 'Asia/Seoul'], ['韩国', 'Asia/Seoul'],
  ['新加坡', 'Asia/Singapore'], ['吉隆坡', 'Asia/Kuala_Lumpur'], ['曼谷', 'Asia/Bangkok'], ['雅加达', 'Asia/Jakarta'],
  ['河内', 'Asia/Ho_Chi_Minh'], ['胡志明市', 'Asia/Ho_Chi_Minh'], ['马尼拉', 'Asia/Manila'], ['新德里', 'Asia/Kolkata'], ['孟买', 'Asia/Kolkata'],
  ['加德满都', 'Asia/Kathmandu'], ['迪拜', 'Asia/Dubai'], ['德黑兰', 'Asia/Tehran'], ['莫斯科', 'Europe/Moscow'], ['伊斯坦布尔', 'Europe/Istanbul'],
  ['伦敦', 'Europe/London'], ['英国', 'Europe/London'], ['巴黎', 'Europe/Paris'], ['法国', 'Europe/Paris'], ['柏林', 'Europe/Berlin'], ['德国', 'Europe/Berlin'],
  ['罗马', 'Europe/Rome'], ['马德里', 'Europe/Madrid'], ['阿姆斯特丹', 'Europe/Amsterdam'], ['开罗', 'Africa/Cairo'], ['约翰内斯堡', 'Africa/Johannesburg'],
  ['纽约', 'America/New_York'], ['华盛顿', 'America/New_York'], ['多伦多', 'America/Toronto'], ['芝加哥', 'America/Chicago'], ['丹佛', 'America/Denver'],
  ['洛杉矶', 'America/Los_Angeles'], ['旧金山', 'America/Los_Angeles'], ['西雅图', 'America/Los_Angeles'], ['温哥华', 'America/Vancouver'],
  ['墨西哥城', 'America/Mexico_City'], ['圣保罗', 'America/Sao_Paulo'], ['布宜诺斯艾利斯', 'America/Argentina/Buenos_Aires'],
  ['悉尼', 'Australia/Sydney'], ['墨尔本', 'Australia/Melbourne'], ['珀斯', 'Australia/Perth'], ['奥克兰', 'Pacific/Auckland'], ['檀香山', 'Pacific/Honolulu'],
  ['UTC', 'UTC'],
];
const ALIAS = new Map(CITIES.map(([c, z]) => [c, z]));
// 时区 → 代表城市中文名（取表中第一个）；Intl 可能把 Asia/Kolkata 规范成 Asia/Calcutta，一并登记
const CITY_OF = new Map();
for (const [c, z] of CITIES) {
  for (const key of new Set([z, normalizeZone(z)])) if (key && !CITY_OF.has(key)) CITY_OF.set(key, c);
}
CITY_OF.set('Asia/Calcutta', CITY_OF.get('Asia/Kolkata'));
CITY_OF.set('Asia/Saigon', CITY_OF.get('Asia/Ho_Chi_Minh'));
CITY_OF.set('Asia/Katmandu', CITY_OF.get('Asia/Kathmandu'));
export const cityOf = (zone) => CITY_OF.get(zone) ?? null;

// 解析单个时区：支持 IANA 名（大小写不敏感）、中文城市名、UTC±N / GMT±N
export function resolveZone(input, name = 'zones') {
  const s = String(input ?? '').trim();
  if (ALIAS.has(s)) return ALIAS.get(s);
  const m = /^(?:UTC|GMT)\s*([+-])\s*(\d{1,2})$/i.exec(s);
  if (m && Number(m[2]) <= 14) {
    // Etc/GMT 的符号与习惯相反：UTC+8 = Etc/GMT-8
    return Number(m[2]) === 0 ? 'UTC' : `Etc/GMT${m[1] === '+' ? '-' : '+'}${Number(m[2])}`;
  }
  const z = normalizeZone(s);
  if (!z) throw new HttpError(400, `${name} 中的「${s}」不是有效时区，请用 IANA 时区名（如 Asia/Tokyo）或常用城市中文名（如 东京）`);
  return z;
}

export function resolveZones(raw, name = 'zones') {
  const list = String(raw).split(/[,，、\s]+/).filter(Boolean);
  if (!list.length) throw new HttpError(400, `${name} 不能为空`);
  if (list.length > MAX_ZONES) throw new HttpError(400, `${name} 最多 ${MAX_ZONES} 个时区`);
  return [...new Set(list.map((z) => resolveZone(z, name)))];
}

// 某时刻在某时区的完整信息
export function zoneInfo(ms, zone) {
  const p = zonedParts(ms, zone);
  const off = zoneOffset(ms, zone);
  return {
    zone,
    city: cityOf(zone),
    datetime: `${fmtYMD(p)} ${fmtHMS(p)}`,
    date: fmtYMD(p),
    time: fmtHM(p),
    weekday: WEEKDAYS[p.weekday],
    offset: fmtOffset(off),
    offsetMinutes: off,
    isDST: isDST(ms, zone),
    iso: localIso(ms, zone),
  };
}

export function worldTime(zones = DEFAULT_ZONES, now = Date.now()) {
  const ms = Math.floor(now / 1000) * 1000;
  return {
    utc: new Date(ms).toISOString().replace('.000', ''),
    timestamp: Math.floor(ms / 1000),
    zones: zones.map((z) => zoneInfo(ms, z)),
  };
}

// 解析 "YYYY-MM-DD HH:mm[:ss]"（也接受 T 分隔、/ 分隔），或只有 "HH:mm"（取 from 时区的今天）
export function parseWallTime(s, zone, now = Date.now()) {
  const str = String(s ?? '').trim();
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(str);
  let w;
  if (m) {
    w = { year: +m[1], month: +m[2], day: +m[3], hour: +(m[4] ?? 0), minute: +(m[5] ?? 0), second: +(m[6] ?? 0) };
  } else if ((m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(str))) {
    const p = zonedParts(now, zone);
    w = { year: p.year, month: p.month, day: p.day, hour: +m[1], minute: +m[2], second: +(m[3] ?? 0) };
  } else {
    throw new HttpError(400, 'time 格式应为 YYYY-MM-DD HH:mm（如 2026-10-01 09:00），或只传 HH:mm 表示今天');
  }
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day));
  if (d.getUTCMonth() !== w.month - 1 || d.getUTCDate() !== w.day || w.hour > 23 || w.minute > 59 || w.second > 59) {
    throw new HttpError(400, 'time 不是有效的日期时间');
  }
  if (w.year < 1900 || w.year > 2100) throw new HttpError(400, 'time 年份须在 1900–2100 之间');
  return w;
}

// 把 from 时区的墙上时间换算到多个时区（正确处理夏令时）
export function convertTime(time, from, to, now = Date.now()) {
  const w = parseWallTime(time, from, now);
  const { ms, ambiguous } = zonedToUtc(w, from);
  if (ms == null) throw new HttpError(400, `${fmtYMD(w)} ${fmtHM(w)} 在 ${from} 因夏令时拨快一小时而不存在，请换一个时间`);
  const src = zoneInfo(ms, from);
  const srcDay = Date.UTC(w.year, w.month - 1, w.day);
  return {
    from: { ...src, ambiguous },
    utc: new Date(ms).toISOString().replace('.000', ''),
    timestamp: Math.floor(ms / 1000),
    results: to.map((z) => {
      const info = zoneInfo(ms, z);
      const p = zonedParts(ms, z);
      const dayDiff = Math.round((Date.UTC(p.year, p.month - 1, p.day) - srcDay) / DAY_MS);
      const diffMin = info.offsetMinutes - src.offsetMinutes;
      return {
        ...info,
        dayDiff,
        diffHours: Math.round((diffMin / 60) * 100) / 100,
        text: `${info.city ?? z} ${info.date} ${info.time} ${info.weekday}${dayDiff ? `（${dayDiff > 0 ? '次日' : '前一天'}${Math.abs(dayDiff) > 1 ? ` ${dayDiff} 天` : ''}）` : ''}`,
      };
    }),
  };
}

const ZONE_FIELDS = (prefix) => [
  { name: `${prefix}.zone`, type: 'string', desc: 'IANA 时区名，如 Asia/Tokyo' },
  { name: `${prefix}.city`, type: 'string|null', desc: '代表城市中文名（内置常用城市表，未收录时为 null）' },
  { name: `${prefix}.datetime`, type: 'string', desc: '当地日期时间 YYYY-MM-DD HH:mm:ss' },
  { name: `${prefix}.date`, type: 'string', desc: '当地日期 YYYY-MM-DD' },
  { name: `${prefix}.time`, type: 'string', desc: '当地时间 HH:mm' },
  { name: `${prefix}.weekday`, type: 'string', desc: '当地星期几，如 星期一' },
  { name: `${prefix}.offset`, type: 'string', desc: '相对 UTC 的偏移，如 +08:00、-04:00、+05:45' },
  { name: `${prefix}.offsetMinutes`, type: 'number', desc: '相对 UTC 的偏移（分钟，东区为正）' },
  { name: `${prefix}.isDST`, type: 'boolean', desc: '当时是否处于夏令时' },
  { name: `${prefix}.iso`, type: 'string', desc: '带偏移的 ISO 8601 当地时间，如 2026-10-01T09:00:00+08:00' },
];

const ZONE_DESC = '逗号分隔的时区，支持 IANA 名（如 Asia/Tokyo）、常用城市中文名（北京、东京、伦敦、纽约、洛杉矶、巴黎、悉尼等）或 UTC+8 形式，最多 20 个';

export default {
  name: 'worldtime',
  category: 'life',
  title: '世界时间',
  description: '查询世界各地当前时间、UTC 偏移与夏令时，或把某个时区的时间换算到其他时区（按 IANA 时区规则，自动处理夏令时）',
  source: '本地计算（Intl 时区数据库）',
  routes: [
    {
      method: 'GET',
      path: '/api/time/world',
      summary: '世界各地当前时间',
      params: [
        { name: 'zones', required: false, default: DEFAULT_ZONES.join(','), desc: ZONE_DESC, example: '北京,东京,伦敦,纽约' },
      ],
      fields: [
        { name: 'utc', type: 'string', desc: '当前 UTC 时间，ISO 8601' },
        { name: 'timestamp', type: 'number', desc: '当前 Unix 时间戳（秒）' },
        { name: 'zones', type: 'array', desc: '各时区当前时间，顺序同请求' },
        ...ZONE_FIELDS('zones[]'),
      ],
      async handler({ query }) {
        const raw = param(query, 'zones', { default: DEFAULT_ZONES.join(','), max: 600 });
        return { data: worldTime(resolveZones(raw)) };
      },
    },
    {
      method: 'GET',
      path: '/api/time/convert',
      summary: '时区换算：把某地时间换算成其他时区',
      params: [
        { name: 'time', required: true, desc: '要换算的当地时间 YYYY-MM-DD HH:mm（也可只传 HH:mm 表示 from 时区的今天）', example: '2026-10-01 09:00' },
        { name: 'from', required: false, default: 'Asia/Shanghai', desc: '源时区（IANA 名或城市中文名）', example: '北京' },
        { name: 'to', required: false, default: DEFAULT_ZONES.join(','), desc: `目标时区，${ZONE_DESC}`, example: '纽约,伦敦,东京' },
      ],
      fields: [
        { name: 'from', type: 'object', desc: '源时区的时间信息' },
        ...ZONE_FIELDS('from'),
        { name: 'from.ambiguous', type: 'boolean', desc: '该时间是否因夏令时结束（时钟拨慢）而出现两次；为 true 时按第一次出现（夏令时）计算' },
        { name: 'utc', type: 'string', desc: '对应的 UTC 时间，ISO 8601' },
        { name: 'timestamp', type: 'number', desc: '对应的 Unix 时间戳（秒）' },
        { name: 'results', type: 'array', desc: '各目标时区的换算结果' },
        ...ZONE_FIELDS('results[]'),
        { name: 'results[].dayDiff', type: 'number', desc: '与源时区日期相差的天数：1 为次日，-1 为前一天，0 为同一天' },
        { name: 'results[].diffHours', type: 'number', desc: '该时区比源时区快多少小时（负数为慢），如 -12' },
        { name: 'results[].text', type: 'string', desc: '一句话中文结果，如 纽约 2026-09-30 21:00 星期三（前一天）' },
      ],
      async handler({ query }) {
        const time = param(query, 'time', { required: true, max: 32 });
        const from = resolveZone(param(query, 'from', { default: 'Asia/Shanghai', max: 64 }), 'from');
        const toRaw = param(query, 'to', { max: 600 });
        const to = toRaw ? resolveZones(toRaw, 'to') : DEFAULT_ZONES.filter((z) => z !== from);
        return { data: convertTime(time, from, to) };
      },
    },
  ],
};

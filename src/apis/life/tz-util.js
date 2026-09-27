// 时区相关的小工具（只用 Intl，不依赖时区数据库文件），供 世界时间 / 日出日落 等接口共用
import { HttpError } from '../../lib/http.js';

export const DAY_MS = 86_400_000;
export const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

const fmtCache = new Map();
function formatter(zone) {
  let f = fmtCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(zone, f);
  }
  return f;
}

// 小写 → 标准写法。Intl 列表里部分是旧名（如 Asia/Calcutta），补上现行名，保证用户传现行名时原样返回
const ZONE_NAMES = new Map(
  [...(Intl.supportedValuesOf?.('timeZone') ?? []), 'UTC', 'Asia/Kolkata', 'Asia/Kathmandu', 'Asia/Ho_Chi_Minh', 'Asia/Yangon', 'Europe/Kyiv', 'America/Nuuk']
    .map((z) => [z.toLowerCase(), z]),
);

// 校验并规范化 IANA 时区名（大小写不敏感），不合法返回 null
export function normalizeZone(zone) {
  if (!zone || typeof zone !== 'string' || zone.length > 64) return null;
  let resolved;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  return ZONE_NAMES.get(zone.toLowerCase()) ?? resolved;
}

// 读取 tz 参数：不合法时抛 400
export function zoneOrThrow(zone, name = 'tz') {
  const z = normalizeZone(zone);
  if (!z) throw new HttpError(400, `${name} 不是有效的 IANA 时区名（如 Asia/Shanghai、America/New_York）`);
  return z;
}

// 某一时刻在指定时区的墙上时间
export function zonedParts(ms, zone) {
  const p = {};
  for (const { type, value } of formatter(zone).formatToParts(new Date(ms))) p[type] = value;
  const parts = { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second };
  parts.weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return parts;
}

// 某一时刻指定时区相对 UTC 的偏移（分钟，东区为正）
export function zoneOffset(ms, zone) {
  const p = zonedParts(ms, zone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60_000);
}

// 偏移分钟 → +08:00 / -05:00 / +05:45
export function fmtOffset(min) {
  const sign = min < 0 ? '-' : '+';
  const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

// 该时刻是否处于夏令时：偏移大于当年 1 月 1 日与 7 月 1 日偏移中较小者（南北半球都适用）
export function isDST(ms, zone) {
  const y = zonedParts(ms, zone).year;
  const std = Math.min(zoneOffset(Date.UTC(y, 0, 1), zone), zoneOffset(Date.UTC(y, 6, 1), zone));
  return zoneOffset(ms, zone) > std;
}

const pad = (n) => String(n).padStart(2, '0');
export const fmtYMD = (p) => `${p.year}-${pad(p.month)}-${pad(p.day)}`;
export const fmtHM = (p) => `${pad(p.hour)}:${pad(p.minute)}`;
export const fmtHMS = (p) => `${fmtHM(p)}:${pad(p.second)}`;

// 带偏移的本地 ISO 时间，如 2026-10-01T09:00:00+08:00
export function localIso(ms, zone) {
  const p = zonedParts(ms, zone);
  return `${fmtYMD(p)}T${fmtHMS(p)}${fmtOffset(zoneOffset(ms, zone))}`;
}

// 指定时区的墙上时间 → UTC 毫秒。正确处理夏令时：
// 返回 { ms, ambiguous }；时间落在夏令时拨快的空档（不存在）时 ms 为 null；
// 拨慢导致重复出现的时间（ambiguous）取第一次出现的时刻
export function zonedToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, zone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsets = new Set([zoneOffset(wall - DAY_MS, zone), zoneOffset(wall, zone), zoneOffset(wall + DAY_MS, zone)]);
  const hits = [];
  for (const o of offsets) {
    const t = wall - o * 60_000;
    const p = zonedParts(t, zone);
    if (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) === wall) hits.push(t);
  }
  hits.sort((a, b) => a - b);
  return { ms: hits[0] ?? null, ambiguous: hits.length > 1 };
}

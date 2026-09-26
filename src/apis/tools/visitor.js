import { isIP } from 'node:net';
import { param } from '../../lib/http.js';
import { parseUA } from '../../lib/ua.js';
import { loadIpInfo, normalizeIp, isPrivateIp } from '../life/ip.js';
import { UA_FIELDS } from './useragent.js';

export const GEO_TIMEOUT_MS = 3000;

// 查询 IP 归属地：内网/保留地址、非法 IP、查询失败或超时都返回 null，不抛错
export async function lookupLocation(ip, timeoutMs = GEO_TIMEOUT_MS) {
  const n = normalizeIp(ip ?? '');
  if (!n || !isIP(n) || isPrivateIp(n)) return null;
  let timer;
  try {
    // 不 unref：无论哪边先完成，finally 都会清掉这个定时器
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    });
    const res = await Promise.race([loadIpInfo(n), timeout]);
    return res?.data ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 解析 Accept-Language：按 q 值从高到低排序（同权重保持原顺序），去掉 * 和 q=0
export function parseAcceptLanguage(header) {
  const items = String(header ?? '')
    .split(',')
    .map((part, i) => {
      const [tag, ...opts] = part.trim().split(';').map((s) => s.trim());
      const q = opts.map((o) => /^q=([\d.]+)$/i.exec(o)).find(Boolean);
      return { tag, q: q ? Number(q[1]) : 1, i };
    })
    .filter((x) => /^[a-z]{1,8}(-[a-z0-9]{1,8})*$/i.test(x.tag) && x.q > 0 && x.q <= 1);
  items.sort((a, b) => b.q - a.q || a.i - b.i);
  return [...new Set(items.map((x) => x.tag))].slice(0, 10);
}

const pad = (n) => String(n).padStart(2, '0');
function beijingTime(ms) {
  const d = new Date(ms + 8 * 3600_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export async function visitorInfo({ ip, headers = {}, geo = true, now = Date.now() }) {
  const n = normalizeIp(ip ?? '');
  const ua = String(headers['user-agent'] ?? '').trim().slice(0, 2000);
  const info = geo ? await lookupLocation(n) : null;
  const languages = parseAcceptLanguage(headers['accept-language']);
  return {
    ip: n || null,
    location: info && {
      text: info.location || null,
      country: info.country,
      region: info.region,
      city: info.city,
      isp: info.isp,
      timezone: info.timezone,
    },
    ua,
    ...parseUA(ua),
    language: languages[0] ?? null,
    languages,
    time: new Date(now).toISOString(),
    beijingTime: beijingTime(now),
  };
}

export default {
  name: 'visitor',
  category: 'tools',
  title: '访客信息',
  description: '返回调用者的 IP、归属地、浏览器、系统、设备类型、首选语言与请求时间',
  source: '本地解析 + ip2region 离线库 / ip-api.com（归属地）',
  routes: [
    {
      method: 'GET',
      path: '/api/visitor',
      summary: '查看我的 IP、归属地与浏览器信息',
      params: [
        { name: 'geo', required: false, default: '1', desc: '是否查询 IP 归属地：1 查询，0 不查（location 为 null，响应更快）', example: '0' },
      ],
      fields: [
        { name: 'ip', type: 'string|null', desc: '调用者 IP（IPv4 映射的 IPv6 地址会还原为 IPv4）；服务部署在反向代理后且未开启 TRUST_PROXY 时是代理的地址；取不到时为 null' },
        { name: 'location', type: 'object|null', desc: `IP 归属地（与 /api/ip 相同：国内 IPv4 查本地 ip2region 离线库，其余查 ip-api.com 并缓存 6 小时）。内网/保留地址、参数 geo=0、查询失败或超过 ${GEO_TIMEOUT_MS / 1000} 秒未返回时为 null，不会报错` },
        { name: 'location.text', type: 'string|null', desc: '拼接好的归属地：国家、省、市依次以空格连接，如 "中国 广东 深圳"；上游没有任何地名时为 null' },
        { name: 'location.country', type: 'string|null', desc: '国家（中文），如 中国' },
        { name: 'location.region', type: 'string|null', desc: '省/州，如 广东；上游未返回时为 null' },
        { name: 'location.city', type: 'string|null', desc: '城市，如 深圳；上游未返回时为 null' },
        { name: 'location.isp', type: 'string|null', desc: '运营商/ISP 名称：本地库命中时为中文（如 中国电信），来自 ip-api 时多为英文（如 Chinanet）；未知时为 null' },
        { name: 'location.timezone', type: 'string|null', desc: '所在时区（IANA 名称），如 Asia/Shanghai；未返回时为 null' },
        { name: 'ua', type: 'string', desc: '请求头 User-Agent 原文（去掉首尾空白，最多 2000 个字符）；没有该请求头时为空字符串' },
        ...UA_FIELDS,
        { name: 'language', type: 'string|null', desc: 'Accept-Language 请求头里的首选语言（q 值最高的一个，同权重取靠前的），如 zh-CN；没有该请求头或无法解析时为 null' },
        { name: 'languages', type: 'array', desc: 'Accept-Language 里的全部语言标签（字符串数组），按 q 值从高到低排序、去重，最多 10 个，不含 * 和 q=0；没有时为空数组' },
        { name: 'time', type: 'string', desc: '服务器收到请求的时间，ISO 8601 格式的 UTC 时间（带 3 位毫秒），如 2026-09-24T08:00:00.000Z' },
        { name: 'beijingTime', type: 'string', desc: '同一时刻的北京时间（UTC+8），格式 YYYY-MM-DD HH:mm:ss' },
      ],
      async handler({ query, ip, req }) {
        const geo = param(query, 'geo', { default: '1', oneOf: ['0', '1'] }) === '1';
        return { data: await visitorInfo({ ip, headers: req?.headers ?? {}, geo }) };
      },
    },
  ],
};

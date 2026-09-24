import { isIP } from 'node:net';
import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError } from '../../lib/http.js';

const FIELDS = 'status,message,country,countryCode,regionName,city,district,zip,lat,lon,timezone,isp,org,as,query';

// 去掉 IPv4-mapped 前缀、IPv6 zone 与方括号
export function normalizeIp(ip = '') {
  let s = String(ip).trim().replace(/^\[|\]$/g, '');
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (m) s = m[1];
  return s.replace(/%.*$/, '');
}

function v4Parts(ip) {
  return ip.split('.').map(Number);
}

// 私有/保留地址判断
export function isPrivateIp(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = v4Parts(ip);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && v4Parts(ip)[2] === 0)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateIp(mapped[1]);
    const first = parseInt(s.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 // fc00::/7 唯一本地
      || (first & 0xffc0) === 0xfe80 // fe80::/10 链路本地
      || (first & 0xff00) === 0xff00 // 组播
      || s.startsWith('2001:db8:'); // 文档地址
  }
  return false;
}

export function parseIpApi(raw) {
  if (raw?.status !== 'success') {
    const msg = raw?.message;
    if (msg === 'private range' || msg === 'reserved range') throw new HttpError(400, '该 IP 为内网或保留地址，无法查询归属地');
    if (msg === 'invalid query') throw new HttpError(400, 'IP 地址不合法');
    throw new HttpError(502, `ip-api 查询失败：${msg ?? '未知错误'}`);
  }
  const location = [raw.country, raw.regionName, raw.city, raw.district].filter((x, i, a) => x && a.indexOf(x) === i);
  return {
    ip: raw.query,
    country: raw.country ?? null,
    countryCode: raw.countryCode ?? null,
    region: raw.regionName || null,
    city: raw.city || null,
    district: raw.district || null,
    isp: raw.isp || null,
    org: raw.org || null,
    asn: raw.as || null,
    lat: raw.lat ?? null,
    lon: raw.lon ?? null,
    timezone: raw.timezone ?? null,
    location: location.join(' '),
  };
}

export async function loadIpInfo(ip) {
  // ip-api 免费版仅支持 HTTP，限 45 次/分钟
  const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN&fields=${FIELDS}`;
  return cache.wrap(`ip:${ip}`, 6 * 3600_000, async () => parseIpApi(await fetchJSON(url)));
}

export default {
  name: 'ip',
  category: 'life',
  title: 'IP 归属地',
  description: '查询 IPv4/IPv6 地址的国家、省市与运营商，默认查询调用者 IP',
  source: 'ip-api.com',
  routes: [
    {
      method: 'GET',
      path: '/api/ip',
      summary: '查询 IP 归属地（默认调用者 IP）',
      params: [{ name: 'ip', desc: 'IPv4 或 IPv6 地址，留空为调用者 IP', example: '114.114.114.114' }],
      async handler({ query, ip: callerIp }) {
        const given = query.get('ip');
        if (given && given.length > 64) throw new HttpError(400, 'ip 参数过长');
        const ip = normalizeIp(given || callerIp || '');
        if (!ip) throw new HttpError(400, '无法获取调用者 IP，请传入 ip 参数');
        if (!isIP(ip)) throw new HttpError(400, 'ip 不是合法的 IPv4/IPv6 地址');
        if (isPrivateIp(ip)) {
          throw new HttpError(400, given ? '该 IP 为内网或保留地址，无法查询归属地' : `你的 IP（${ip}）为内网地址，请通过 ip 参数指定公网 IP`);
        }
        return loadIpInfo(ip);
      },
    },
  ],
};

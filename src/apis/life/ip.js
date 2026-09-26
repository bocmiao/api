import { isIP } from 'node:net';
import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError } from '../../lib/http.js';
import { lookupIpOffline } from './offline-db.js';

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
    source: 'ip-api',
  };
}

const joinLocation = (...xs) => xs.filter((x, i, a) => x && a.indexOf(x) === i).join(' ');
// 去掉行政区划后缀，与 ip-api 中文结果（"广东"、"深圳"）保持一致；"阿里地区"、自治州简称等不动
const shortName = (s) => (s && /^.{2,}?(省|市|特别行政区)$/.test(s) ? s.replace(/(省|市|特别行政区)$/, '') : s);
const ISP_MAP = { 电信: '中国电信', 联通: '中国联通', 移动: '中国移动', 广电: '中国广电', 铁通: '中国铁通' };
// ip2region 把港澳台记在"中国"下、代码为 CN；按省份还原成各自的地区代码
const SAR_CODES = { 香港: 'HK', 澳门: 'MO', 台湾: 'TW' };

// 把 ip2region 结果转成与 parseIpApi 相同的结构（本地库没有的字段为 null）
export function fromIp2region(ip, r) {
  const region = shortName(r.province);
  const city = shortName(r.city);
  const countryCode = (r.countryCode === 'CN' && SAR_CODES[region]) || r.countryCode;
  return {
    ip,
    country: r.country,
    countryCode,
    region,
    city,
    district: null,
    isp: ISP_MAP[r.isp] ?? r.isp,
    org: null,
    asn: null,
    lat: null,
    lon: null,
    // 中国大陆统一使用北京时间，可以直接给出；其他地区本地库没有时区
    timezone: countryCode === 'CN' ? 'Asia/Shanghai' : null,
    location: joinLocation(r.country, region, city),
    source: 'ip2region',
  };
}

// 本地结果 + ip-api 结果合并：国内且本地有城市时地名/运营商以本地（中文、更细）为准，
// 其余情况以 ip-api 为准；任一方缺失的字段由另一方补上
export function mergeIpInfo(local, online) {
  const localFirst = local.city && ['CN', 'HK', 'MO', 'TW'].includes(local.countryCode);
  const [a, b] = localFirst ? [local, online] : [online, local];
  const pick = (k) => a[k] ?? b[k] ?? null;
  const out = {
    ip: online.ip || local.ip,
    country: pick('country'),
    countryCode: pick('countryCode'),
    region: pick('region'),
    city: pick('city'),
    district: online.district ?? null,
    isp: pick('isp'),
    org: online.org ?? null,
    asn: online.asn ?? null,
    lat: online.lat ?? null,
    lon: online.lon ?? null,
    timezone: online.timezone ?? local.timezone ?? null,
  };
  return { ...out, location: joinLocation(out.country, out.region, out.city, out.district), source: 'ip2region+ip-api' };
}

/**
 * 查询 IP 归属地，返回 { data, cached?, updatedAt? }。
 * IPv4 先查本地 ip2region：国内/港澳台且能定位到城市时直接返回，不请求外部接口；
 * 境外 IP、本地查不到城市、IPv6，或调用方需要 ASN（withAsn）时再请求 ip-api 补全，
 * ip-api 失败时仍返回本地结果。
 * @param {string} ip 已规整的公网 IP
 * @param {{ withAsn?: boolean }} [opts]
 */
export async function loadIpInfo(ip, { withAsn = false } = {}) {
  const raw = isIP(ip) === 4 ? lookupIpOffline(ip) : null;
  const local = raw && fromIp2region(ip, raw);
  if (local && !withAsn && local.city && ['CN', 'HK', 'MO', 'TW'].includes(local.countryCode)) return { data: local };
  // ip-api 免费版仅支持 HTTP，限 45 次/分钟
  const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?lang=zh-CN&fields=${FIELDS}`;
  try {
    const res = await cache.wrap(`ip:${ip}`, 6 * 3600_000, async () => parseIpApi(await fetchJSON(url)));
    return local ? { ...res, data: mergeIpInfo(local, res.data) } : res;
  } catch (err) {
    if (local) return { data: local };
    throw err;
  }
}

export default {
  name: 'ip',
  category: 'life',
  title: 'IP 归属地',
  description: '查询 IPv4/IPv6 地址的国家、省市与运营商，默认查询调用者 IP；国内 IPv4 优先使用本地离线库',
  source: 'ip2region 离线库 + ip-api.com',
  routes: [
    {
      method: 'GET',
      path: '/api/ip',
      summary: '查询 IP 归属地（默认调用者 IP）',
      params: [{ name: 'ip', desc: 'IPv4 或 IPv6 地址，留空为调用者 IP', example: '114.114.114.114' }],
      fields: [
        { name: 'ip', type: 'string', desc: '实际查询的 IP 地址（IPv4 映射的 IPv6 地址会还原为 IPv4）' },
        { name: 'country', type: 'string|null', desc: '国家，如 中国。国内 IP 与 ip-api 结果为中文；ip-api 不可用、仅有本地库结果的境外 IP 为英文（如 Australia）' },
        { name: 'countryCode', type: 'string|null', desc: '国家/地区代码（ISO 3166-1 两位字母），如 CN；香港、澳门、台湾分别为 HK、MO、TW' },
        { name: 'region', type: 'string|null', desc: '省/州，如 广东（去掉"省""市"后缀，直辖市为 北京）；未知时为 null' },
        { name: 'city', type: 'string|null', desc: '城市，如 深圳（去掉"市"后缀）；未知时为 null' },
        { name: 'district', type: 'string|null', desc: '区县；仅 ip-api 可能提供且多数情况下没有，此时为 null' },
        { name: 'isp', type: 'string|null', desc: '运营商/ISP 名称：本地库命中的国内 IP 为中文（如 中国电信、阿里），来自 ip-api 时多为英文（如 Chinanet）；未知时为 null' },
        { name: 'org', type: 'string|null', desc: '所属组织名称，如 Chinanet GD；仅 ip-api 提供，只查了本地库时为 null' },
        { name: 'asn', type: 'string|null', desc: '自治系统编号与名称，如 "AS4134 CHINANET-BACKBONE"；仅 ip-api 提供，只查了本地库时为 null' },
        { name: 'lat', type: 'number|null', desc: '大致纬度（十进制度，城市级精度，仅供参考）；仅 ip-api 提供，只查了本地库时为 null' },
        { name: 'lon', type: 'number|null', desc: '大致经度（十进制度，城市级精度，仅供参考）；仅 ip-api 提供，只查了本地库时为 null' },
        { name: 'timezone', type: 'string|null', desc: '所在时区（IANA 名称），如 Asia/Shanghai；本地库命中的中国大陆 IP 固定为 Asia/Shanghai，其他地区仅 ip-api 提供，未知时为 null' },
        { name: 'location', type: 'string', desc: '拼接好的归属地：国家、省、市、区县依次以空格连接，去掉空值和重复值，如 "中国 广东 深圳"' },
        { name: 'source', type: 'string', desc: '数据来源：ip2region（仅本地离线库）、ip-api（仅在线接口，如 IPv6 或本地库无记录）、ip2region+ip-api（本地结果由 ip-api 补全）' },
      ],
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

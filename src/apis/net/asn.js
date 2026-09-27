// IP 网段与 ASN 查询：通过 RDAP 查询 IP 所属网段、持有组织与所属地区注册机构（RIR），以及 AS 号的注册信息。
// 先用 IANA 的 RDAP 引导文件（ipv4.json / ipv6.json / asn.json）找到负责该地址段的 RIR 的 RDAP 服务器，
// 直接查询；引导数据取不到或 RIR 服务器失败时改用 rdap.org（它会 302 跳转到对应 RIR）。
import net from 'node:net';
import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError, param, upstreamError } from '../../lib/http.js';
import { outboundFetch } from '../../lib/proxy.js';
import { parseIPv6 } from '../../lib/netguard.js';
import { isBlockedIP } from './common.js';

const BOOTSTRAP = {
  v4: 'https://data.iana.org/rdap/ipv4.json',
  v6: 'https://data.iana.org/rdap/ipv6.json',
  asn: 'https://data.iana.org/rdap/asn.json',
};
const BOOTSTRAP_TTL = 86_400_000;
const RESULT_TTL = 6 * 3600_000;
const MAX_CIDRS = 64;
const MAX_ASN = 4294967295;

// ---------- 地址与前缀 ----------

// IP -> BigInt；不合法返回 null
export function ipToBigInt(ip) {
  const v = net.isIP(ip);
  if (v === 4) return ip.split('.').reduce((acc, p) => (acc << 8n) | BigInt(Number(p)), 0n);
  if (v === 6) {
    const w = parseIPv6(ip);
    return w ? w.reduce((acc, x) => (acc << 16n) | BigInt(x), 0n) : null;
  }
  return null;
}

export function bigIntToIp(n, version) {
  if (version === 4) return [24n, 16n, 8n, 0n].map((s) => String((n >> s) & 255n)).join('.');
  const words = [];
  for (let i = 7; i >= 0; i--) words.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16));
  // 压缩最长的一段连续 0（至少两组）
  let best = [-1, 0];
  for (let i = 0; i < 8; ) {
    if (words[i] !== '0') { i++; continue; }
    let j = i;
    while (j < 8 && words[j] === '0') j++;
    if (j - i > best[1]) best = [i, j - i];
    i = j;
  }
  if (best[1] < 2) return words.join(':');
  return `${words.slice(0, best[0]).join(':')}::${words.slice(best[0] + best[1]).join(':')}`;
}

// 起止地址 -> 最少的 CIDR 列表（最多 MAX_CIDRS 条）；地址不合法时返回空数组
export function rangeToCidrs(start, end) {
  const version = net.isIP(start);
  if (!version || version !== net.isIP(end)) return [];
  const bits = version === 4 ? 32 : 128;
  let a = ipToBigInt(start);
  const b = ipToBigInt(end);
  if (a == null || b == null || a > b) return [];
  const out = [];
  while (a <= b && out.length < MAX_CIDRS) {
    // 从 a 开始、对齐且不超过 b 的最大块
    let size = 0;
    while (size < bits && (a & ((1n << BigInt(size + 1)) - 1n)) === 0n && a + (1n << BigInt(size + 1)) - 1n <= b) size++;
    out.push(`${bigIntToIp(a, version)}/${bits - size}`);
    a += 1n << BigInt(size);
  }
  return out;
}

function prefixContains(prefix, ipNum, version) {
  const [base, lenStr] = String(prefix).split('/');
  const bits = version === 4 ? 32 : 128;
  const len = Number(lenStr);
  if (net.isIP(base) !== version || !Number.isInteger(len) || len < 0 || len > bits) return -1;
  const shift = BigInt(bits - len);
  return ipToBigInt(base) >> shift === ipNum >> shift ? len : -1;
}

// https 优先
const sortUrls = (urls) =>
  (urls ?? []).map(String).sort((a, b) => Number(b.startsWith('https:')) - Number(a.startsWith('https:')));

// IP 引导文件：services 为 [[前缀...], [RDAP 服务器...]]，取最长前缀匹配
export function serversForIp(bootstrap, ip) {
  if (!Array.isArray(bootstrap?.services)) throw new HttpError(502, 'RDAP 引导数据格式无法识别');
  const version = net.isIP(ip);
  const n = ipToBigInt(ip);
  let best = { len: -1, urls: [] };
  for (const s of bootstrap.services) {
    for (const p of s?.[0] ?? []) {
      const len = prefixContains(p, n, version);
      if (len > best.len) best = { len, urls: sortUrls(s?.[1]) };
    }
  }
  return best.urls;
}

// ASN 引导文件：services 为 [["1-1876", "13335"...], [RDAP 服务器...]]
export function serversForAsn(bootstrap, asn) {
  if (!Array.isArray(bootstrap?.services)) throw new HttpError(502, 'RDAP 引导数据格式无法识别');
  for (const s of bootstrap.services) {
    for (const r of s?.[0] ?? []) {
      const [lo, hi = lo] = String(r).split('-').map(Number);
      if (asn >= lo && asn <= hi) return sortUrls(s?.[1]);
    }
  }
  return [];
}

// ---------- RIR 识别 ----------

const RIRS = [
  [/apnic/i, 'APNIC'],
  [/arin/i, 'ARIN'],
  [/ripe/i, 'RIPE NCC'],
  [/lacnic/i, 'LACNIC'],
  [/afrinic/i, 'AFRINIC'],
];

export function registryOf(...hints) {
  for (const h of hints) {
    if (!h) continue;
    for (const [re, name] of RIRS) if (re.test(h)) return name;
  }
  return null;
}

// ---------- 解析 ----------

function vcardField(entity, field) {
  const props = entity?.vcardArray?.[1];
  if (!Array.isArray(props)) return null;
  const p = props.find((x) => x?.[0] === field);
  const v = p?.[3];
  return Array.isArray(v) ? v.filter(Boolean).join(' ') || null : typeof v === 'string' && v ? v : null;
}

function findEntity(entities, role, depth = 0) {
  if (!Array.isArray(entities) || depth > 4) return null;
  for (const e of entities) {
    if (e?.roles?.includes(role)) return e;
    const nested = findEntity(e?.entities, role, depth + 1);
    if (nested) return nested;
  }
  return null;
}

const iso = (d) => {
  const t = d ? Date.parse(d) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};
const eventOf = (raw, ...actions) => iso(raw?.events?.find?.((e) => actions.includes(e?.eventAction))?.eventDate);

// remarks 里的描述文字（去重、去空行）
function remarksOf(raw) {
  const lines = [];
  for (const r of Array.isArray(raw?.remarks) ? raw.remarks : []) {
    for (const d of Array.isArray(r?.description) ? r.description : []) {
      const s = typeof d === 'string' ? d.trim() : '';
      if (s && !lines.includes(s)) lines.push(s);
    }
  }
  return lines;
}

const orgOf = (raw) => {
  const e = findEntity(raw?.entities, 'registrant') ?? findEntity(raw?.entities, 'administrative');
  return vcardField(e, 'fn') ?? e?.handle ?? null;
};
const abuseOf = (raw) => vcardField(findEntity(raw?.entities, 'abuse'), 'email')?.replace(/^mailto:/i, '') ?? null;

// RDAP 响应里的 AS 号引用：ARIN 的 arin_originas0 扩展，或指向 /autnum/<n> 的链接；没有则为 null
function asnOf(raw) {
  const origin = raw?.arin_originas0_originautnums;
  if (Array.isArray(origin) && Number.isInteger(Number(origin[0]))) return Number(origin[0]);
  for (const l of Array.isArray(raw?.links) ? raw.links : []) {
    const m = /\/autnum\/(\d+)(?:$|[/?#])/.exec(l?.href ?? '');
    if (m) return Number(m[1]);
  }
  return null;
}

export function parseIpNetwork(raw, { ip, url } = {}) {
  if (!raw || raw.objectClassName !== 'ip network') throw new HttpError(502, 'RDAP 返回的数据格式无法识别');
  const start = typeof raw.startAddress === 'string' ? raw.startAddress : null;
  const end = typeof raw.endAddress === 'string' ? raw.endAddress : null;
  const cidr0 = (Array.isArray(raw.cidr0_cidrs) ? raw.cidr0_cidrs : [])
    .map((c) => {
      const base = c?.v4prefix ?? c?.v6prefix;
      return net.isIP(base ?? '') && Number.isInteger(c?.length) ? `${base}/${c.length}` : null;
    })
    .filter(Boolean);
  return {
    ip,
    version: net.isIP(ip) === 6 ? 'IPv6' : 'IPv4',
    registry: registryOf(url, raw.port43, ...(raw.links ?? []).map((l) => l?.href)),
    handle: raw.handle ?? null,
    name: raw.name ?? null,
    type: raw.type ?? null,
    start,
    end,
    cidrs: cidr0.length ? cidr0 : start && end ? rangeToCidrs(start, end) : [],
    country: typeof raw.country === 'string' && raw.country ? raw.country.toUpperCase() : null,
    org: orgOf(raw),
    description: remarksOf(raw),
    abuseEmail: abuseOf(raw),
    asn: asnOf(raw),
    created: eventOf(raw, 'registration'),
    updated: eventOf(raw, 'last changed', 'last update'),
    parentHandle: raw.parentHandle ?? null,
  };
}

// 国家代码：autnum 有的带 country（APNIC / RIPE / LACNIC），ARIN 没有
export function parseAutnum(raw, { asn, url } = {}) {
  if (!raw || raw.objectClassName !== 'autnum') throw new HttpError(502, 'RDAP 返回的数据格式无法识别');
  const startAutnum = Number.isInteger(raw.startAutnum) ? raw.startAutnum : null;
  const endAutnum = Number.isInteger(raw.endAutnum) ? raw.endAutnum : null;
  return {
    asn,
    handle: raw.handle ?? null,
    name: raw.name ?? null,
    type: raw.type ?? null,
    registry: registryOf(url, raw.port43, ...(raw.links ?? []).map((l) => l?.href)),
    country: typeof raw.country === 'string' && raw.country ? raw.country.toUpperCase() : null,
    org: orgOf(raw),
    description: remarksOf(raw),
    abuseEmail: abuseOf(raw),
    rangeStart: startAutnum,
    rangeEnd: endAutnum,
    status: Array.isArray(raw.status) ? raw.status.filter((s) => typeof s === 'string') : [],
    created: eventOf(raw, 'registration'),
    updated: eventOf(raw, 'last changed', 'last update'),
  };
}

// ---------- 请求 ----------

async function bootstrap(kind) {
  const { data } = await cache.wrap(`net:rdap-bootstrap:${kind}`, BOOTSTRAP_TTL, async () => {
    const raw = await fetchJSON(BOOTSTRAP[kind], { timeoutMs: 8000 });
    if (!Array.isArray(raw?.services)) throw new HttpError(502, 'RDAP 引导数据格式无法识别');
    return raw;
  });
  return data;
}

// 依次尝试 RIR 服务器与 rdap.org；404 表示未查到，429 表示限流。返回 { raw, url }
async function rdapQuery(kind, pathPart, servers) {
  const urls = [...servers.map((b) => `${b.replace(/\/*$/, '/')}${pathPart}`), `https://rdap.org/${pathPart}`];
  let lastErr;
  for (const url of urls) {
    let res;
    try {
      res = await outboundFetch(url, {
        headers: { accept: 'application/rdap+json, application/json' },
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      lastErr = upstreamError(err, url, 'RDAP 服务');
      continue;
    }
    if (res.status === 404) throw new HttpError(404, kind === 'ip' ? '未查到该 IP 的注册信息' : '未查到该 AS 号的注册信息（可能尚未分配）');
    if (res.status === 429) throw new HttpError(429, 'RDAP 服务限流，请稍后再试');
    if (!res.ok) {
      lastErr = new HttpError(502, `RDAP 服务返回 HTTP ${res.status}（${new URL(url).hostname}）`);
      continue;
    }
    try {
      return { raw: await res.json(), url: res.url || url };
    } catch {
      lastErr = new HttpError(502, 'RDAP 返回的不是合法 JSON');
    }
  }
  throw lastErr;
}

export async function lookupIp(ip) {
  const version = net.isIP(ip);
  let servers = [];
  try {
    servers = serversForIp(await bootstrap(version === 6 ? 'v6' : 'v4'), ip);
  } catch { /* 引导数据暂时取不到：只用 rdap.org */ }
  const { raw, url } = await rdapQuery('ip', `ip/${ip}`, servers);
  return parseIpNetwork(raw, { ip, url });
}

export async function lookupAsn(asn) {
  let servers = [];
  try {
    servers = serversForAsn(await bootstrap('asn'), asn);
  } catch { /* 同上 */ }
  const { raw, url } = await rdapQuery('asn', `autnum/${asn}`, servers);
  return parseAutnum(raw, { asn, url });
}

// 读取 ip 参数：只接受 IPv4 / IPv6 字面量（可带方括号），拒绝内网与保留地址
export function readIp(query) {
  const raw = param(query, 'ip', { required: true, max: 64 }).trim().replace(/^\[(.*)\]$/, '$1');
  if (!net.isIP(raw)) throw new HttpError(400, 'ip 不是合法的 IPv4 或 IPv6 地址');
  if (isBlockedIP(raw)) throw new HttpError(400, '内网或保留地址没有公网注册信息');
  const n = ipToBigInt(raw);
  if (net.isIP(raw) === 4) return bigIntToIp(n, 4);
  // ::ffff:a.b.c.d 映射地址按 IPv4 查询
  if (n >> 32n === 0xffffn) return bigIntToIp(n & 0xffffffffn, 4);
  return bigIntToIp(n, 6);
}

export function readAsn(query) {
  const raw = param(query, 'asn', { required: true, max: 12 }).trim();
  const m = /^(?:AS)?(\d{1,10})$/i.exec(raw);
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_ASN) throw new HttpError(400, 'asn 须为 1~4294967295 的 AS 号，如 13335 或 AS13335');
  return n;
}

const COMMON_FIELDS = (what) => [
  { name: 'handle', type: 'string|null', desc: `${what}在 RIR 数据库中的句柄（如 APNIC 为「1.1.1.0 - 1.1.1.255」、ARIN 为 NET-…/AS…）；上游未提供时为 null` },
  { name: 'name', type: 'string|null', desc: `${what}名称（如 APNIC-LABS、CLOUDFLARENET）；上游未提供时为 null` },
  { name: 'type', type: 'string|null', desc: '分配类型，上游原文，如 ASSIGNED PORTABLE、DIRECT ALLOCATION；上游未提供时为 null' },
  { name: 'registry', type: 'string|null', desc: '所属地区注册机构：APNIC（亚太）/ ARIN（北美）/ RIPE NCC（欧洲、中东）/ LACNIC（拉美）/ AFRINIC（非洲）；无法判断时为 null' },
  { name: 'country', type: 'string|null', desc: '国家或地区代码（ISO 3166-1 两位字母，如 CN、US、AU）；ARIN 等上游不提供时为 null' },
  { name: 'org', type: 'string|null', desc: '持有组织名称（registrant 联系人的名称，缺失时取 administrative 联系人）；都没有时为 null' },
  { name: 'description', type: 'array', desc: '上游 remarks 中的描述文字（每行一个字符串，已去重）；没有时为空数组' },
  { name: 'description[]', type: 'string', desc: '一行描述文字，上游原文（通常为英文）' },
  { name: 'abuseEmail', type: 'string|null', desc: '滥用投诉邮箱（abuse 联系人）；上游未提供时为 null' },
  { name: 'created', type: 'string|null', desc: '注册时间，ISO 8601 格式，UTC 时区；上游未提供时为 null' },
  { name: 'updated', type: 'string|null', desc: '最后修改时间，ISO 8601 格式，UTC 时区；上游未提供时为 null' },
];

export default {
  name: 'asn',
  category: 'net',
  title: 'IP 网段与 ASN',
  description: '通过 RDAP 查询 IP 所属网段、持有组织、地区注册机构与 AS 号信息',
  source: 'RDAP（APNIC / ARIN / RIPE NCC / LACNIC / AFRINIC，rdap.org 备用）',
  routes: [
    {
      method: 'GET',
      path: '/api/ip/asn',
      summary: '查询 IP 所属网段、组织、国家与 ASN',
      params: [{ name: 'ip', required: true, desc: 'IPv4 或 IPv6 公网地址', example: '1.1.1.1' }],
      fields: [
        { name: 'ip', type: 'string', desc: '查询的 IP（规范化后的写法，IPv6 为压缩小写形式）' },
        { name: 'version', type: 'string', desc: 'IP 版本：IPv4 / IPv6' },
        ...COMMON_FIELDS('网段'),
        { name: 'start', type: 'string|null', desc: '网段起始地址；上游未提供时为 null' },
        { name: 'end', type: 'string|null', desc: '网段结束地址；上游未提供时为 null' },
        { name: 'cidrs', type: 'array', desc: '网段的 CIDR 表示（优先取上游 cidr0 扩展，没有时由起止地址计算，最多 64 条）；起止地址缺失时为空数组' },
        { name: 'cidrs[]', type: 'string', desc: 'CIDR，如 1.1.1.0/24' },
        { name: 'asn', type: 'number|null', desc: '该网段的 AS 号（仅当 RDAP 响应含 AS 号引用时有值，如 ARIN 的 originautnums 扩展；APNIC、RIPE 等多数情况下没有，为 null）' },
        { name: 'parentHandle', type: 'string|null', desc: '上级网段的句柄；没有时为 null' },
      ],
      async handler({ query }) {
        const ip = readIp(query);
        return cache.wrap(`net:asn:ip:${ip}`, RESULT_TTL, () => lookupIp(ip));
      },
    },
    {
      method: 'GET',
      path: '/api/asn',
      summary: '查询 AS 号的名称、持有组织与注册机构',
      params: [{ name: 'asn', required: true, desc: 'AS 号，可带 AS 前缀，如 13335 或 AS4134', example: '13335' }],
      fields: [
        { name: 'asn', type: 'number', desc: '查询的 AS 号' },
        ...COMMON_FIELDS('AS 号'),
        { name: 'rangeStart', type: 'number|null', desc: '该 RDAP 记录覆盖的 AS 号段起点（通常与 asn 相同）；上游未提供时为 null' },
        { name: 'rangeEnd', type: 'number|null', desc: '该 RDAP 记录覆盖的 AS 号段终点；上游未提供时为 null' },
        { name: 'status', type: 'array', desc: 'RDAP 状态，如 active；上游未提供时为空数组' },
        { name: 'status[]', type: 'string', desc: '状态值，上游原文' },
      ],
      async handler({ query }) {
        const asn = readAsn(query);
        return cache.wrap(`net:asn:as:${asn}`, RESULT_TTL, () => lookupAsn(asn));
      },
    },
  ],
};

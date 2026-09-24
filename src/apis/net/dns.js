import dns from 'node:dns';
import net from 'node:net';
import { HttpError, param } from '../../lib/http.js';
import { parseIPv6 } from '../../lib/netguard.js';
import { createGate, parseHost, isBlockedIP, BLOCKED_MSG, since } from './common.js';

// 只允许这几个公共 DNS，不接受任意服务器地址（否则可被用来探测内网 DNS 或做反射）。
// 不使用服务器本机的系统 DNS，避免泄露内网私有域名的解析结果。
export const DNS_SERVERS = {
  cloudflare: '1.1.1.1',
  google: '8.8.8.8',
  alidns: '223.5.5.5',
  dnspod: '119.29.29.29',
  114: '114.114.114.114',
};
export const DEFAULT_SERVER = 'cloudflare';
// 数字键 114 在对象里会排到最前，提示信息按这个顺序列出
const SERVER_NAMES = ['cloudflare', 'google', 'alidns', 'dnspod', '114'];
export const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'CAA', 'SRV', 'PTR'];
const ALL_TYPES = RECORD_TYPES.filter((t) => t !== 'PTR');
const QUERY_TIMEOUT_MS = 5000; // 整体时限；单个查询由 c-ares 控制：每次 2 秒，最多 2 次
const gate = createGate(20);

const ERRORS = {
  ETIMEOUT: 'DNS 服务器响应超时',
  ECANCELLED: 'DNS 查询超时，已取消',
  ESERVFAIL: 'DNS 服务器返回 SERVFAIL（上游解析失败，常见于权威服务器故障或 DNSSEC 校验失败）',
  EREFUSED: 'DNS 服务器拒绝了查询',
  ECONNREFUSED: '无法连接 DNS 服务器',
  EBADRESP: 'DNS 响应格式错误',
  EFORMERR: 'DNS 服务器认为查询格式错误',
  ENOTIMP: 'DNS 服务器不支持该查询类型',
  EBADNAME: '域名格式错误',
  EBADFAMILY: '不支持的地址族',
  EDESTRUCTION: '查询被中止',
};

// 查询状态：ok 有记录；empty 域名存在但没有该类型的记录（NODATA）；nxdomain 域名不存在；error 查询出错
export function classifyDnsError(err) {
  if (err?.code === 'ENODATA') return { status: 'empty', error: null };
  if (err?.code === 'ENOTFOUND') return { status: 'nxdomain', error: null };
  return { status: 'error', error: ERRORS[err?.code] ?? `查询失败（${err?.code ?? err?.message ?? '未知错误'}）` };
}

// IP → 反向解析用的域名（1.2.3.4 → 4.3.2.1.in-addr.arpa）
export function reverseName(ip) {
  if (net.isIPv4(ip)) return `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
  const words = parseIPv6(ip);
  if (!words) return null;
  const hex = words.map((w) => w.toString(16).padStart(4, '0')).join('');
  return `${[...hex].reverse().join('.')}.ip6.arpa`;
}

// 把 node:dns 各类型的原始结果统一成 { value, ... } 的记录数组
export function normalizeRecords(type, raw) {
  switch (type) {
    case 'A':
    case 'AAAA':
      return raw.map((r) => ({ value: r.address, ttl: r.ttl }));
    case 'CNAME':
    case 'NS':
    case 'PTR':
      return raw.map((v) => ({ value: v }));
    case 'MX':
      // Null MX（RFC 7505，交换服务器为根域 "."）node:dns 返回空字符串，这里还原成 "."
      return [...raw].sort((a, b) => a.priority - b.priority).map((r) => ({ value: r.exchange || '.', priority: r.priority }));
    case 'TXT':
      return raw.map((chunks) => ({ value: chunks.join('') }));
    case 'SOA':
      return [{
        value: raw.nsname,
        hostmaster: raw.hostmaster,
        serial: raw.serial,
        refresh: raw.refresh,
        retry: raw.retry,
        expire: raw.expire,
        minttl: raw.minttl,
      }];
    case 'CAA':
      return raw.map(({ critical, ...rest }) => {
        const [tag = null, value = ''] = Object.entries(rest)[0] ?? [];
        return { value: String(value), tag, flags: critical ?? 0 };
      });
    case 'SRV':
      return [...raw].sort((a, b) => a.priority - b.priority || b.weight - a.weight)
        .map((r) => ({ value: r.name, priority: r.priority, weight: r.weight, port: r.port }));
    default:
      return [];
  }
}

function runQuery(resolver, type, name) {
  switch (type) {
    case 'A': return resolver.resolve4(name, { ttl: true });
    case 'AAAA': return resolver.resolve6(name, { ttl: true });
    case 'CNAME': return resolver.resolveCname(name);
    case 'MX': return resolver.resolveMx(name);
    case 'TXT': return resolver.resolveTxt(name);
    case 'NS': return resolver.resolveNs(name);
    case 'SOA': return resolver.resolveSoa(name);
    case 'CAA': return resolver.resolveCaa(name);
    case 'SRV': return resolver.resolveSrv(name);
    case 'PTR': return resolver.resolvePtr(name);
    default: throw new Error(`unknown type ${type}`);
  }
}

// DNS 查询的域名：允许下划线（_dmarc、_sip._tcp 等），至少两级
function parseQueryName(input) {
  const h = parseHost(input);
  if (!h) throw new HttpError(400, 'domain 不是合法的域名或 IP 地址');
  if (h.local) throw new HttpError(400, BLOCKED_MSG);
  return h;
}

const defaultResolver = (opts) => new dns.promises.Resolver(opts);

// createResolver、blocked、timeoutMs 仅供测试替换
export async function lookupDns({ domain, type = 'ALL', server = DEFAULT_SERVER }, {
  createResolver = defaultResolver, blocked = isBlockedIP, timeoutMs = QUERY_TIMEOUT_MS,
} = {}) {
  const serverIp = DNS_SERVERS[server];
  if (!serverIp) throw new HttpError(400, `server 只能是 ${SERVER_NAMES.join(' / ')}`);
  const h = parseQueryName(domain);
  let types;
  let name = h.host;
  if (h.ip) {
    // IP 只能做反向解析；内网 / 保留地址的反向解析没有意义，一并拒绝
    if (blocked(h.ip)) throw new HttpError(400, BLOCKED_MSG);
    if (type !== 'ALL' && type !== 'PTR') throw new HttpError(400, 'IP 地址只能查询 PTR（反向解析）记录');
    types = ['PTR'];
    name = reverseName(h.ip);
  } else {
    if (type === 'PTR' && !name.endsWith('.arpa')) throw new HttpError(400, 'PTR 查询请直接传 IP 地址，或 in-addr.arpa / ip6.arpa 形式的域名');
    types = type === 'ALL' ? ALL_TYPES : [type];
  }

  const resolver = createResolver({ timeout: 2000, tries: 2 });
  resolver.setServers([serverIp]);
  const t0 = performance.now();
  // 各类型并行查询、互不影响（相当于 allSettled）；整体超过 timeoutMs 时取消仍未完成的查询
  const results = new Array(types.length);
  const tasks = types.map(async (t, i) => {
    const s = performance.now();
    try {
      const records = normalizeRecords(t, await runQuery(resolver, t, name));
      results[i] ??= { type: t, status: records.length ? 'ok' : 'empty', ms: since(s), records, error: null };
    } catch (err) {
      const { status, error } = classifyDnsError(err);
      results[i] ??= { type: t, status, ms: since(s), records: [], error };
    }
  });
  let timer;
  await Promise.race([
    Promise.all(tasks),
    new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  clearTimeout(timer);
  types.forEach((t, i) => {
    results[i] ??= { type: t, status: 'error', ms: null, records: [], error: ERRORS.ECANCELLED };
  });
  resolver.cancel?.();

  return {
    domain: h.host,
    query: name,
    type,
    server,
    serverIp,
    ms: since(t0),
    results,
  };
}

export default {
  name: 'dns',
  category: 'net',
  title: 'DNS 查询',
  description: '通过指定的公共 DNS 查询域名的 A、AAAA、CNAME、MX、TXT、NS、SOA、CAA、SRV、PTR 记录',
  source: '公共 DNS（Cloudflare / Google / 阿里 / DNSPod / 114）',
  routes: [
    {
      method: 'GET',
      path: '/api/dns',
      summary: '查询域名的 DNS 记录，可选公共 DNS 服务器',
      params: [
        { name: 'domain', required: true, desc: '要查询的域名（支持中文域名、_dmarc 这类带下划线的名称）；查 PTR 时直接传 IP 地址', example: 'github.com' },
        { name: 'type', required: false, default: 'ALL', desc: `记录类型：${RECORD_TYPES.join(' / ')} / ALL（除 PTR 外全部查询）。domain 为 IP 时自动按 PTR 查询`, example: 'MX' },
        { name: 'server', required: false, default: DEFAULT_SERVER, desc: 'DNS 服务器：cloudflare（1.1.1.1）、google（8.8.8.8）、alidns（223.5.5.5）、dnspod（119.29.29.29）、114（114.114.114.114），不支持自定义地址', example: 'alidns' },
      ],
      fields: [
        { name: 'domain', type: 'string', desc: '查询的域名（ASCII 形式，中文域名已转为 punycode，如 xn--fiqs8s）；传入 IP 时为该 IP' },
        { name: 'query', type: 'string', desc: '实际发给 DNS 服务器的名称：通常与 domain 相同；PTR 查询时为反向域名（如 4.4.8.8.in-addr.arpa）' },
        { name: 'type', type: 'string', desc: '请求的记录类型：A / AAAA / CNAME / MX / TXT / NS / SOA / CAA / SRV / PTR / ALL（与 type 参数一致，未传时为 ALL）' },
        { name: 'server', type: 'string', desc: '使用的 DNS 服务器名：cloudflare / google / alidns / dnspod / 114' },
        { name: 'serverIp', type: 'string', desc: 'DNS 服务器的 IP 地址（如 1.1.1.1）' },
        { name: 'ms', type: 'number', desc: '全部查询完成的总耗时（毫秒，保留两位小数；各类型并行查询）' },
        { name: 'results', type: 'array', desc: '每种记录类型一项，顺序固定为 A、AAAA、CNAME、MX、TXT、NS、SOA、CAA、SRV（ALL 时）；单独查询时只有一项' },
        { name: 'results[].type', type: 'string', desc: '记录类型（A / AAAA / CNAME / MX / TXT / NS / SOA / CAA / SRV / PTR）' },
        { name: 'results[].status', type: 'string', desc: '查询结果：ok 有记录；empty 域名存在但没有该类型的记录；nxdomain 域名不存在；error 查询出错（超时、服务器拒绝等，见 error）。empty / nxdomain 是正常的"没有记录"，与 error 区分' },
        { name: 'results[].ms', type: 'number|null', desc: '该类型的查询耗时（毫秒，保留两位小数）；整体超过 5 秒被取消时为 null' },
        { name: 'results[].records', type: 'array', desc: '记录列表；status 不是 ok 时为空数组。MX 按优先级升序，SRV 按优先级升序、权重降序' },
        { name: 'results[].records[].value', type: 'string', desc: '记录值：A / AAAA 为 IP 地址；CNAME / NS / PTR 为域名；MX 为邮件服务器域名（为 . 时是 Null MX，表示该域名不接收邮件）；TXT 为文本（多段字符串已拼接）；SOA 为主 DNS 服务器；CAA 为属性值（如 letsencrypt.org）；SRV 为目标主机' },
        { name: 'results[].records[].ttl', type: 'number', desc: '缓存时间 TTL（秒），仅 A / AAAA 记录有此字段（其他类型 node:dns 无法取得 TTL）' },
        { name: 'results[].records[].priority', type: 'number', desc: '优先级，数值越小越优先；仅 MX、SRV 记录有此字段' },
        { name: 'results[].records[].weight', type: 'number', desc: '同优先级下的权重，仅 SRV 记录有此字段' },
        { name: 'results[].records[].port', type: 'number', desc: '服务端口，仅 SRV 记录有此字段' },
        { name: 'results[].records[].tag', type: 'string|null', desc: 'CAA 属性名：issue 允许签发证书的 CA、issuewild 允许签发通配符证书的 CA、iodef 违规报告地址；仅 CAA 记录有此字段，无法识别时为 null' },
        { name: 'results[].records[].flags', type: 'number', desc: 'CAA 标志位：0 普通，128 关键（CA 不认识该属性时必须拒绝签发）；仅 CAA 记录有此字段' },
        { name: 'results[].records[].hostmaster', type: 'string', desc: '管理员邮箱（SOA 格式，第一个点代表 @，如 dns.cloudflare.com 即 dns@cloudflare.com）；仅 SOA 记录有此字段' },
        { name: 'results[].records[].serial', type: 'number', desc: '区域序列号，每次修改记录后递增；仅 SOA 记录有此字段' },
        { name: 'results[].records[].refresh', type: 'number', desc: '辅 DNS 服务器检查更新的间隔（秒）；仅 SOA 记录有此字段' },
        { name: 'results[].records[].retry', type: 'number', desc: '辅 DNS 服务器更新失败后的重试间隔（秒）；仅 SOA 记录有此字段' },
        { name: 'results[].records[].expire', type: 'number', desc: '辅 DNS 服务器联系不上主服务器时，区域数据的有效期（秒）；仅 SOA 记录有此字段' },
        { name: 'results[].records[].minttl', type: 'number', desc: '否定缓存时间（秒）：查询不到记录的结果被缓存多久；仅 SOA 记录有此字段' },
        { name: 'results[].error', type: 'string|null', desc: '查询出错的中文说明（如"DNS 服务器响应超时"）；status 为 ok / empty / nxdomain 时为 null' },
      ],
      async handler({ query }) {
        const domain = param(query, 'domain', { required: true, max: 253 });
        const type = (param(query, 'type', { default: 'ALL', max: 5 }) ?? 'ALL').toUpperCase();
        if (type !== 'ALL' && !RECORD_TYPES.includes(type)) throw new HttpError(400, `type 只能是 ${RECORD_TYPES.join(' / ')} / ALL`);
        const server = param(query, 'server', { default: DEFAULT_SERVER, oneOf: SERVER_NAMES });
        return { data: await gate(() => lookupDns({ domain, type, server })) };
      },
    },
  ],
};

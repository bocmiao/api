// DNS 传播检测：并发向多个公共 DoH（DNS over HTTPS）JSON 接口查询同一条记录，比较各家的答案是否一致。
// 这些 DoH 地址是写死的固定地址，不接受用户传入的服务器，因此不需要 SSRF 检查；只校验 domain 格式。
import { HttpError, param } from '../../lib/http.js';
import { createGate, parseHost, BLOCKED_MSG, since } from './common.js';

export const PROPAGATION_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'];
const TYPE_CODES = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 };
const TIMEOUT_MS = 5000;
const MAX_BODY = 256 * 1024;
const gate = createGate(10);

// typeStyle：type 参数传记录类型名（A）还是数字（1）。
// verified=false 的接口在编写时无法联网确认是否支持 JSON 格式，需要上线后验证；不支持时该源会显示为 error，不影响其他源。
export const DOH_SOURCES = [
  { id: 'google', name: 'Google', location: '全球 Anycast', endpoint: 'https://dns.google/resolve', typeStyle: 'name', verified: true },
  { id: 'cloudflare', name: 'Cloudflare', location: '全球 Anycast', endpoint: 'https://cloudflare-dns.com/dns-query', typeStyle: 'name', verified: true },
  { id: 'alidns', name: '阿里公共 DNS', location: '中国', endpoint: 'https://dns.alidns.com/resolve', typeStyle: 'number', verified: true },
  // DNSPod 的 https://doh.pub/dns-query 与 sm2.doh.pub 是 RFC 8484 二进制格式；/resolve 的 JSON 接口未在官方文档中确认
  { id: 'dnspod', name: '腾讯 DNSPod', location: '中国', endpoint: 'https://doh.pub/resolve', typeStyle: 'name', verified: false },
  { id: 'quad9', name: 'Quad9', location: '全球 Anycast', endpoint: 'https://dns.quad9.net:5053/dns-query', typeStyle: 'name', verified: true },
  // 用 AdGuard 的"无过滤"地址，默认地址会把广告域名解析成 0.0.0.0，造成误判为不一致
  { id: 'adguard', name: 'AdGuard（无过滤）', location: '全球 Anycast', endpoint: 'https://unfiltered.adguard-dns.com/resolve', typeStyle: 'name', verified: true },
  { id: 'nextdns', name: 'NextDNS', location: '全球 Anycast', endpoint: 'https://dns.nextdns.io/dns-query', typeStyle: 'name', verified: false },
];

const RCODES = { 1: 'FORMERR（查询格式错误）', 2: 'SERVFAIL（上游解析失败，常见于权威服务器故障或 DNSSEC 校验失败）', 4: 'NOTIMP（不支持该查询）', 5: 'REFUSED（拒绝查询）' };

// 解析 domain 参数：必须是域名（不接受 IP、localhost），允许下划线（_dmarc 等）
export function parseDomain(input) {
  const h = parseHost(input);
  if (!h) throw new HttpError(400, 'domain 不是合法的域名');
  if (h.local) throw new HttpError(400, BLOCKED_MSG);
  if (h.ip) throw new HttpError(400, 'domain 须为域名，不能是 IP 地址');
  return h.host;
}

// 规范化 IPv6 写法（不同 DoH 可能返回不同的压缩形式）
function canonicalV6(s) {
  try {
    return new URL(`http://[${s}]/`).hostname.slice(1, -1);
  } catch {
    return s.toLowerCase();
  }
}

// TXT 的 data 在不同 DoH 中有的带引号、有的分段（"a" "b"），统一去引号并拼接
export function unquoteTxt(data) {
  const s = String(data).trim();
  if (!s.startsWith('"')) return s;
  const parts = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(s))) parts.push(m[1].replace(/\\(.)/g, '$1'));
  return parts.length ? parts.join('') : s;
}

const stripDot = (s) => String(s).trim().toLowerCase().replace(/\.$/, '') || '.';

// 把一条 Answer 的 data 规范化成便于比较的字符串
export function normalizeData(type, data) {
  switch (type) {
    case 'A': return String(data).trim();
    case 'AAAA': return canonicalV6(String(data).trim());
    case 'CNAME':
    case 'NS': return stripDot(data);
    case 'MX': {
      const [prio, host = '.'] = String(data).trim().split(/\s+/);
      return `${Number(prio)} ${stripDot(host)}`;
    }
    case 'TXT': return unquoteTxt(data);
    default: return String(data);
  }
}

// 解析 DoH JSON 响应 → { status, rcode, records, error }
// status：ok 有记录 / empty 域名存在但没有该类型记录 / nxdomain 域名不存在 / error 出错
export function parseDohJson(type, json) {
  if (!json || typeof json !== 'object' || typeof json.Status !== 'number') {
    return { status: 'error', rcode: null, records: [], error: '返回的不是 DoH JSON 格式' };
  }
  const rcode = json.Status;
  if (rcode === 3) return { status: 'nxdomain', rcode, records: [], error: null };
  if (rcode !== 0) return { status: 'error', rcode, records: [], error: `DNS 返回 ${RCODES[rcode] ?? `错误码 ${rcode}`}` };
  const code = TYPE_CODES[type];
  const seen = new Set();
  const records = [];
  for (const a of Array.isArray(json.Answer) ? json.Answer : []) {
    if (a?.type !== code || a.data == null) continue;
    const value = normalizeData(type, a.data);
    if (seen.has(value)) continue;
    seen.add(value);
    records.push({ value, ttl: Number.isFinite(a.TTL) ? a.TTL : null });
  }
  records.sort((x, y) => (x.value < y.value ? -1 : x.value > y.value ? 1 : 0));
  return { status: records.length ? 'ok' : 'empty', rcode, records, error: null };
}

// 查询一个 DoH 源；任何失败都记录在结果里，不抛出
export async function queryDoh(src, domain, type, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const t0 = performance.now();
  const u = new URL(src.endpoint);
  u.searchParams.set('name', domain);
  u.searchParams.set('type', src.typeStyle === 'number' ? String(TYPE_CODES[type]) : type);
  const base = { id: src.id, name: src.name, location: src.location, endpoint: src.endpoint, verified: src.verified };
  try {
    const res = await fetchImpl(u.href, {
      headers: { accept: 'application/dns-json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      try { await res.body?.cancel(); } catch {}
      return { ...base, status: 'error', rcode: null, records: [], ms: since(t0), error: `HTTP ${res.status}` };
    }
    const text = await res.text();
    if (text.length > MAX_BODY) return { ...base, status: 'error', rcode: null, records: [], ms: since(t0), error: '响应过大' };
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { ...base, status: 'error', rcode: null, records: [], ms: since(t0), error: '返回的不是 JSON（该接口可能不支持 JSON 格式）' };
    }
    return { ...base, ...parseDohJson(type, json), ms: since(t0) };
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { ...base, status: 'error', rcode: null, records: [], ms: since(t0), error: timeout ? `查询超时（${timeoutMs / 1000} 秒）` : `请求失败（${err?.cause?.code ?? err?.code ?? err?.message ?? '未知错误'}）` };
  }
}

// 按答案分组：状态相同且记录值集合相同的源归为一组（不比较 TTL）；出错的源不参与分组
export function groupAnswers(sources) {
  const groups = new Map();
  for (const s of sources) {
    if (s.status === 'error') continue;
    const values = s.records.map((r) => r.value);
    const key = `${s.status}\n${values.join('\n')}`;
    if (!groups.has(key)) groups.set(key, { status: s.status, values, sources: [], count: 0 });
    const g = groups.get(key);
    g.sources.push(s.id);
    g.count++;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

// fetchImpl、timeoutMs、sources 仅供测试替换
export async function checkPropagation(rawDomain, type = 'A', { fetchImpl, timeoutMs = TIMEOUT_MS, sources = DOH_SOURCES } = {}) {
  const domain = parseDomain(rawDomain);
  if (!PROPAGATION_TYPES.includes(type)) throw new HttpError(400, `type 只能是 ${PROPAGATION_TYPES.join(' / ')}`);
  const t0 = performance.now();
  const results = await Promise.all(sources.map((s) => queryDoh(s, domain, type, { fetchImpl: fetchImpl ?? globalThis.fetch, timeoutMs })));
  const groups = groupAnswers(results);
  const responded = results.filter((r) => r.status !== 'error').length;
  // 最多数答案：数量并列时取排在前面的一组（源顺序靠前者优先），同时用 tie 标明
  const majority = groups[0] ?? null;
  return {
    domain,
    type,
    consistent: responded > 0 && groups.length === 1,
    total: results.length,
    responded,
    failed: results.length - responded,
    majority: majority && { ...majority, tie: groups.length > 1 && groups[1].count === majority.count },
    groups,
    sources: results,
    ms: since(t0),
  };
}

const SOURCE_DESC = DOH_SOURCES.map((s) => s.id).join(' / ');

export default {
  name: 'dns-propagation',
  category: 'net',
  title: 'DNS 传播检测',
  description: '同时向 Google、Cloudflare、阿里、DNSPod、Quad9、AdGuard、NextDNS 等公共 DoH 查询同一记录，检查修改 DNS 后各地是否已生效、答案是否一致',
  source: '公共 DoH（DNS over HTTPS）JSON 接口',
  routes: [
    {
      method: 'GET',
      path: '/api/dns/propagation',
      summary: '多个公共 DNS 并发查询，对比解析结果是否一致',
      params: [
        { name: 'domain', required: true, desc: '要检测的域名（支持中文域名，允许 _dmarc 这类下划线标签；不接受 IP）', example: 'github.com' },
        { name: 'type', required: false, default: 'A', desc: `记录类型：${PROPAGATION_TYPES.join(' / ')}`, example: 'A' },
      ],
      fields: [
        { name: 'domain', type: 'string', desc: '查询的域名（ASCII 形式，中文域名为 punycode）' },
        { name: 'type', type: 'string', desc: '查询的记录类型' },
        { name: 'consistent', type: 'boolean', desc: '所有成功响应的源答案是否完全一致（比较记录值集合与状态，不比较 TTL；出错的源不参与）。注意：使用 GeoDNS / CDN 的域名在不同地区本就会返回不同 IP，此时不一致是正常现象，不代表未生效' },
        { name: 'total', type: 'number', desc: '查询的源数量' },
        { name: 'responded', type: 'number', desc: '成功得到 DNS 答复的源数量（含 nxdomain、empty）' },
        { name: 'failed', type: 'number', desc: '查询失败（超时、HTTP 错误、SERVFAIL 等）的源数量' },
        { name: 'majority', type: 'object|null', desc: '最多源给出的答案（即 groups 的第一组）；全部失败时为 null' },
        { name: 'majority.status', type: 'string', desc: '该答案的状态：ok 有记录 / empty 域名存在但无该类型记录 / nxdomain 域名不存在' },
        { name: 'majority.values', type: 'array', desc: '该答案的记录值（已规范化并排序）；empty / nxdomain 时为空数组' },
        { name: 'majority.sources', type: 'array', desc: '给出该答案的源 id 列表' },
        { name: 'majority.count', type: 'number', desc: '给出该答案的源数量' },
        { name: 'majority.tie', type: 'boolean', desc: '是否有其他答案与它票数相同（并列时取源顺序靠前的一组）' },
        { name: 'groups', type: 'array', desc: '按答案分组（相同答案的源归为一组），按源数量从多到少排列；出错的源不计入' },
        { name: 'groups[].status', type: 'string', desc: '该组答案的状态：ok / empty / nxdomain' },
        { name: 'groups[].values', type: 'array', desc: '该组的记录值（已规范化并排序）' },
        { name: 'groups[].sources', type: 'array', desc: '该组包含的源 id' },
        { name: 'groups[].count', type: 'number', desc: '该组的源数量' },
        { name: 'sources', type: 'array', desc: '每个 DoH 源的查询结果，顺序固定' },
        { name: 'sources[].id', type: 'string', desc: `源 id：${SOURCE_DESC}` },
        { name: 'sources[].name', type: 'string', desc: '源名称' },
        { name: 'sources[].location', type: 'string', desc: '服务节点分布（Anycast 表示按访问者就近接入，本服务器所在地区决定实际节点）' },
        { name: 'sources[].endpoint', type: 'string', desc: '查询的 DoH JSON 接口地址' },
        { name: 'sources[].verified', type: 'boolean', desc: '该接口是否已确认支持 DoH JSON 格式；false 表示未经确认，若不支持会显示为 error' },
        { name: 'sources[].status', type: 'string', desc: '查询状态：ok 有记录 / empty 域名存在但没有该类型记录 / nxdomain 域名不存在 / error 查询失败' },
        { name: 'sources[].rcode', type: 'number|null', desc: 'DNS 响应码：0 NOERROR、2 SERVFAIL、3 NXDOMAIN、5 REFUSED 等；请求失败未得到 DNS 答复时为 null' },
        { name: 'sources[].records', type: 'array', desc: '与查询类型一致的记录（CNAME 链中的中间记录不含在内），按值排序、去重' },
        { name: 'sources[].records[].value', type: 'string', desc: '记录值（规范化后）：A / AAAA 为 IP；CNAME / NS 为小写且去掉末尾点的域名；MX 为"优先级 邮件服务器"；TXT 已去掉引号并拼接分段' },
        { name: 'sources[].records[].ttl', type: 'number|null', desc: '该源返回的剩余 TTL（秒）：递归服务器缓存的剩余时间，各源不同属正常；未返回时为 null' },
        { name: 'sources[].ms', type: 'number', desc: '该源查询耗时（毫秒，含 HTTPS 连接）' },
        { name: 'sources[].error', type: 'string|null', desc: '失败原因的中文说明（如"查询超时（5 秒）""HTTP 400""DNS 返回 SERVFAIL"）；成功时为 null' },
        { name: 'ms', type: 'number', desc: '总耗时（毫秒）：所有源并发查询，单个源超时 5 秒' },
      ],
      async handler({ query }) {
        const domain = param(query, 'domain', { required: true, max: 300 });
        const type = String(param(query, 'type', { default: 'A', max: 10 })).toUpperCase();
        return { data: await gate(() => checkPropagation(domain, type)) };
      },
    },
  ],
};

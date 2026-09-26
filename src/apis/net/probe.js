// 多节点检测：通过 Globalping（jsDelivr 运营的免费全球探针网络）从各地探针发起 Ping / TCPing、HTTP 测速、DNS 解析、Traceroute。
// 请求由 Globalping 的探针发出，不经过本服务器，因此只校验目标格式并拒绝内网 / 保留地址与 localhost 等本地名称。
// 流程：POST /v1/measurements 创建测量 → 每 500ms 轮询 GET /v1/measurements/{id}，直到 finished 或约 25 秒超时（超时返回已有结果并标 partial）。
import { HttpError, param, networkReason, overseasHint } from '../../lib/http.js';
import { outboundFetch } from '../../lib/proxy.js';
import { cache } from '../../lib/cache.js';
import { createGate, requireHost, isBlockedIP, BLOCKED_MSG, round2 } from './common.js';

export const API_BASE = 'https://api.globalping.io/v1';
// 轮询参数，测试里可改小
export const POLL = { intervalMs: 500, timeoutMs: 25_000, requestTimeoutMs: 10_000 };
const CACHE_TTL = 60_000;
const UA = 'MiaoAPI/1.0 (multi-probe check)';

// 每个请求最长占用约 25 秒，并发上限不宜太高
const gate = createGate(5);

export const RATE_LIMIT_MSG = 'Globalping 探针网络额度已用完（匿名约每小时 250 次），请稍后再试，或在后台「第三方接口密钥」中配置 GLOBALPING_TOKEN 提高额度';

// ---------- 地区 ----------

const CONTINENTS = { asia: 'AS', europe: 'EU', northamerica: 'NA', southamerica: 'SA', africa: 'AF', oceania: 'OC' };
export const REGION_DESC = 'china（中国大陆）/ asia / europe / northamerica / southamerica / africa / oceania / world（全球分布）/ 两位国家代码（如 US、JP、HK）';

// region 参数 → Globalping locations（world 不传 locations，由 Globalping 全球分布挑选探针）
export function buildLocations(region) {
  const r = String(region ?? 'china').trim().toLowerCase();
  if (r === 'world') return { region: 'world', locations: undefined };
  if (r === 'china' || r === 'cn') return { region: 'china', locations: [{ country: 'CN' }] };
  if (CONTINENTS[r]) return { region: r, locations: [{ continent: CONTINENTS[r] }] };
  if (/^[a-z]{2}$/.test(r)) return { region: r.toUpperCase(), locations: [{ country: r.toUpperCase() }] };
  throw new HttpError(400, `region 只能是 ${REGION_DESC}`);
}

// ---------- 目标校验 ----------

// 这些顶级域只在内网 / 本地使用或为保留域，公网探针解析不到，也不应让探针去试探
const PRIVATE_TLDS = new Set(['local', 'localhost', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'corp', 'private', 'test', 'invalid', 'arpa', 'onion', 'alt']);

// 目标必须是公网域名或公网 IP；返回 ASCII 域名或 IP
export function checkProbeTarget(raw, name = 'target', blocked = isBlockedIP) {
  const h = requireHost(raw, blocked, name);
  if (!h.ip && PRIVATE_TLDS.has(h.host.split('.').at(-1))) throw new HttpError(400, BLOCKED_MSG);
  return h.host;
}

// http 路由的网址：没有协议时按 https 处理；只取主机名交给 Globalping，路径 / 查询串 / 端口分开传
export function parseProbeUrl(raw) {
  let s = String(raw ?? '').trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new HttpError(400, 'url 不是合法的网址');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, '只支持 http / https 网址');
  if (u.username || u.password) throw new HttpError(400, '网址中不能包含用户名或密码');
  const host = checkProbeTarget(u.hostname, 'url');
  const https = u.protocol === 'https:';
  return {
    url: `${u.protocol}//${u.host}${u.pathname}${u.search}`,
    host,
    protocol: https ? 'HTTPS' : 'HTTP',
    port: u.port ? Number(u.port) : https ? 443 : 80,
    path: u.pathname || '/',
    query: u.search ? u.search.slice(1) : '',
  };
}

// ---------- 调用 Globalping ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function headers(json = false) {
  const h = { accept: 'application/json', 'user-agent': UA };
  if (json) h['content-type'] = 'application/json';
  const token = process.env.GLOBALPING_TOKEN; // 实时读取，后台修改后立即生效
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

// 上游错误 → 中文 HttpError
async function upstreamError(res) {
  let body = null;
  try {
    body = await res.json();
  } catch { /* 忽略非 JSON 错误体 */ }
  const type = body?.error?.type;
  const msg = body?.error?.message;
  if (res.status === 429) return new HttpError(503, RATE_LIMIT_MSG);
  if (res.status === 401 || res.status === 403) return new HttpError(503, 'GLOBALPING_TOKEN 无效或已过期，请在后台检查或清空后重试');
  if (res.status === 422 || type === 'no_probes_found') return new HttpError(400, '所选地区暂无可用探针，请换一个 region 或减小 limit');
  if (res.status === 400) return new HttpError(400, `Globalping 拒绝了请求${msg ? `：${msg}` : ''}`);
  if (res.status === 404) return new HttpError(502, '测量结果已不存在');
  return new HttpError(502, `Globalping 返回 HTTP ${res.status}`);
}

async function call(path, init) {
  let res;
  try {
    res = await outboundFetch(`${API_BASE}${path}`, { ...init, signal: AbortSignal.timeout(POLL.requestTimeoutMs) });
  } catch (err) {
    const hint = overseasHint(API_BASE);
    if (err?.name === 'TimeoutError') throw new HttpError(504, `Globalping 响应超时${hint}`);
    const reason = networkReason(err);
    throw new HttpError(502, `无法连接 Globalping${reason ? `（${reason}）` : ''}${hint}`);
  }
  if (!res.ok) throw await upstreamError(res);
  try {
    return await res.json();
  } catch {
    throw new HttpError(502, 'Globalping 返回的不是合法 JSON');
  }
}

// 创建测量并轮询到完成或超时。返回 { id, probesCount, status, partial, results }
export async function runMeasurement(body) {
  const created = await call('/measurements', { method: 'POST', headers: headers(true), body: JSON.stringify(body) });
  if (!created?.id || typeof created.id !== 'string') throw new HttpError(502, 'Globalping 没有返回测量 id');
  const deadline = Date.now() + POLL.timeoutMs;
  let last = null;
  for (;;) {
    await sleep(POLL.intervalMs);
    last = await call(`/measurements/${encodeURIComponent(created.id)}`, { headers: headers() });
    if (last?.status !== 'in-progress') break;
    if (Date.now() + POLL.intervalMs > deadline) break;
  }
  const finished = last?.status !== 'in-progress';
  return {
    id: created.id,
    probesCount: Number(created.probesCount ?? last?.probesCount ?? 0) || 0,
    status: finished ? (last?.status ?? 'finished') : 'in-progress',
    partial: !finished,
    results: Array.isArray(last?.results) ? last.results : [],
  };
}

// ---------- 结果整理 ----------

let regionNames = null;
export function countryName(code) {
  if (!code) return null;
  try {
    regionNames ??= new Intl.DisplayNames(['zh-CN'], { type: 'region' });
    const n = regionNames.of(code);
    return n && n !== code ? n : code;
  } catch {
    return code;
  }
}

const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOrNull = (v) => (typeof v === 'string' && v ? v : null);
const avgOf = (arr) => (arr.length ? round2(arr.reduce((a, b) => a + b, 0) / arr.length) : null);

// 探针信息（每个结果都带）
export function probeInfo(probe = {}) {
  return {
    country: strOrNull(probe.country),
    countryName: countryName(strOrNull(probe.country)),
    state: strOrNull(probe.state),
    city: strOrNull(probe.city),
    continent: strOrNull(probe.continent),
    asn: numOrNull(probe.asn),
    network: strOrNull(probe.network),
    latitude: numOrNull(probe.latitude),
    longitude: numOrNull(probe.longitude),
  };
}

// 失败时从原始输出里取一行作为说明
function errorOf(r) {
  if (r?.status === 'finished') return null;
  if (r?.status === 'in-progress') return '超时未完成';
  if (r?.status === 'offline') return '探针离线';
  const line = String(r?.rawOutput ?? '').split('\n').map((s) => s.trim()).find(Boolean);
  return line ? line.slice(0, 200) : '检测失败';
}

const baseOf = (item) => {
  const r = item?.result ?? {};
  return { ...probeInfo(item?.probe), status: String(r.status ?? 'failed'), error: errorOf(r) };
};

export function normalizePing(item) {
  const r = item?.result ?? {};
  const s = r.stats ?? {};
  const sent = numOrNull(s.total);
  const received = numOrNull(s.rcv);
  const times = Array.isArray(r.timings) ? r.timings.map((t) => numOrNull(t?.rtt)).filter((v) => v != null) : [];
  const base = baseOf(item);
  const ok = base.status === 'finished' && received != null && received > 0;
  const lossRate = numOrNull(s.loss) ?? (sent ? round2(((sent - (received ?? 0)) / sent) * 100) : null);
  return {
    ...base,
    ok,
    resolvedAddress: strOrNull(r.resolvedAddress),
    sent,
    received,
    lossRate: lossRate == null ? null : round2(lossRate),
    min: ok ? numOrNull(s.min) : null,
    avg: ok ? numOrNull(s.avg) : null,
    max: ok ? numOrNull(s.max) : null,
    times,
    latency: ok ? numOrNull(s.avg) ?? avgOf(times) : null,
  };
}

export function normalizeHttp(item) {
  const r = item?.result ?? {};
  const t = r.timings ?? {};
  const base = baseOf(item);
  const statusCode = numOrNull(r.statusCode);
  const ok = base.status === 'finished' && statusCode != null;
  return {
    ...base,
    ok,
    resolvedAddress: strOrNull(r.resolvedAddress),
    statusCode,
    timings: {
      dns: numOrNull(t.dns),
      tcp: numOrNull(t.tcp),
      tls: numOrNull(t.tls),
      firstByte: numOrNull(t.firstByte),
      download: numOrNull(t.download),
      total: numOrNull(t.total),
    },
    tlsProtocol: strOrNull(r.tls?.protocol),
    latency: ok ? numOrNull(t.total) : null,
  };
}

export function normalizeDns(item) {
  const r = item?.result ?? {};
  const base = baseOf(item);
  const ok = base.status === 'finished';
  const answers = Array.isArray(r.answers)
    ? r.answers.map((a) => ({ name: String(a?.name ?? ''), type: String(a?.type ?? ''), ttl: numOrNull(a?.ttl), value: String(a?.value ?? '') }))
    : [];
  return {
    ...base,
    ok,
    resolver: strOrNull(r.resolver),
    statusCodeName: strOrNull(r.statusCodeName),
    answers,
    latency: ok ? numOrNull(r.timings?.total) : null,
  };
}

const asnOf = (v) => (Array.isArray(v) ? numOrNull(v[0]) : numOrNull(v));

export function normalizeTraceroute(item) {
  const r = item?.result ?? {};
  const base = baseOf(item);
  const hops = (Array.isArray(r.hops) ? r.hops : []).map((h, i) => {
    const rtts = Array.isArray(h?.timings) ? h.timings.map((t) => numOrNull(t?.rtt)).filter((v) => v != null) : [];
    return {
      hop: i + 1,
      ip: strOrNull(h?.resolvedAddress),
      hostname: strOrNull(h?.resolvedHostname),
      asn: asnOf(h?.asn),
      rtts,
      avg: avgOf(rtts),
    };
  });
  const dest = strOrNull(r.resolvedAddress);
  const last = hops.at(-1);
  const reached = Boolean(dest && last?.ip === dest);
  const ok = base.status === 'finished';
  return {
    ...base,
    ok,
    resolvedAddress: dest,
    resolvedHostname: strOrNull(r.resolvedHostname),
    reached,
    hopCount: hops.length,
    hops,
    latency: ok && reached ? last.avg : null,
  };
}

// ---------- 聚合 ----------

const pick = (p) => (p ? { country: p.country, countryName: p.countryName, state: p.state, city: p.city, asn: p.asn, network: p.network, latency: p.latency } : null);

function stats(items) {
  const lat = items.filter((p) => p.latency != null).map((p) => p.latency);
  const withPackets = items.filter((p) => p.sent != null && p.status === 'finished');
  const sent = withPackets.reduce((a, p) => a + p.sent, 0);
  const received = withPackets.reduce((a, p) => a + (p.received ?? 0), 0);
  return {
    probes: items.length,
    ok: items.filter((p) => p.ok).length,
    avg: avgOf(lat),
    min: lat.length ? Math.min(...lat) : null,
    max: lat.length ? Math.max(...lat) : null,
    lossRate: sent ? round2(((sent - received) / sent) * 100) : null,
  };
}

// 按 key 分组，组按平均延迟升序（无延迟数据的排最后）
function groupBy(items, keyOf, headOf) {
  const groups = new Map();
  for (const p of items) {
    const k = keyOf(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  return [...groups.values()]
    .map((g) => ({ ...headOf(g[0]), ...stats(g) }))
    .sort((a, b) => (a.avg ?? Infinity) - (b.avg ?? Infinity));
}

// 汇总：latency 为各类型的"延迟"指标（Ping 平均 RTT、HTTP 总耗时、DNS 查询耗时、Traceroute 末跳 RTT）
export function summarize(items) {
  const done = items.filter((p) => p.status !== 'in-progress');
  const ranked = items.filter((p) => p.latency != null).sort((a, b) => a.latency - b.latency);
  const s = stats(items);
  return {
    probes: items.length,
    ok: s.ok,
    failed: done.filter((p) => !p.ok).length,
    pending: items.length - done.length,
    avg: s.avg,
    min: s.min,
    max: s.max,
    lossRate: s.lossRate,
    fastest: pick(ranked[0]),
    slowest: pick(ranked.at(-1)),
    byCountry: groupBy(items, (p) => p.country ?? '', (p) => ({ country: p.country, countryName: p.countryName })),
    byCity: groupBy(
      items,
      (p) => `${p.country ?? ''}|${p.state ?? ''}|${p.city ?? ''}`,
      (p) => ({ country: p.country, countryName: p.countryName, state: p.state, city: p.city }),
    ),
  };
}

// ---------- 执行 ----------

const NORMALIZE = { ping: normalizePing, http: normalizeHttp, dns: normalizeDns, traceroute: normalizeTraceroute };

// 统一入口：缓存 60 秒（未完成的 partial 结果不缓存），并发受 gate 限制
export async function probe(type, { target, region, limit, measurementOptions, echo }) {
  const loc = buildLocations(region);
  const key = `probe:${type}:${target}:${loc.region}:${limit}:${JSON.stringify(measurementOptions)}`;
  const hit = cache.get(key);
  if (hit?.fresh) return { data: hit.value, cached: true, updatedAt: hit.updatedAt };

  const body = { type, target, limit, measurementOptions, ...(loc.locations ? { locations: loc.locations } : {}) };
  const m = await gate(() => runMeasurement(body));
  const results = m.results.map(NORMALIZE[type]);
  const data = {
    target,
    region: loc.region,
    limit,
    ...echo,
    measurementId: m.id,
    status: m.status,
    partial: m.partial,
    probesCount: m.probesCount,
    results,
    summary: summarize(results),
  };
  if (!m.partial) cache.set(key, data, CACHE_TTL);
  return { data, cached: false, updatedAt: new Date().toISOString() };
}

// ---------- 字段说明 ----------

const PROBE_FIELDS = (p, noun) => [
  { name: p, type: 'array', desc: `每个探针的${noun}结果，顺序与 Globalping 返回一致` },
  { name: `${p}[].country`, type: 'string|null', desc: '探针所在国家 / 地区代码（ISO 3166-1 两位，如 CN、US）' },
  { name: `${p}[].countryName`, type: 'string|null', desc: '国家 / 地区中文名（如 中国、美国）' },
  { name: `${p}[].state`, type: 'string|null', desc: '州 / 省代码；Globalping 目前只为美国探针提供（如 CA），其他国家为 null' },
  { name: `${p}[].city`, type: 'string|null', desc: '探针所在城市（英文，如 Beijing、Shanghai）' },
  { name: `${p}[].continent`, type: 'string|null', desc: '大洲代码（AS 亚洲、EU 欧洲、NA 北美、SA 南美、AF 非洲、OC 大洋洲）' },
  { name: `${p}[].asn`, type: 'number|null', desc: '探针所在网络的 ASN（自治系统号，如 4134 为中国电信）' },
  { name: `${p}[].network`, type: 'string|null', desc: '探针所在网络 / 运营商名称（英文，如 China Telecom）' },
  { name: `${p}[].latitude`, type: 'number|null', desc: '探针大致纬度（城市级）' },
  { name: `${p}[].longitude`, type: 'number|null', desc: '探针大致经度（城市级）' },
  { name: `${p}[].status`, type: 'string', desc: '该探针的检测状态：finished 完成、failed 失败、offline 探针离线、in-progress 超时未完成（partial 时出现）' },
  { name: `${p}[].error`, type: 'string|null', desc: '失败原因（取自探针原始输出的第一行）；成功完成时为 null' },
  { name: `${p}[].ok`, type: 'boolean', desc: '该探针是否成功' },
];

const GROUP_FIELDS = (p, noun) => [
  { name: `${p}[].probes`, type: 'number', desc: '该组探针数' },
  { name: `${p}[].ok`, type: 'number', desc: '该组成功的探针数' },
  { name: `${p}[].avg`, type: 'number|null', desc: `该组平均${noun}（毫秒，只计成功的探针）；没有数据时为 null` },
  { name: `${p}[].min`, type: 'number|null', desc: `该组最低${noun}（毫秒）` },
  { name: `${p}[].max`, type: 'number|null', desc: `该组最高${noun}（毫秒）` },
  { name: `${p}[].lossRate`, type: 'number|null', desc: '该组整体丢包率（百分比，按包数合计；仅 Ping 有，其他类型为 null）' },
];

const NODE_FIELDS = (p, noun) => [
  { name: p, type: 'object|null', desc: `${noun}最低 / 最高的探针；没有成功的探针时为 null` },
  { name: `${p}.country`, type: 'string|null', desc: '国家 / 地区代码' },
  { name: `${p}.countryName`, type: 'string|null', desc: '国家 / 地区中文名' },
  { name: `${p}.state`, type: 'string|null', desc: '州 / 省代码（仅美国探针有）' },
  { name: `${p}.city`, type: 'string|null', desc: '城市' },
  { name: `${p}.asn`, type: 'number|null', desc: 'ASN' },
  { name: `${p}.network`, type: 'string|null', desc: '运营商 / 网络名称' },
  { name: `${p}.latency`, type: 'number', desc: `${noun}（毫秒）` },
];

const COMMON_FIELDS = (noun, latencyDesc) => [
  { name: 'target', type: 'string', desc: '检测目标（ASCII 域名或 IP）' },
  { name: 'region', type: 'string', desc: '探针地区：china、asia 等或大写国家代码' },
  { name: 'limit', type: 'number', desc: '请求的探针数量上限' },
  { name: 'measurementId', type: 'string', desc: 'Globalping 测量 id，可在 https://globalping.io 查看' },
  { name: 'status', type: 'string', desc: '测量状态：finished 已完成；in-progress 表示等待超时，返回的是部分结果' },
  { name: 'partial', type: 'boolean', desc: '是否为部分结果（约 25 秒内未全部完成）；部分结果不缓存' },
  { name: 'probesCount', type: 'number', desc: 'Globalping 实际分配的探针数（该地区探针不足时少于 limit）' },
  ...PROBE_FIELDS('results', noun),
  { name: 'results[].latency', type: 'number|null', desc: latencyDesc },
  { name: 'summary', type: 'object', desc: '汇总，便于前端画表格' },
  { name: 'summary.probes', type: 'number', desc: '探针总数' },
  { name: 'summary.ok', type: 'number', desc: '成功的探针数' },
  { name: 'summary.failed', type: 'number', desc: '已结束但失败的探针数（含离线）' },
  { name: 'summary.pending', type: 'number', desc: '超时未完成的探针数（partial 时大于 0）' },
  { name: 'summary.avg', type: 'number|null', desc: `所有成功探针的平均${noun}（毫秒）` },
  { name: 'summary.min', type: 'number|null', desc: `最低${noun}（毫秒）` },
  { name: 'summary.max', type: 'number|null', desc: `最高${noun}（毫秒）` },
  { name: 'summary.lossRate', type: 'number|null', desc: '整体丢包率（百分比，所有已完成探针的包数合计；仅 Ping 有，其他类型为 null）' },
  ...NODE_FIELDS('summary.fastest', noun),
  ...NODE_FIELDS('summary.slowest', noun),
  { name: 'summary.byCountry', type: 'array', desc: `按国家 / 地区聚合，按平均${noun}升序` },
  { name: 'summary.byCountry[].country', type: 'string|null', desc: '国家 / 地区代码' },
  { name: 'summary.byCountry[].countryName', type: 'string|null', desc: '国家 / 地区中文名' },
  ...GROUP_FIELDS('summary.byCountry', noun),
  { name: 'summary.byCity', type: 'array', desc: `按国家 + 州 / 省 + 城市聚合，按平均${noun}升序（中国探针没有省份数据，按城市分组）` },
  { name: 'summary.byCity[].country', type: 'string|null', desc: '国家 / 地区代码' },
  { name: 'summary.byCity[].countryName', type: 'string|null', desc: '国家 / 地区中文名' },
  { name: 'summary.byCity[].state', type: 'string|null', desc: '州 / 省代码（仅美国探针有）' },
  { name: 'summary.byCity[].city', type: 'string|null', desc: '城市' },
  ...GROUP_FIELDS('summary.byCity', noun),
];

const REGION_PARAM = { name: 'region', required: false, default: 'china', desc: `探针地区：${REGION_DESC}`, example: 'china' };
const limitParam = (def, max) => ({ name: 'limit', required: false, default: def, desc: `探针数量，1~${max}；每个探针都计入 Globalping 额度`, example: def });

export const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'CAA', 'SRV', 'HTTPS'];

const readRegion = (query) => param(query, 'region', { default: 'china', max: 20 });

export default {
  name: 'probe',
  category: 'net',
  title: '多节点检测',
  description: '通过 Globalping 全球探针网络，从中国各地或世界各地的节点对目标做 Ping / TCPing、HTTP 测速、DNS 解析和路由追踪，按国家、城市汇总',
  source: 'Globalping',
  env: [{ name: 'GLOBALPING_TOKEN', optional: true }],
  unofficial: false,
  routes: [
    {
      method: 'GET',
      path: '/api/probe/ping',
      summary: '多节点 Ping / TCPing：各地延迟与丢包',
      params: [
        { name: 'target', required: true, desc: '公网域名或 IP（不允许内网 / 保留地址和 localhost）', example: 'www.baidu.com' },
        REGION_PARAM,
        limitParam(5, 20),
        { name: 'protocol', required: false, default: 'icmp', desc: 'icmp（普通 Ping）或 tcp（TCPing，测 TCP 握手耗时）', example: 'icmp' },
        { name: 'port', required: false, default: 443, desc: 'TCP 端口（仅 protocol=tcp 时有效），1~65535', example: 443 },
        { name: 'packets', required: false, default: 3, desc: '每个探针发送的包数，1~10', example: 3 },
      ],
      fields: [
        ...COMMON_FIELDS('延迟', '平均往返时间（毫秒）；未收到任何回复时为 null'),
        { name: 'protocol', type: 'string', desc: '协议：ICMP 或 TCP' },
        { name: 'port', type: 'number|null', desc: 'TCP 端口；ICMP 时为 null' },
        { name: 'packets', type: 'number', desc: '每个探针发送的包数' },
        { name: 'results[].resolvedAddress', type: 'string|null', desc: '探针解析出的目标 IP（各地可能不同，可看出 CDN 调度）' },
        { name: 'results[].sent', type: 'number|null', desc: '发送的包数' },
        { name: 'results[].received', type: 'number|null', desc: '收到回复的包数' },
        { name: 'results[].lossRate', type: 'number|null', desc: '丢包率（百分比，0~100）' },
        { name: 'results[].min', type: 'number|null', desc: '最小往返时间（毫秒）；全部丢包时为 null' },
        { name: 'results[].avg', type: 'number|null', desc: '平均往返时间（毫秒）；全部丢包时为 null' },
        { name: 'results[].max', type: 'number|null', desc: '最大往返时间（毫秒）；全部丢包时为 null' },
        { name: 'results[].times', type: 'array', desc: '每个收到回复的包的往返时间（毫秒，数字数组）' },
      ],
      async handler({ query }) {
        const target = checkProbeTarget(param(query, 'target', { required: true, max: 300 }));
        const region = readRegion(query);
        const limit = param(query, 'limit', { default: 5, int: true, min: 1, max: 20 });
        const protocol = param(query, 'protocol', { default: 'icmp', oneOf: ['icmp', 'tcp'] }).toUpperCase();
        const port = param(query, 'port', { default: 443, int: true, min: 1, max: 65535 });
        const packets = param(query, 'packets', { default: 3, int: true, min: 1, max: 10 });
        const measurementOptions = { packets, protocol, ...(protocol === 'TCP' ? { port } : {}) };
        return probe('ping', { target, region, limit, measurementOptions, echo: { protocol, port: protocol === 'TCP' ? port : null, packets } });
      },
    },
    {
      method: 'GET',
      path: '/api/probe/http',
      summary: '多节点 HTTP 测速：DNS、TCP、TLS、首字节、下载、总耗时与状态码',
      params: [
        { name: 'url', required: true, desc: '公网网址；不带协议时按 https 处理', example: 'https://www.baidu.com/' },
        REGION_PARAM,
        limitParam(5, 20),
        { name: 'method', required: false, default: 'HEAD', desc: '请求方法：HEAD 或 GET', example: 'HEAD' },
        { name: 'http2', required: false, default: 0, desc: '1 = 用 HTTP/2 请求（仅 https 网址）', example: 0 },
      ],
      fields: [
        ...COMMON_FIELDS('总耗时', '总耗时（毫秒）；请求失败时为 null'),
        { name: 'url', type: 'string', desc: '规范化后的检测网址' },
        { name: 'method', type: 'string', desc: '请求方法：HEAD 或 GET' },
        { name: 'protocol', type: 'string', desc: '协议：HTTP、HTTPS 或 HTTP2' },
        { name: 'port', type: 'number', desc: '端口' },
        { name: 'results[].resolvedAddress', type: 'string|null', desc: '探针连接的目标 IP' },
        { name: 'results[].statusCode', type: 'number|null', desc: 'HTTP 状态码；请求失败时为 null' },
        { name: 'results[].timings', type: 'object', desc: '各阶段耗时（毫秒），探针未提供的阶段为 null' },
        { name: 'results[].timings.dns', type: 'number|null', desc: 'DNS 解析耗时' },
        { name: 'results[].timings.tcp', type: 'number|null', desc: 'TCP 建连耗时' },
        { name: 'results[].timings.tls', type: 'number|null', desc: 'TLS 握手耗时（http 网址为 null）' },
        { name: 'results[].timings.firstByte', type: 'number|null', desc: '首字节时间（发出请求到收到第一个字节）' },
        { name: 'results[].timings.download', type: 'number|null', desc: '下载响应耗时' },
        { name: 'results[].timings.total', type: 'number|null', desc: '总耗时' },
        { name: 'results[].tlsProtocol', type: 'string|null', desc: 'TLS 协议版本（如 TLSv1.3）；http 网址或探针未提供时为 null' },
      ],
      async handler({ query }) {
        const u = parseProbeUrl(param(query, 'url', { required: true, max: 2000 }));
        const region = readRegion(query);
        const limit = param(query, 'limit', { default: 5, int: true, min: 1, max: 20 });
        const method = param(query, 'method', { default: 'HEAD', oneOf: ['HEAD', 'GET', 'head', 'get'] }).toUpperCase();
        const http2 = param(query, 'http2', { default: '0', oneOf: ['0', '1'] }) === '1';
        if (http2 && u.protocol !== 'HTTPS') throw new HttpError(400, 'HTTP/2 只支持 https 网址');
        const protocol = http2 ? 'HTTP2' : u.protocol;
        const measurementOptions = {
          request: { method, host: u.host, path: u.path, ...(u.query ? { query: u.query } : {}) },
          protocol,
          port: u.port,
        };
        return probe('http', { target: u.host, region, limit, measurementOptions, echo: { url: u.url, method, protocol, port: u.port } });
      },
    },
    {
      method: 'GET',
      path: '/api/probe/dns',
      summary: '多节点 DNS 解析：各地解析结果对比（可看出 CDN 调度与污染）',
      params: [
        { name: 'domain', required: true, desc: '要解析的公网域名', example: 'www.baidu.com' },
        { name: 'type', required: false, default: 'A', desc: `记录类型：${DNS_TYPES.join(' / ')}`, example: 'A' },
        REGION_PARAM,
        limitParam(5, 20),
        { name: 'resolver', required: false, desc: '指定公网 DNS 服务器 IP（如 223.5.5.5）；不填用探针默认的 DNS', example: '223.5.5.5' },
      ],
      fields: [
        ...COMMON_FIELDS('查询耗时', 'DNS 查询耗时（毫秒）；失败时为 null'),
        { name: 'queryType', type: 'string', desc: '查询的记录类型' },
        { name: 'resolver', type: 'string|null', desc: '指定的 DNS 服务器；未指定为 null' },
        { name: 'results[].resolver', type: 'string|null', desc: '探针实际使用的 DNS 服务器' },
        { name: 'results[].statusCodeName', type: 'string|null', desc: 'DNS 响应码（NOERROR 正常、NXDOMAIN 域名不存在、SERVFAIL 服务器失败等）' },
        { name: 'results[].answers', type: 'array', desc: '应答记录' },
        { name: 'results[].answers[].name', type: 'string', desc: '记录名' },
        { name: 'results[].answers[].type', type: 'string', desc: '记录类型' },
        { name: 'results[].answers[].ttl', type: 'number|null', desc: 'TTL（秒）' },
        { name: 'results[].answers[].value', type: 'string', desc: '记录值（如 IP、CNAME 目标、MX 主机）' },
      ],
      async handler({ query }) {
        const target = checkProbeTarget(param(query, 'domain', { required: true, max: 300 }), 'domain');
        if (/^[\d.]+$|:/.test(target)) throw new HttpError(400, 'domain 须为域名');
        const type = param(query, 'type', { default: 'A', max: 10 }).toUpperCase();
        if (!DNS_TYPES.includes(type)) throw new HttpError(400, `type 只能是 ${DNS_TYPES.join(' / ')}`);
        const region = readRegion(query);
        const limit = param(query, 'limit', { default: 5, int: true, min: 1, max: 20 });
        const rawResolver = param(query, 'resolver', { max: 64 });
        let resolver = null;
        if (rawResolver) {
          const h = requireHost(rawResolver, isBlockedIP, 'resolver');
          if (!h.ip) throw new HttpError(400, 'resolver 须为公网 DNS 服务器 IP');
          resolver = h.ip;
        }
        const measurementOptions = { query: { type }, ...(resolver ? { resolver } : {}) };
        return probe('dns', { target, region, limit, measurementOptions, echo: { queryType: type, resolver } });
      },
    },
    {
      method: 'GET',
      path: '/api/probe/traceroute',
      summary: '多节点路由追踪：各地到目标经过的每一跳',
      params: [
        { name: 'target', required: true, desc: '公网域名或 IP（不允许内网 / 保留地址和 localhost）', example: 'www.baidu.com' },
        REGION_PARAM,
        limitParam(3, 5),
        { name: 'protocol', required: false, default: 'icmp', desc: 'icmp / tcp / udp', example: 'icmp' },
        { name: 'port', required: false, default: 80, desc: '端口（仅 tcp / udp 有效），1~65535', example: 80 },
      ],
      fields: [
        ...COMMON_FIELDS('末跳延迟', '到达目标那一跳的平均 RTT（毫秒）；未到达目标或失败时为 null'),
        { name: 'protocol', type: 'string', desc: '协议：ICMP、TCP 或 UDP' },
        { name: 'port', type: 'number|null', desc: '端口；ICMP 时为 null' },
        { name: 'results[].resolvedAddress', type: 'string|null', desc: '目标 IP（探针解析结果）' },
        { name: 'results[].resolvedHostname', type: 'string|null', desc: '目标 IP 的反向解析主机名' },
        { name: 'results[].reached', type: 'boolean', desc: '最后一跳是否就是目标 IP（是否到达目标）' },
        { name: 'results[].hopCount', type: 'number', desc: '跳数' },
        { name: 'results[].hops', type: 'array', desc: '每一跳，按顺序' },
        { name: 'results[].hops[].hop', type: 'number', desc: '跳序号（从 1 开始）' },
        { name: 'results[].hops[].ip', type: 'string|null', desc: '该跳路由器 IP；无响应（* * *）时为 null' },
        { name: 'results[].hops[].hostname', type: 'string|null', desc: '该跳 IP 的反向解析主机名' },
        { name: 'results[].hops[].asn', type: 'number|null', desc: '该跳所属 ASN；Globalping traceroute 结果通常不含，为 null' },
        { name: 'results[].hops[].rtts', type: 'array', desc: '该跳每次探测的 RTT（毫秒，数字数组），超时的不计入' },
        { name: 'results[].hops[].avg', type: 'number|null', desc: '该跳平均 RTT（毫秒）；全部超时为 null' },
      ],
      async handler({ query }) {
        const target = checkProbeTarget(param(query, 'target', { required: true, max: 300 }));
        const region = readRegion(query);
        const limit = param(query, 'limit', { default: 3, int: true, min: 1, max: 5 });
        const protocol = param(query, 'protocol', { default: 'icmp', oneOf: ['icmp', 'tcp', 'udp'] }).toUpperCase();
        const port = param(query, 'port', { default: 80, int: true, min: 1, max: 65535 });
        const measurementOptions = { protocol, ...(protocol !== 'ICMP' ? { port } : {}) };
        return probe('traceroute', { target, region, limit, measurementOptions, echo: { protocol, port: protocol !== 'ICMP' ? port : null } });
      },
    },
  ],
};

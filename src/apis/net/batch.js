// 批量检测：一次对最多 10 个目标做 TCPing / 网站检测 / Ping。
// 直接复用单目标实现（tcping()、checkSite()、ping()）及其并发上限 gate，SSRF 检查由单目标实现完成（netguard）。
// 每个目标独立成功 / 失败，整体不因单个失败而报错。按目标数计费（ctx.charge，见 app.js）。
import net from 'node:net';
import { HttpError, param } from '../../lib/http.js';
import { mapLimit, parseHost, reasonOf, round2 } from './common.js';
import { tcping, gate as tcpingGate } from './tcping.js';
import { ping, gate as pingGate } from './ping.js';
import { checkSite, gate as siteGate } from './site.js';

export const MAX_TARGETS = 10;
const MAX_RAW_ITEMS = 50; // POST 数组去重前的长度上限，防止超大数组

// ---------- 目标解析 ----------

// 把 GET 的逗号分隔字符串或 POST 的数组统一成去掉空白的字符串数组
export function splitTargets(raw) {
  if (Array.isArray(raw)) {
    if (raw.length > MAX_RAW_ITEMS) throw new HttpError(400, `目标过多，最多 ${MAX_TARGETS} 个`);
    return raw.map((x) => (x == null ? '' : String(x).trim())).filter(Boolean);
  }
  return String(raw ?? '').split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean);
}

// TCPing 目标：host、host:port、[IPv6]:port、IPv6（不带端口）、http(s):// 网址（取主机与端口）
export function parseTcpTarget(input, defaultPort) {
  let s = String(input).trim();
  let port = defaultPort;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      s = u.hostname;
      if (u.port) port = Number(u.port);
    } catch {
      return { error: '不是合法的主机或网址' };
    }
  } else if (!net.isIP(s)) {
    const m = /^\[([^\]]+)\]:(\d+)$/.exec(s) ?? /^([^:]+):(\d+)$/.exec(s);
    if (m) {
      s = m[1];
      port = Number(m[2]);
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: '端口须为 1~65535 之间的整数' };
  const h = parseHost(s);
  if (!h) return { error: '不是合法的域名或 IP 地址' };
  return { host: h.host, port, key: `${h.host}:${port}` };
}

// 网站目标：没有协议的补上 https://
export function parseUrlTarget(input) {
  const s = String(input).trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    u.hash = '';
    return { url: u.href, key: u.href };
  } catch {
    return { error: '不是合法的网址' };
  }
}

export function parsePingTarget(input) {
  const h = parseHost(input);
  if (!h) return { error: '不是合法的域名或 IP 地址' };
  return { host: h.host, key: h.host };
}

// 解析 + 去重 + 数量检查。返回 [{ target, parsed }]；不合法的目标保留，稍后作为失败项返回
export function prepareTargets(raw, parse) {
  const list = splitTargets(raw);
  if (!list.length) throw new HttpError(400, '缺少检测目标');
  const seen = new Set();
  const out = [];
  for (const target of list) {
    const parsed = parse(target);
    const key = parsed.key ?? `raw:${target.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ target, parsed });
  }
  if (out.length > MAX_TARGETS) throw new HttpError(400, `最多同时检测 ${MAX_TARGETS} 个目标（去重后为 ${out.length} 个）`);
  return out;
}

const errorText = (err) => (err instanceof HttpError ? err.message : reasonOf(err));

// 汇总：成功数、最快、最慢、平均（只统计成功项的 ms）
export function summarizeBatch(items) {
  const ok = items.filter((i) => i.ok && typeof i.ms === 'number');
  const pick = (cmp) => ok.reduce((a, b) => (a == null || cmp(b.ms, a.ms) ? b : a), null);
  const fastest = pick((x, y) => x < y);
  const slowest = pick((x, y) => x > y);
  return {
    total: items.length,
    success: items.filter((i) => i.ok).length,
    failed: items.filter((i) => !i.ok).length,
    fastest: fastest && { target: fastest.target, ms: fastest.ms },
    slowest: slowest && { target: slowest.target, ms: slowest.ms },
    avg: ok.length ? round2(ok.reduce((s, i) => s + i.ms, 0) / ok.length) : null,
  };
}

// ---------- 三种批量检测 ----------

// deps 仅供测试替换（tcping / checkSite / ping 的 options，如 blocked、execFileImpl、ca）
export async function batchTcping(prepared, { count = 2, concurrency = 5, deps = {} } = {}) {
  const items = await mapLimit(prepared, concurrency, async ({ target, parsed }) => {
    const base = { target, host: parsed.host ?? null, ip: null, port: parsed.port ?? null };
    const empty = { sent: 0, received: 0, lossRate: 100, min: null, max: null, ms: null };
    if (parsed.error) return { ...base, ok: false, ...empty, error: parsed.error };
    try {
      const r = await tcpingGate(() => tcping(parsed.host, { port: parsed.port, count, ...deps }));
      return {
        ...base, ip: r.ip, ok: r.received > 0, sent: r.sent, received: r.received, lossRate: r.lossRate,
        min: r.min, max: r.max, ms: r.avg, error: r.received > 0 ? null : r.results.find((x) => x.error)?.error ?? '连接失败',
      };
    } catch (err) {
      return { ...base, ok: false, ...empty, error: errorText(err) };
    }
  });
  return { count, items, summary: summarizeBatch(items) };
}

export async function batchHttp(prepared, { concurrency = 5, deps = {} } = {}) {
  const items = await mapLimit(prepared, concurrency, async ({ target, parsed }) => {
    const empty = {
      url: parsed.url ?? null, finalUrl: null, reachable: false, status: null, statusText: null, redirects: null,
      ip: null, ms: null, ttfb: null, https: null, certValid: null, server: null,
    };
    if (parsed.error) return { target, ok: false, ...empty, error: parsed.error };
    try {
      const r = await siteGate(() => checkSite(parsed.url, deps));
      return {
        target, ok: r.ok, url: r.url, finalUrl: r.finalUrl, reachable: true, status: r.status, statusText: r.statusText,
        redirects: r.redirects, ip: r.ip, ms: r.timing.total, ttfb: r.timing.ttfb, https: r.https, certValid: r.certValid,
        server: r.server, error: r.ok ? null : `HTTP ${r.status} ${r.statusText}`,
      };
    } catch (err) {
      return { target, ok: false, ...empty, error: errorText(err) };
    }
  });
  return { items, summary: summarizeBatch(items) };
}

// ping 的并发上限只有 5，单批最多占 3 个，给单目标接口留余量
export async function batchPing(prepared, { count = 2, concurrency = 3, deps = {} } = {}) {
  const items = await mapLimit(prepared, concurrency, async ({ target, parsed }) => {
    const base = { target, host: parsed.host ?? null, ip: null };
    const empty = { sent: 0, received: 0, lossRate: 100, min: null, max: null, ms: null, ttl: null };
    if (parsed.error) return { ...base, ok: false, ...empty, error: parsed.error };
    try {
      const r = await pingGate(() => ping(parsed.host, { count, ...deps }));
      return {
        ...base, ip: r.ip, ok: r.received > 0, sent: r.sent, received: r.received, lossRate: r.lossRate,
        min: r.min, max: r.max, ms: r.avg, ttl: r.results.find((x) => x.ok)?.ttl ?? null,
        error: r.received > 0 ? null : '全部超时，未收到回复（目标可能禁 ping）',
      };
    } catch (err) {
      return { ...base, ok: false, ...empty, error: errorText(err) };
    }
  });
  return { count, items, summary: summarizeBatch(items) };
}

// ---------- 路由 ----------

// POST 时参数取自 JSON 请求体，否则取网址参数；列表参数在请求体中可以是数组或逗号分隔的字符串
function input(ctx, listName) {
  const b = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : null;
  const q = new URLSearchParams(ctx.query);
  if (b) for (const [k, v] of Object.entries(b)) if (k !== listName && v != null && typeof v !== 'object') q.set(k, String(v));
  let list;
  if (b && b[listName] != null) {
    list = b[listName];
    if (!Array.isArray(list) && typeof list !== 'string') throw new HttpError(400, `${listName} 须为字符串数组或逗号分隔的字符串`);
  } else if (Array.isArray(ctx.body)) {
    list = ctx.body;
  } else {
    list = param(q, listName, { required: true, max: listName === 'urls' ? 12_000 : 4000 });
  }
  return { q, list };
}

// 入口已计 1 次，这里按去重后的目标数补足
const charge = (ctx, n) => ctx.charge?.(n - 1);

const SUMMARY_FIELDS = [
  { name: 'summary', type: 'object', desc: '汇总' },
  { name: 'summary.total', type: 'number', desc: '目标数（去重后）' },
  { name: 'summary.success', type: 'number', desc: '成功的目标数（ok 为 true）' },
  { name: 'summary.failed', type: 'number', desc: '失败的目标数' },
  { name: 'summary.fastest', type: 'object|null', desc: '成功目标中耗时最短的一个；全部失败时为 null' },
  { name: 'summary.fastest.target', type: 'string', desc: '目标（原样）' },
  { name: 'summary.fastest.ms', type: 'number', desc: '耗时（毫秒），含义同 items[].ms' },
  { name: 'summary.slowest', type: 'object|null', desc: '成功目标中耗时最长的一个；全部失败时为 null' },
  { name: 'summary.slowest.target', type: 'string', desc: '目标（原样）' },
  { name: 'summary.slowest.ms', type: 'number', desc: '耗时（毫秒）' },
  { name: 'summary.avg', type: 'number|null', desc: '成功目标 ms 的平均值（毫秒，保留两位小数）；全部失败时为 null' },
];

const LOSS_FIELDS = (what) => [
  { name: 'items[].sent', type: 'number', desc: `发出的${what}次数；目标不合法或被拒绝时为 0` },
  { name: 'items[].received', type: 'number', desc: '成功次数' },
  { name: 'items[].lossRate', type: 'number', desc: '丢失率（百分比，0~100）；未发出时为 100' },
  { name: 'items[].min', type: 'number|null', desc: '最小耗时（毫秒）；全部失败时为 null' },
  { name: 'items[].max', type: 'number|null', desc: '最大耗时（毫秒）；全部失败时为 null' },
];

const TARGET_DESC = `最多 ${MAX_TARGETS} 个（去重后），每个目标计 1 次调用次数`;

const tcpingRoute = (method) => ({
  method,
  path: '/api/batch/tcping',
  summary: `批量 TCPing：一次检测最多 ${MAX_TARGETS} 个主机端口的连通性与延迟${method === 'POST' ? '（JSON 请求体）' : ''}`,
  params: [
    { name: 'targets', ...(method === 'POST' ? { in: 'body' } : {}), required: true, desc: `目标列表，${method === 'POST' ? '字符串数组（也可以是逗号分隔的字符串）' : '逗号分隔'}；每项为域名、IP、host:port 或 [IPv6]:port，不写端口时用 port 参数。${TARGET_DESC}。不允许内网和保留地址`, example: method === 'POST' ? 'github.com,1.1.1.1:53' : 'github.com,1.1.1.1:53,[2606:4700::1111]:443' },
    { name: 'port', ...(method === 'POST' ? { in: 'body' } : {}), required: false, default: 443, desc: '目标未写端口时使用的端口，1~65535', example: 443 },
    { name: 'count', ...(method === 'POST' ? { in: 'body' } : {}), required: false, default: 2, desc: '每个目标的测试次数，1~4', example: 2 },
  ],
  fields: [
    { name: 'count', type: 'number', desc: '每个目标的测试次数' },
    { name: 'items', type: 'array', desc: '每个目标的结果，顺序与输入一致（已去重）；单个目标失败不影响其他目标' },
    { name: 'items[].target', type: 'string', desc: '输入的目标（原样）' },
    { name: 'items[].host', type: 'string|null', desc: '解析出的主机（ASCII 域名或 IP）；目标格式不合法时为 null' },
    { name: 'items[].ip', type: 'string|null', desc: '实际连接的 IP；失败于解析或检查阶段时为 null' },
    { name: 'items[].port', type: 'number|null', desc: '测试的端口；目标格式不合法时可能为 null' },
    { name: 'items[].ok', type: 'boolean', desc: '是否至少有一次成功建立 TCP 连接' },
    ...LOSS_FIELDS('连接'),
    { name: 'items[].ms', type: 'number|null', desc: '成功连接的平均耗时（毫秒）；全部失败时为 null' },
    { name: 'items[].error', type: 'string|null', desc: '失败原因（格式不合法、不允许访问内网或保留地址、连接被拒绝、连接超时、同类检测请求过多等）；成功时为 null' },
    ...SUMMARY_FIELDS,
  ],
  async handler(ctx) {
    const { q, list } = input(ctx, 'targets');
    const port = param(q, 'port', { default: 443, int: true, min: 1, max: 65535 });
    const count = param(q, 'count', { default: 2, int: true, min: 1, max: 4 });
    const prepared = prepareTargets(list, (t) => parseTcpTarget(t, port));
    charge(ctx, prepared.length);
    return { data: await batchTcping(prepared, { count }) };
  },
});

const httpRoute = (method) => ({
  method,
  path: '/api/batch/http',
  summary: `批量网站检测：一次检测最多 ${MAX_TARGETS} 个网址的状态码与响应时间${method === 'POST' ? '（JSON 请求体）' : ''}`,
  params: [
    { name: 'urls', ...(method === 'POST' ? { in: 'body' } : {}), required: true, desc: `网址列表，${method === 'POST' ? '字符串数组（也可以是逗号分隔的字符串）' : '逗号或空白分隔（网址本身含逗号时请写成 %2C 或改用 POST）'}；没写协议的按 https:// 处理。${TARGET_DESC}。只允许公网地址，每一跳跳转都会检查`, example: 'https://github.com,https://example.com' },
  ],
  fields: [
    { name: 'items', type: 'array', desc: '每个网址的结果，顺序与输入一致（已去重）；单个失败不影响其他网址' },
    { name: 'items[].target', type: 'string', desc: '输入的网址（原样）' },
    { name: 'items[].ok', type: 'boolean', desc: '是否可正常访问（最终状态码为 2xx / 3xx）' },
    { name: 'items[].url', type: 'string|null', desc: '实际检测的起始网址（补全协议、规范化后）；格式不合法时为 null' },
    { name: 'items[].finalUrl', type: 'string|null', desc: '跟随跳转（最多 5 次）后的最终网址；请求失败时为 null' },
    { name: 'items[].reachable', type: 'boolean', desc: '是否收到了 HTTP 响应（4xx / 5xx 也算收到）' },
    { name: 'items[].status', type: 'number|null', desc: '最终 HTTP 状态码；请求失败时为 null' },
    { name: 'items[].statusText', type: 'string|null', desc: '状态码的中文说明；请求失败时为 null' },
    { name: 'items[].redirects', type: 'number|null', desc: '跳转次数；请求失败时为 null' },
    { name: 'items[].ip', type: 'string|null', desc: '最终连接的服务器 IP；取不到时为 null' },
    { name: 'items[].ms', type: 'number|null', desc: '总耗时（毫秒）：含全部跳转与下载（最多 1MB）；请求失败时为 null' },
    { name: 'items[].ttfb', type: 'number|null', desc: '最终那一跳的首字节时间（毫秒）；请求失败时为 null' },
    { name: 'items[].https', type: 'boolean|null', desc: '最终网址是否为 HTTPS；请求失败时为 null' },
    { name: 'items[].certValid', type: 'boolean|null', desc: '证书是否可信；http 网址或请求失败时为 null' },
    { name: 'items[].server', type: 'string|null', desc: '响应头 Server 的原值；没有或请求失败时为 null' },
    { name: 'items[].error', type: 'string|null', desc: '失败原因（格式不合法、内网地址、无法解析、超时、HTTP 4xx/5xx 等）；成功时为 null' },
    ...SUMMARY_FIELDS,
  ],
  async handler(ctx) {
    const { list } = input(ctx, 'urls');
    const prepared = prepareTargets(list, parseUrlTarget);
    charge(ctx, prepared.length);
    return { data: await batchHttp(prepared) };
  },
});

const pingRoute = (method) => ({
  method,
  path: '/api/batch/ping',
  summary: `批量 ICMP Ping：一次检测最多 ${MAX_TARGETS} 个主机的延迟与丢包${method === 'POST' ? '（JSON 请求体）' : ''}`,
  params: [
    { name: 'targets', ...(method === 'POST' ? { in: 'body' } : {}), required: true, desc: `目标列表，${method === 'POST' ? '字符串数组（也可以是逗号分隔的字符串）' : '逗号分隔'}；每项为域名或 IP。${TARGET_DESC}。只 ping 公网地址`, example: '1.1.1.1,8.8.8.8,github.com' },
    { name: 'count', ...(method === 'POST' ? { in: 'body' } : {}), required: false, default: 2, desc: '每个目标的发送次数，1~4', example: 2 },
  ],
  fields: [
    { name: 'count', type: 'number', desc: '每个目标的发送次数' },
    { name: 'items', type: 'array', desc: '每个目标的结果，顺序与输入一致（已去重）；单个失败不影响其他目标' },
    { name: 'items[].target', type: 'string', desc: '输入的目标（原样）' },
    { name: 'items[].host', type: 'string|null', desc: '解析出的主机（ASCII 域名或 IP）；格式不合法时为 null' },
    { name: 'items[].ip', type: 'string|null', desc: '实际 ping 的 IP；失败于解析或检查阶段时为 null' },
    { name: 'items[].ok', type: 'boolean', desc: '是否至少收到一次回复' },
    ...LOSS_FIELDS('ICMP 包'),
    { name: 'items[].ms', type: 'number|null', desc: '平均往返时间（毫秒）；全部丢包时为 null' },
    { name: 'items[].ttl', type: 'number|null', desc: '第一个回复包的 TTL；未收到回复时为 null' },
    { name: 'items[].error', type: 'string|null', desc: '失败原因（格式不合法、内网地址、全部超时、服务器不支持 ICMP Ping 等）；成功时为 null' },
    ...SUMMARY_FIELDS,
  ],
  async handler(ctx) {
    const { q, list } = input(ctx, 'targets');
    const count = param(q, 'count', { default: 2, int: true, min: 1, max: 4 });
    const prepared = prepareTargets(list, parsePingTarget);
    charge(ctx, prepared.length);
    return { data: await batchPing(prepared, { count }) };
  },
});

export default {
  name: 'batch-check',
  category: 'net',
  title: '批量检测',
  description: `一次对最多 ${MAX_TARGETS} 个目标做 TCPing、网站可用性检测或 Ping，返回每个目标的结果与汇总（按目标数计调用次数）`,
  source: '本服务器发起的连接',
  routes: [
    tcpingRoute('GET'), tcpingRoute('POST'),
    httpRoute('GET'), httpRoute('POST'),
    pingRoute('GET'), pingRoute('POST'),
  ],
};

import { setTimeout as delay } from 'node:timers/promises';

export class HttpError extends Error {
  // code：可选的错误代码（如 QUOTA_EXCEEDED），不传时按状态码给一个通用的
  constructor(status, message, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

// 错误代码：放在错误响应的 errorCode 字段里，程序可以按它判断，不用解析中文提示
export const ERROR_CODES = {
  400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE', 429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR', 502: 'UPSTREAM_ERROR', 503: 'SERVICE_UNAVAILABLE', 504: 'UPSTREAM_TIMEOUT',
};
export const errorCode = (status, err) => (typeof err?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(err.code) ? err.code : null)
  ?? ERROR_CODES[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');

import { outboundFetch, proxyConfig, shouldProxy, DEFAULT_PROXY_HOSTS } from './proxy.js';
import { complianceOn } from './compliance.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

// 把网络错误翻译成能看出原因的中文，便于判断是上游挂了、被墙了还是本机网络问题
const NET_REASONS = [
  [/ENOTFOUND|EAI_AGAIN|EAI_NONAME/, '域名解析失败'],
  [/ECONNREFUSED/, '连接被拒绝'],
  [/ECONNRESET|UND_ERR_SOCKET|EPIPE/, '连接被重置，可能被网络拦截'],
  [/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ENETUNREACH|EHOSTUNREACH/, '连接超时，网络不通'],
  [/CERT|SSL|TLS|ERR_TLS|DEPTH_ZERO|SELF_SIGNED/, '证书校验失败'],
];
export function networkReason(err) {
  const code = `${err?.cause?.code ?? ''} ${err?.code ?? ''} ${err?.cause?.message ?? ''}`;
  return NET_REASONS.find(([re]) => re.test(code))?.[1] ?? (err?.proxy ? err.message : '');
}

// 需要代理才能访问的数据源没走代理时，提示站长可以配置出站代理（备案合规模式下不提示）
export function overseasHint(url) {
  if (proxyConfig() && shouldProxy(url)) return '（已通过代理访问，请检查代理是否可用）';
  const known = shouldProxy(url, { hosts: DEFAULT_PROXY_HOSTS.split(',') });
  return known && !complianceOn() ? '。该数据源在服务器所在网络下可能无法直接访问，站长可在「系统设置 → 网络」配置出站代理' : '';
}

export function upstreamError(err, url, what = '上游服务') {
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  if (err?.name === 'TimeoutError') return new HttpError(504, `${what}响应超时（${host}）${overseasHint(url)}`);
  const reason = networkReason(err);
  return new HttpError(502, `无法连接${what}（${host}${reason ? `：${reason}` : ''}）${overseasHint(url)}`);
}

const RETRY_STATUS = new Set([502, 503, 504]);
const TRANSIENT_NETWORK = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);
const transientNetworkError = (error) => !error?.proxy && (TRANSIENT_NETWORK.has(error?.cause?.code ?? error?.code)
  || (error instanceof TypeError && /fetch failed|failed to fetch|network/i.test(error.message)));

// 不能等待不可信响应体的cancel钩子完成；发起取消并接住失败，保证重试/最终错误仍受总预算约束。
function discardResponse(res) {
  try { Promise.resolve(res.body?.cancel()).catch(() => {}); } catch {}
}

// retry必须由已确认只读、可重复且可承担额外请求的调用方显式启用。
// GET/HEAD本身不能证明无副作用；带body的请求和POST等永不重放。
async function request(url, { timeoutMs = 10_000, headers = {}, method = 'GET', body, signal, retry = false } = {}) {
  signal?.throwIfAborted();
  method = String(method).toUpperCase();
  const attempts = retry === true && (method === 'GET' || method === 'HEAD') && body == null ? 2 : 1;
  // 一个信号贯穿首次请求、退避、第二次请求和调用方读取正文，不为每次尝试重开预算。
  const budgetSignal = AbortSignal.timeout(timeoutMs);
  const deadline = performance.now() + timeoutMs;
  const requestSignal = signal ? AbortSignal.any([signal, budgetSignal]) : budgetSignal;
  const checkStopped = () => {
    signal?.throwIfAborted();
    if (requestSignal.aborted || performance.now() >= deadline) throw upstreamError(requestSignal.reason ?? new DOMException('请求总预算已用完', 'TimeoutError'), url);
  };
  const pause = async () => {
    try { await delay(200, undefined, { signal: requestSignal }); }
    catch (err) { checkStopped(); throw err; }
    checkStopped();
  };

  for (let attempt = 1; attempt <= attempts; attempt++) {
    checkStopped();
    let res;
    try {
      res = await outboundFetch(url, {
        method, body, headers: { 'user-agent': UA, ...headers }, signal: requestSignal,
      });
    } catch (err) {
      checkStopped();
      if (attempt < attempts && transientNetworkError(err)) { await pause(); continue; }
      throw upstreamError(err, url);
    }
    try { checkStopped(); } catch (err) { discardResponse(res); throw err; }
    if (!res.ok) {
      discardResponse(res);
      // 429/4xx、认证/证书错误及要求Retry-After的响应均不自动重试。
      if (attempt < attempts && RETRY_STATUS.has(res.status) && !res.headers?.has('retry-after')) {
        await pause();
        continue;
      }
      throw new HttpError(502, `上游返回 HTTP ${res.status}`);
    }
    return { res, signal: requestSignal };
  }
}

export async function fetchJSON(url, opts = {}) {
  const { res, signal } = await request(url, { ...opts, headers: { accept: 'application/json', ...opts.headers } });
  try {
    return await res.json();
  } catch {
    opts.signal?.throwIfAborted();
    if (signal.aborted) throw upstreamError(signal.reason, url);
    throw new HttpError(502, '上游返回的不是合法 JSON');
  }
}

// encoding 用于 GBK 等非 UTF-8 页面，例如 fetchText(url, { encoding: 'gbk' })
export async function fetchText(url, { encoding = 'utf-8', ...opts } = {}) {
  const { res, signal } = await request(url, opts);
  let body;
  try { body = await res.arrayBuffer(); }
  catch (err) { opts.signal?.throwIfAborted(); throw upstreamError(signal.aborted ? signal.reason : err, url); }
  return new TextDecoder(encoding).decode(body);
}

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new HttpError(503, `服务端未配置 ${name}，该接口暂不可用`);
  return v;
}

// 读取并校验查询参数：param(query, 'city', { default: '北京', pattern: /^.{1,20}$/ })
export function param(query, name, { default: def, required = false, pattern, oneOf, int, min, max } = {}) {
  const raw = query.get(name);
  if (raw == null || raw === '') {
    if (required) throw new HttpError(400, `缺少参数 ${name}`);
    return def;
  }
  if (oneOf && !oneOf.includes(raw)) throw new HttpError(400, `${name} 只能是 ${oneOf.join(' / ')}`);
  if (pattern && !pattern.test(raw)) throw new HttpError(400, `${name} 参数不合法`);
  if (int) {
    const n = Number(raw);
    if (!Number.isInteger(n) || (min != null && n < min) || (max != null && n > max)) {
      throw new HttpError(400, `${name} 须为 ${min ?? ''}~${max ?? ''} 之间的整数`);
    }
    return n;
  }
  if (max != null && raw.length > max) throw new HttpError(400, `${name} 过长（最多 ${max} 个字符）`);
  return raw;
}

// 超出 Unicode 范围的数字实体（如 &#99999999999;）保留原文，不抛异常
const codePoint = (n, raw) => (Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : raw);

export function decodeEntities(s = '') {
  return s
    .replace(/&#(\d+);/g, (m, n) => codePoint(Number(n), m))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => codePoint(parseInt(n, 16), m))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

export const stripTags = (s = '') => decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

import { outboundFetch, proxyConfig, shouldProxy, DEFAULT_PROXY_HOSTS } from './proxy.js';

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

// 境外数据源没走代理时，提示可以配置代理
function overseasHint(url) {
  if (proxyConfig() && shouldProxy(url)) return '（已通过代理访问，请检查代理是否可用）';
  const known = shouldProxy(url, { hosts: DEFAULT_PROXY_HOSTS.split(',') });
  return known ? '。该数据源在境外，服务器在大陆时通常无法直连，可在「系统设置 → 网络」配置代理' : '';
}

export function upstreamError(err, url, what = '上游服务') {
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  if (err?.name === 'TimeoutError') return new HttpError(504, `${what}响应超时（${host}）${overseasHint(url)}`);
  const reason = networkReason(err);
  return new HttpError(502, `无法连接${what}（${host}${reason ? `：${reason}` : ''}）${overseasHint(url)}`);
}

async function request(url, { timeoutMs = 10_000, headers = {}, method = 'GET', body } = {}) {
  let res;
  try {
    res = await outboundFetch(url, {
      method,
      body,
      headers: { 'user-agent': UA, ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw upstreamError(err, url);
  }
  if (!res.ok) throw new HttpError(502, `上游返回 HTTP ${res.status}`);
  return res;
}

export async function fetchJSON(url, opts = {}) {
  const res = await request(url, { ...opts, headers: { accept: 'application/json', ...opts.headers } });
  try {
    return await res.json();
  } catch {
    throw new HttpError(502, '上游返回的不是合法 JSON');
  }
}

// encoding 用于 GBK 等非 UTF-8 页面，例如 fetchText(url, { encoding: 'gbk' })
export async function fetchText(url, { encoding = 'utf-8', ...opts } = {}) {
  const res = await request(url, opts);
  return new TextDecoder(encoding).decode(await res.arrayBuffer());
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

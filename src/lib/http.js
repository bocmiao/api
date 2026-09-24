export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

async function request(url, { timeoutMs = 10_000, headers = {}, method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      body,
      headers: { 'user-agent': UA, ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new HttpError(504, '上游服务响应超时');
    throw new HttpError(502, '无法连接上游服务');
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

export function decodeEntities(s = '') {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

export const stripTags = (s = '') => decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

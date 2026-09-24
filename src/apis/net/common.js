// 网络分类的公共工具：目标地址校验、安全连接、限量读取、并发上限、中文错误说明。
// 所有出站连接都经过 src/lib/netguard.js：IP 字面量先用 blocked 检查，域名在 DNS lookup 钩子里检查解析结果，
// 连接时才校验，避免"先解析检查、再连接"之间的 DNS 重绑定。
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { domainToASCII } from 'node:url';
import { HttpError } from '../../lib/http.js';
import { isBlockedIP, makeLookup, checkUrl } from '../../lib/netguard.js';

export { isBlockedIP, makeLookup, checkUrl };

export const BLOCKED_MSG = '不允许访问内网或保留地址';
export const UA = 'Mozilla/5.0 (compatible; MiaoAPI-NetCheck/1.0)';
export const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

export const round2 = (n) => Math.round(n * 100) / 100;
export const since = (t0) => round2(performance.now() - t0);

// ---------- 并发上限 ----------

// 超过上限直接返回 503，不排队，避免请求堆积占满连接和内存
export function createGate(max) {
  let active = 0;
  const run = async (fn) => {
    if (active >= max) throw new HttpError(503, '同类检测请求过多，请稍后再试');
    active++;
    try {
      return await fn();
    } finally {
      active--;
    }
  };
  run.active = () => active;
  run.max = max;
  return run;
}

// 以固定并发处理列表，结果顺序与输入一致
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------- 主机名 / IP ----------

const LABEL_RE = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;
const isLocalName = (h) => h === 'localhost' || h.endsWith('.localhost');

// 解析 host 参数：支持域名（含中文域名）、IPv4、IPv6（可带方括号），也容忍直接粘贴的网址。
// 返回 { host, ip, family }：host 为 ASCII 域名或 IP；ip 仅在输入是 IP 字面量时有值。不合法返回 null。
export function parseHost(input) {
  let s = String(input ?? '').trim();
  if (!s || s.length > 300) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      return null;
    }
  }
  s = s.replace(/^\[(.*)\]$/, '$1');
  const family = net.isIP(s);
  if (family) return { host: s.toLowerCase(), ip: s.toLowerCase(), family };
  s = s.toLowerCase().replace(/\.$/, '');
  if (isLocalName(s)) return { host: s, ip: null, family: 0, local: true };
  const ascii = domainToASCII(s);
  if (!ascii || ascii.length > 253) return null;
  // 127.1、0x7f.1 这类简写会被规范化成 IPv4，按 IP 处理
  if (net.isIP(ascii)) return { host: ascii, ip: ascii, family: net.isIP(ascii) };
  const labels = ascii.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) return null;
  if (!/^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels.at(-1))) return null;
  return { host: ascii, ip: null, family: 0 };
}

// 读取并校验 host 参数；IP 字面量与 localhost 在这里就拒绝
export function requireHost(raw, blocked = isBlockedIP, name = 'host') {
  const h = parseHost(raw);
  if (!h) throw new HttpError(400, `${name} 不是合法的域名或 IP 地址`);
  if (h.local || (h.ip && blocked(h.ip))) throw new HttpError(400, BLOCKED_MSG);
  return h;
}

// 把域名解析成一个公网 IP（解析结果中只要有一个内网地址就整体拒绝），用于先解析、再按 IP 连接的场景（TCPing、Ping）。
// 之后直接连接返回的 IP，不再二次解析，因此不存在 DNS 重绑定窗口。
export async function resolvePublic(h, { blocked = isBlockedIP, timeoutMs = 5000 } = {}) {
  if (h.local) throw new HttpError(400, BLOCKED_MSG);
  if (h.ip) {
    if (blocked(h.ip)) throw new HttpError(400, BLOCKED_MSG);
    return { address: h.ip, family: h.family, dnsMs: null };
  }
  const t0 = performance.now();
  const lookup = makeLookup(blocked);
  let timer;
  try {
    const addrs = await Promise.race([
      new Promise((resolve, reject) => lookup(h.host, { all: true }, (err, a) => (err ? reject(err) : resolve(a)))),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ELOOKUPTIMEOUT' })), timeoutMs); }),
    ]);
    return { address: addrs[0].address, family: addrs[0].family, dnsMs: since(t0) };
  } catch (err) {
    if (err.code === 'EBLOCKED') throw new HttpError(400, BLOCKED_MSG);
    if (err.code === 'ELOOKUPTIMEOUT') throw new HttpError(504, '域名解析超时');
    throw new HttpError(400, '无法解析该域名');
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 错误说明 ----------

const REASONS = {
  ECONNREFUSED: '连接被拒绝（端口未开放或服务未启动）',
  ECONNRESET: '连接被对方重置',
  ETIMEDOUT: '连接超时',
  EHOSTUNREACH: '主机不可达',
  ENETUNREACH: '网络不可达',
  EHOSTDOWN: '主机已关闭',
  EADDRNOTAVAIL: '无法使用该地址连接',
  EPIPE: '连接已被对方关闭',
  ENOTFOUND: '域名无法解析',
  EAI_AGAIN: '域名解析暂时失败',
  ENODATA: '域名没有可用的地址',
  EBLOCKED: BLOCKED_MSG,
  EPROTO: 'TLS 握手失败',
  ERR_SSL_WRONG_VERSION_NUMBER: 'TLS 握手失败（对方可能不是 HTTPS 服务）',
  ERR_SSL_UNSUPPORTED_PROTOCOL: 'TLS 握手失败（对方只支持过时的协议版本）',
  ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION: 'TLS 握手失败（协议版本不兼容）',
  ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE: 'TLS 握手失败（没有共同支持的加密套件）',
  ERR_SSL_TLSV1_UNRECOGNIZED_NAME: 'TLS 握手失败（服务器不认识该域名）',
  CERT_HAS_EXPIRED: '证书已过期',
  DEPTH_ZERO_SELF_SIGNED_CERT: '自签名证书',
  SELF_SIGNED_CERT_IN_CHAIN: '证书链中有不受信任的自签名根证书',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '无法验证证书（可能缺少中间证书）',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: '无法找到颁发者证书（可能缺少中间证书或根证书不受信任）',
  ERR_TLS_CERT_ALTNAME_INVALID: '证书与域名不匹配',
  HPE_INVALID_CONSTANT: '响应不是合法的 HTTP',
  HPE_HEADER_OVERFLOW: '响应头过大',
  ERR_TOO_MANY_REDIRECTS: '重定向次数过多',
  ERR_BAD_REDIRECT: '返回了无效的重定向地址',
  ERR_TIMEOUT: '请求超时',
};

export function reasonOf(err) {
  if (!err) return '未知错误';
  if (err.name === 'TimeoutError' || err.name === 'AbortError' || err.code === 'ABORT_ERR') return REASONS.ERR_TIMEOUT;
  if (err.code && REASONS[err.code]) return REASONS[err.code];
  if (err.code?.startsWith?.('ERR_SSL_')) return 'TLS 握手失败';
  if (err.code?.startsWith?.('HPE_')) return '响应不是合法的 HTTP';
  if (err instanceof HttpError) return err.message;
  return `连接失败（${err.code ?? err.message ?? '未知错误'}）`;
}

export const isTimeout = (err, signal) => Boolean(signal?.aborted) || err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || err?.code === 'ERR_TIMEOUT';

// 网址是否因指向内网 / 保留地址而被拒绝（与 checkUrl 的静态判断一致）
function urlIsInternal(raw, blocked) {
  try {
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host)) return blocked(host);
    return isLocalName(host) || !host.includes('.');
  } catch {
    return false;
  }
}

// 请求失败的统一描述：{ code, reason, blocked, timeout }
export class NetError extends Error {
  constructor(code, message, { blocked = false } = {}) {
    super(message);
    this.code = code;
    this.blocked = blocked;
  }
}

// checkUrl 的包装：失败时抛 NetError，并标明是否因为内网地址被拒绝
export function checkTarget(raw, blocked = isBlockedIP) {
  try {
    return checkUrl(raw, blocked);
  } catch (err) {
    const internal = urlIsInternal(raw, blocked);
    throw new NetError(internal ? 'EBLOCKED' : 'EBADURL', internal ? BLOCKED_MSG : err.message, { blocked: internal });
  }
}

// NetError / 连接错误 → HttpError（整个接口失败时用）
export function toHttpError(err, signal) {
  if (err instanceof HttpError) return err;
  if (err?.code === 'EBLOCKED' || err?.blocked) return new HttpError(400, BLOCKED_MSG);
  if (err?.code === 'EBADURL') return new HttpError(400, err.message);
  if (isTimeout(err, signal)) return new HttpError(504, '目标网站响应超时');
  if (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN' || err?.code === 'ENODATA') return new HttpError(400, '无法解析该域名');
  return new HttpError(502, `无法访问目标网站：${reasonOf(err)}`);
}

// ---------- HTTP 请求 ----------

// 发一次请求（不跟随跳转）。返回 { res, timing, socket }；timing 各项单位为毫秒：
// dns 域名解析耗时（IP 字面量为 null）、connect TCP 建连耗时（不含 DNS）、tls TLS 握手耗时（http 为 null）、ttfb 从发起到收到响应头。
export function httpRequest(u, { method = 'GET', headers = {}, blocked = isBlockedIP, signal, rejectUnauthorized = true, ca } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const marks = { dnsStart: null, dnsEnd: null, connect: null, secure: null };
    const guarded = makeLookup(blocked);
    const lookup = (host, opts, cb) => {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      marks.dnsStart ??= performance.now();
      guarded(host, opts, (...args) => {
        marks.dnsEnd = performance.now();
        cb(...args);
      });
    };
    const isHttps = u.protocol === 'https:';
    const req = (isHttps ? https : http).request(u, {
      method,
      lookup,
      signal,
      agent: false,
      ...(isHttps ? { rejectUnauthorized, ...(ca ? { ca } : {}) } : {}),
      headers: { 'user-agent': UA, ...headers },
    });
    req.on('socket', (sock) => {
      sock.once('connect', () => { marks.connect = performance.now(); });
      sock.once('secureConnect', () => { marks.secure = performance.now(); });
    });
    req.on('response', (res) => {
      const now = performance.now();
      const connectStart = marks.dnsEnd ?? t0;
      const timing = {
        dns: marks.dnsEnd != null ? round2(marks.dnsEnd - marks.dnsStart) : null,
        connect: marks.connect != null ? round2(marks.connect - connectStart) : null,
        tls: marks.secure != null && marks.connect != null ? round2(marks.secure - marks.connect) : null,
        ttfb: round2(now - t0),
      };
      const sock = req.socket;
      resolve({
        res,
        timing,
        socket: {
          remoteAddress: sock?.remoteAddress ?? null,
          tlsProtocol: isHttps ? sock?.getProtocol?.() ?? null : null,
          authorized: isHttps ? Boolean(sock?.authorized) : null,
          authorizationError: isHttps && sock?.authorizationError ? String(sock.authorizationError) : null,
        },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// 手动跟随跳转（最多 maxRedirects 次），每一跳都先 checkUrl 静态检查，再由 lookup 钩子检查解析出的 IP。
// 返回 { url, res, timing, socket, hops, signal }，最后一跳的响应体尚未读取，调用方负责读取或销毁。
// hops[]：{ url, status, ms }。失败抛 NetError（跳转被拒绝、次数过多）或原始连接错误。
export async function fetchFollow(rawUrl, {
  method = 'GET', headers, blocked = isBlockedIP, maxRedirects = 5, timeoutMs = 5000, signal: outer, rejectUnauthorized = true, ca,
} = {}) {
  let u = checkTarget(rawUrl, blocked);
  const hops = [];
  for (let i = 0; ; i++) {
    const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const t0 = performance.now();
    let r;
    try {
      r = await httpRequest(u, { method, headers, blocked, signal, rejectUnauthorized, ca });
    } catch (err) {
      err.hops = hops;
      err.url = u.href;
      if (isTimeout(err, signal) && !err.code) err.code = 'ERR_TIMEOUT';
      throw err;
    }
    const status = r.res.statusCode;
    hops.push({ url: u.href, status, ms: since(t0) });
    const loc = r.res.headers.location;
    if (REDIRECT_CODES.has(status) && loc) {
      r.res.destroy();
      if (i >= maxRedirects) throw Object.assign(new NetError('ERR_TOO_MANY_REDIRECTS', `重定向次数超过 ${maxRedirects} 次`), { hops });
      let next;
      try {
        next = new URL(loc, u).href;
      } catch {
        throw Object.assign(new NetError('ERR_BAD_REDIRECT', REASONS.ERR_BAD_REDIRECT), { hops });
      }
      try {
        u = checkTarget(next, blocked);
      } catch (err) {
        err.hops = hops;
        err.url = next;
        throw err;
      }
      if (status === 303 && method !== 'HEAD') method = 'GET';
      continue;
    }
    return { url: u, res: r.res, timing: r.timing, socket: r.socket, hops, signal };
  }
}

function decompressStream(res) {
  const enc = String(res.headers['content-encoding'] ?? '').trim().toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(zlib.createGunzip());
  if (enc === 'deflate') return res.pipe(zlib.createInflate());
  if (enc === 'br') return res.pipe(zlib.createBrotliDecompress());
  return res;
}

// 限量读取响应体。decompress：按 Content-Encoding 解压后计数（防压缩炸弹）；
// overflow='truncate' 超出时截断并返回 truncated=true，'error' 时抛出 NetError('ETOOLARGE')。
// 返回 { body, bytes（读到的字节数，截断时为上限）, truncated }
export function readLimited(res, { maxBytes, decompress = false, overflow = 'truncate', signal } = {}) {
  return new Promise((resolve, reject) => {
    const stream = decompress ? decompressStream(res) : res;
    const chunks = [];
    let total = 0;
    let done = false;
    const cleanup = () => {
      res.destroy();
      if (stream !== res) stream.destroy();
    };
    const finish = (truncated) => {
      if (done) return;
      done = true;
      cleanup();
      const body = Buffer.concat(chunks).subarray(0, Math.min(total, maxBytes));
      resolve({ body, bytes: body.length, truncated });
    };
    const fail = (e) => {
      if (done) return;
      done = true;
      cleanup();
      reject(e);
    };
    stream.on('data', (c) => {
      chunks.push(c);
      total += c.length;
      if (total > maxBytes) {
        if (overflow === 'error') fail(new NetError('ETOOLARGE', `内容超过 ${Math.round(maxBytes / 1024)}KB 上限`));
        else finish(true);
      }
    });
    // 中途断开：允许截断的场景返回已读到的部分，要求完整的场景（如图片）报错
    const broken = (e) => {
      if (done) return;
      if (signal?.aborted) return fail(signal.reason ?? e);
      if (overflow === 'error' || !chunks.length) return fail(e ?? new NetError('EINCOMPLETE', '响应不完整'));
      return finish(true);
    };
    stream.on('end', () => finish(false));
    stream.on('error', broken);
    if (stream !== res) res.on('error', broken);
    stream.on('close', () => broken(new NetError('EINCOMPLETE', '响应不完整')));
    signal?.addEventListener('abort', () => fail(signal.reason ?? new Error('aborted')), { once: true });
  });
}

// ---------- HTTP 状态码中文说明 ----------

const STATUS_TEXT = {
  100: '继续', 101: '切换协议',
  200: '成功', 201: '已创建', 202: '已接受', 203: '非权威信息', 204: '无内容', 205: '重置内容', 206: '部分内容',
  300: '多种选择', 301: '永久重定向', 302: '临时重定向', 303: '查看其他位置', 304: '未修改', 307: '临时重定向（保持请求方法）', 308: '永久重定向（保持请求方法）',
  400: '请求错误', 401: '未授权', 402: '需要付款', 403: '禁止访问', 404: '未找到', 405: '方法不允许', 406: '无法接受', 407: '需要代理认证',
  408: '请求超时', 409: '冲突', 410: '已永久删除', 411: '需要 Content-Length', 412: '前提条件失败', 413: '请求体过大', 414: '网址过长',
  415: '不支持的媒体类型', 416: '请求范围不符合要求', 417: '预期失败', 418: '我是茶壶', 421: '请求被误导', 422: '无法处理的内容', 423: '已锁定',
  425: '太早', 426: '需要升级协议', 428: '需要前提条件', 429: '请求过多', 431: '请求头过大', 451: '因法律原因不可用',
  500: '服务器内部错误', 501: '未实现', 502: '网关错误', 503: '服务不可用', 504: '网关超时', 505: 'HTTP 版本不受支持', 507: '存储空间不足', 508: '检测到循环',
  511: '需要网络认证', 520: '未知错误（Cloudflare）', 521: '源站已关闭（Cloudflare）', 522: '连接源站超时（Cloudflare）', 523: '源站不可达（Cloudflare）',
  524: '源站响应超时（Cloudflare）', 525: 'SSL 握手失败（Cloudflare）', 526: '源站证书无效（Cloudflare）',
};

export function statusText(code) {
  if (STATUS_TEXT[code]) return STATUS_TEXT[code];
  if (code >= 200 && code < 300) return '成功';
  if (code >= 300 && code < 400) return '重定向';
  if (code >= 400 && code < 500) return '客户端错误';
  if (code >= 500 && code < 600) return '服务器错误';
  return '未知状态';
}

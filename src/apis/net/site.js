import tls from 'node:tls';
import net from 'node:net';
import { param } from '../../lib/http.js';
import {
  createGate, fetchFollow, readLimited, toHttpError, isBlockedIP, makeLookup, statusText, since,
} from './common.js';

const MAX_REDIRECTS = 5;
const HOP_TIMEOUT_MS = 5000;
const TOTAL_TIMEOUT_MS = 10_000;
const MAX_BODY = 1024 * 1024;
export const gate = createGate(20);

// 用 ALPN 探测是否支持 HTTP/2：单独做一次 TLS 握手，只提供 h2 / http/1.1，看服务器选哪个。
// 连接同样经过 lookup 钩子检查。失败或超时返回 null（无法判断）。
export function probeHttp2(u, { blocked = isBlockedIP, timeoutMs = 3000, ca } = {}) {
  return new Promise((resolve) => {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && blocked(host)) return resolve(null);
    const socket = tls.connect({
      host,
      port: Number(u.port) || 443,
      servername: net.isIP(host) ? undefined : host,
      lookup: makeLookup(blocked),
      rejectUnauthorized: false,
      ALPNProtocols: ['h2', 'http/1.1'],
      ...(ca ? { ca } : {}),
    });
    const done = (v) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(v);
    };
    socket.on('error', () => {});
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.once('secureConnect', () => done(socket.alpnProtocol === 'h2'));
    socket.once('error', () => done(null));
  });
}

// blocked、ca 仅供测试替换
export async function checkSite(rawUrl, { blocked = isBlockedIP, ca } = {}) {
  const t0 = performance.now();
  const signal = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
  let r;
  try {
    r = await fetchFollow(rawUrl, {
      method: 'GET',
      blocked,
      maxRedirects: MAX_REDIRECTS,
      timeoutMs: HOP_TIMEOUT_MS,
      signal,
      // 只读取响应头和少量内容，不向目标发送任何凭据；为了能检测证书有问题的网站，这里不因证书无效而中断，
      // 证书是否有效通过 certValid / certError 返回
      rejectUnauthorized: false,
      ca,
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-encoding': 'gzip, deflate, br',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
  } catch (err) {
    throw toHttpError(err, signal);
  }
  const { res, url, timing, socket, hops } = r;
  const t1 = performance.now();
  let body;
  try {
    body = await readLimited(res, { maxBytes: MAX_BODY, signal: r.signal });
  } catch {
    body = { bytes: 0, truncated: true };
  }
  const download = since(t1);
  const isHttps = url.protocol === 'https:';
  const http2 = isHttps ? await probeHttp2(url, { blocked, ca }) : null;
  const h = res.headers;
  const encoding = String(h['content-encoding'] ?? '').trim().toLowerCase();
  const length = Number(h['content-length']);
  const status = res.statusCode;

  return {
    url: hops[0].url,
    finalUrl: url.href,
    status,
    statusText: statusText(status),
    ok: status >= 200 && status < 400,
    redirects: hops.length - 1,
    hops: hops.map((x) => ({ ...x, statusText: statusText(x.status) })),
    ip: socket.remoteAddress,
    timing: {
      total: since(t0),
      dns: timing.dns,
      connect: timing.connect,
      tls: timing.tls,
      ttfb: timing.ttfb,
      download,
    },
    compressed: Boolean(encoding) && encoding !== 'identity',
    compression: encoding && encoding !== 'identity' ? encoding : 'none',
    server: h.server ?? null,
    contentType: h['content-type'] ?? null,
    contentLength: h['content-length'] != null && Number.isFinite(length) ? length : null,
    bodyBytes: body.bytes,
    truncated: body.truncated,
    https: isHttps,
    http2,
    tlsProtocol: socket.tlsProtocol,
    certValid: socket.authorized,
    certError: socket.authorizationError,
  };
}

export default {
  name: 'site-check',
  category: 'net',
  title: '网站检测',
  description: '检测网站能否访问：状态码、跳转链、DNS / 连接 / 首字节耗时、压缩、服务器软件、HTTPS 与 HTTP/2 支持',
  source: '目标网站',
  routes: [
    {
      method: 'GET',
      path: '/api/site/check',
      summary: '检测网站可达性、响应时间与跳转',
      params: [
        { name: 'url', required: true, desc: '网址（http / https），只允许公网地址；每一跳跳转都会检查', example: 'https://github.com' },
      ],
      fields: [
        { name: 'url', type: 'string', desc: '检测的起始网址（规范化后，已去掉 # 及之后的部分）' },
        { name: 'finalUrl', type: 'string', desc: '跟随跳转后的最终网址；没有跳转时与 url 相同' },
        { name: 'status', type: 'number', desc: '最终响应的 HTTP 状态码（如 200、404）' },
        { name: 'statusText', type: 'string', desc: '状态码的中文说明，如 200 成功、301 永久重定向、404 未找到、503 服务不可用' },
        { name: 'ok', type: 'boolean', desc: '最终状态码是否为 2xx / 3xx（可正常访问）' },
        { name: 'redirects', type: 'number', desc: '跳转次数（0~5）' },
        { name: 'hops', type: 'array', desc: '每一跳的请求记录，第一项是起始网址，最后一项是最终网址' },
        { name: 'hops[].url', type: 'string', desc: '该跳请求的网址' },
        { name: 'hops[].status', type: 'number', desc: '该跳的 HTTP 状态码（跳转为 301 / 302 / 303 / 307 / 308）' },
        { name: 'hops[].statusText', type: 'string', desc: '该跳状态码的中文说明' },
        { name: 'hops[].ms', type: 'number', desc: '该跳从发起请求到收到响应头的耗时（毫秒，保留两位小数）' },
        { name: 'ip', type: 'string|null', desc: '最终网址所连接的服务器 IP；取不到时为 null' },
        { name: 'timing', type: 'object', desc: '耗时明细（毫秒，保留两位小数）；dns / connect / tls / ttfb 为最终那一跳的数据' },
        { name: 'timing.total', type: 'number', desc: '总耗时：从第一跳开始到读完响应（含全部跳转和下载，下载最多 1MB）' },
        { name: 'timing.dns', type: 'number|null', desc: 'DNS 解析耗时；网址中直接写 IP 时不需要解析，为 null' },
        { name: 'timing.connect', type: 'number|null', desc: 'TCP 建连耗时（不含 DNS）；取不到时为 null' },
        { name: 'timing.tls', type: 'number|null', desc: 'TLS 握手耗时；http 网址为 null' },
        { name: 'timing.ttfb', type: 'number', desc: '首字节时间：从发起最终那一跳请求（含 DNS、建连、握手）到收到响应头' },
        { name: 'timing.download', type: 'number', desc: '读取响应体的耗时（最多读 1MB）' },
        { name: 'compressed', type: 'boolean', desc: '响应是否启用了压缩（请求时带 Accept-Encoding: gzip, deflate, br）' },
        { name: 'compression', type: 'string', desc: '压缩方式：gzip / br / deflate；未压缩为 none；其他方式为 Content-Encoding 原值（小写）' },
        { name: 'server', type: 'string|null', desc: '响应头 Server 的原值（如 nginx、cloudflare）；没有时为 null' },
        { name: 'contentType', type: 'string|null', desc: '响应头 Content-Type 的原值（如 text/html; charset=utf-8）；没有时为 null' },
        { name: 'contentLength', type: 'number|null', desc: '响应头 Content-Length（字节，压缩后的大小）；分块传输等没有该头时为 null' },
        { name: 'bodyBytes', type: 'number', desc: '实际读取到的响应体字节数（未解压），最多 1048576（1MB）' },
        { name: 'truncated', type: 'boolean', desc: '响应体是否超过 1MB 被截断（或读取中途断开）' },
        { name: 'https', type: 'boolean', desc: '最终网址是否为 HTTPS' },
        { name: 'http2', type: 'boolean|null', desc: '是否支持 HTTP/2（通过 TLS ALPN 协商 h2 判断）；最终网址是 http 或探测失败时为 null' },
        { name: 'tlsProtocol', type: 'string|null', desc: '最终网址的 TLS 协议版本（如 TLSv1.3）；http 网址为 null' },
        { name: 'certValid', type: 'boolean|null', desc: '最终网址的证书是否可信（链可验证、未过期、与域名匹配）；http 网址为 null。详细信息可用 /api/ssl 查询' },
        { name: 'certError', type: 'string|null', desc: '证书不可信的原因代码（如 CERT_HAS_EXPIRED、ERR_TLS_CERT_ALTNAME_INVALID）；证书可信或 http 网址时为 null' },
      ],
      async handler({ query }) {
        const url = param(query, 'url', { required: true, max: 2048 });
        return { data: await gate(() => checkSite(url)) };
      },
    },
  ],
};


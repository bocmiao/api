// 抓取用户指定网址的正文（HTML / XML），供 RSS、网页正文、网页转 Markdown 使用。
// 全部经过 fetchFollow：每一跳先 checkTarget 静态检查，再由 lookup 钩子在连接时检查解析出的 IP（防 DNS 重绑定）；
// 响应体按 Content-Encoding 解压后限量读取（防压缩炸弹），整体有总时限。
import { HttpError } from '../../lib/http.js';
import { decodeBody } from '../tools/webmeta.js';
import { fetchFollow, readLimited, toHttpError, isBlockedIP, statusText } from './common.js';

// XML 声明里的编码（<?xml version="1.0" encoding="GBK"?>）；只看开头 200 字节
function xmlEncoding(buf) {
  const head = buf.subarray(0, 200).toString('latin1');
  if (!head.trimStart().startsWith('<?xml')) return null;
  return /encoding\s*=\s*["']([\w-]{1,40})["']/i.exec(head)?.[1] ?? null;
}

export function decodeText(buf, contentType = '') {
  if (!/charset=/i.test(contentType)) {
    const enc = xmlEncoding(buf);
    if (enc) return decodeBody(buf, `text/xml; charset=${enc}`);
  }
  return decodeBody(buf, contentType);
}

export const HOP_TIMEOUT_MS = 6000;
export const TOTAL_TIMEOUT_MS = 12_000;

// 返回 { url（起始网址）, finalUrl, status, contentType, text, buffer, bytes, truncated, redirects }。
// text 按 Content-Type / <meta charset> / <?xml encoding?> 解码。
// accept：请求头 Accept；types：允许的 Content-Type 前缀（小写，缺少 Content-Type 时放行）；blocked 仅供测试替换
export async function fetchDocument(rawUrl, {
  accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
  types = null,
  maxBytes = 2 * 1024 * 1024,
  blocked = isBlockedIP,
  maxRedirects = 5,
  hopTimeoutMs = HOP_TIMEOUT_MS,
  totalTimeoutMs = TOTAL_TIMEOUT_MS,
} = {}) {
  const signal = AbortSignal.timeout(totalTimeoutMs);
  let r;
  try {
    r = await fetchFollow(rawUrl, {
      method: 'GET',
      blocked,
      maxRedirects,
      timeoutMs: hopTimeoutMs,
      signal,
      headers: {
        accept,
        'accept-encoding': 'gzip, deflate, br',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
  } catch (err) {
    throw toHttpError(err, signal);
  }
  const { res, url, hops } = r;
  const status = res.statusCode;
  if (status < 200 || status >= 300) {
    res.destroy();
    throw new HttpError(502, `目标网址返回 HTTP ${status} ${statusText(status)}`);
  }
  const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
  const mime = contentType.split(';')[0].trim();
  if (types && mime && !types.some((t) => mime.startsWith(t))) {
    res.destroy();
    throw new HttpError(415, `目标内容类型不受支持（${mime}）`);
  }
  let body;
  try {
    body = await readLimited(res, { maxBytes, decompress: true, signal });
  } catch (err) {
    throw toHttpError(err, signal);
  }
  return {
    url: hops[0].url,
    finalUrl: url.href,
    status,
    contentType,
    text: decodeText(body.body, contentType),
    buffer: body.body,
    bytes: body.bytes,
    truncated: body.truncated,
    redirects: hops.length - 1,
  };
}

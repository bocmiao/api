import http from 'node:http';
import https from 'node:https';
import { HttpError } from '../http.js';
import { makeLookup, isBlockedIP } from '../netguard.js';
import { publicSourceUrl } from './format.js';

// Direct, credential-free requests. Do not use an outbound proxy that could bypass
// the connect-time DNS guard. Injection is for isolated tests, never HTTP input.
export function createPublicDownloader({ lookup = makeLookup(isBlockedIP), requestHttp = http.request, requestHttps = https.request } = {}) {
  return async function download(raw, { maxBytes = 256 * 1024, timeoutMs = 10_000, hosts } = {}) {
    const signal = AbortSignal.timeout(timeoutMs); // one deadline across every redirect and body
    let url = publicSourceUrl(raw);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const u = new URL(publicSourceUrl(url));
      if (hosts && (!hosts.includes(u.hostname) || u.protocol !== 'https:')) throw new HttpError(400, '文章跳转到了不允许的站点');
      const result = await new Promise((resolve, reject) => {
        const fail = (err) => reject(err instanceof HttpError ? err : new HttpError(signal.aborted ? 504 : err?.code === 'EBLOCKED' ? 400 : 502,
          signal.aborted ? '来源读取超时' : err?.code === 'EBLOCKED' ? '来源解析到了内网或保留地址' : '无法读取来源；未发布新版本'));
        const req = (u.protocol === 'https:' ? requestHttps : requestHttp)(u, {
          method: 'GET', lookup, agent: false, signal,
          headers: { accept: '*/*', 'accept-encoding': 'identity', 'user-agent': 'miao-api-news60s/1.0' },
        }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            if (!res.headers.location) { fail(new HttpError(502, '来源重定向缺少地址')); res.destroy(); return; }
            resolve({ redirect: res.headers.location }); res.destroy(); return;
          }
          if (res.statusCode !== 200) { fail(new HttpError(502, `来源返回 HTTP ${res.statusCode}；未发布新版本`)); res.destroy(); return; }
          if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { fail(new HttpError(502, '来源忽略 identity 编码要求')); res.destroy(); return; }
          if (Number(res.headers['content-length'] || 0) > maxBytes) { fail(new HttpError(413, '来源响应过大')); res.destroy(); return; }
          let size = 0;
          const chunks = [];
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) { fail(new HttpError(413, '来源响应过大')); res.destroy(); }
            else chunks.push(chunk);
          });
          res.on('error', fail);
          res.on('aborted', () => fail(new HttpError(502, '来源响应被截断')));
          res.on('end', () => resolve({ bytes: Buffer.concat(chunks), url: u.href, contentType: String(res.headers['content-type'] || '').split(';')[0].toLowerCase() }));
        });
        req.on('error', fail);
        req.end();
      });
      if (!result.redirect) return result;
      if (redirects === 3) throw new HttpError(502, '来源重定向超过 3 次');
      const next = publicSourceUrl(result.redirect, u.href);
      if (u.protocol === 'https:' && new URL(next).protocol !== 'https:') throw new HttpError(400, '拒绝 HTTPS 降级跳转');
      url = next;
    }
  };
}

export const downloadPublic = createPublicDownloader();

// 后台声明式上游是非可信地址，不能使用固定供应商的 fetch/出站代理通道。
import http from 'node:http';
import https from 'node:https';
import { HttpError } from './http.js';
import { checkUrl, isBlockedIP, makeLookup } from './netguard.js';

// 依赖注入仅供本地测试，声明式 JSON 没有覆盖这些函数的入口。
export function createCustomRequester({ lookup = makeLookup(isBlockedIP), requestHttp = (...args) => http.request(...args), requestHttps = (...args) => https.request(...args) } = {}) {
  return async function requestCustom(raw, { method = 'GET', headers = {}, body, timeoutMs = 10000, signal: external, responseType = 'json' } = {}) {
    const url = checkUrl(raw);
    external?.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = external ? AbortSignal.any([external, timeout]) : timeout;
    const deadline = performance.now() + timeoutMs;
    const stopped = () => {
      external?.throwIfAborted();
      if (signal.aborted || performance.now() >= deadline) throw new HttpError(504, '自定义接口上游响应超时');
    };
    const bytes = await new Promise((resolve, reject) => {
      const fail = (err) => {
        try { stopped(); } catch (e) { reject(e); return; }
        reject(err instanceof HttpError ? err : new HttpError(err?.code === 'EBLOCKED' ? 400 : 502,
          err?.code === 'EBLOCKED' ? '不允许访问内网或保留地址' : '自定义接口上游请求失败'));
      };
      let req;
      try {
        req = (url.protocol === 'https:' ? requestHttps : requestHttp)(url, {
          method, lookup, agent: false, signal,
          headers: { ...headers, 'accept-encoding': 'identity', 'user-agent': 'miao-api-custom/1.0' },
        }, (res) => {
          // 不跟随任何跳转，避免目标变化与认证信息被转发。
          if (res.statusCode < 200 || res.statusCode >= 300) {
            fail(new HttpError(502, `自定义接口上游返回 HTTP ${res.statusCode}（不跟随跳转）`)); res.destroy(); return;
          }
          if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
            fail(new HttpError(502, '上游未按要求返回未压缩正文')); res.destroy(); return;
          }
          const maxBytes = 1024 * 1024;
          if (Number(res.headers['content-length'] || 0) > maxBytes) {
            fail(new HttpError(502, '自定义接口上游正文超过 1 MiB')); res.destroy(); return;
          }
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) { fail(new HttpError(502, '自定义接口上游正文超过 1 MiB')); res.destroy(); }
            else chunks.push(chunk);
          });
          res.on('error', fail);
          res.on('aborted', () => fail(new HttpError(502, '自定义接口上游正文被截断')));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', fail);
        req.end(body);
      } catch (err) { fail(err); req?.destroy(); }
    });
    stopped();
    const text = bytes.toString('utf8');
    if (responseType === 'text') { stopped(); return { text }; }
    let result;
    try { result = JSON.parse(text); } catch { throw new HttpError(502, '自定义接口上游返回的不是合法 JSON'); }
    stopped();
    return result;
  };
}

export const requestCustom = createCustomRequester();

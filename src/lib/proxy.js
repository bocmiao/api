// 境外数据源代理：大陆服务器访问 Steam、V2EX、CoinGecko 等境外网站经常超时或连不上，
// 管理员可在「设置 → 网络」填写一个 HTTP 代理（例如服务器上 Clash 的 http://127.0.0.1:7890），
// 只有列表里的域名走代理，其余请求照常直连。零依赖实现：HTTP CONNECT 隧道 + TLS。
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import zlib from 'node:zlib';

export const DEFAULT_PROXY_HOSTS = 'steampowered.com,steamcommunity.com,isthereanydeal.com,v2ex.com,coingecko.com,bgm.tv,github.com,globalping.io';
const MAX_REDIRECTS = 5;
const MAX_BODY = 20 * 1024 * 1024;

export function proxyConfig(env = process.env) {
  const raw = (env.OUTBOUND_PROXY ?? '').trim();
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'http:') return null;
  const hosts = (env.OUTBOUND_PROXY_HOSTS || DEFAULT_PROXY_HOSTS).split(/[,，\s]+/).map((h) => h.trim().toLowerCase().replace(/^\*?\./, '')).filter(Boolean);
  return { url, hosts };
}

// 域名本身或其子域名在列表里时走代理；列表写 * 表示全部境外请求都走代理
export function shouldProxy(target, cfg = proxyConfig()) {
  if (!cfg) return false;
  const host = new URL(target).hostname.toLowerCase();
  return cfg.hosts.some((h) => h === '*' || host === h || host.endsWith(`.${h}`));
}

function proxyAuth(url) {
  if (!url.username) return {};
  const cred = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  return { 'proxy-authorization': `Basic ${Buffer.from(cred).toString('base64')}` };
}

function decode(buf, encoding) {
  switch ((encoding ?? '').toLowerCase()) {
    case 'gzip': case 'x-gzip': return zlib.gunzipSync(buf);
    case 'deflate': try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); }
    case 'br': return zlib.brotliDecompressSync(buf);
    default: return buf;
  }
}

function toHeaders(raw) {
  const h = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'content-encoding' || k === 'content-length' || k === 'transfer-encoding') continue;
    for (const x of [].concat(v)) h.append(k, x);
  }
  return h;
}

function once(target, { method = 'GET', headers = {}, body, signal }, cfg) {
  const u = new URL(target);
  const p = cfg.url;
  const reqHeaders = { 'accept-encoding': 'gzip, deflate, br', ...Object.fromEntries(new Headers(headers)), host: u.host };
  const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : body);
  if (payload) reqHeaders['content-length'] = String(payload.length);

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    const reqs = [];
    const onAbort = () => { for (const r of reqs) r.destroy(); fail(signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' })); };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });

    const handle = (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { res.destroy(); fail(new Error('响应过大')); return; }
        chunks.push(c);
      });
      res.on('error', fail);
      res.on('end', () => {
        signal?.removeEventListener('abort', onAbort);
        try {
          const buf = decode(Buffer.concat(chunks), res.headers['content-encoding']);
          const status = res.statusCode;
          const noBody = status === 204 || status === 304 || method === 'HEAD';
          settled = true;
          resolve({ status, headers: res.headers, response: new Response(noBody ? null : buf, { status, headers: toHeaders(res.headers) }) });
        } catch (err) { fail(err); }
      });
    };
    const send = (req) => {
      reqs.push(req);
      req.on('error', fail);
      if (payload) req.write(payload);
      req.end();
    };

    const port = Number(p.port) || 80;
    if (u.protocol === 'http:') {
      // 明文 HTTP：直接把完整网址发给代理
      return send(http.request({ host: p.hostname, port, method, path: target, headers: { ...reqHeaders, ...proxyAuth(p) } }, handle));
    }
    const tunnel = http.request({
      host: p.hostname, port, method: 'CONNECT', path: `${u.hostname}:${u.port || 443}`,
      headers: { host: `${u.hostname}:${u.port || 443}`, ...proxyAuth(p) },
    });
    reqs.push(tunnel);
    tunnel.on('error', (err) => fail(Object.assign(new Error(`无法连接代理服务器：${err.code ?? err.message}`), { cause: err, proxy: true })));
    tunnel.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return fail(Object.assign(new Error(`代理服务器拒绝连接（HTTP ${res.statusCode}）`), { proxy: true }));
      }
      const req = https.request({
        host: u.hostname, port: u.port || 443, method, path: u.pathname + u.search, headers: reqHeaders, servername: u.hostname,
        createConnection: () => tls.connect({ socket, servername: u.hostname }),
      }, handle);
      send(req);
    });
    tunnel.end();
  });
}

// 与 fetch 用法相同，返回标准 Response；自动跟随跳转
export async function proxyFetch(target, init = {}, cfg = proxyConfig()) {
  let url = target;
  let opts = init;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const { status, headers, response } = await once(url, opts, cfg);
    if (![301, 302, 303, 307, 308].includes(status) || !headers.location || init.redirect === 'manual') return response;
    url = new URL(headers.location, url).href;
    if (status === 303 || ((status === 301 || status === 302) && opts.method && opts.method !== 'GET')) opts = { ...opts, method: 'GET', body: undefined };
  }
  throw new Error('跳转次数过多');
}

// 出站请求统一入口：命中代理列表走代理，否则直连
export function outboundFetch(target, init = {}) {
  const cfg = proxyConfig();
  return cfg && shouldProxy(target, cfg) ? proxyFetch(target, init, cfg) : fetch(target, init);
}

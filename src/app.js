import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { apiRouter, catalog } from './registry.js';
import { accountRouter } from './routes/account.js';
import { HttpError } from './lib/http.js';
import { parseCookies, userFromSession, userFromApiKey, extractApiKey, publicUser } from './lib/auth.js';
import { isModuleEnabled } from './lib/modules.js';
import { applySettings } from './lib/settings.js';

// 后台「系统设置」中保存的配置优先于环境变量
applySettings();
import { consume, logRequest } from './lib/limits.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization, X-API-Key',
  'access-control-expose-headers': 'X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
};
const PAGE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy': "default-src 'self'; img-src * data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};

function send(res, status, body, headers = {}) {
  const isJson = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    ...(isJson ? { 'content-type': 'application/json; charset=utf-8' } : {}),
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

const envelope = (r) => ({
  code: 200, message: 'ok',
  ...(r?.cached !== undefined ? { cached: r.cached } : {}),
  ...(r?.stale ? { stale: true } : {}),
  ...(r?.updatedAt ? { updatedAt: r.updatedAt } : {}),
  data: r?.data ?? null,
});

function clientIp(req) {
  if (config.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return fwd.split(',')[0].trim();
  }
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

async function readBody(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return undefined;
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 100_000) throw new HttpError(413, '请求体过大');
    chunks.push(c);
  }
  if (!size) return undefined;
  if (!String(req.headers['content-type']).includes('application/json')) throw new HttpError(415, '请求体须为 JSON');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON 格式错误');
  }
}

// 基于 Cookie 的写操作：要求 JSON 且同源，防止 CSRF
function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, '跨站请求被拒绝');
  if (req.method !== 'GET' && !String(req.headers['content-type']).includes('application/json')) {
    throw new HttpError(415, '请求体须为 JSON');
  }
}

// 静态文件一律 no-cache + ETag：浏览器每次都向服务器确认，未变化时返回 304，
// 在线更新后无需强制刷新即可拿到新版页面脚本
async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return false;
  try {
    let body = await readFile(file);
    // 页面里引用的脚本和样式加上内容指纹，文件一变地址就变，旧缓存自动失效
    if (file.endsWith('.html')) {
      let html = body.toString('utf8');
      for (const asset of ['app.js', 'styles.css']) {
        try {
          const h = createHash('sha1').update(await readFile(join(PUBLIC_DIR, asset))).digest('base64url').slice(0, 10);
          html = html.replaceAll(`"/${asset}"`, `"/${asset}?v=${h}"`);
        } catch {}
      }
      body = Buffer.from(html);
    }
    const etag = `"${createHash('sha1').update(body).digest('base64url').slice(0, 16)}"`;
    const headers = {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      etag,
      ...(file.endsWith('.html') ? PAGE_HEADERS : {}),
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
    } else {
      send(res, 200, body, headers);
    }
    return true;
  } catch {
    return false;
  }
}

export async function handle(req, res) {
  const started = Date.now();
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : '/';
  const ip = clientIp(req);
  const cookies = parseCookies(req.headers.cookie);
  const isApi = path === '/api' || path.startsWith('/api/');
  const log = { user: null, keyId: null, logged: false };

  try {
    if (req.method === 'OPTIONS') return send(res, 204, '', CORS);
    if (req.method === 'GET' && path === '/health') return send(res, 200, envelope({ data: { status: 'up' } }));
    if (req.method === 'GET' && path === '/api') {
      const viewer = userFromSession(cookies.sid);
      return send(res, 200, envelope({ data: catalog({ includeDisabled: Boolean(publicUser(viewer)?.isAdmin) }) }), { ...CORS, 'cache-control': 'no-store' });
    }

    // 平台接口（注册登录、控制台、管理后台）
    const acct = accountRouter.match(req.method, path);
    if (acct) {
      if (acct.methodNotAllowed) throw new HttpError(405, '不支持的请求方法');
      assertSameOrigin(req);
      const cookieOut = [];
      const ctx = {
        req, ip, params: acct.params, query: url.searchParams, body: await readBody(req),
        sessionToken: cookies.sid, user: userFromSession(cookies.sid), setCookie: (c) => cookieOut.push(c),
      };
      const result = await acct.route.handler(ctx);
      return send(res, 200, envelope(result), { 'cache-control': 'no-store', ...(cookieOut.length ? { 'set-cookie': cookieOut } : {}) });
    }

    // 聚合接口
    const hit = apiRouter.match(req.method, path);
    if (hit?.methodNotAllowed) throw new HttpError(405, '不支持的请求方法');
    if (hit) {
      const { route } = hit.route;
      const key = extractApiKey(req, url.searchParams);
      let user = null;
      if (key) {
        user = userFromApiKey(key);
        if (!user) throw new HttpError(401, 'API Key 无效或已删除');
        log.keyId = user.key_id;
      } else {
        user = userFromSession(cookies.sid);
      }
      log.user = user;
      log.logged = !route.public;
      // 被管理员关闭的模块对所有人（包括管理员）返回 403，已生成的短链接也随之失效
      if (!isModuleEnabled(hit.route.module.name)) throw new HttpError(403, '该接口已被管理员关闭');

      const rateHeaders = route.public ? {} : consume({ user, ip });
      const body = await readBody(req);
      const ctx = { req, ip, params: hit.params, query: url.searchParams, body, user: user && { id: user.id, email: user.email } };
      const result = await route.handler(ctx);

      if (route.raw) {
        const headers = { ...CORS, ...rateHeaders, ...result.headers };
        // 从本站域名直接返回的 SVG 可能被当作页面打开，统一禁止脚本
        if (/svg/i.test(headers['content-type'] ?? '')) {
          headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
        }
        send(res, result.status ?? 200, result.body ?? '', headers);
      } else {
        send(res, 200, envelope(result), { ...CORS, ...rateHeaders });
      }
      if (log.logged) logRequest({ ...log, ip, path, status: result.status ?? 200, ms: Date.now() - started });
      return;
    }

    if (req.method === 'GET' && !isApi && (await serveStatic(req, res, path))) return;
    throw new HttpError(404, isApi ? '接口不存在，访问 /api 查看全部接口' : '页面不存在');
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    // 代码错误打印完整堆栈；上游故障、服务不支持等预期内的 5xx 只记一行
    if (status >= 500) console.error(`[${req.method} ${path}]`, err instanceof HttpError ? `${status} ${err.message}` : err);
    // 被限流的请求不计入日志，避免刷量拖慢数据库
    if (log.logged && status !== 429) logRequest({ ...log, ip, path, status, ms: Date.now() - started });
    if (res.headersSent) return res.end();
    send(res, status, { code: status, message: status === 500 ? '服务器内部错误' : err.message, data: null }, {
      ...(isApi ? CORS : {}), ...(err.headers ?? {}),
    });
  }
}

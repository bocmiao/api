import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { apiRouter, catalog } from './registry.js';
import { accountRouter, checkConfirm } from './routes/account.js';
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

// 默认不允许浏览器和 CDN 缓存（接口数据、登录状态、短链跳转都不能被缓存）；静态文件等需要缓存的自己传 cache-control
function send(res, status, body, headers = {}) {
  const isJson = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    ...(isJson ? { 'content-type': 'application/json; charset=utf-8' } : {}),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
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
    // 腾讯云 EdgeOne 回源时带上的真实客户端 IP
    const eo = req.headers['eo-connecting-ip'];
    if (eo && isIP(String(eo).trim())) return String(eo).trim();
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
function assertSameOrigin(req, { raw = false } = {}) {
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, '跨站请求被拒绝');
  if (raw) {
    // 上传文件：必须是本站页面发出的请求（浏览器会带 Origin），且类型为二进制
    if (!origin) throw new HttpError(403, '跨站请求被拒绝');
    if (!String(req.headers['content-type']).startsWith('application/octet-stream')) throw new HttpError(415, '请求体须为文件');
    return;
  }
  if (req.method !== 'GET' && !String(req.headers['content-type']).includes('application/json')) {
    throw new HttpError(415, '请求体须为 JSON');
  }
}

// 读取二进制请求体（上传更新包），超过上限直接拒绝
async function readRawBody(req, limit) {
  if (Number(req.headers['content-length'] || 0) > limit) throw new HttpError(413, `文件过大，最大 ${Math.round(limit / 1048576)} MB`);
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, `文件过大，最大 ${Math.round(limit / 1048576)} MB`);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// 静态文件默认 no-cache + ETag：浏览器每次都向服务器确认，未变化时返回 304，在线更新后无需强制刷新；
// 页面引用的脚本和样式带内容指纹，这类地址可以长期缓存
async function serveStatic(req, res, pathname, query, { page = false, status = 200 } = {}) {
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
    // 带内容指纹（?v=）且与当前文件一致的脚本和样式可长期缓存：浏览器和 CDN（如 EdgeOne）都不用再回源确认
    const versioned = query?.get('v') && query.get('v') === createHash('sha1').update(body).digest('base64url').slice(0, 10);
    const headers = {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      // 页面地址（如 /status、/admin/users）同时也是网页程序取数据的 JSON 地址：禁止 CDN 缓存，并按请求类型区分浏览器缓存
      'cache-control': versioned ? 'public, max-age=31536000, immutable' : page ? 'private, no-cache' : 'no-cache',
      ...(page ? { vary: 'Sec-Fetch-Mode, Accept' } : {}),
      etag,
      ...(file.endsWith('.html') ? PAGE_HEADERS : {}),
    };
    if (status === 200 && req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
    } else {
      send(res, status, body, headers);
    }
    return true;
  } catch {
    return false;
  }
}

// 网页的页面地址（/docs/epic、/console/keys、/admin/users……）：浏览器直接打开时返回页面，
// 网页程序内部用 fetch 取数据时照常返回 JSON。/api/ 开头的接口和 /s/ 短链接不受影响
const PAGE_ROOTS = new Set(['', 'docs', 'status', 'login', 'register', 'reset', 'console', 'admin']);
export function pageNavigation(req, path) {
  if (req.method !== 'GET' || path === '/api' || /^\/(api|s)\//.test(path) || /\.[a-z0-9]+$/i.test(path)) return null;
  const mode = req.headers['sec-fetch-mode'];
  const html = mode ? mode === 'navigate' : /text\/html/.test(req.headers.accept ?? '');
  if (!html) return null;
  return PAGE_ROOTS.has(path.split('/')[1]) ? 200 : 404;
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
    const pageStatus = pageNavigation(req, path);
    if (pageStatus && (await serveStatic(req, res, '/', url.searchParams, { page: true, status: pageStatus }))) return;
    if (req.method === 'GET' && path === '/health') return send(res, 200, envelope({ data: { status: 'up' } }));
    if (req.method === 'GET' && path === '/api') {
      const viewer = userFromSession(cookies.sid);
      return send(res, 200, envelope({ data: catalog({ includeDisabled: Boolean(publicUser(viewer)?.isAdmin) }) }), { ...CORS, 'cache-control': 'no-store' });
    }

    // 平台接口（注册登录、控制台、管理后台）
    const acct = accountRouter.match(req.method, path);
    if (acct) {
      if (acct.methodNotAllowed) throw new HttpError(405, '不支持的请求方法');
      const raw = acct.route.rawBody;
      assertSameOrigin(req, { raw: Boolean(raw) });
      // 上传前先确认是管理员，避免陌生人往服务器传大文件
      if (raw) {
        const admin = publicUser(userFromSession(cookies.sid));
        if (!admin?.isAdmin) throw new HttpError(403, '需要管理员权限');
        if (!checkConfirm(req.headers['x-admin-confirm'], admin.id)) throw new HttpError(403, '请先输入管理员密码确认');
      }
      const cookieOut = [];
      const ctx = {
        req, ip, params: acct.params, query: url.searchParams, body: raw ? await readRawBody(req, raw) : await readBody(req),
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
      // 数据源已失效、暂停服务的接口：直接说明原因，不再请求上游，也不计入额度
      if (hit.route.module.suspended) { log.logged = false; throw new HttpError(503, `该接口暂不可用：${hit.route.module.suspended}`); }

      const rateHeaders = route.public ? {} : consume({ user, ip });
      const body = await readBody(req);
      const ctx = { req, ip, params: hit.params, query: url.searchParams, body, user: user && { id: user.id, email: user.email } };
      // 批量接口按目标数计费：入口已计 1 次，handler 调用 ctx.charge(n) 再多计 n 次（额度不足时抛 429）
      ctx.charge = (n) => { if (!route.public && n > 0) Object.assign(rateHeaders, consume({ user, ip }, n)); };
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

    if (req.method === 'GET' && !isApi && (await serveStatic(req, res, path, url.searchParams))) return;
    throw new HttpError(404, isApi ? '接口不存在，访问 /api 查看全部接口' : '页面不存在');
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    // 代码错误打印完整堆栈；上游故障、服务不支持等预期内的 5xx 只记一行
    if (status >= 500) console.error(`[${req.method} ${path}]`, err instanceof HttpError ? `${status} ${err.message}` : err);
    // 被限流的请求不计入日志，避免刷量拖慢数据库
    if (log.logged && status !== 429) {
      const error = err instanceof HttpError ? err.message : `${err?.name ?? 'Error'}: ${err?.message ?? err}`;
      logRequest({ ...log, ip, path, status, ms: Date.now() - started, error });
    }
    if (res.headersSent) return res.end();
    send(res, status, { code: status, message: status === 500 ? '服务器内部错误' : err.message, data: null }, {
      ...(isApi ? CORS : {}), ...(err.headers ?? {}),
    });
  }
}

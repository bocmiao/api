import { readFile } from 'node:fs/promises';
import { modules } from './apis/index.js';

const INDEX_HTML = new URL('../public/index.html', import.meta.url);

const routes = new Map();
for (const mod of modules) {
  for (const r of mod.routes) routes.set(`${r.method} ${r.path}`, { ...r, module: mod.name });
}

function catalog() {
  return modules.map((m) => ({
    name: m.name,
    title: m.title,
    routes: m.routes.map(({ method, path, summary, params = [] }) => ({ method, path, summary, params })),
  }));
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

const ok = (data, extra = {}) => ({ code: 200, message: 'ok', ...extra, data });
const fail = (code, message) => ({ code, message, data: null });

export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  try {
    if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain');
    if (req.method === 'GET' && path === '/') return send(res, 200, await readFile(INDEX_HTML), 'text/html; charset=utf-8');
    if (req.method === 'GET' && path === '/health') return send(res, 200, ok({ status: 'up' }));
    if (req.method === 'GET' && path === '/api') return send(res, 200, ok(catalog()));

    const route = routes.get(`${req.method} ${path}`);
    if (!route) return send(res, 404, fail(404, '接口不存在，访问 /api 查看全部接口'));

    const { data, cached = false, stale = false, updatedAt } = await route.handler({ query: url.searchParams, req });
    return send(res, 200, ok(data, { cached, stale, updatedAt }));
  } catch (err) {
    const status = err.status ?? (err.name === 'TimeoutError' ? 504 : 500);
    if (status >= 500) console.error(`[${req.method} ${path}]`, err);
    return send(res, status, fail(status, status >= 500 && !err.status ? '上游服务请求失败' : err.message));
  }
}

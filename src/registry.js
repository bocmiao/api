import { Router } from './lib/router.js';
import { categories, modules } from './apis/index.js';
import { HttpError } from './lib/http.js';
import { config } from './config.js';

export const apiRouter = new Router();
for (const mod of modules) {
  for (const r of mod.routes) apiRouter.add(r.method, r.path, r.handler, { route: r, module: mod });
}

const envStatus = (env = []) => env.map((e) => {
  const { name, optional = false } = typeof e === 'string' ? { name: e } : e;
  return { name, optional, configured: Boolean(process.env[name]) };
});

export function catalog() {
  return {
    auth: { registrationOpen: config.registrationOpen, emailVerify: config.emailVerify },
    limits: { anonDaily: config.limits.anonDaily, userDaily: config.limits.userDaily, anonMinute: config.limits.anonMinute, userMinute: config.limits.userMinute },
    categories: categories.map((c) => ({ ...c, count: modules.filter((m) => m.category === c.id).length })),
    modules: modules.map((m) => {
      const env = envStatus(m.env);
      return {
        name: m.name,
        category: m.category,
        title: m.title,
        description: m.description ?? '',
        source: m.source ?? null,
        unofficial: Boolean(m.unofficial),
        env,
        available: m.isAvailable ? Boolean(m.isAvailable()) : env.every((e) => e.optional || e.configured),
        routes: m.routes.map(({ method, path, summary, params = [], raw = false, fields = [], returns = null }) => ({ method, path, summary, params, raw, fields, returns })),
      };
    }),
  };
}

// 供推送等内部功能直接调用接口（不走限流）
export async function invoke(path, query = {}) {
  const hit = apiRouter.match('GET', path);
  if (!hit?.route) throw new HttpError(404, `接口不存在：${path}`);
  const res = await hit.route.handler({ query: new URLSearchParams(query), params: hit.params, ip: '127.0.0.1', user: null, req: { headers: {} } });
  return res?.data;
}

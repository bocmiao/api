// 缓存预热：定时在后台调用最近 24 小时里最常用的、不需要参数的接口，
// 让它们的缓存一直是热的，访客调用时直接命中缓存，不用等上游。
// 服务重启（包括在线更新）后内存缓存会清空，启动后也会先预热一轮。
import { sql } from '../db.js';
import { apiRouter, invoke } from '../registry.js';
import { isModuleEnabled } from './modules.js';

const INTERVAL_MS = 3 * 60_000;
const TOP_N = 30;
const CONCURRENCY = 4;
// 结果取决于调用者、会产生数据或消耗第三方额度的模块，不预热
const SKIP_MODULES = new Set(['ip', 'visitor', 'ipcard', 'captcha', 'crawl', 'probe', 'batch-check', 'ip-reputation']);

// 可以预热的：GET、不是图片等原始输出、路径里没有参数、没有必填参数、调用了外部数据源（source 不是「本地…」「本站」）
export function warmable(path) {
  const hit = apiRouter.match('GET', path);
  if (!hit?.route || hit.methodNotAllowed || Object.keys(hit.params ?? {}).length) return false;
  const { route, module } = hit.route;
  if (route.raw || module.suspended || !module.source || /^本(地|站)/.test(module.source) || SKIP_MODULES.has(module.name)) return false;
  if ((route.params ?? []).some((p) => p.required && p.in !== 'body')) return false;
  return isModuleEnabled(module.name);
}

export function hotPaths(limit = TOP_N) {
  const rows = sql(`SELECT path, COUNT(*) AS n FROM request_log WHERE ts >= ? AND status < 500
                    GROUP BY path ORDER BY n DESC LIMIT ?`).all(Date.now() - 86400_000, limit * 3);
  return rows.map((r) => r.path).filter(warmable).slice(0, limit);
}

export async function prewarmOnce() {
  const queue = hotPaths();
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) await invoke(p).catch(() => {});
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

export function startPrewarm() {
  setTimeout(() => prewarmOnce().catch(() => {}), 10_000).unref();
  setInterval(() => prewarmOnce().catch(() => {}), INTERVAL_MS).unref();
}

// 接口注册表：把「代码里的接口 + 后台文案覆盖 + 后台新增的声明式接口」合并成一份运行时快照。
// 快照可重建（后台发布后立即生效，不用重启）；构建新快照成功后才原子替换，
// 在途请求仍然持有旧的 route 对象，不会因为发布被打断。
import { db, sql } from './db.js';
import { Router } from './lib/router.js';
import { categories, modules, coreModules } from './apis/index.js';
import { community } from './lib/seo.js';
import { HttpError } from './lib/http.js';
import { config } from './config.js';
import { isModuleEnabled, moduleOptions } from './lib/modules.js';
import { routeTtl } from './lib/routecache.js';
import { moduleSourceInfo } from './lib/api-sources.js';
import { applyMeta, loadAllPatches } from './lib/api-meta.js';
import { loadCustomModules } from './lib/custom-api.js';

export const apiRouter = new Router();

let rev = 0;
let activeEditRev = -1;
let sourceByName = new Map();
const listeners = new Set();

export const registryRev = () => rev;
export const getModules = () => modules;
export const getCategories = () => categories;
// 未套用文案覆盖的原始模块（后台详情用来对比"代码默认值"）
export const sourceModule = (name) => sourceByName.get(name) ?? null;
export const sourceModules = () => [...sourceByName.values()];
export const onRegistryChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

function assertUnique(list) {
  const names = new Set();
  const paths = new Map();
  for (const mod of list) {
    if (names.has(mod.name)) throw new HttpError(500, `接口模块重名：${mod.name}`);
    names.add(mod.name);
    for (const route of mod.routes ?? []) {
      const key = `${route.method} ${route.path}`;
      if (paths.has(key)) throw new HttpError(500, `接口地址重复：${key}（${paths.get(key)} / ${mod.name}）`);
      paths.set(key, mod.name);
    }
  }
}

function build(list) {
  const next = new Router();
  for (const mod of list) {
    for (const route of mod.routes) next.add(route.method, route.path, route.handler, { route, module: mod });
  }
  return next;
}

// extra：测试或调用方可以临时注入模块；默认从数据库加载后台新增的接口
function prepareRegistry({ reason = 'manual', extra = null, strict = false } = {}) {
  const custom = extra ?? loadCustomModules({ strict });
  const originals = [...coreModules, ...custom];
  assertUnique(originals);
  const patches = loadAllPatches();
  const merged = originals.map((mod) => applyMeta(mod, patches.get(mod.name) ?? new Map()));
  const next = build(merged);
  return { merged, next, originals, reason };
}

function activateRegistry({ merged, next, originals, reason }) {
  // 原地更新：所有 import 了 modules / apiRouter 的模块（SEO、统计、后台）都不需要改引用
  modules.splice(0, modules.length, ...merged);
  apiRouter.routes = next.routes;
  sourceByName = new Map(originals.map((mod) => [mod.name, mod]));
  rev += 1;
  activeEditRev = workbenchRev();
  for (const fn of listeners) {
    try { fn({ rev, modules: merged, reason }); } catch (err) { console.error('[registry] 通知失败：', err.message); }
  }
  return { rev, modules: merged, source: sourceByName };
}

export function rebuildRegistry(options = {}) {
  return activateRegistry(prepareRegistry(options));
}

export const workbenchRev = () => sql('SELECT rev FROM api_workbench_state WHERE id = 1').get().rev;

// 在一个同步 SQLite 事务中校验编辑版本、保存/审计并预构建 registry。
// 构建或提交失败时 DB 和旧快照均保持原样；提交后只做不会执行用户代码的引用替换。
export function mutateWorkbench(expectedRev, mutate, { reason = 'workbench', rebuild = true } = {}) {
  db.exec('SAVEPOINT workbench_edit');
  let result, next, editRev;
  try {
    if (!Number.isSafeInteger(expectedRev) || expectedRev !== workbenchRev()) throw new HttpError(409, '接口内容已变化，请刷新后重新确认；本次修改未保存');
    // expectedRev 与本进程快照必须来自同一已提交版本，避免跨进程刷新窗口。
    refreshRegistry();
    result = mutate();
    if (result?.then) throw new Error('工作台事务必须同步完成');
    sql('UPDATE api_workbench_state SET rev = rev + 1 WHERE id = 1').run();
    next = rebuild ? prepareRegistry({ reason, strict: true }) : null;
    editRev = workbenchRev();
    db.exec('RELEASE workbench_edit');
  } catch (err) {
    db.exec('ROLLBACK TO workbench_edit');
    db.exec('RELEASE workbench_edit');
    if (/database (?:is )?(?:locked|busy)/i.test(err?.message ?? '')) throw new HttpError(409, '其他操作正在保存，请刷新后重新确认；本次修改未保存');
    throw err;
  }
  const snapshot = next ? activateRegistry(next) : { rev };
  if (!next) activeEditRev = editRev;
  return { ...result, rev: snapshot.rev, editRev };
}

// 其他进程提交后，下一次 HTTP 请求先同步目录；在途请求继续持有原 route。
export function refreshRegistry() {
  if (workbenchRev() !== activeEditRev) rebuildRegistry({ reason: 'database-change' });
}

// 后台的编辑内容与 editRev 在同一个 SQLite 读快照中返回，不能混用旧内容和新版本号。
export function readWorkbench(read) {
  db.exec('SAVEPOINT workbench_read');
  try {
    refreshRegistry();
    const result = read();
    if (result?.then) throw new Error('工作台读取必须同步完成');
    db.exec('RELEASE workbench_read');
    return result;
  } catch (err) {
    db.exec('ROLLBACK TO workbench_read');
    db.exec('RELEASE workbench_read');
    throw err;
  }
}

rebuildRegistry({ reason: 'boot' });

const envStatus = (env = []) => env.map((e) => {
  const { name, optional = false } = typeof e === 'string' ? { name: e } : e;
  return { name, optional, configured: Boolean(process.env[name]) };
});

// includeDisabled：管理员可见被关闭的模块（带 enabled: false）
export function catalog({ includeDisabled = false } = {}) {
  return {
    auth: { registrationOpen: config.registrationOpen, emailVerify: config.emailVerify },
    community: community(),
    limits: { anonDaily: config.limits.anonDaily, userDaily: config.limits.userDaily, anonMinute: config.limits.anonMinute, userMinute: config.limits.userMinute },
    categories: categories.map((c) => ({ ...c, count: modules.filter((m) => m.category === c.id && (includeDisabled || isModuleEnabled(m.name))).length })),
    modules: modules.filter((m) => includeDisabled || isModuleEnabled(m.name)).map((m) => {
      const env = envStatus(m.env);
      return {
        name: m.name,
        category: m.category,
        title: m.title,
        description: m.description ?? '',
        source: m.source ?? null,
        // 后台新增的接口自带来源说明；核心接口查审计表
        sourceInfo: m.sourceInfo ?? moduleSourceInfo(m.name),
        unofficial: Boolean(m.unofficial),
        origin: m.origin ?? 'core',
        custom: Boolean(m.custom),
        overrides: (m.metaApplied ?? []).length,
        env,
        enabled: isModuleEnabled(m.name),
        available: m.isAvailable ? Boolean(m.isAvailable()) : env.every((e) => e.optional || e.configured),
        suspended: m.suspended ?? null,
        // 后台设置的置顶 / 推荐：首页排在前面、卡片上显示「推荐」
        pinned: moduleOptions(m.name).pinned,
        featured: moduleOptions(m.name).featured,
        // cacheTtl：实际调用时记录到的缓存时长（毫秒），0 为实时获取，null 为还没有调用记录
        routes: m.routes.map(({ method, path, summary, params = [], raw = false, fields = [], returns = null }) => ({ method, path, summary, params, raw, fields, returns, cacheTtl: routeTtl(path) })),
      };
    }),
  };
}

// 供推送等内部功能直接调用接口（不走限流）
export async function invoke(path, query = {}) {
  const hit = apiRouter.match('GET', path);
  if (!hit?.route) throw new HttpError(404, `接口不存在：${path}`);
  if (!isModuleEnabled(hit.route.module.name)) throw new HttpError(403, `接口已被管理员关闭：${path}`);
  if (hit.route.module.suspended) throw new HttpError(503, `该接口暂不可用：${hit.route.module.suspended}`);
  const res = await hit.route.handler({ query: new URLSearchParams(query), params: hit.params, ip: '127.0.0.1', user: null, req: { headers: {} } });
  return res?.data;
}

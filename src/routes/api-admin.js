// 接口工作台的接口：列表、文案编辑、体检、试跑，以及后台新增声明式接口的草稿/发布/回滚。
// 路由挂在 accountRouter 上（同源 + JSON + CSRF 检查），由 app.js 在 account.js 之后加载。
import { sql } from '../db.js';
import { HttpError } from '../lib/http.js';
import { accountRouter, requireAdmin } from './account.js';
import {
  apiRouter, registryRev, getModules, mutateWorkbench, workbenchRev, readWorkbench, sourceModule, sourceModules,
} from '../registry.js';
import {
  loadPatch, metaTargets, saveMeta, metaDoctor, shapeHash, targetRev,
} from '../lib/api-meta.js';
import {
  listCustomApis, getCustomApi, customVersions, saveCustomDraft, publishCustomApi,
  rollbackCustomApi, removeCustomApi, parseConfig, buildModule, assertNoConflict,
} from '../lib/custom-api.js';
import { isModuleSwitchedOn, isModuleHidden, setModuleHidden, moduleOptions } from '../lib/modules.js';
import { complianceBlocks, COMPLIANCE_MODULES } from '../lib/compliance.js';
import { audit, requireReason } from '../lib/audit.js';
import { cacheScope, clearModuleCache } from '../lib/cache.js';
import { moduleSourceInfo } from '../lib/api-sources.js';
import { trafficSql as statsSql } from '../lib/traffic.js';

const r = (method, path, handler) => accountRouter.add(method, path, method === 'GET' ? (ctx) => { requireAdmin(ctx); return readWorkbench(() => handler(ctx)); } : handler);
const DAY = 86400_000;

function callsMap() {
  const since = Date.now() - 7 * DAY;
  const rows = new Map(statsSql('SELECT path, COUNT(*) AS n FROM request_log WHERE ts >= ? GROUP BY path').all(since).map((x) => [x.path, x.n]));
  return rows;
}
function calls7d(mod, rows = callsMap()) {
  return mod.routes.reduce((n, route) => n + (rows.get(route.path) ?? 0), 0);
}

function latestHealth() {
  const ts = sql('SELECT MAX(ts) AS ts FROM health_checks').get()?.ts;
  if (!ts) return new Map();
  return new Map(sql('SELECT module, ok, status, ms, error FROM health_checks WHERE ts = ?').all(ts).map((row) => [row.module, row]));
}

function trialRequiresConfirmation(mod, route) {
  const profile = mod.custom ? null : moduleSourceInfo(mod.name);
  return mod.custom || route.method !== 'GET' || profile?.network !== 'none' || !['local-compute', 'local-data'].includes(profile.kind) || mod.name === 'shorturl';
}

// ---------- 列表 ----------

r('GET', '/admin/apis', (ctx) => {
  requireAdmin(ctx);
  const health = latestHealth();
  const calls = callsMap();
  const drafts = new Map(listCustomApis().map((row) => [row.name, row]));
  const doctor = metaDoctor(sourceModules());
  const liveRows = getModules().map((mod) => {
    const custom = drafts.get(mod.name) ?? null;
    return {
      name: mod.name,
      title: mod.title,
      category: mod.category,
      origin: mod.origin ?? 'core',
      custom: Boolean(mod.custom),
      description: mod.description ?? '',
      source: mod.source ?? null,
      sourceInfo: mod.sourceInfo ?? null,
      routes: mod.routes.map((route) => ({ method: route.method, path: route.path, summary: route.summary ?? '' })),
      enabled: isModuleSwitchedOn(mod.name), hidden: isModuleHidden(mod.name),
      compliance: complianceBlocks(mod.name) ? COMPLIANCE_MODULES[mod.name] : null,
      overrides: (mod.metaApplied ?? []).length,
      calls7d: calls7d(mod, calls),
      health: health.get(mod.name) ?? null,
      customDraft: custom?.status === 'draft',
      version: custom?.version ?? null,
    };
  });
  // 只有草稿、还没发布过的接口也要出现在列表里，否则保存草稿后就找不到了
  const liveNames = new Set(liveRows.map((m) => m.name));
  const draftRows = [];
  for (const row of drafts.values()) {
    if (liveNames.has(row.name)) continue;
    const cfg = row.draft ?? row.config;
    if (!cfg) continue;
    draftRows.push({
      name: row.name,
      title: cfg.title,
      category: cfg.category,
      origin: 'custom',
      custom: true,
      description: cfg.description ?? '',
      source: cfg.source ?? null,
      sourceInfo: cfg.sourceInfo ?? null,
      routes: cfg.routes.map((r) => ({ method: r.method, path: r.path, summary: r.summary ?? '' })),
      enabled: true, hidden: isModuleHidden(row.name),
      compliance: null,
      overrides: 0,
      calls7d: 0,
      health: null,
      customDraft: true,
      version: row.version,
    });
  }
  return {
    data: {
      rev: registryRev(), editRev: workbenchRev(),
      modules: [...liveRows, ...draftRows],
      doctor: { ok: doctor.ok, counts: doctor.counts, issues: doctor.issues.slice(0, 50) },
      custom: listCustomApis().map((row) => ({ name: row.name, status: row.status, version: row.version, updatedAt: row.updatedAt, publishedAt: row.publishedAt })),
    },
  };
});

// ---------- 体检 ----------
// 必须注册在 /admin/apis/:name 之前，否则 "doctor" 会被当成模块名

r('GET', '/admin/apis/doctor', (ctx) => {
  requireAdmin(ctx);
  return { data: metaDoctor(sourceModules()) };
});

// ---------- 详情 ----------

r('GET', '/admin/apis/:name', (ctx) => {
  requireAdmin(ctx);
  let mod = getModules().find((m) => m.name === ctx.params.name);
  if (!mod) {
    // 还没发布的草稿也能打开详情继续编辑
    const row = getCustomApi(ctx.params.name);
    const cfg = row?.draft ?? row?.config;
    if (!cfg) throw new HttpError(404, '接口不存在');
    try { mod = buildModule(parseConfig(cfg)); } catch { throw new HttpError(404, '接口不存在'); }
  }
  const src = sourceModule(mod.name) ?? mod;
  const patch = loadPatch(mod.name);
  const custom = getCustomApi(mod.name);
  const trial = custom?.draft ? buildModule(parseConfig(custom.draft)) : mod;
  const last = sql('SELECT ts, ok, status, ms, error FROM health_checks WHERE module = ? ORDER BY ts DESC LIMIT 1').get(mod.name);
  return {
    data: {
      rev: registryRev(), editRev: workbenchRev(),
      module: {
        name: mod.name,
        title: mod.title,
        description: mod.description ?? '',
        category: mod.category,
        origin: mod.origin ?? 'core',
        custom: Boolean(mod.custom),
        source: mod.source ?? null,
        sourceInfo: mod.sourceInfo ?? null,
        routes: mod.routes.map((route) => ({
          method: route.method, path: route.path, summary: route.summary ?? '',
          params: route.params ?? [], fields: route.fields ?? [], returns: route.returns ?? null, raw: Boolean(route.raw),
        })),
        enabled: isModuleSwitchedOn(mod.name), hidden: isModuleHidden(mod.name),
        compliance: complianceBlocks(mod.name) ? COMPLIANCE_MODULES[mod.name] : null,
        options: moduleOptions(mod.name),
        calls7d: calls7d(mod),
        health: last ?? null,
      },
      trialRoutes: trial.routes.map((route) => ({ method: route.method, path: route.path, summary: route.summary, params: route.params ?? [], requiresConfirmation: trialRequiresConfirmation(trial, route) })),
      code: { title: src.title, description: src.description ?? '' },
      shapeHash: shapeHash(src),
      targets: metaTargets(src, patch).map((t) => ({ ...t, currentRev: targetRev(src, t.target) })),
      custom: custom ? {
        status: custom.status,
        version: custom.version,
        publishedAt: custom.publishedAt,
        publishedBy: custom.publishedBy,
        config: custom.config,
        draft: custom.draft,
        versions: customVersions(custom.name),
      } : null,
    },
  };
});

// 隐藏只影响公开目录和文档；不改变调用开关、Key 范围或路由。
r('PUT', '/admin/apis/:name/visibility', (ctx) => {
  requireAdmin(ctx);
  const { hidden, expectedRev } = ctx.body ?? {};
  if (typeof hidden !== 'boolean') throw new HttpError(400, 'hidden 须为 true 或 false');
  const name = ctx.params.name;
  const saved = mutateWorkbench(expectedRev, () => {
    if (!sourceModule(name) && !getCustomApi(name)) throw new HttpError(404, '接口不存在');
    const before = isModuleHidden(name);
    setModuleHidden(name, hidden);
    audit(ctx, 'api.visibility.save', { target: name, detail: { before, hidden } });
    return { name, hidden };
  }, { reason: `visibility:${name}`, rebuild: false });
  return { data: saved };
});

// ---------- 保存文案 ----------
// body: { changes: [{ target, value }], reset: [target] }

r('PUT', '/admin/apis/:name/meta', (ctx) => {
  requireAdmin(ctx);
  const name = ctx.params.name;
  const { changes = [], reset = [] } = ctx.body ?? {};
  if (!Array.isArray(changes) || !Array.isArray(reset)) throw new HttpError(400, 'changes / reset 必须是数组');
  if (changes.length + reset.length > 200) throw new HttpError(400, '一次最多修改 200 项');
  const saved = mutateWorkbench(ctx.body?.expectedRev, () => {
    const src = sourceModule(name);
    if (!src) throw new HttpError(404, '接口不存在');
    const before = loadPatch(src.name);
    const result = saveMeta(src, { changes, reset }, ctx.user?.email ?? null);
    for (const target of [...result.applied, ...result.cleared]) {
      audit(ctx, 'api.meta.save', { target: src.name, detail: { target, before: before.get(target)?.value ?? null, after: loadPatch(src.name).get(target)?.value ?? null } });
    }
    return result;
  }, { reason: `meta:${name}` });
  clearModuleCache(name);
  return { data: saved };
});

// 清理某个接口的全部文案补丁（接口已删除时体检里的一键清理）
r('DELETE', '/admin/apis/:name/meta', (ctx) => {
  requireAdmin(ctx);
  const saved = mutateWorkbench(ctx.body?.expectedRev, () => {
    const rows = loadPatch(ctx.params.name);
    const result = sql('DELETE FROM api_meta WHERE name = ?').run(ctx.params.name);
    for (const [target, row] of rows) audit(ctx, 'api.meta.clear', { target: ctx.params.name, detail: { target, before: row.value, after: null } });
    return { cleared: result.changes };
  }, { reason: `meta-clear:${ctx.params.name}` });
  clearModuleCache(ctx.params.name);
  return { data: saved };
});

// ---------- 试跑 ----------
// body: { path, query, body }；直接调用处理函数，不计额度、不写调用日志

r('POST', '/admin/apis/:name/try', async (ctx) => {
  requireAdmin(ctx);
  let mod = getModules().find((m) => m.name === ctx.params.name);
  if (mod?.custom) {
    const row = getCustomApi(ctx.params.name);
    if (row?.draft) mod = buildModule(parseConfig(row.draft));
  }
  if (!mod) {
    // 草稿也能试跑，发布前先确认上游结构
    const row = getCustomApi(ctx.params.name);
    const cfg = row?.draft ?? row?.config;
    if (!cfg) throw new HttpError(404, '接口不存在');
    mod = buildModule(parseConfig(cfg));
  }
  if (!isModuleSwitchedOn(mod.name) || complianceBlocks(mod.name) || mod.suspended) throw new HttpError(403, '接口已关闭、合规停用或暂停，不能试跑');
  const path = String(ctx.body?.path ?? '');
  const route = mod.routes.find((x) => x.path === path);
  if (!route) throw new HttpError(400, '这个接口下没有该地址');
  if (trialRequiresConfirmation(mod, route)) {
    if (ctx.body?.confirmExternal !== true) throw new HttpError(400, '该试跑可能访问外部服务或产生副作用，请确认并填写原因');
    const reason = requireReason(ctx.body);
    audit(ctx, 'api.try.external', { target: mod.name, detail: { path, method: route.method, draft: Boolean(getCustomApi(mod.name)?.draft) }, reason });
  }
  const query = ctx.body?.query && typeof ctx.body.query === 'object' ? ctx.body.query : {};
  const input = { query: new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v ?? '')])), params: {}, body: ctx.body?.body ?? null, trial: true, signal: ctx.signal, ip: '127.0.0.1', user: null, req: { headers: {} }, charge: () => {} };
  try {
    const res = await cacheScope.run({ ttlOverride: 0, keys: new Set() }, () => route.handler(input));
    return { data: { ok: true, data: res?.data ?? res ?? null, meta: { cached: res?.cached ?? null, stale: res?.stale ?? null, updatedAt: res?.updatedAt ?? null } } };
  } catch (err) {
    return { data: { ok: false, error: { status: err?.status ?? 500, message: err?.message ?? String(err) } } };
  }
});

// ---------- 自定义接口 ----------

r('GET', '/admin/custom-apis', (ctx) => {
  requireAdmin(ctx);
  return { data: { items: listCustomApis(), editRev: workbenchRev() } };
});

// body: { config }；只做校验并返回预览，不落库
r('POST', '/admin/custom-apis/validate', (ctx) => {
  requireAdmin(ctx);
  const config = parseConfig(ctx.body?.config);
  const mod = buildModule(config);
  return {
    data: {
      ok: true,
      config,
      preview: {
        name: mod.name,
        title: mod.title,
        category: mod.category,
        source: mod.source,
        sourceInfo: mod.sourceInfo,
        routes: mod.routes.map((r2) => ({ method: r2.method, path: r2.path, summary: r2.summary, params: r2.params, fields: r2.fields })),
      },
      warnings: conflicts(config),
    },
  };
});

function conflicts(config) {
  try { assertNoConflict(config); return []; } catch (err) { return [err.message]; }
}

// body: { config }
r('POST', '/admin/custom-apis', (ctx) => {
  requireAdmin(ctx);
  const saved = mutateWorkbench(ctx.body?.expectedRev, () => {
    const row = saveCustomDraft(ctx.body?.config, { by: ctx.user?.email ?? null, createOnly: true });
    audit(ctx, 'api.custom.draft', { target: row.name });
    return row;
  }, { rebuild: false });
  return { data: saved };
});

// body: { config }
r('PUT', '/admin/custom-apis/:name', (ctx) => {
  requireAdmin(ctx);
  const config = ctx.body?.config;
  if (String(config?.name ?? '') !== ctx.params.name) throw new HttpError(400, '配置里的 name 不能修改');
  const saved = mutateWorkbench(ctx.body?.expectedRev, () => {
    if (!getCustomApi(ctx.params.name)) throw new HttpError(404, '接口不存在');
    const row = saveCustomDraft(config, { by: ctx.user?.email ?? null });
    audit(ctx, 'api.custom.draft', { target: row.name });
    return row;
  }, { rebuild: false });
  return { data: saved };
});

// body: { reason, note? }
r('POST', '/admin/custom-apis/:name/publish', (ctx) => {
  requireAdmin(ctx);
  const reason = requireReason(ctx.body);
  const note = String(ctx.body?.note ?? '').slice(0, 200) || null;
  const saved = mutateWorkbench(ctx.body?.expectedRev, () => {
    if (ctx.body?.config !== undefined) {
      if (ctx.body.config?.name !== ctx.params.name) throw new HttpError(400, '配置里的 name 不能修改');
      if (!getCustomApi(ctx.params.name)) throw new HttpError(404, '接口不存在');
      saveCustomDraft(ctx.body.config, { by: ctx.user?.email ?? null });
    }
    const row = publishCustomApi(ctx.params.name, { by: ctx.user?.email ?? null, note });
    audit(ctx, 'api.custom.publish', { target: ctx.params.name, detail: { version: row.version }, reason });
    return row;
  }, { reason: `publish:${ctx.params.name}` });
  clearModuleCache(ctx.params.name);
  return { data: saved };
});

// body: { reason, version }
r('POST', '/admin/custom-apis/:name/rollback', (ctx) => {
  requireAdmin(ctx);
  const reason = requireReason(ctx.body);
  const version = Number(ctx.body?.version);
  if (!Number.isInteger(version)) throw new HttpError(400, 'version 必须是整数');
  const saved = mutateWorkbench(ctx.body?.expectedRev, () => {
    const row = rollbackCustomApi(ctx.params.name, version, { by: ctx.user?.email ?? null });
    audit(ctx, 'api.custom.rollback', { target: ctx.params.name, detail: { version }, reason });
    return row;
  }, { reason: `rollback:${ctx.params.name}` });
  clearModuleCache(ctx.params.name);
  return { data: saved };
});

r('GET', '/admin/custom-apis/:name/versions', (ctx) => {
  requireAdmin(ctx);
  if (!getCustomApi(ctx.params.name)) throw new HttpError(404, '接口不存在');
  return { data: { items: customVersions(ctx.params.name) } };
});

// 放弃未发布的草稿
r('POST', '/admin/custom-apis/:name/discard', (ctx) => {  requireAdmin(ctx);
  const saved = mutateWorkbench(ctx.body?.expectedRev, () => {
    const row = getCustomApi(ctx.params.name);
    if (!row) throw new HttpError(404, '接口不存在');
    if (!row.config) { removeCustomApi(ctx.params.name); }
    else sql("UPDATE custom_apis SET draft = NULL, status = 'published', updated_at = ? WHERE name = ?").run(Date.now(), ctx.params.name);
    audit(ctx, 'api.custom.discard', { target: ctx.params.name });
    return { name: ctx.params.name, deleted: !row.config };
  }, { rebuild: false });
  return { data: saved };
});

// body: { reason }
r('DELETE', '/admin/custom-apis/:name', (ctx) => {
  requireAdmin(ctx);
  const reason = requireReason(ctx.body);
  const saved = mutateWorkbench(ctx.body?.expectedRev, () => {
    const row = removeCustomApi(ctx.params.name);
    sql('DELETE FROM api_meta WHERE name = ?').run(ctx.params.name);
    sql('UPDATE module_settings SET hidden = 0 WHERE name = ?').run(ctx.params.name);
    audit(ctx, 'api.custom.delete', { target: ctx.params.name, reason });
    return row;
  }, { reason: `delete:${ctx.params.name}` });
  clearModuleCache(ctx.params.name);
  return { data: saved };
});

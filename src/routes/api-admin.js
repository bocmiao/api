// 接口工作台的接口：列表、文案编辑、体检、试跑，以及后台新增声明式接口的草稿/发布/回滚。
// 路由挂在 accountRouter 上（同源 + JSON + CSRF 检查），由 app.js 在 account.js 之后加载。
import { sql } from '../db.js';
import { HttpError } from '../lib/http.js';
import { accountRouter, requireAdmin } from './account.js';
import {
  apiRouter, registryRev, getModules, rebuildRegistry, sourceModule, sourceModules,
} from '../registry.js';
import {
  loadPatch, metaTargets, saveMeta, metaDoctor, shapeHash, targetRev,
} from '../lib/api-meta.js';
import {
  listCustomApis, getCustomApi, customVersions, saveCustomDraft, publishCustomApi,
  rollbackCustomApi, removeCustomApi, parseConfig, buildModule, assertNoConflict,
} from '../lib/custom-api.js';
import { isModuleSwitchedOn, moduleOptions } from '../lib/modules.js';
import { complianceBlocks, COMPLIANCE_MODULES } from '../lib/compliance.js';
import { audit, requireReason } from '../lib/audit.js';
import { clearModuleCache } from '../lib/cache.js';
import { trafficSql as statsSql } from '../lib/traffic.js';

const r = (method, path, handler) => accountRouter.add(method, path, handler);
const DAY = 86400_000;

function calls7d(mod) {
  const since = Date.now() - 7 * DAY;
  const rows = new Map(statsSql('SELECT path, COUNT(*) AS n FROM request_log WHERE ts >= ? GROUP BY path').all(since).map((x) => [x.path, x.n]));
  return mod.routes.reduce((n, route) => n + (rows.get(route.path) ?? 0), 0);
}

function latestHealth() {
  const ts = sql('SELECT MAX(ts) AS ts FROM health_checks').get()?.ts;
  if (!ts) return new Map();
  return new Map(sql('SELECT module, ok, status, ms, error FROM health_checks WHERE ts = ?').all(ts).map((row) => [row.module, row]));
}

// ---------- 列表 ----------

r('GET', '/admin/apis', (ctx) => {
  requireAdmin(ctx);
  const health = latestHealth();
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
      enabled: isModuleSwitchedOn(mod.name),
      compliance: complianceBlocks(mod.name) ? COMPLIANCE_MODULES[mod.name] : null,
      overrides: (mod.metaApplied ?? []).length,
      calls7d: calls7d(mod),
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
      enabled: true,
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
      rev: registryRev(),
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
  const last = sql('SELECT ts, ok, status, ms, error FROM health_checks WHERE module = ? ORDER BY ts DESC LIMIT 1').get(mod.name);
  return {
    data: {
      rev: registryRev(),
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
        enabled: isModuleSwitchedOn(mod.name),
        compliance: complianceBlocks(mod.name) ? COMPLIANCE_MODULES[mod.name] : null,
        options: moduleOptions(mod.name),
        calls7d: calls7d(mod),
        health: last ?? null,
      },
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

// ---------- 保存文案 ----------
// body: { changes: [{ target, value }], reset: [target] }

r('PUT', '/admin/apis/:name/meta', (ctx) => {
  requireAdmin(ctx);
  const src = sourceModule(ctx.params.name);
  if (!src) throw new HttpError(404, '接口不存在');
  const { changes = [], reset = [] } = ctx.body ?? {};
  if (!Array.isArray(changes) || !Array.isArray(reset)) throw new HttpError(400, 'changes / reset 必须是数组');
  if (changes.length + reset.length > 200) throw new HttpError(400, '一次最多修改 200 项');
  const result = saveMeta(src, { changes, reset }, ctx.user?.email ?? null);
  const { rev } = rebuildRegistry({ reason: `meta:${src.name}` });
  clearModuleCache(src.name);
  audit(ctx, 'api.meta.save', { target: src.name, detail: { applied: result.applied, cleared: result.cleared, rev } });
  return { data: { ...result, rev } };
});

// ---------- 试跑 ----------
// body: { path, query, body }；直接调用处理函数，不计额度、不写调用日志

r('POST', '/admin/apis/:name/try', async (ctx) => {
  requireAdmin(ctx);
  let mod = getModules().find((m) => m.name === ctx.params.name);
  if (!mod) {
    // 草稿也能试跑，发布前先确认上游结构
    const row = getCustomApi(ctx.params.name);
    const cfg = row?.draft ?? row?.config;
    if (!cfg) throw new HttpError(404, '接口不存在');
    mod = buildModule(parseConfig(cfg));
  }
  const path = String(ctx.body?.path ?? '');
  const route = mod.routes.find((x) => x.path === path);
  if (!route) throw new HttpError(400, '这个接口下没有该地址');
  const query = ctx.body?.query && typeof ctx.body.query === 'object' ? ctx.body.query : {};
  const input = { query: new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v ?? '')])), params: {}, body: ctx.body?.body ?? null, ip: '127.0.0.1', user: null, req: { headers: {} }, charge: () => {} };
  try {
    const res = await route.handler(input);
    return { data: { ok: true, data: res?.data ?? res ?? null, meta: { cached: res?.cached ?? null, stale: res?.stale ?? null, updatedAt: res?.updatedAt ?? null } } };
  } catch (err) {
    return { data: { ok: false, error: { status: err?.status ?? 500, message: err?.message ?? String(err) } } };
  }
});

// ---------- 自定义接口 ----------

r('GET', '/admin/custom-apis', (ctx) => {
  requireAdmin(ctx);
  return { data: { items: listCustomApis() } };
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
  const saved = saveCustomDraft(ctx.body?.config, { by: ctx.user?.email ?? null });
  audit(ctx, 'api.custom.draft', { target: saved.name });
  return { data: saved };
});

// body: { config }
r('PUT', '/admin/custom-apis/:name', (ctx) => {
  requireAdmin(ctx);
  const config = ctx.body?.config;
  if (String(config?.name ?? '') !== ctx.params.name) throw new HttpError(400, '配置里的 name 不能修改');
  const saved = saveCustomDraft(config, { by: ctx.user?.email ?? null });
  audit(ctx, 'api.custom.draft', { target: saved.name });
  return { data: saved };
});

// body: { reason, note? }
r('POST', '/admin/custom-apis/:name/publish', (ctx) => {
  requireAdmin(ctx);
  const reason = requireReason(ctx.body);
  const note = String(ctx.body?.note ?? '').slice(0, 200) || null;
  const saved = publishCustomApi(ctx.params.name, { by: ctx.user?.email ?? null, note });
  const { rev } = rebuildRegistry({ reason: `publish:${ctx.params.name}` });
  clearModuleCache(ctx.params.name);
  audit(ctx, 'api.custom.publish', { target: ctx.params.name, detail: { version: saved.version, rev }, reason });
  return { data: { ...saved, rev } };
});

// body: { reason, version }
r('POST', '/admin/custom-apis/:name/rollback', (ctx) => {
  requireAdmin(ctx);
  const reason = requireReason(ctx.body);
  const version = Number(ctx.body?.version);
  if (!Number.isInteger(version)) throw new HttpError(400, 'version 必须是整数');
  const saved = rollbackCustomApi(ctx.params.name, version, { by: ctx.user?.email ?? null });
  const { rev } = rebuildRegistry({ reason: `rollback:${ctx.params.name}` });
  clearModuleCache(ctx.params.name);
  audit(ctx, 'api.custom.rollback', { target: ctx.params.name, detail: { version, rev }, reason });
  return { data: { ...saved, rev } };
});

r('GET', '/admin/custom-apis/:name/versions', (ctx) => {
  requireAdmin(ctx);
  if (!getCustomApi(ctx.params.name)) throw new HttpError(404, '接口不存在');
  return { data: { items: customVersions(ctx.params.name) } };
});

// 放弃未发布的草稿
r('POST', '/admin/custom-apis/:name/discard', (ctx) => {  requireAdmin(ctx);
  const row = getCustomApi(ctx.params.name);
  if (!row) throw new HttpError(404, '接口不存在');
  sql("UPDATE custom_apis SET draft = NULL, status = CASE WHEN config IS NULL THEN 'draft' ELSE 'published' END, updated_at = ? WHERE name = ?").run(Date.now(), ctx.params.name);
  audit(ctx, 'api.custom.discard', { target: ctx.params.name });
  return { data: { name: ctx.params.name, status: getCustomApi(ctx.params.name)?.status ?? 'draft' } };
});

// body: { reason }
r('DELETE', '/admin/custom-apis/:name', (ctx) => {
  requireAdmin(ctx);
  const reason = requireReason(ctx.body);
  const removed = removeCustomApi(ctx.params.name);
  const { rev } = rebuildRegistry({ reason: `delete:${ctx.params.name}` });
  clearModuleCache(ctx.params.name);
  audit(ctx, 'api.custom.delete', { target: ctx.params.name, detail: { rev }, reason });
  return { data: { ...removed, rev } };
});

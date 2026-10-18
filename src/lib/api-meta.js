// 接口文案覆盖层。
// 规则：代码里的接口定义（参数、字段、类型、必填、枚举）是唯一权威，这里只保存管理员改过的"说法"。
// - 一行 = 一个补丁，删掉一行即恢复代码默认值，不会出现"字段没文档"；
// - 合并函数只写 title / description / summary / desc / example，结构字段没有写入口；
// - 每条补丁记录写给自己结构指纹（base_rev），代码结构变了就进体检清单，而不是静默套用旧文案。
import { createHash } from 'node:crypto';
import { sql, db } from '../db.js';
import { HttpError } from './http.js';

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;const ATTR_LIMITS = { title: 60, description: 300, summary: 120, desc: 300, example: 200 };
const MODULE_ATTRS = new Set(['title', 'description']);
const ROUTE_ATTRS = new Set(['summary']);
const PARAM_ATTRS = new Set(['desc', 'example']);
const FIELD_ATTRS = new Set(['desc']);

export const META_LIMITS = ATTR_LIMITS;

const hash = (value) => createHash('sha1').update(JSON.stringify(value)).digest('hex');

// 模块结构快照：只包含"形状"，不包含任何可编辑的文字
export function shapeOf(mod) {
  return {
    name: mod.name,
    category: mod.category,
    env: (mod.env ?? []).map((e) => (typeof e === 'string' ? { name: e, optional: false } : { name: e.name, optional: Boolean(e.optional) })),
    routes: (mod.routes ?? []).map((r) => ({
      method: r.method,
      path: r.path,
      raw: Boolean(r.raw),
      params: (r.params ?? []).map((p) => [p.name, Boolean(p.required), p.in ?? 'query', p.type ?? null, Boolean(p.int), p.min ?? null, p.max ?? null, p.oneOf ?? null, p.default ?? null]),
      fields: (r.fields ?? []).map((f) => [f.name, f.type ?? null]),
    })),
  };
}

export const shapeHash = (mod) => hash(shapeOf(mod));

// 文案目标：module|title、route|<path>|summary、param|<path>|<name>|desc、field|<path>|<name>|desc
export function parseTarget(target) {
  const parts = String(target ?? '').split('|');
  const [kind, ...rest] = parts;
  if (kind === 'module' && rest.length === 1 && MODULE_ATTRS.has(rest[0])) return { kind, attr: rest[0] };
  if (kind === 'route' && rest.length === 2 && ROUTE_ATTRS.has(rest[1]) && rest[0]) return { kind, path: rest[0], attr: rest[1] };
  if (kind === 'param' && rest.length === 3 && PARAM_ATTRS.has(rest[2]) && rest[0] && rest[1]) return { kind, path: rest[0], name: rest[1], attr: rest[2] };
  if (kind === 'field' && rest.length === 3 && FIELD_ATTRS.has(rest[2]) && rest[0] && rest[1]) return { kind, path: rest[0], name: rest[1], attr: rest[2] };
  throw new HttpError(400, `无效的文案目标：${target}`);
}

// 在"代码原始模块"里定位一个文案目标；不存在时返回 null（调用方据此判断孤儿补丁）
export function findTarget(mod, target) {
  const t = parseTarget(target);
  if (t.kind === 'module') {
    const code = t.attr === 'title' ? mod.title : (mod.description ?? '');
    return { value: code ?? '', limit: ATTR_LIMITS[t.attr], required: t.attr === 'title' };
  }
  const route = (mod.routes ?? []).find((r) => r.path === t.path);
  if (!route) return null;
  if (t.kind === 'route') return { value: route.summary ?? '', limit: ATTR_LIMITS.summary };
  if (t.kind === 'param') {
    const p = (route.params ?? []).find((x) => x.name === t.name);
    if (!p) return null;
    if (t.attr === 'desc') return { value: p.desc ?? '', limit: ATTR_LIMITS.desc };
    return { value: p.example == null ? '' : String(p.example), limit: ATTR_LIMITS.example, param: p };
  }
  const f = (route.fields ?? []).find((x) => x.name === t.name);
  if (!f) return null;
  return { value: f.desc ?? '', limit: ATTR_LIMITS.desc };
}

// 同一个目标自己的结构指纹：只和这个目标的形状有关，别的接口改动不会让它过期
export function targetRev(mod, target) {
  const t = parseTarget(target);
  if (t.kind === 'module') return hash(['module', mod.name, mod.category, mod.routes?.map((r) => r.path) ?? []]);
  const route = (mod.routes ?? []).find((r) => r.path === t.path);
  if (!route) return '';
  if (t.kind === 'route') return hash(['route', route.method, route.path, route.raw ?? false, (route.params ?? []).map((p) => p.name), (route.fields ?? []).map((f) => f.name)]);
  if (t.kind === 'param') {
    const p = (route.params ?? []).find((x) => x.name === t.name);
    if (!p) return '';
    return hash(['param', route.path, p.name, p.required ?? false, p.in ?? 'query', p.type ?? null, p.int ?? null, p.min ?? null, p.max ?? null, p.oneOf ?? null]);
  }
  const f = (route.fields ?? []).find((x) => x.name === t.name);
  return f ? hash(['field', route.path, f.name, f.type ?? null]) : '';
}

function checkExample(param, value) {
  if (value === '') return;
  if (param.oneOf && !param.oneOf.includes(value)) throw new HttpError(400, `示例「${value}」不在可选值里：${param.oneOf.join(' / ')}`);
  if (param.int) {
    const n = Number(value);
    if (!Number.isInteger(n)) throw new HttpError(400, '这个参数是整数，示例也必须是整数');
    if (param.min != null && n < param.min) throw new HttpError(400, `示例不能小于 ${param.min}`);
    if (param.max != null && n > param.max) throw new HttpError(400, `示例不能大于 ${param.max}`);
    return;
  }
  if (param.pattern) {
    const re = param.pattern instanceof RegExp ? param.pattern : new RegExp(param.pattern);
    if (!re.test(value)) throw new HttpError(400, `示例不符合参数格式：${re}`);
  }
  if (param.max != null && String(value).length > param.max) throw new HttpError(400, `示例过长（最多 ${param.max} 个字符）`);
}

function checkValue(mod, target, value) {
  const def = findTarget(mod, target);
  if (!def) throw new HttpError(400, `代码里已经没有这个字段了：${target}`);
  if (def.required && !value) throw new HttpError(400, '接口名称不能为空');
  if (value.length > def.limit) throw new HttpError(400, `最多 ${def.limit} 个字`);
  if (CONTROL_RE.test(value)) throw new HttpError(400, '不能包含控制字符');
  if (def.param) checkExample(def.param, value);
  return value;
}

export function loadPatch(name) {
  const map = new Map();
  for (const row of sql('SELECT target, value, base_rev, rev, updated_by, updated_at FROM api_meta WHERE name = ?').all(name)) {
    map.set(row.target, { value: row.value, baseRev: row.base_rev, rev: row.rev, updatedBy: row.updated_by, updatedAt: row.updated_at });
  }
  return map;
}

export function loadAllPatches() {
  const out = new Map();
  for (const row of sql('SELECT name, target, value, base_rev, rev, updated_by, updated_at FROM api_meta').all()) {
    let map = out.get(row.name);
    if (!map) out.set(row.name, (map = new Map()));
    map.set(row.target, { value: row.value, baseRev: row.base_rev, rev: row.rev, updatedBy: row.updated_by, updatedAt: row.updated_at });
  }
  return out;
}

// 合并：只覆盖文字，返回值里带 metaApplied / metaOrphans 供后台展示
export function applyMeta(mod, patch = loadPatch(mod.name)) {
  const used = new Set();
  const take = (target, fallback) => {
    const hit = patch.get(target);
    if (!hit) return fallback;
    used.add(target);
    return hit.value;
  };
  const out = {
    ...mod,
    title: take('module|title', mod.title),
    description: take('module|description', mod.description ?? ''),
  };
  out.routes = (mod.routes ?? []).map((route) => ({
    ...route,
    summary: take(`route|${route.path}|summary`, route.summary),
    params: (route.params ?? []).map((p) => ({
      ...p,
      desc: take(`param|${route.path}|${p.name}|desc`, p.desc ?? ''),
      example: take(`param|${route.path}|${p.name}|example`, p.example),
    })),
    fields: (route.fields ?? []).map((f) => ({ ...f, desc: take(`field|${route.path}|${f.name}|desc`, f.desc ?? '') })),
  }));
  out.metaApplied = [...used];
  out.metaOrphans = [...patch.keys()].filter((target) => !used.has(target));
  return out;
}

// 后台详情：列出所有可编辑文字，以及代码默认值和当前覆盖值
export function metaTargets(mod, patch = loadPatch(mod.name)) {
  const list = [];
  const push = (target, label, extra = {}) => {
    let def;
    try { def = findTarget(mod, target); } catch { return; }
    if (!def) return;
    const hit = patch.get(target);
    list.push({
      target, label, ...extra,
      code: def.value, value: hit ? hit.value : def.value,
      overridden: Boolean(hit), limit: def.limit,
      baseRev: hit?.baseRev ?? null, currentRev: targetRev(mod, target),
      stale: Boolean(hit?.baseRev && hit.baseRev !== targetRev(mod, target)),
      updatedAt: hit?.updatedAt ?? null, updatedBy: hit?.updatedBy ?? null,
    });
  };
  push('module|title', '接口名称');
  push('module|description', '接口描述');
  for (const route of mod.routes ?? []) {
    push(`route|${route.path}|summary`, '接口说明', { path: route.path });
    for (const p of route.params ?? []) {
      push(`param|${route.path}|${p.name}|desc`, `参数说明 · ${p.name}`, { path: route.path, name: p.name });
      push(`param|${route.path}|${p.name}|example`, `参数示例 · ${p.name}`, { path: route.path, name: p.name });
    }
    for (const f of route.fields ?? []) push(`field|${route.path}|${f.name}|desc`, `字段说明 · ${f.name}`, { path: route.path, name: f.name });
  }
  return list;
}

// 保存/还原。changes: [{ target, value }]；reset: [target]。返回本次实际写入的目标。
export function saveMeta(mod, { changes = [], reset = [] } = {}, by = null) {
  if (!Array.isArray(changes) || !Array.isArray(reset)) throw new HttpError(400, 'changes / reset 必须是数组');
  const applied = [];
  const cleared = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const change of changes) {
      const target = String(change?.target ?? '');
      const value = String(change?.value ?? '').trim();
      checkValue(mod, target, value);
      sql(`INSERT INTO api_meta (name, target, value, base_rev, rev, updated_by, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(name, target) DO UPDATE SET value = excluded.value, base_rev = excluded.base_rev,
             rev = api_meta.rev + 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(mod.name, target, value, targetRev(mod, target), by, Date.now());
      applied.push(target);
    }
    for (const raw of reset) {
      const target = String(raw ?? '');
      parseTarget(target);
      sql('DELETE FROM api_meta WHERE name = ? AND target = ?').run(mod.name, target);
      cleared.push(target);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { applied, cleared };
}

// 体检：孤儿（代码里已没有）、过期（结构变过）、无效（超长等）、模块已删除
export function metaDoctor(modules = []) {
  const patches = loadAllPatches();
  const byName = new Map(modules.map((m) => [m.name, m]));
  const issues = [];
  for (const [name, patch] of patches) {
    const mod = byName.get(name);
    if (!mod) {
      for (const [target, row] of patch) issues.push({ name, target, kind: 'module-missing', value: row.value });
      continue;
    }
    for (const [target, row] of patch) {
      let def;
      try { def = findTarget(mod, target); } catch { issues.push({ name, target, kind: 'invalid-target', value: row.value }); continue; }
      if (!def) { issues.push({ name, target, kind: 'orphan', value: row.value }); continue; }
      if (row.baseRev && row.baseRev !== targetRev(mod, target)) { issues.push({ name, target, kind: 'stale', value: row.value }); continue; }
      if (row.value.length > def.limit || (def.required && !row.value) || CONTROL_RE.test(row.value)) issues.push({ name, target, kind: 'invalid', value: row.value });
    }
  }
  const counts = issues.reduce((acc, i) => ((acc[i.kind] = (acc[i.kind] ?? 0) + 1), acc), {});
  return { ok: issues.length === 0, issues, counts };
}

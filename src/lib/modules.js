// 接口模块的开放状态（管理员可在后台关闭指定模块）。只记录被改过的模块，未记录的默认开放。
import { sql } from '../db.js';
import { complianceBlocks } from './compliance.js';

let disabled = null;

function load() {
  if (!disabled) disabled = new Set(sql('SELECT name FROM module_settings WHERE enabled = 0').all().map((r) => r.name));
  return disabled;
}

// 备案合规模式打开时，列在 compliance.js 里的模块一律视为关闭
export const isModuleEnabled = (name) => !load().has(name) && !complianceBlocks(name);
export const isModuleSwitchedOn = (name) => !load().has(name);
export const disabledModules = () => [...load()];

export function setModulesEnabled(names, enabled) {
  const stmt = sql(`INSERT INTO module_settings (name, enabled, updated_at) VALUES (?, ?, datetime('now'))
                    ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`);
  for (const n of names) stmt.run(n, enabled ? 1 : 0);
  disabled = null;
}

// ---------- 接口运行参数（后台可改）：置顶、推荐、缓存时长、每分钟限流 ----------
let options = null;
const loadOptions = () => (options ??= new Map(sql('SELECT * FROM module_options').all().map((r) => [r.name, {
  pinned: Boolean(r.pinned), featured: Boolean(r.featured), cacheTtlMs: r.cache_ttl_ms, minuteLimit: r.minute_limit,
}])));
const EMPTY = Object.freeze({ pinned: false, featured: false, cacheTtlMs: null, minuteLimit: null });
export const moduleOptions = (name) => loadOptions().get(name) ?? EMPTY;
export const allModuleOptions = () => Object.fromEntries(loadOptions());

export function setModuleOptions(name, { pinned, featured, cacheTtlMs, minuteLimit }) {
  const cur = moduleOptions(name);
  const v = {
    pinned: pinned === undefined ? cur.pinned : Boolean(pinned),
    featured: featured === undefined ? cur.featured : Boolean(featured),
    cacheTtlMs: cacheTtlMs === undefined ? cur.cacheTtlMs : cacheTtlMs,
    minuteLimit: minuteLimit === undefined ? cur.minuteLimit : minuteLimit,
  };
  sql(`INSERT INTO module_options (name, pinned, featured, cache_ttl_ms, minute_limit, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET pinned = excluded.pinned, featured = excluded.featured, cache_ttl_ms = excluded.cache_ttl_ms,
       minute_limit = excluded.minute_limit, updated_at = excluded.updated_at`)
    .run(name, Number(v.pinned), Number(v.featured), v.cacheTtlMs, v.minuteLimit, Date.now());
  options = null;
  return moduleOptions(name);
}

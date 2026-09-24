// 接口模块的开放状态（管理员可在后台关闭指定模块）。只记录被改过的模块，未记录的默认开放。
import { sql } from '../db.js';

let disabled = null;

function load() {
  if (!disabled) disabled = new Set(sql('SELECT name FROM module_settings WHERE enabled = 0').all().map((r) => r.name));
  return disabled;
}

export const isModuleEnabled = (name) => !load().has(name);
export const disabledModules = () => [...load()];

export function setModulesEnabled(names, enabled) {
  const stmt = sql(`INSERT INTO module_settings (name, enabled, updated_at) VALUES (?, ?, datetime('now'))
                    ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`);
  for (const n of names) stmt.run(n, enabled ? 1 : 0);
  disabled = null;
}

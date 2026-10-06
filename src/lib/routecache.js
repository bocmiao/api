// 每个接口地址实际使用的缓存时长（毫秒，0 表示不缓存），由调用时自动记录，文档页显示给开发者看
import { sql } from '../db.js';

let ttls = null;
const load = () => (ttls ??= new Map(sql('SELECT path, ttl_ms FROM route_cache').all().map((r) => [r.path, r.ttl_ms])));

// 只在调用成功时记录；同一地址取见过的最长缓存（个别参数不走缓存时不覆盖）
export function noteRouteTtl(path, ttl) {
  const map = load();
  const prev = map.get(path);
  const v = Math.max(0, Math.round(ttl ?? 0));
  if (prev !== undefined && prev >= v) return;
  map.set(path, v);
  sql(`INSERT INTO route_cache (path, ttl_ms, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET ttl_ms = excluded.ttl_ms, updated_at = excluded.updated_at`).run(path, v, Date.now());
}

export const routeTtl = (path) => load().get(path) ?? null;

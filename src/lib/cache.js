// 简单的内存 TTL 缓存。上游失败时可以取回过期数据兜底。
// maxEntries 限制条数：缓存键可能来自用户输入（如网址），不能无限增长
import { AsyncLocalStorage } from 'node:async_hooks';

const MAX_STALE_MS = 6 * 3600_000;

// 记录一次接口调用里用到的缓存时长：app.js 用 cacheScope.run({}, ...) 包住接口处理函数，
// wrap 被调用时把 TTL 写进去，文档页据此显示「缓存约 N 分钟」，不用给每个接口手写
export const cacheScope = new AsyncLocalStorage();

export class TTLCache {
  constructor({ maxEntries = 5000 } = {}) {
    this.maxEntries = maxEntries;
    this.store = new Map();
    this.pending = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    const now = Date.now();
    // 过期不久（不超过一个 TTL，最多 6 小时）的数据仍可先返回，同时在后台刷新
    const revalidate = entry.expiresAt <= now && now - entry.expiresAt < Math.min(entry.ttlMs, MAX_STALE_MS);
    return { value: entry.value, fresh: entry.expiresAt > now, revalidate, updatedAt: entry.updatedAt };
  }

  set(key, value, ttlMs) {
    const now = Date.now();
    this.store.delete(key); // 重新插入，保持 Map 顺序为写入先后
    this.store.set(key, { value, ttlMs, expiresAt: now + ttlMs, updatedAt: new Date(now).toISOString() });
    if (this.store.size > this.maxEntries) this.evict(now);
  }

  // 先删过期的；仍超出上限时从最早写入的开始删
  evict(now) {
    for (const [k, e] of this.store) if (e.expiresAt <= now) this.store.delete(k);
    for (const k of this.store.keys()) {
      if (this.store.size <= this.maxEntries) break;
      this.store.delete(k);
    }
  }

  // 命中新鲜缓存直接返回；刚过期的先返回旧数据、后台刷新（stale-while-revalidate）；
  // 否则调用 loader（同 key 并发请求合并为一次）；loader 失败但有旧数据时返回旧数据并标记 stale。
  async wrap(key, ttlMs, loader) {
    const scope = cacheScope.getStore();
    if (scope) {
      // 后台给这个接口单独设置了缓存时长时以后台为准（0 表示不缓存，每次实时获取）
      if (scope.ttlOverride != null) ttlMs = scope.ttlOverride;
      scope.ttl = Math.max(scope.ttl ?? 0, ttlMs);
      // 记下用到的缓存键，后台「清除该接口缓存」时按键删除
      if (scope.keys && scope.keys.size < 50) scope.keys.add(key);
    }
    if (scope?.ttlOverride === 0) {
      const data = await loader();
      return { data, cached: false, updatedAt: new Date().toISOString() };
    }
    const hit = this.get(key);
    if (hit?.fresh) return { data: hit.value, cached: true, updatedAt: hit.updatedAt };
    if (hit?.revalidate) {
      this.load(key, ttlMs, loader).catch(() => {});
      return { data: hit.value, cached: true, updatedAt: hit.updatedAt };
    }

    try {
      const data = await this.load(key, ttlMs, loader);
      return { data, cached: false, updatedAt: this.get(key).updatedAt };
    } catch (err) {
      if (hit) return { data: hit.value, cached: true, stale: true, updatedAt: hit.updatedAt };
      throw err;
    }
  }

  // 同一个 key 同时只有一个 loader 在跑
  load(key, ttlMs, loader) {
    if (!this.pending.has(key)) {
      const p = (async () => {
        const value = await loader();
        this.set(key, value, ttlMs);
        return value;
      })().finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return this.pending.get(key);
  }
}

export const cache = new TTLCache();

// 每个接口用到过的缓存键（最多各 500 个），用于按接口清除缓存
const routeKeys = new Map();
export function noteRouteKeys(module, keys) {
  if (!keys?.size) return;
  let set = routeKeys.get(module);
  if (!set) routeKeys.set(module, (set = new Set()));
  for (const k of keys) {
    if (set.size >= 500) set.delete(set.values().next().value);
    set.add(k);
  }
}
export function clearModuleCache(module) {
  const set = routeKeys.get(module);
  let n = 0;
  for (const k of set ?? []) if (cache.store.delete(k)) n++;
  routeKeys.delete(module);
  return n;
}

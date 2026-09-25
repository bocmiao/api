// 简单的内存 TTL 缓存。上游失败时可以取回过期数据兜底。
// maxEntries 限制条数：缓存键可能来自用户输入（如网址），不能无限增长
const MAX_STALE_MS = 6 * 3600_000;

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

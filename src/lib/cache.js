// 简单的内存 TTL 缓存。上游失败时可以取回过期数据兜底。
// maxEntries 限制条数：缓存键可能来自用户输入（如网址），不能无限增长
export class TTLCache {
  constructor({ maxEntries = 5000 } = {}) {
    this.maxEntries = maxEntries;
    this.store = new Map();
    this.pending = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    return { value: entry.value, fresh: entry.expiresAt > Date.now(), updatedAt: entry.updatedAt };
  }

  set(key, value, ttlMs) {
    const now = Date.now();
    this.store.delete(key); // 重新插入，保持 Map 顺序为写入先后
    this.store.set(key, { value, expiresAt: now + ttlMs, updatedAt: new Date(now).toISOString() });
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

  // 命中新鲜缓存直接返回；否则调用 loader（同 key 并发请求合并为一次）；
  // loader 失败但有旧数据时返回旧数据并标记 stale。
  async wrap(key, ttlMs, loader) {
    const hit = this.get(key);
    if (hit?.fresh) return { data: hit.value, cached: true, updatedAt: hit.updatedAt };

    if (!this.pending.has(key)) {
      const p = (async () => {
        const value = await loader();
        this.set(key, value, ttlMs);
        return value;
      })().finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }

    try {
      const data = await this.pending.get(key);
      return { data, cached: false, updatedAt: this.get(key).updatedAt };
    } catch (err) {
      if (hit) return { data: hit.value, cached: true, stale: true, updatedAt: hit.updatedAt };
      throw err;
    }
  }
}

export const cache = new TTLCache();

// 简单的内存 TTL 缓存。上游失败时可以取回过期数据兜底。
export class TTLCache {
  constructor() {
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
    this.store.set(key, { value, expiresAt: now + ttlMs, updatedAt: new Date(now).toISOString() });
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

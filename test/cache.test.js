import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TTLCache } from '../src/lib/cache.js';

test('并发请求合并为一次上游调用', async () => {
  const c = new TTLCache();
  let calls = 0;
  const loader = async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return 'v'; };
  const results = await Promise.all([c.wrap('k', 1000, loader), c.wrap('k', 1000, loader)]);
  assert.equal(calls, 1);
  assert.deepEqual(results.map((r) => r.data), ['v', 'v']);
});

test('缓存过期后上游失败，返回旧数据并标记 stale', async () => {
  const c = new TTLCache();
  await c.wrap('k', -1, async () => 'old');
  const res = await c.wrap('k', 1000, async () => { throw new Error('down'); });
  assert.equal(res.data, 'old');
  assert.equal(res.stale, true);
});

test('无旧数据时上游失败抛出错误', async () => {
  const c = new TTLCache();
  await assert.rejects(c.wrap('k', 1000, async () => { throw new Error('down'); }), /down/);
});

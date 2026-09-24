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

test('超过条数上限时淘汰最早写入的', () => {
  const c = new TTLCache({ maxEntries: 3 });
  for (const k of ['a', 'b', 'c', 'd']) c.set(k, k, 60_000);
  assert.equal(c.get('a'), undefined);
  assert.equal(c.get('d').value, 'd');
  assert.equal(c.store.size, 3);
});

test('发件人：地址始终使用登录账号，只取 SMTP_FROM 的显示名称', async () => {
  const { senderOf } = await import('../src/notify/smtp.js');
  assert.deepEqual(senderOf('Miao API <noreply@miao.club>', 'i@miao.club'), { envelope: 'i@miao.club', header: 'Miao API <i@miao.club>' });
  assert.deepEqual(senderOf('Miao API', 'i@miao.club'), { envelope: 'i@miao.club', header: 'Miao API <i@miao.club>' });
  assert.deepEqual(senderOf('', 'i@miao.club'), { envelope: 'i@miao.club', header: 'i@miao.club' });
  assert.deepEqual(senderOf('other@miao.club', 'i@miao.club'), { envelope: 'i@miao.club', header: 'i@miao.club' });
  assert.equal(senderOf('喵喵 API', 'i@miao.club').header, '=?UTF-8?B?5Za15Za1IEFQSQ==?= <i@miao.club>');
});

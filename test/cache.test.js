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

test('刚过期的数据先返回、后台刷新；过期太久则等待新数据', async () => {
  const c = new TTLCache();
  await c.wrap('k', 1000, async () => 'old');
  c.store.get('k').expiresAt = Date.now() - 500; // 过期 0.5 秒（TTL 1 秒以内）
  let resolve;
  const slow = new Promise((r) => { resolve = r; });
  const t0 = Date.now();
  const res = await c.wrap('k', 1000, () => slow);
  assert.equal(res.data, 'old');
  assert.equal(res.cached, true);
  assert.ok(Date.now() - t0 < 50, '不等待上游');
  resolve('new');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await c.wrap('k', 1000, async () => 'x')).data, 'new', '后台刷新后换成新数据');

  c.store.get('k').expiresAt = Date.now() - 5000; // 过期超过一个 TTL
  assert.equal((await c.wrap('k', 1000, async () => 'fresh')).data, 'fresh');
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

test('过期兜底默认最多6小时，允许显式保留长期历史策略', async()=>{
 const c=new TTLCache();c.set('old','old',1000);c.store.get('old').expiresAt=Date.now()-7*3600_000;
 const down=()=>Promise.reject(Error('synthetic down'));
 await assert.rejects(c.wrap('old',1000,down),/synthetic down/);
 assert.equal((await c.wrap('old',1000,down,{maxStaleMs:Infinity})).stale,true);
 await assert.rejects(c.wrap('old',1000,down,{maxStaleMs:0}),/synthetic down/);
});

test('清除在途缓存后旧loader不能回填或删除新pending',async()=>{
 const c=new TTLCache();let oldResolve,newResolve;
 const old=c.wrap('k',1000,()=>new Promise(r=>oldResolve=r));c.delete('k');
 const fresh=c.wrap('k',1000,()=>new Promise(r=>newResolve=r));
 oldResolve('old');assert.equal((await old).data,'old');assert.equal(c.get('k'),undefined);assert.equal(c.pending.size,1);
 newResolve('new');assert.equal((await fresh).data,'new');assert.equal(c.get('k').value,'new');
});

test('一个等待者取消不终止共享loader，不返回stale；监听清理，已取消不启动loader',async()=>{
 const c=new TTLCache(),controller=new AbortController();let resolve,calls=0;
 const loader=()=>{calls++;return new Promise(r=>resolve=r);};
 const cancelled=c.wrap('k',1000,loader,{signal:controller.signal});const other=c.wrap('k',1000,loader);
 controller.abort();await assert.rejects(cancelled,e=>e.name==='AbortError');resolve('value');assert.equal((await other).data,'value');assert.equal(calls,1);
 await assert.rejects(c.wrap('new',1000,loader,{signal:controller.signal}),e=>e.name==='AbortError');assert.equal(calls,1);
});

test('模块清除覆盖首次请求的在途key，无需等handler完成',async()=>{
 const {cache,cacheScope,clearModuleCache}=await import('../src/lib/cache.js');let resolve;
 const pending=cacheScope.run({module:'synthetic-clear',keys:new Set()},()=>cache.wrap('first-inflight',1000,()=>new Promise(r=>resolve=r)));
 clearModuleCache('synthetic-clear');resolve('old');await pending;assert.equal(cache.get('first-inflight'),undefined);
});

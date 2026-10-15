import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { db, sql } from '../src/db.js';
import { logRequest, pruneLogs, today } from '../src/lib/limits.js';
import { createSession, generateApiKey } from '../src/lib/auth.js';
import { handle } from '../src/app.js';
import { apiRouter, invoke } from '../src/registry.js';
import { HttpError } from '../src/lib/http.js';
import { flushStats } from '../src/lib/stats.js';

const admin = Number(sql("INSERT INTO users(email,password_hash,is_admin) VALUES ('admin@calls.test','unused',1)").run().lastInsertRowid);
const user = Number(sql("INSERT INTO users(email,password_hash) VALUES ('user@calls.test','unused')").run().lastInsertRowid);
const other = Number(sql("INSERT INTO users(email,password_hash) VALUES ('other@calls.test','unused')").run().lastInsertRowid);
const adminSid = createSession(admin), userSid = createSession(user);
const escapedErrors = [];
const server = createServer((req, res) => {
  handle(req, res).catch(err => { escapedErrors.push(err); if (!res.headersSent) res.writeHead(599); res.end(); });
}).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());
async function details(id, day = today(), sid = adminSid) {
  const res = await fetch(`${base}/admin/users/${id}/calls?day=${encodeURIComponent(day)}`, { headers: sid ? { cookie: `sid=${sid}` } : {} });
  return { status: res.status, data: (await res.json()).data, headers: res.headers };
}
const insert = (id, ts, path, status = 200, key = null) => sql('INSERT INTO request_log(ts,user_id,key_id,path,status,ms) VALUES (?,?,?,?,?,1)').run(ts,id,key,path,status);

test('管理员鉴权优先，真实日期和 ID 校验，白名单和 no-store', async () => {
  assert.equal((await details(user, 'bad', '')).status, 401);
  assert.equal((await details(user, 'bad', userSid)).status, 403);
  for (const day of ['2025-02-29','2024-02-30','2024-13-01','0000-01-01','2024-2-01',"2024-01-01' OR 1=1"]) assert.equal((await details(user, day)).status, 400);
  for (const id of ['0','-1','1.5','1e1','9007199254740992']) assert.equal((await details(id)).status,400);
  assert.equal((await details(99999)).status,404);
  const r = await details(user,'2024-02-29');
  assert.equal(r.status,200);
  assert.equal(r.headers.get('cache-control'),'no-store');
  assert.deepEqual(Object.keys(r.data.user),['id','email']);
  assert.equal(r.data.coverage,'partial');
  assert.equal((await details(user)).data.coverage,'partial');
  assert.equal((await details(user,today(new Date(Date.now()+86400_000)))).data.coverage,'complete');
});

test('多 Key 与 session 合并、北京时间日界线、闰日、全接口不截断、原子回滚及清理后保留', async () => {
  const edge = Date.parse('2024-02-28T16:00:00Z');
  insert(user,edge-1,'/api/before');
  insert(user,edge,'/api/a',200,11); insert(user,edge+1,'/api/a',302,12);
  insert(user,edge+2,'/api/a',403); insert(user,edge+3,'/api/a',503);
  for (const status of [404,405,429]) insert(user,edge+4,'/api/a',status);
  insert(other,edge,'/api/a'); insert(null,edge,'/api/a');
  for (let i=0;i<20;i++) insert(user,edge,`/api/route${i}`);
  db.exec('BEGIN'); insert(user,edge,'/api/rollback'); db.exec('ROLLBACK');
  let d = (await details(user,'2024-02-29')).data;
  assert.equal(d.items.length,21);
  assert.deepEqual(d.totals,{ calls:24,ok:22,e4xx:1,e5xx:1 });
  assert.deepEqual(d.items.find(x=>x.path==='/api/a'),{path:'/api/a',calls:4,ok:2,e4xx:1,e5xx:1});
  assert.equal((await details(user,'2024-02-28')).data.totals.calls,1);
  pruneLogs();
  assert.deepEqual((await details(user,'2024-02-29')).data,d);
  const future = today(new Date(Date.now()+2*86400_000));
  assert.equal((await details(user,future)).data.coverage,'complete');
  assert.equal((await details(user,future)).data.totals.calls,0);
});

test('真实入口：缓存 / 批量 HTTP 一次、5xx 退额度、已识别 Key 403、429 与无效 Key 不计调用', async () => {
  const makeKey = name => {
    const k = generateApiKey();
    sql('INSERT INTO api_keys(user_id,name,prefix,key_hash) VALUES (?,?,?,?)').run(user,name,k.prefix,k.hash);
    return k.key;
  };
  const key1 = makeKey('one'), key2 = makeKey('two');
  const module = { name:'calls-test' };
  const add = (path,handler,extra={}) => {
    const route={path,handler,...extra}; apiRouter.add('GET',path,handler,{ route,module });
  };
  add('/api/calls-test/:id',()=>({data:null,cached:true}));
  add('/api/calls-batch',ctx=>{ ctx.charge(2); return {data:null}; });
  add('/api/calls-fail',()=>{throw new HttpError(503,'synthetic');});
  add('/api/calls-public',()=>({data:null}),{public:true});
  const call=async(path,key=key1,method='GET')=>(await fetch(base+path,{method,headers:{'x-api-key':key}})).status;
  const before=(await details(user)).data.totals.calls;
  assert.equal(await call('/api/calls-test/one'),200);
  assert.equal(await call('/api/calls-test/two',key2),200);
  assert.equal((await fetch(base+'/api/calls-test/session',{headers:{cookie:`sid=${userSid}`}})).status,200);
  assert.equal(await call('/api/calls-batch'),200);
  const used=sql('SELECT count FROM usage_daily WHERE subject=? AND day=?').get(`user:${user}`,today()).count;
  assert.equal(used,6);
  assert.equal(await call('/api/calls-fail'),503);
  assert.equal(sql('SELECT count FROM usage_daily WHERE subject=? AND day=?').get(`user:${user}`,today()).count,used);
  sql('UPDATE api_keys SET disabled=1 WHERE user_id=?').run(user);
  assert.equal(await call('/api/calls-test/denied'),403);
  sql('UPDATE api_keys SET disabled=0 WHERE user_id=?').run(user);
  sql('UPDATE users SET daily_limit=0 WHERE id=?').run(user);
  assert.equal(await call('/api/calls-test/limited'),429);
  assert.equal(await call('/api/calls-test/invalid','invalid'),401);
  assert.equal(await call('/api/calls-public'),200);
  assert.equal(await call('/api/unknown'),404);
  assert.equal(await call('/api/calls-test/one',key1,'POST'),405);
  assert.equal(await call('/api/calls-test/one',key1,'OPTIONS'),204);
  const reset = generateApiKey();
  sql('UPDATE api_keys SET key_hash=?, prefix=? WHERE user_id=? AND name=?').run(reset.hash,reset.prefix,user,'one');
  assert.equal(await call('/api/calls-test/reset-old',key1),401);
  await invoke('/api/calls-test/internal');
  assert.equal((await fetch(base+'/api/calls-test/anonymous')).status,200);
  const d=(await details(user)).data;
  assert.equal(d.totals.calls-before,6);
  assert.equal(d.items.find(x=>x.path==='/api/calls-test/:id').calls,4);
  flushStats();
  assert.equal(sql('SELECT count FROM stats_limited WHERE subject=?').get(`user:${user}`).count,1);
  sql('DELETE FROM api_keys WHERE user_id=?').run(user);
  assert.deepEqual((await details(user)).data,d);
});

test('统一日志入口使用完成时间归日；汇总失败同时回滚原始日志', () => {
  const edge = Date.parse('2024-02-29T16:00:00Z');
  const row = { user: { id: user }, ip: '127.0.0.1', path: '/api/completion', status: 200, ms: 1000 };
  const clock = mock.method(Date, 'now', () => edge - 1);
  try {
    logRequest(row);
    clock.mock.mockImplementation(() => edge);
    logRequest(row);
  } finally { clock.mock.restore(); }
  assert.equal(sql("SELECT calls FROM user_calls_daily WHERE user_id=? AND path=? AND day='2024-02-29'").get(user,row.path).calls,1);
  assert.equal(sql("SELECT calls FROM user_calls_daily WHERE user_id=? AND path=? AND day='2024-03-01'").get(user,row.path).calls,1);
  db.exec(`CREATE TRIGGER reject_summary BEFORE INSERT ON user_calls_daily WHEN NEW.path = '/api/reject' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
  try {
    assert.throws(() => logRequest({ ...row, path: '/api/reject' }), /synthetic failure/);
    assert.equal(sql("SELECT COUNT(*) AS n FROM request_log WHERE path='/api/reject'").get().n,0);
  } finally { db.exec('DROP TRIGGER reject_summary'); }
});

test('HTTP 入口汇总故障只写一次、不逃出、不误退成功额度，并仍发送原业务失败', async () => {
  const route = (path, handler) => apiRouter.add('GET', path, handler, { route: { path, handler }, module: { name: 'summary-failure' } });
  route('/api/summary-success', () => ({ data: null }));
  route('/api/summary-error', () => { throw new HttpError(503, 'synthetic upstream failure'); });
  db.exec(`CREATE TRIGGER reject_http_summary BEFORE INSERT ON user_calls_daily
    WHEN NEW.path LIKE '/api/summary-%' BEGIN SELECT RAISE(ABORT, 'synthetic summary failure'); END`);
  const errorLog = mock.method(console, 'error', () => {});
  const before = sql('SELECT count FROM usage_daily WHERE day=? AND subject=?').get(today(), `user:${other}`)?.count ?? 0;
  const sid = createSession(other);
  try {
    for (const [path, expected] of [['/api/summary-success', 200], ['/api/summary-error', 503]]) {
      const res = await fetch(base + path, { headers: { cookie: `sid=${sid}` } });
      assert.equal(res.status, expected);
      assert.equal((await res.json()).code, expected);
    }
    assert.equal(sql('SELECT count FROM usage_daily WHERE day=? AND subject=?').get(today(), `user:${other}`).count, before + 1);
    assert.equal(sql("SELECT COUNT(*) AS n FROM request_log WHERE path LIKE '/api/summary-%'").get().n, 0);
    assert.equal(sql("SELECT COUNT(*) AS n FROM user_calls_daily WHERE path LIKE '/api/summary-%'").get().n, 0);
    assert.equal(errorLog.mock.calls.filter(c => c.arguments[0] === '[request_log] 写入失败').length, 2);
    assert.deepEqual(escapedErrors, []);
  } finally { db.exec('DROP TRIGGER reject_http_summary'); errorLog.mock.restore(); }
});

test('注销最高 ID 后再注册不复用账号 ID、不继承原账号调用历史', async () => {
  const register = async email => {
    const res = await fetch(base + '/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'synthetic-password123' }) });
    assert.equal(res.status, 200);
    return { user: (await res.json()).data, cookie: res.headers.get('set-cookie').split(';')[0] };
  };
  const retired = await register('retired@calls.test');
  insert(retired.user.id, Date.now(), '/api/retired-private');
  const deleted = await fetch(base + '/account', { method: 'DELETE', headers: { cookie: retired.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'synthetic-password123' }) });
  assert.equal(deleted.status, 200);
  const fresh = await register('fresh@calls.test');
  assert.ok(fresh.user.id > retired.user.id);
  assert.equal((await details(fresh.user.id)).data.totals.calls, 0);
  assert.equal(sql('SELECT calls FROM user_calls_daily WHERE user_id=? AND path=?').get(retired.user.id, '/api/retired-private').calls, 1);
});

test('持久数据库首次事务回填，重启迁移幂等，清理原日志后汇总不丢', () => {
  const dir=mkdtempSync(join(tmpdir(),'miao-user-calls-migration-'));
  const file=join(dir,'fixture.db');
  const run=code=>{
    const r=spawnSync(process.execPath,['--input-type=module','-e',code],{cwd:process.cwd(),env:{...process.env,DB_FILE:file},encoding:'utf8'});
    assert.equal(r.status,0,r.stderr); return r.stdout.trim();
  };
  try {
    run(`import {db} from './src/db.js'; db.exec('DROP TRIGGER user_calls_log_insert; DROP TABLE user_calls_daily; DROP TABLE user_calls_meta'); db.prepare('INSERT INTO request_log(ts,user_id,path,status,ms) VALUES (?,?,?,?,?)').run(${Date.parse('2024-02-28T16:00:00Z')},42,'/api/legacy',503,1); db.close();`);
    const check=`import {db} from './src/db.js'; console.log(JSON.stringify(db.prepare('SELECT * FROM user_calls_daily').all())); db.close();`;
    assert.ok(Number(run(`import {db} from './src/db.js'; console.log(db.prepare('SELECT last_id FROM user_id_sequence WHERE id=1').get().last_id); db.close();`)) >= 42);
    const first=run(check); assert.equal(JSON.parse(first)[0].e5xx,1); assert.equal(JSON.parse(first)[0].day,'2024-02-29');
    assert.equal(run(check),first);
    run(`import {db} from './src/db.js'; db.exec('DELETE FROM request_log'); db.close();`);
    assert.equal(run(check),first);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

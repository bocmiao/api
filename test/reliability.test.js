import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { db, sql } from '../src/db.js';
import { recordCall, recordLimited, flushStats, _pendingSize } from '../src/lib/stats.js';
import { consume, reserveAdditional, refund, today } from '../src/lib/limits.js';
import { createSession } from '../src/lib/auth.js';
import { handle } from '../src/app.js';
import { apiRouter } from '../src/registry.js';
import { HttpError } from '../src/lib/http.js';

const escaped = [];
const server = createServer((req,res) => handle(req,res).catch(e=>{escaped.push(e);res.destroy();})).listen(0,'127.0.0.1');
await new Promise(r=>server.once('listening',r));
const base=`http://127.0.0.1:${server.address().port}`;
after(()=>server.close());
const seed = (daily,bonus=0) => {
 const id=Number(sql('INSERT INTO users(email,password_hash,daily_limit,bonus_calls) VALUES (?,?,?,?)').run(`synthetic${Math.random()}@review.test`,'unused',daily,bonus).lastInsertRowid);
 return {user:{id,daily_limit:daily},ip:'127.0.0.1'};
};
const used = id => sql('SELECT count FROM usage_daily WHERE day=? AND subject=?').get(today(),`user:${id}`)?.count ?? 0;

test('统计事务失败保留所有批次；新调用合并后重试恰好一次，BEGIN失败不回滚别人事务',()=>{
 const log=mock.method(console,'error',()=>{});
 try {
  recordCall({path:'/api/retry',status:200,ms:5});recordLimited({subject:'user:synthetic',path:'/api/retry'});
  db.exec("CREATE TRIGGER reject_stats BEFORE INSERT ON stats_limited BEGIN SELECT RAISE(ABORT,'synthetic stats failure'); END");
  assert.equal(flushStats(),false);assert.equal(_pendingSize(),1);
  assert.equal(sql("SELECT COUNT(*) AS n FROM stats_daily WHERE path='/api/retry'").get().n,0);
  recordCall({path:'/api/retry',status:503,ms:20});
  db.exec('DROP TRIGGER reject_stats');assert.equal(flushStats(),true);
  const row=sql("SELECT calls,ok,e5xx,limited,ms_max FROM stats_daily WHERE path='/api/retry'").get();
  assert.deepEqual({...row},{calls:2,ok:1,e5xx:1,limited:1,ms_max:20});
  assert.equal(sql("SELECT count FROM stats_limited WHERE subject='user:synthetic'").get().count,1);
  flushStats();assert.equal(sql("SELECT calls FROM stats_daily WHERE path='/api/retry'").get().calls,2);
  recordCall({path:'/api/begin-retry',status:200,ms:1});db.exec('BEGIN');
  assert.equal(flushStats(),false);
  db.exec('ROLLBACK');assert.equal(flushStats(),true);assert.equal(_pendingSize(),0);
 } finally {log.mock.restore();}
});

test('批量HTTP追加日额度/bonus/模块频率429整笔退回；成功、普通4xx和5xx口径保留',async()=>{
 let worked=0;
 const add=(path,handler,module='reliability')=>apiRouter.add('GET',path,handler,{route:{path,handler},module:{name:module}});
 add('/api/reliable-batch',ctx=>{ctx.charge(2);worked++;return {data:null};});
 add('/api/reliable-error',ctx=>{ctx.charge(2);throw new HttpError(503,'synthetic failure');});
 add('/api/reliable-client',()=>{throw new HttpError(400,'synthetic invalid input');});
 add('/api/reliable-minute',ctx=>{ctx.charge(2);worked++;return {data:null};},'reliability-minute');
 sql('INSERT INTO module_options(name,minute_limit,updated_at) VALUES (?,?,?)').run('reliability-minute',1,Date.now());
 const call=async(identity,path)=>{
  const res=await fetch(base+path,{headers:{cookie:`sid=${createSession(identity.user.id)}`}});
  await res.json();return res;
 };
 for(const [daily,bonus] of [[2,0],[0,2],[1,1]]) {
  const identity=seed(daily,bonus);assert.equal((await call(identity,'/api/reliable-batch')).status,429);
  assert.equal(used(identity.user.id),0);assert.equal(sql('SELECT bonus_calls FROM users WHERE id=?').get(identity.user.id).bonus_calls,bonus);
 }
 assert.equal(worked,0);
 const limited=seed(10);assert.equal((await call(limited,'/api/reliable-minute')).status,429);assert.equal(used(limited.user.id),0);assert.equal(worked,0);
 const ok=seed(3);assert.equal((await call(ok,'/api/reliable-batch')).status,200);assert.equal(used(ok.user.id),3);
 const mixed=seed(1,2);assert.equal((await call(mixed,'/api/reliable-batch')).status,200);assert.equal(used(mixed.user.id),1);assert.equal(sql('SELECT bonus_calls FROM users WHERE id=?').get(mixed.user.id).bonus_calls,0);
 const fail=seed(1,2);assert.equal((await call(fail,'/api/reliable-error')).status,503);assert.equal(used(fail.user.id),0);assert.equal(sql('SELECT bonus_calls FROM users WHERE id=?').get(fail.user.id).bonus_calls,2);
 const client=seed(3);assert.equal((await call(client,'/api/reliable-client')).status,400);assert.equal(used(client.user.id),1);
 assert.deepEqual(escaped,[]);
});

test('混合额度退款故障整体回滚，保留charges可重试，结算后重复退款不重退',()=>{
 const identity=seed(1,2),charges=[];
 consume(identity,1,{charges});consume(identity,2,{charges});
 db.exec(`CREATE TRIGGER reject_refund BEFORE UPDATE OF bonus_calls ON users WHEN NEW.id=${identity.user.id} AND NEW.bonus_calls > OLD.bonus_calls BEGIN SELECT RAISE(ABORT,'synthetic refund failure'); END`);
 try {assert.throws(()=>refund(charges),/synthetic refund failure/);assert.equal(used(identity.user.id),1);assert.equal(charges.length,2);}
 finally{db.exec('DROP TRIGGER reject_refund');}
 refund(charges);refund(charges);assert.equal(charges.length,0);assert.equal(used(identity.user.id),0);
 assert.equal(sql('SELECT bonus_calls FROM users WHERE id=?').get(identity.user.id).bonus_calls,2);
});

test('退款按原扣款日结算，不把跨午夜账目退到新日',()=>{
 const identity=seed(3),charges=[];const clock=mock.method(Date,'now',()=>Date.parse('2024-02-29T15:59:59Z'));
 try{consume(identity,1,{charges});clock.mock.mockImplementation(()=>Date.parse('2024-02-29T16:00:01Z'));refund(charges);
 assert.equal(sql("SELECT count FROM usage_daily WHERE day='2024-02-29' AND subject=?").get(`user:${identity.user.id}`).count,0);
 assert.equal(sql("SELECT count FROM usage_daily WHERE day='2024-03-01' AND subject=?").get(`user:${identity.user.id}`),undefined);
 }finally{clock.mock.restore();}
});

test('畸形Cookie/URL受控400，服务继续处理正常请求，绝不逃出handle',async()=>{
 const bad=await fetch(base+'/health',{headers:{cookie:'sid=%'}});assert.equal(bad.status,400);assert.equal((await bad.json()).errorCode,'BAD_REQUEST');
 assert.equal((await fetch(base+'/health')).status,200);
 let status;await handle({url:'http://[',method:'GET',headers:{},socket:{remoteAddress:'127.0.0.1'}},{setHeader(){},writeHead(s){status=s;},end(){}});
 assert.equal(status,400);assert.deepEqual(escaped,[]);
});

test('统计提交后重启无重复；未刷内存批次不承诺跨进程恢复',()=>{
 const dir=mkdtempSync(join(tmpdir(),'miao-reliability-')),file=join(dir,'synthetic.db');
 const run=code=>{const r=spawnSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,DB_FILE:file},encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 try{
 run(`import {recordCall,flushStats} from './src/lib/stats.js';recordCall({path:'/api/persisted',status:200,ms:1});flushStats();recordCall({path:'/api/unflushed',status:200,ms:1});`);
 const result=JSON.parse(run(`import {sql} from './src/db.js';console.log(JSON.stringify(sql('SELECT path,calls FROM stats_daily').all()));`));
 assert.deepEqual(result,[{path:'/api/persisted',calls:1}]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('上游headers后取消JSON/text正文仍是调用方取消；正文超时504，非法JSON502',async()=>{
 const {fetchJSON,fetchText}=await import('../src/lib/http.js');
 const fetchMock=mock.method(globalThis,'fetch',async(_url,{signal})=>{
  const body=()=>new Promise((_,reject)=>{ if(signal.aborted) reject(signal.reason); else signal.addEventListener('abort',()=>reject(signal.reason),{once:true}); });
  return {ok:true,json:body,arrayBuffer:body};
 });
 try{
  for(const fn of [fetchJSON,fetchText]){
   const controller=new AbortController();const promise=fn('https://synthetic.invalid',{signal:controller.signal,timeoutMs:500});
   await new Promise(r=>setImmediate(r));controller.abort();await assert.rejects(promise,e=>e===controller.signal.reason);
  }
  // timeout timer is unref'ed; keep event loop alive for this pending body.
  const keep=setTimeout(()=>{},100);
  try{await assert.rejects(fetchJSON('https://synthetic.invalid',{timeoutMs:5}),e=>e.status===504);}finally{clearTimeout(keep);}
  fetchMock.mock.mockImplementation(async()=>({ok:true,json:async()=>{throw new SyntaxError('synthetic invalid json');}}));
  await assert.rejects(fetchJSON('https://synthetic.invalid'),e=>e.status===502);
 }finally{fetchMock.mock.restore();}
});

test('首次api_calls/全站统计回填故障连同建表回滚，下次启动可重新完成且不重复',()=>{
 for(const target of ['api_calls','stats_daily']){
  const dir=mkdtempSync(join(tmpdir(),'miao-bootstrap-')),file=join(dir,'synthetic.db');
  const run=code=>{const r=spawnSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,DB_FILE:file},encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  try{
   run(`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.env.DB_FILE);db.exec('CREATE TABLE request_log(id INTEGER PRIMARY KEY,ts INTEGER NOT NULL,user_id INTEGER,key_id INTEGER,ip TEXT,path TEXT NOT NULL,status INTEGER NOT NULL,ms INTEGER NOT NULL)');db.prepare('INSERT INTO request_log(ts,path,status,ms) VALUES(?,?,?,?)').run(Date.now(),'/api/legacy',200,1);db.close();`);
   const result=run(`import {DatabaseSync} from 'node:sqlite';const exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(s){if(s.startsWith('INSERT INTO ${target}'))throw Error('synthetic bootstrap failure');return exec.call(this,s);};try{await import('./src/db.js');throw Error('expected failure');}catch(e){if(e.message!=='synthetic bootstrap failure')throw e;}const db=new DatabaseSync(process.env.DB_FILE);console.log(Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name='${target==='api_calls'?'api_calls':'stats_hourly'}'").get()));db.close();`);
   assert.equal(result,'false');
   const check=`import {db} from './src/db.js';console.log(db.prepare("SELECT ${target==='api_calls'?'total':'calls'} AS n FROM ${target} WHERE path='/api/legacy'").get().n);db.close();`;
   assert.equal(run(check),'1');assert.equal(run(check),'1');
  }finally{rmSync(dir,{recursive:true,force:true});}
 }
});

test('HTTP错误路径退款失败不逃逸、不谎称成功，原始500/503响应照常返回',async()=>{
 const identity=seed(10);
 const add=(path,handler,raw=false)=>apiRouter.add('GET',path,handler,{route:{path,handler,raw},module:{name:'refund-fault'}});
 add('/api/refund-thrown',()=>{throw new HttpError(503,'synthetic upstream failure');});
 add('/api/refund-raw',()=>({status:503,body:'synthetic raw failure'}),true);
 db.exec(`CREATE TRIGGER reject_http_refund BEFORE UPDATE ON usage_daily WHEN NEW.subject='user:${identity.user.id}' AND NEW.count<OLD.count BEGIN SELECT RAISE(ABORT,'synthetic HTTP refund failure'); END`);
 const errors=mock.method(console,'error',()=>{});
 try{
  for(const path of ['/api/refund-thrown','/api/refund-raw']){
   const res=await fetch(base+path,{headers:{cookie:`sid=${createSession(identity.user.id)}`}});assert.equal(res.status,503);await res.text();
  }
  assert.equal(used(identity.user.id),2);assert.deepEqual(escaped,[]);
  assert.equal(errors.mock.calls.filter(c=>c.arguments[0]?.event === 'quota_refund_failed').length,2);
 }finally{db.exec('DROP TRIGGER reject_http_refund');errors.mock.restore();}
 assert.equal((await fetch(base+'/health')).status,200);
});

test('统计告警仅白名单阶段/代码/次数，不泄露message stack cause SQL或凭据',()=>{
 const sensitive='SYNTHETIC_SECRET_password_token_SQL';
 const fault=Object.assign(new Error(sensitive),{stack:sensitive,cause:{credential:sensitive},code:sensitive,sql:sensitive});
 const logs=mock.method(console,'error',()=>{});
 recordCall({path:'/api/safe-warning',status:200,ms:1});
 const exec=mock.method(db,'exec',()=>{throw fault;});
 try{
  assert.equal(flushStats(),false);assert.equal(flushStats(),false);
  const events=logs.mock.calls.map(c=>{assert.equal(c.arguments.length,1);return c.arguments[0];});
  for(const e of events){
   assert.deepEqual(Object.keys(e).sort(),['code','event','failureCount','requestId','stage']);
   assert.equal(e.event,'stats_write_failed');assert.equal(e.stage,'begin');assert.equal(e.code,'STATS_DB_FAILURE');assert.equal(e.requestId,null);
  }
  assert.equal(events[1].failureCount,events[0].failureCount+1);
  assert.equal(JSON.stringify(logs.mock.calls.map(c=>c.arguments)).includes(sensitive),false);
 }finally{exec.mock.restore();logs.mock.restore();}
 assert.equal(flushStats(),true);
});

test('退款HTTP告警只保留安全rid和受控字段，不输出敏感数据库异常',async()=>{
 const sensitive='SYNTHETIC_SECRET_password_token_SQL';
 const identity=seed(10);
 const path='/api/safe-refund-warning';const handler=()=>{throw new HttpError(503,'synthetic business failure');};
 apiRouter.add('GET',path,handler,{route:{path,handler},module:{name:'safe-warning'}});
 db.exec(`CREATE TRIGGER reject_sensitive_refund BEFORE UPDATE ON usage_daily WHEN NEW.subject='user:${identity.user.id}' AND NEW.count<OLD.count BEGIN SELECT RAISE(ABORT,'${sensitive}'); END`);
 const logs=mock.method(console,'error',()=>{});
 try{
  const res=await fetch(base+path,{headers:{cookie:`sid=${createSession(identity.user.id)}`,'x-request-id':sensitive}});
  assert.equal(res.status,503);await res.text();
  const calls=logs.mock.calls.filter(c=>c.arguments[0]?.event==='quota_refund_failed');assert.equal(calls.length,1);assert.equal(calls[0].arguments.length,1);
  const e=calls[0].arguments[0];assert.deepEqual(Object.keys(e).sort(),['code','event','failureCount','requestId','stage']);
  assert.equal(e.requestId,res.headers.get('x-request-id'));assert.match(e.requestId,/^[a-z0-9]{1,16}-[a-f0-9]{10}$/);
  assert.equal(e.stage,'refund');assert.equal(e.code,'REFUND_DB_FAILURE');assert.ok(e.failureCount>=1);
  assert.equal(JSON.stringify(logs.mock.calls.map(c=>c.arguments)).includes(sensitive),false);
  assert.equal(used(identity.user.id),1);assert.deepEqual(escaped,[]);
 }finally{db.exec('DROP TRIGGER reject_sensitive_refund');logs.mock.restore();}
});

test('统计回滚本身失败也只输出受控阶段，不泄露异常并保留批次',()=>{
 const sensitive='SYNTHETIC_SECRET_rollback_SQL';
 recordCall({path:'/api/safe-rollback-warning',status:200,ms:1});
 db.exec(`CREATE TRIGGER reject_safe_stats BEFORE INSERT ON stats_daily BEGIN SELECT RAISE(ABORT,'${sensitive}'); END`);
 const logs=mock.method(console,'error',()=>{}),original=db.exec;
 const exec=mock.method(db,'exec',function(text){if(text==='ROLLBACK')throw Object.assign(new Error(sensitive),{cause:sensitive,stack:sensitive});return original.call(this,text);});
 try{
  assert.equal(flushStats(),false);const e=logs.mock.calls[0].arguments[0];
  assert.equal(e.stage,'rollback');assert.equal(e.code,'STATS_ROLLBACK_FAILURE');assert.equal(e.event,'stats_write_failed');assert.ok(_pendingSize()>0);
  assert.equal(JSON.stringify(logs.mock.calls.map(c=>c.arguments)).includes(sensitive),false);
 }finally{exec.mock.restore();db.exec('ROLLBACK');db.exec('DROP TRIGGER reject_safe_stats');logs.mock.restore();}
 assert.equal(flushStats(),true);
});

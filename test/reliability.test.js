import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
 const dir=mkdtempSync(join(process.cwd(),'data/reliability-')),file=join(dir,'synthetic.db');
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
  const dir=mkdtempSync(join(process.cwd(),'data/bootstrap-')),file=join(dir,'synthetic.db');
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
  assert.equal(errors.mock.calls.filter(c=>String(c.arguments[0]).startsWith('[quota] 退款未完成 requestId=')).length,2);
 }finally{db.exec('DROP TRIGGER reject_http_refund');errors.mock.restore();}
 assert.equal((await fetch(base+'/health')).status,200);
});

import {test,after,mock} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {db,sql,STAT_COLS} from '../src/db.js';
import {migrateSources} from '../src/lib/source-migration.js';
import {migrateTraffic} from '../src/lib/traffic-migration.js';
import {classifyTraffic,initializeTrafficConfiguration,withTrafficScope,trafficSql,trafficConfiguration} from '../src/lib/traffic.js';
import {logRequest as writeRequest,pruneLogs,today} from '../src/lib/limits.js';
import {recordCall,flushStats} from '../src/lib/stats.js';
import {createSession} from '../src/lib/auth.js';
import {handle} from '../src/app.js';
import {updateIncidents} from '../src/lib/health.js';

const secretA='ak_'+'A'.repeat(32),secretB='ak_'+'B'.repeat(32);
const logRequest=entry=>writeRequest({ip:'127.0.0.1',...entry});
const hash=v=>createHash('sha256').update(v).digest('hex');
sql("INSERT INTO users(id,email,password_hash,is_admin) VALUES(10,'admin@traffic.test','unused',1),(20,'test@traffic.test','unused',0),(30,'business@traffic.test','unused',0),(40,'shared@traffic.test','unused',0)").run();
sql("INSERT INTO api_keys(id,user_id,name,prefix,key_hash) VALUES(700,40,'已有内部测试标签','fixture',?),(701,40,'已有业务标签','fixture',?)").run(hash(secretA),hash(secretB));
process.env.STATS_INTERNAL_USER_IDS='20';process.env.STATS_INTERNAL_KEY_IDS='700';
initializeTrafficConfiguration({force:true});
const admin=createSession(10),testSid=createSession(20),businessSid=createSession(30);
const server=createServer(handle).listen(0,'127.0.0.1');
await new Promise(r=>server.once('listening',r));
const base=`http://127.0.0.1:${server.address().port}`;
after(()=>{server.close();delete process.env.STATS_INTERNAL_USER_IDS;delete process.env.STATS_INTERNAL_KEY_IDS;initializeTrafficConfiguration({force:true});});
async function get(path,sid=admin,headers={}) {
  const r=await fetch(base+path,{headers:{...(sid?{cookie:`sid=${sid}`}:{ }),...headers}});
  return {status:r.status,headers:r.headers,body:await r.json()};
}
const scoped=(scope,text,...args)=>withTrafficScope(scope,()=>trafficSql(text).get(...args));

test('transactional upgrade preserves legacy totals and source counts, duplicate upgrade and failed upgrade retry',()=>{
  const fixture=()=>{
    const d=new DatabaseSync(':memory:');
    const fields=STAT_COLS.map(c=>`${c} INTEGER NOT NULL DEFAULT 0`).join(',');
    d.exec(`CREATE TABLE request_log(id INTEGER PRIMARY KEY,ts INTEGER,user_id INTEGER,key_id INTEGER,path TEXT,status INTEGER,ms INTEGER,referer TEXT);
      CREATE TABLE stats_hourly(hour INTEGER,path TEXT,${fields},PRIMARY KEY(hour,path));
      CREATE TABLE stats_daily(day TEXT,path TEXT,${fields},PRIMARY KEY(day,path));
      CREATE TABLE stats_limited(day TEXT,subject TEXT,path TEXT,count INTEGER);
      CREATE TABLE stats_day_meta(day TEXT,ips INTEGER,users INTEGER);
      CREATE TABLE api_calls(path TEXT PRIMARY KEY,total INTEGER);
      CREATE TABLE user_calls_daily(user_id INTEGER,day TEXT,path TEXT,calls INTEGER,ok INTEGER,e4xx INTEGER,e5xx INTEGER);
      INSERT INTO stats_daily(day,path,calls,ok) VALUES('2024-01-01','/api/old',9,9);
      INSERT INTO request_log(ts,path,status,ms,referer) VALUES(1000,'/api/old',200,2,'legacy.test');`);
    migrateSources(d);return d;
  };
  const old=fixture();migrateTraffic(old,STAT_COLS,1234);migrateTraffic(old,STAT_COLS,5678);
  assert.equal(old.prepare('SELECT SUM(calls) AS n FROM traffic_business_stats_daily').get().n,9);
  assert.equal(old.prepare('SELECT COUNT(*) AS n FROM traffic_internal_stats_daily').get().n,0);
  assert.equal(old.prepare('SELECT SUM(calls) AS n FROM source_daily').get().n,1);
  assert.equal(old.prepare('SELECT traffic,traffic_basis FROM request_log').get().traffic_basis,'legacy_unclassified');
  assert.equal(old.prepare('SELECT started_at FROM traffic_meta').get().started_at,1234);old.close();
  const broken=fixture();broken.exec('CREATE TABLE traffic_daily(bad TEXT)');assert.throws(()=>migrateTraffic(broken,STAT_COLS));
  assert.equal(broken.prepare('PRAGMA table_info(request_log)').all().some(c=>c.name==='traffic'),false);
  assert.equal(broken.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='traffic_meta'").get().n,0);
  broken.exec('DROP TABLE traffic_daily');migrateTraffic(broken,STAT_COLS);broken.close();
});

test('only explicit existing identities; account vs individual Key; no role/address/header inference',()=>{
  assert.deepEqual(classifyTraffic({id:20},null),{traffic:'internal',basis:'configured_user'});
  assert.deepEqual(classifyTraffic({id:40},700),{traffic:'internal',basis:'configured_key'});
  for(const [u,k] of [[{id:40},701],[{id:40},null],[{id:10,is_admin:1},null],[null,700],[{id:30},700],[{id:999},null]])
    assert.equal(classifyTraffic(u,k).traffic,'business');
  const id=logRequest({ip:'127.0.0.1',path:'/api/tools/uuid',status:200,ms:2,headers:{origin:'http://localhost',referer:'http://127.0.0.1/test','x-internal-test':'true','x-traffic':'internal','user-agent':'internal-test'}});
  assert.equal(sql('SELECT traffic FROM request_log ORDER BY id DESC LIMIT 1').get().traffic,'business');
  assert.equal(id,undefined);
  const before=sql('SELECT key_hash,disabled,scopes,allow FROM api_keys WHERE id=700').get();
  const cfg=trafficConfiguration();assert.equal(cfg.keys[0].id,700);
  assert.doesNotMatch(JSON.stringify(cfg),/fingerprint|key_hash|password|fixed-existing/);
  assert.deepEqual(sql('SELECT key_hash,disabled,scopes,allow FROM api_keys WHERE id=700').get(),before);
});

test('real HTTP business default, all/internal switching, snapshots, quota and 429 remain accounted',async()=>{
  process.env.USER_MINUTE_LIMIT='1000';process.env.ANON_MINUTE_LIMIT='1000';
  assert.equal((await get('/api/tools/uuid',testSid)).status,200);
  assert.equal((await get('/api/tools/hash','',{'x-api-key':secretA})).status,400);
  assert.equal((await get('/api/tools/uuid','',{'x-api-key':secretB})).status,200);
  assert.equal((await get('/api/tools/uuid',businessSid,{'x-internal-test':'1','x-traffic':'internal',origin:'http://localhost'})).status,200);
  const allRows=sql('SELECT * FROM request_log').all();
  assert.equal(allRows.filter(r=>r.traffic==='internal').length,2);
  assert.equal(allRows.filter(r=>r.traffic==='business').length,3);
  assert.equal(sql("SELECT count FROM usage_daily WHERE subject='user:20' AND day=?").get(today()).count,1,'internal consumes ordinary quota');
  const data={};
  for(const scope of ['business','internal','all']) {
    const r=await get(`/admin/analytics/overview?range=24h&traffic=${scope}`);assert.equal(r.status,200);
    data[scope]=r.body.data.kpi.cur;
    assert.equal(r.body.data.traffic.scope,scope);
    const expected=scoped(scope,'SELECT COUNT(*) AS n,COALESCE(SUM(status>=400),0) AS errors FROM request_log');
    assert.equal(data[scope].calls,expected.n);
    assert.equal(data[scope].e4xx+data[scope].e5xx,expected.errors);
  }
  assert.equal(data.all.calls,data.business.calls+data.internal.calls);
  assert.equal((await get('/admin/analytics/overview?range=24h')).body.data.traffic.scope,'business');
  for(const route of ['endpoints','endpoint?path=/api/tools/uuid','audience','users','issues','sources','source-attribution','source-requests']) {
    const sep=route.includes('?')?'&':'?';
    for(const scope of ['business','internal','all'])assert.equal((await get(`/admin/analytics/${route}${sep}range=24h&traffic=${scope}`)).status,200,route+scope);
  }
  const requests=(await get('/admin/analytics/source-requests?traffic=internal&range=24h')).body.data.items;
  assert.equal(requests.length,2);assert.ok(requests.every(r=>r.traffic==='internal'));
  const rid=allRows.find(r=>r.traffic==='internal'&&r.rid)?.rid;
  assert.equal((await get('/admin/request?rid='+rid)).body.data.traffic,'internal');
  process.env.USER_MINUTE_LIMIT='1';
  assert.equal((await get('/api/tools/uuid',testSid)).status,429);
  flushStats();
  assert.equal(scoped('business','SELECT COALESCE(SUM(count),0) AS n FROM stats_limited').n,0);
  assert.equal(scoped('internal','SELECT COALESCE(SUM(count),0) AS n FROM stats_limited').n,1);
  assert.equal(sql('SELECT COUNT(*) AS n FROM request_log WHERE status=429').get().n,0);
  const pub=(await get('/site/overview?traffic=all')).body.data;
  assert.equal(pub.requestTotal,scoped('business','SELECT COALESCE(SUM(total),0) AS n FROM api_calls').n);
  const modules=(await get('/stats/modules?traffic=internal')).body.data;
  assert.equal(modules.devtools.total,scoped('business',"SELECT COALESCE(SUM(total),0) AS n FROM api_calls WHERE path LIKE '/api/tools/%'").n);
  const businessDaily=(await get('/admin/users/20/calls')).body.data;
  assert.equal(businessDaily.totals.calls,0);
  assert.equal((await get('/admin/users/20/calls?traffic=internal')).body.data.totals.calls,1);
  process.env.USER_MINUTE_LIMIT='1000';
});

test('authorization, whitelist validation, concurrent scope isolation and no credential disclosure',async()=>{
  for(const p of ['/admin/analytics/overview?traffic=invalid','/admin/analytics/traffic-config','/admin/analytics/source-requests?traffic=internal']) {
    assert.equal((await get(p,'')).status,401);assert.equal((await get(p,businessSid)).status,403);
  }
  assert.equal((await get('/admin/analytics/overview?traffic=invalid')).status,400);
  const replies=await Promise.all(Array.from({length:18},(_,i)=>get(`/admin/analytics/sources?range=24h&traffic=${['internal','business','all'][i%3]}`)));
  replies.forEach((r,i)=>{const scope=['internal','business','all'][i%3];assert.equal(r.body.data.traffic.scope,scope);assert.equal(r.body.data.totals.calls,scoped(scope,'SELECT COUNT(*) AS n FROM request_log').n);});
  assert.equal((await get('/admin/analytics/traffic-config')).headers.get('cache-control'),'no-store');
  for(const r of replies)assert.doesNotMatch(JSON.stringify(r.body),/key_hash|fingerprint|fixed-existing|password_hash/);
  process.env.STATS_INTERNAL_USER_IDS="20,1 OR 1=1";
  assert.throws(()=>initializeTrafficConfiguration(),/正整数/);
  process.env.STATS_INTERNAL_USER_IDS='20';initializeTrafficConfiguration({force:true});
});

test('immutable request snapshot and binding: removed/reused/rotated Key cannot gain stale internal status',()=>{
  const snapshot=classifyTraffic({id:40},700);
  const old=sql('SELECT key_hash FROM api_keys WHERE id=700').get().key_hash;
  sql('UPDATE api_keys SET key_hash=? WHERE id=700').run(hash('rotated-synthetic-fixture'));
  assert.equal(classifyTraffic({id:40},700).traffic,'business');
  initializeTrafficConfiguration({force:true});assert.equal(classifyTraffic({id:40},700).traffic,'business');
  assert.ok(trafficConfiguration().inactiveKeyIds.includes(700));
  process.env.STATS_INTERNAL_KEY_IDS='';initializeTrafficConfiguration({force:true});
  process.env.STATS_INTERNAL_KEY_IDS='700';initializeTrafficConfiguration({force:true});
  assert.equal(classifyTraffic({id:40},700).traffic,'internal','explicit removal then re-selection confirms the changed existing Key');
  logRequest({user:{id:40},keyId:700,ip:'8.8.8.8',path:'/api/snapshot',status:200,ms:1,trafficClassification:snapshot});
  assert.equal(sql("SELECT traffic FROM request_log WHERE path='/api/snapshot'").get().traffic,'internal');
  sql('UPDATE api_keys SET key_hash=? WHERE id=700').run(old);
  const classified=sql("SELECT traffic,traffic_basis FROM request_log WHERE path='/api/snapshot'").get();
  process.env.STATS_INTERNAL_KEY_IDS='';initializeTrafficConfiguration({force:true});
  assert.equal(classifyTraffic({id:40},700).traffic,'business');
  assert.deepEqual(sql("SELECT traffic,traffic_basis FROM request_log WHERE path='/api/snapshot'").get(),classified);
  process.env.STATS_INTERNAL_KEY_IDS='700';initializeTrafficConfiguration({force:true});
});

test('atomic classified log/source/user counts and retry-safe rollups; exact independent maximums',()=>{
  const before=sql('SELECT COUNT(*) AS n FROM request_log').get().n;
  db.exec("CREATE TRIGGER traffic_failure BEFORE INSERT ON traffic_internal_calls BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.throws(()=>logRequest({user:{id:20},path:'/api/atomic-traffic',status:200,ms:1}));
  db.exec('DROP TRIGGER traffic_failure');
  assert.equal(sql('SELECT COUNT(*) AS n FROM request_log').get().n,before);
  assert.equal(sql("SELECT COUNT(*) AS n FROM source_daily WHERE path='/api/atomic-traffic'").get().n,0);
  flushStats();
  recordCall({path:'/api/flush-traffic',status:200,ms:900,traffic:'internal'});
  recordCall({path:'/api/flush-traffic',status:200,ms:10,traffic:'business'});
  db.exec("CREATE TRIGGER traffic_flush_failure BEFORE INSERT ON traffic_daily BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  assert.equal(flushStats(),false);assert.equal(sql("SELECT COUNT(*) AS n FROM stats_daily WHERE path='/api/flush-traffic'").get().n,0);
  db.exec('DROP TRIGGER traffic_flush_failure');assert.equal(flushStats(),true);flushStats();
  assert.equal(scoped('business',"SELECT SUM(calls) AS n,MAX(ms_max) AS ms FROM stats_daily WHERE path='/api/flush-traffic'").ms,10);
  assert.equal(scoped('internal',"SELECT SUM(calls) AS n,MAX(ms_max) AS ms FROM stats_daily WHERE path='/api/flush-traffic'").ms,900);
  assert.equal(scoped('all',"SELECT SUM(calls) AS n FROM stats_daily WHERE path='/api/flush-traffic'").n,2);
});

test('internal failures do not create business incidents, while durable scoped counts survive raw expiry',()=>{
  for(let i=0;i<12;i++)logRequest({user:{id:20},path:'/api/only-internal-failure',status:503,ms:1});
  updateIncidents(Date.now(),[],p=>p==='/api/only-internal-failure'?'internal-only':null);
  assert.equal(sql("SELECT COUNT(*) AS n FROM incidents WHERE module='internal-only'").get().n,0);
  const now=Date.now(),past=now-40*86400_000;
  const clock=mock.method(Date,'now',()=>past);
  logRequest({user:{id:20},path:'/api/durable-traffic',status:400,ms:20,headers:{origin:'https://durable.test'}});
  clock.mock.restore();flushStats();pruneLogs();
  assert.equal(sql("SELECT COUNT(*) AS n FROM request_log WHERE path='/api/durable-traffic'").get().n,0);
  assert.equal(scoped('internal',"SELECT SUM(calls) AS n FROM stats_daily WHERE path='/api/durable-traffic'").n,1);
  assert.equal(scoped('business',"SELECT COALESCE(SUM(calls),0) AS n FROM stats_daily WHERE path='/api/durable-traffic'").n,0);
  assert.equal(scoped('internal',"SELECT SUM(calls) AS n FROM source_daily WHERE path='/api/durable-traffic'").n,1);
  assert.equal(scoped('internal',"SELECT SUM(calls) AS n FROM user_calls_daily WHERE path='/api/durable-traffic'").n,1);
});

test('persistent restart is idempotent, legacy remains visible and unclassified, bindings persist',()=>{
  const temp=mkdtempSync(join(tmpdir(),'miao-traffic-'));
  const file=join(temp,'traffic.sqlite');
  const run=code=>{
    const r=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',env:{...process.env,DB_FILE:file,STATS_INTERNAL_USER_IDS:'20',STATS_INTERNAL_KEY_IDS:''}});
    assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim());
  };
  try {
    run(`const {sql}=await import('./src/db.js');sql("INSERT INTO users(id,email,password_hash) VALUES(20,'persist@test','unused')").run();const {logRequest}=await import('./src/lib/limits.js');logRequest({user:{id:20},ip:'127.0.0.1',path:'/api/persist',status:200,ms:1});const {flushStats}=await import('./src/lib/stats.js');flushStats();console.log('{}');`);
    const code=`const {sql}=await import('./src/db.js');const {withTrafficScope,trafficSql}=await import('./src/lib/traffic.js');console.log(JSON.stringify({internal:withTrafficScope('internal',()=>trafficSql('SELECT SUM(calls) AS n FROM stats_daily').get().n),logs:sql('SELECT COUNT(*) AS n FROM request_log').get().n,started:sql('SELECT started_at FROM traffic_meta').get().started_at}));`;
    const a=run(code),b=run(code);assert.deepEqual(a,b);assert.equal(a.internal,1);assert.equal(a.logs,1);
  } finally {assert.ok(resolve(temp).startsWith(resolve(tmpdir())+sep));rmSync(temp,{recursive:true,force:true});}
});

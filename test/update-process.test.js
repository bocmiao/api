// 真正的 launcher/server + 本机 HTTP 生命周期。所有源码、数据库、包与故障注入位于临时目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { codeDigest } from '../src/lib/deployment.js';

const source = fileURLToPath(new URL('../', import.meta.url));
const wait = ms => new Promise(r => setTimeout(r, ms));
const preload = String.raw`
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Socket } from 'node:net';
const meta=JSON.parse(readFileSync(process.env.UPDATE_PROCESS_META));
process.on('uncaughtExceptionMonitor',err=>writeFileSync(join(meta.root,'../uncaught.log'),err.stack??String(err)));
// 不保留原生 fetch 的出口。真实应用的预热请求全部在这里失败，不访问上游。
globalThis.fetch=async input=>{
  const url=new URL(String(input));
  if(url.hostname==='api.github.com') {
    if(url.pathname==='/repos/fixture/api')return Response.json({default_branch:'Miao-API'});
    if(url.pathname.includes('/commits/'))return Response.json({sha:meta.branchSha,commit:{message:'fixture target',committer:{date:'2026-10-15T16:00:00Z'}}});
    if(url.pathname.includes('/compare/')) {
      const [base,head]=decodeURIComponent(url.pathname.split('/compare/')[1]).split('...');
      const git=(...args)=>execFileSync('git',['-C',meta.root,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
      const [behind,ahead]=git('rev-list','--left-right','--count',base+'...'+head).split(/\s+/).map(Number);
      return Response.json({status:!behind&&!ahead?'identical':!behind?'ahead':!ahead?'behind':'diverged',ahead_by:ahead,behind_by:behind,
        merge_base_commit:{sha:git('merge-base',base,head)},commits:[{sha:meta.targetSha,commit:{message:'fixture target'}}]});
    }
    if(url.pathname.includes('/git/trees/'))return Response.json(meta.tree);
    if(url.pathname.includes('/contents/')) {
      const path=decodeURIComponent(url.pathname.split('/contents/')[1]),file=join(meta.targetDir,path);
      return existsSync(file)?new Response(readFileSync(file)):new Response('',{status:404});
    }
  }
  const marker='/'+meta.targetSha+'/';
  if(['raw.githubusercontent.com','fastly.jsdelivr.net'].includes(url.hostname)&&url.pathname.includes(marker)) {
    const file=join(meta.targetDir,decodeURIComponent(url.pathname.split(marker)[1]));
    return existsSync(file)?new Response(readFileSync(file)):new Response('',{status:404});
  }
  throw new Error('Synthetic environment blocks outbound fetch');
};
const connect=Socket.prototype.connect;
Socket.prototype.connect=function(...args){
  const first=args[0],opts=Array.isArray(first)?first[0]:first;
  const host=typeof opts==='object'?opts.host:typeof args[1]==='string'?args[1]:'localhost';
  if(host&&!['localhost','127.0.0.1','::1'].includes(host))throw new Error('Synthetic environment blocks outbound socket');
  return connect.apply(this,args);
};
`;

async function fixture(mode) {
  const dir=mkdtempSync(join(tmpdir(),'miao-real-update-')),root=join(dir,'app'),targetDir=join(dir,'target');
  mkdirSync(root);
  for(const name of ['src','public','package.json'])cpSync(join(source,name),join(root,name),{recursive:true});
  writeFileSync(join(root,'.gitignore'),'/data/\n/.env\n/.update*/\n');
  const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore'],maxBuffer:80*1024*1024}).trim();
  const commit=message=>{git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm',message);return git('rev-parse','HEAD');};
  git('init','-q');git('config','core.autocrlf','false');const oldSha=commit('baseline');
  // launcher 从头到尾都是原文件。健康/未重启场景的 server 也逐字节保持原样。
  assert.deepEqual(readFileSync(join(root,'src/launcher.js')),readFileSync(join(source,'src/launcher.js')));
  assert.deepEqual(readFileSync(join(root,'src/server.js')),readFileSync(join(source,'src/server.js')));
  writeFileSync(join(root,'src/app.js'),readFileSync(join(root,'src/app.js'),'utf8')+'\n// synthetic same-semver target\n');
  if(mode==='crash')writeFileSync(join(root,'src/server.js'),readFileSync(join(root,'src/server.js'),'utf8')+'\nsetTimeout(()=>{console.error("synthetic-update-crash");process.exit(1);},1000).unref();\n');
  const targetSha=commit('same version target');
  mkdirSync(targetDir);
  for(const name of ['src','public','package.json','.gitignore'])cpSync(join(root,name),join(targetDir,name),{recursive:true});
  const zip=execFileSync('git',['-C',root,'archive','--format=zip','--prefix=api/',targetSha],{maxBuffer:80*1024*1024});
  const tree={truncated:false,tree:git('ls-tree','-r',targetSha).split('\n').map(line=>{
    const [meta,path]=line.split('\t'),[fileMode,type,sha]=meta.split(' ');
    return {path,mode:fileMode,type,sha,size:readFileSync(join(targetDir,path)).length};
  })};
  let branchSha=targetSha;
  if(mode==='healthy-upload') {
    writeFileSync(join(root,'src/app.js'),readFileSync(join(root,'src/app.js'),'utf8')+'\n// later branch commit, uploaded ZIP remains its ancestor\n');
    branchSha=commit('branch advances after ZIP was downloaded');
  }
  git('branch','Miao-API',branchSha);git('checkout','-q','--detach',oldSha);
  mkdirSync(join(root,'data'));
  writeFileSync(join(root,'data/keep.txt'),'synthetic private data');
  writeFileSync(join(root,'.env'),'SYNTHETIC_ONLY=1\n');
  writeFileSync(join(root,'data/version.json'),JSON.stringify({schema:2,version:'0.11.1',sha:oldSha,codeDigest:codeDigest(root),installationId:'11111111-1111-4111-8111-111111111111'}));
  writeFileSync(join(dir,'meta.json'),JSON.stringify({root,targetDir,oldSha,targetSha,branchSha,tree}));
  writeFileSync(join(dir,'preload.mjs'),preload);
  const portServer=createServer().listen(0,'127.0.0.1');await new Promise(r=>portServer.once('listening',r));
  const port=portServer.address().port;await new Promise(r=>portServer.close(r));
  const base='http://127.0.0.1:'+port;
  let logs='';
  const preloadUrl=pathToFileURL(join(dir,'preload.mjs')).href;
  const child=spawn(process.execPath,['--import',preloadUrl,join(root,'src',mode==='unmanaged'?'server.js':'launcher.js')],{
    cwd:root,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],
    env:{PATH:process.env.PATH,NODE_ENV:'test',DB_FILE:join(root,'data/fixture.db'),DATA_DIR:join(root,'data'),PORT:String(port),PUBLIC_URL:base,
      NODE_OPTIONS:'--import '+preloadUrl,UPDATE_PROCESS_META:join(dir,'meta.json'),UPDATE_REPO:'fixture/api',UPDATE_BRANCH:'Miao-API',UPDATE_UPLOAD_VERIFY:'1',
      HEALTH_CHECK_INTERVAL_MIN:'0',EMAIL_VERIFY:'0',ADMIN_EMAILS:'process@preview.invalid',TZ:'UTC'},
  });
  for(const stream of [child.stdout,child.stderr])stream.on('data',d=>{if(logs.length<200000)logs+=d;});
  let cookie='';
  const call=async(method,path,body,extra={})=>{
    const binary=Buffer.isBuffer(body);
    const res=await fetch(base+path,{method,headers:{accept:'application/json',origin:base,cookie,
      ...(body?{'content-type':binary?'application/octet-stream':'application/json'}:{}),...extra},
      body:body?(binary?body:JSON.stringify(body)):undefined,signal:AbortSignal.timeout(3000)});
    if(res.headers.get('set-cookie'))cookie=res.headers.get('set-cookie').split(';')[0];
    const value=await res.json();assert.equal(res.status,200,JSON.stringify(value));return value.data;
  };
  const until=async(fn,timeout=15000)=>{
    const end=Date.now()+timeout;let last;
    while(Date.now()<end){try{const value=await fn();if(value)return value;}catch(e){last=e;if(e.fatal)break;}await wait(100);}
    const crashFile=join(dir,'uncaught.log');
    throw new Error('HTTP process timeout: '+(last?.message??'condition not reached')+'\n'+logs.slice(-5000)+(existsSync(crashFile)?'\n'+readFileSync(crashFile,'utf8'):''));
  };
  const close=async()=>{
    if(child.exitCode===null){try{process.kill(process.platform==='win32'?child.pid:-child.pid,'SIGTERM');}catch{}
      await Promise.race([new Promise(r=>child.once('exit',r)),wait(3000)]);
      if(child.exitCode===null)try{process.kill(process.platform==='win32'?child.pid:-child.pid,'SIGKILL');}catch{}
    }
    rmSync(dir,{recursive:true,force:true});
  };
  return {root,oldSha,targetSha,branchSha,zip,call,until,close,logs:()=>logs};
}

for(const [mode,title] of [['unmanaged','替换后旧 HTTP 进程保持旧身份并等待重启'],['healthy-upload','分支前进后的合法旧 ZIP 由真实 launcher 重启并通过实际 20 秒观察'],['crash','真实新进程崩溃后 launcher 自动恢复旧代码与安装记录']]) {
  test('进程端到端：'+title,{timeout:70000},async()=>{
    const f=await fixture(mode);
    try {
      await f.until(()=>f.call('GET','/status'));
      await f.call('POST','/auth/register',{email:'process@preview.invalid',password:'synthetic-password123'});
      const before=await f.call('GET','/admin/version');assert.equal(before.runningIdentity.sha,f.oldSha);
      if(mode==='healthy-upload') {
        assert.notEqual(f.targetSha,f.branchSha);
        const confirmation=await f.call('POST','/admin/confirm',{password:'synthetic-password123'});
        await f.call('POST','/admin/update/upload',f.zip,{'x-admin-confirm':confirmation.token});
      } else {
        const check=await f.call('GET','/admin/update');assert.equal(check.latest.sha,f.targetSha);
        await f.call('POST','/admin/update',{sha:f.targetSha});
      }
      const installed=await f.until(async()=>{const p=await f.call('GET','/admin/update/progress');if(p.state==='error')throw Object.assign(new Error(p.error),{fatal:true});return p.state==='done'?p:null;});
      assert.equal(installed.result.version.sha,f.targetSha);
      assert.equal(installed.result.restart,mode!=='unmanaged');
      const disk=await f.call('GET','/admin/version');
      assert.equal(disk.runningIdentity.sha,f.oldSha);assert.equal(disk.diskIdentity.sha,f.targetSha);
      assert.equal(disk.restartNeeded,true);assert.equal(disk.health,'pending');
      if(mode==='unmanaged') {
        await wait(1200);const stillOld=await f.call('GET','/admin/version');
        assert.equal(stillOld.runningIdentity.instanceId,before.runningIdentity.instanceId);
        assert.equal(stillOld.restartNeeded,true);assert.equal(stillOld.health,'pending');
        assert.ok(existsSync(join(f.root,'data/update-pending.json')));
      } else if(mode==='healthy-upload') {
        const live=await f.until(async()=>{const v=await f.call('GET','/admin/version');return v.runningIdentity.sha===f.targetSha?v:null;});
        assert.notEqual(live.runningIdentity.instanceId,before.runningIdentity.instanceId);
        assert.equal(live.runningIdentity.installationId,installed.result.version.installationId);
        assert.equal(live.restartNeeded,false);assert.equal(live.health,'pending');
        const healthy=await f.until(async()=>{const v=await f.call('GET','/admin/version');return v.health==='confirmed'?v:null;},30000);
        assert.equal(healthy.runningIdentity.sha,f.targetSha);
        assert.ok(Date.now()-Date.parse(healthy.runningIdentity.startedAt)>=19000,'实际经过健康观察时间');
        assert.equal(existsSync(join(f.root,'data/update-pending.json')),false);
        assert.match(f.logs(),/更新完成，正在重启服务/);
      } else {
        const restored=await f.until(async()=>{const v=await f.call('GET','/admin/version');return v.lastRollback?.failedSha===f.targetSha?v:null;});
        assert.equal(restored.runningIdentity.sha,f.oldSha);assert.equal(restored.diskIdentity.sha,f.oldSha);
        assert.equal(restored.lastRollback.failedInstallationId,installed.result.version.installationId);
        assert.notEqual(restored.runningIdentity.instanceId,before.runningIdentity.instanceId);
        assert.equal(restored.health,'confirmed');assert.equal(restored.restartNeeded,false);
        assert.match(f.logs(),/synthetic-update-crash/);assert.match(f.logs(),/已自动回滚/);
      }
      assert.equal(readFileSync(join(f.root,'data/keep.txt'),'utf8'),'synthetic private data');
      assert.equal(readFileSync(join(f.root,'.env'),'utf8'),'SYNTHETIC_ONLY=1\n');
    } finally {await f.close();}
  });
}

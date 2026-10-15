// 本地合成数据验收。实际 app.js/followUpdate 在 Chromium 中运行；只附加测试入口，未改写函数。
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_PATH=/usr/bin/chromium node scripts/check-update-ui.js
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
process.env.NODE_ENV = 'test'; process.env.DB_FILE = ':memory:';
const temp = mkdtempSync(join(tmpdir(), 'miao-update-browser-'));
process.env.DATA_DIR = temp;
const { handle } = await import('../src/app.js');
const { sql } = await import('../src/db.js');
const { createSession } = await import('../src/lib/auth.js');
sql("INSERT INTO users(id,email,password_hash,is_admin) VALUES (1,'update@preview.example','unused',1)").run();
const sid = createSession(1);
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const server = createServer((req, res) => {
  if (req.url === '/__preview/update') { res.writeHead(302, { 'set-cookie': `sid=${sid}; HttpOnly; SameSite=Lax; Path=/`, location: '/admin' }); res.end(); return; }
  if (req.url.split('?')[0] === '/app.js') {
    res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
    res.end(appSource + '\n;globalThis.__updateTest = {checkUpdate, followUpdate};'); return;
  }
  handle(req, res);
});
server.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const out = resolve(process.env.UI_EVIDENCE_DIR || 'data/update-evidence'); mkdirSync(out, { recursive: true });
const notes = JSON.parse(readFileSync(new URL('../UPDATE_NOTES.json', import.meta.url)));
const oldSha = '76b1c618fb003a76e5a169c2dd42e15df90c75d3', targetSha = '2f0ded7d62e6c5ec923055812d0a7a041924d7f7';
const old = { version: '0.11.1', sha: oldSha, codeDigest: 'old-digest', installationId: 'old-install', instanceId: 'old-process', installedAt: '2026-10-13T10:25:00Z' };
const target = { version: '0.11.1', sha: targetSha, codeDigest: 'new-digest', installationId: 'new-install' };
const initial = { running: old.version, disk: old.version, runningIdentity: old, diskIdentity: old, restartNeeded: false, restartUnknown: false, health: 'confirmed', lastRollback: null };
const sourceItems = notes.find(n => n.sha === targetSha).items;
const fixture = () => ({ repo: 'bocmiao/api', branch: 'Miao-API', current: { version: old.version, sha: old.sha, runningIdentity: old, diskIdentity: old, restartNeeded: false },
  latest: { version: target.version, sha: target.sha, shortSha: target.sha.slice(0,7), date: '2026-10-15T14:43:54Z', message: '<img src=x onerror=alert(1)> 来源追踪' },
  hasUpdate: true, patch: true, canInstall: true, comparisonUnknown: false, upToDate: false, managed: true,
  changes: [], commits: [{sha: targetSha, shortSha: targetSha.slice(0,7), message: '增强来源追踪、筛选与持久统计', notes: sourceItems}], notesScope: 'range', targetNotes: sourceItems });
const checks = [], errors = [];
let browser;
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {}), args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: {width: 1360, height: 1000}, reducedMotion: 'reduce' });
  const open = async () => {
    const page = await context.newPage();
    const state = { live: structuredClone(initial), update: fixture(), polls: 0, progress: {state: 'idle'} };
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await page.route('**/admin/version', route => {state.polls++; return route.fulfill({json: {code:200,data:state.live}});});
    await page.route('**/admin/update', route => route.fulfill({json:{code:200,data:state.update}}));
    await page.route('**/admin/update/progress', route => route.fulfill({json:{code:200,data:state.progress}}));
    await page.goto(base+'/__preview/update');
    await page.waitForFunction(() => Boolean(globalThis.__updateTest && document.querySelector('#ver-now b')));
    return {page, state};
  };
  const {page, state} = await open();
  await page.locator('#check-update').click();
  await page.locator('#do-update').waitFor();
  const body = page.locator('#update-body');
  assert.equal(await body.locator('.ver-box').count(), 3);
  assert.match(await body.innerText(), /v0\.11\.1 \+ 76b1c61/);
  assert.match(await body.innerText(), /v0\.11\.1 \+ 2f0ded7/);
  assert.match(await body.innerText(), /安装/); assert.match(await body.innerText(), /提交/);
  assert.doesNotMatch(await body.innerText(), / 发布|新增 \/api\/qq\/nickname/);
  assert.match(await body.innerText(), /来源追踪|来源日汇总/);
  assert.equal(await body.locator('img').count(), 0);
  const stamp = () => page.evaluate(() => { const note=document.createElement('p'); note.textContent='合成数据验收 · 版本与提交演示，不代表生产部署'; note.className='small faint'; document.querySelector('#update-body').prepend(note); });
  await stamp(); await page.locator('#update-card').screenshot({path:out+'/desktop.png',style:'#topbar { visibility:hidden }'});
  for (const width of [390,320,390,320,390,320,390,320]) {
    await page.setViewportSize({width,height:900});
    const layout=await page.evaluate(() => ({width:innerWidth,scroll:document.documentElement.scrollWidth,
      overflow:[...document.querySelectorAll('body *')].filter(el=>el.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(el=>({tag:el.tagName,id:el.id,class:el.className,width:el.getBoundingClientRect().width,right:el.getBoundingClientRect().right}))}));
    assert.ok(layout.scroll<=layout.width, 'mobile overflow '+width+' '+JSON.stringify(layout));
    await page.locator('#update-card').screenshot({path:out+`/mobile-${width}.png`,style:'#topbar { visibility:hidden }'});
  }
  checks.push('three version/SHA identities, accurate install/commit labels, source tracking notes, escaped text, 390/320px');
  state.update = {...fixture(), hasUpdate:false, comparisonUnknown:true, upToDate:false, notesScope:'target', commits:[],
    current:{...fixture().current,sha:null,runningIdentity:{...old,sha:null},diskIdentity:{...old,sha:null}}};
  await page.locator('#check-update').click(); await page.locator('#do-update').waitFor();
  assert.match(await body.innerText(), /当前提交未知，无法确认是否最新/);
  assert.match(await body.innerText(), /不代表本机到目标的完整改动/);
  assert.doesNotMatch(await body.innerText(), /已经是最新版本/);
  await page.locator('#update-card').screenshot({path:out+'/unknown.png'});
  checks.push('unknown identity remains unknown and offers explicit target installation');
  state.update = {...fixture(), commits:[], notesScope:'target', commitRangeUnavailable:true};
  await page.locator('#check-update').click(); await page.locator('#do-update').waitFor();
  assert.match(await body.innerText(), /提交比较失败，完整更新范围不可得/);
  state.update = {...fixture(), commitRangeIncomplete:true, commits:[{...fixture().commits[0],notesTruncated:true}]};
  await page.locator('#check-update').click(); await page.locator('#do-update').waitFor();
  assert.match(await body.innerText(), /只展示部分提交/); assert.match(await body.innerText(), /说明条目被截断/);
  checks.push('comparison failures and truncated note ranges visibly disclosed');
  state.update = {...fixture(), hasUpdate:false, canInstall:false, upToDate:true, latest:{...fixture().latest,sha:old.sha,shortSha:old.sha.slice(0,7)}};
  await page.locator('#check-update').click(); await page.getByText('已经是最新版本',{exact:true}).waitFor();
  state.update = {...fixture(), hasUpdate:false, canInstall:false, upToDate:false, current:{...fixture().current,restartNeeded:true,diskIdentity:{...target,installedAt:'2026-10-15T16:00:00Z'}}};
  await page.locator('#check-update').click(); await page.getByText('磁盘代码已就位，等待重启生效',{exact:true}).waitFor();
  assert.equal(await page.locator('#do-update').count(),0);
  checks.push('same SHA is current; installed same-semver target waits for restart');
  state.update = {...fixture(),hasUpdate:false,upToDate:true,current:{version:'0.11.1',running:'0.11.1',sha:targetSha}};
  await page.locator('#check-update').click(); await page.getByText('服务尚未提供可验证的运行身份，请重启后检查更新',{exact:true}).waitFor();
  assert.match(await body.innerText(), /v0\.11\.1 \+ 提交未知/);
  assert.doesNotMatch(await body.innerText(), /已经是最新版本/);
  assert.equal(await page.locator('#do-update').count(),0);
  checks.push('new static UI with legacy server API never trusts old semver/SHA records');
  await page.close();

  const runFollow = async (name, {live, payload, expected, success=false, progress}) => {
    const {page,state} = await open();
    state.live=live;
    if(progress)state.progress=progress;
    await page.clock.install();
    await page.evaluate(p => { globalThis.__followDone=false; globalThis.__updateTest.followUpdate(p,document.querySelector('#update-body')).then(()=>globalThis.__followDone=true); },payload);
    for(let i=0;i<100;i++) {
      await page.clock.fastForward(i===0?4000:1000);
      await page.waitForTimeout(12);
      const text=await page.locator('#update-body').innerText();
      if(text.includes(expected))break;
      if(!success)assert.ok(!text.includes('更新成功'), name+' incorrectly reported success');
    }
    const text=await page.locator('#update-body').innerText();
    assert.ok(text.includes(expected),name+': '+text);
    if(!success)assert.ok(!text.includes('更新成功'));
    await page.locator('#update-card').screenshot({path:out+'/'+name+'.png'});
    checks.push(name);
    await page.close();
  };
  const done = {state:'done',previousInstanceId:old.instanceId,startedAt:'2026-10-15T16:00:00Z',result:{version:target,restart:true}};
  const targetLive = {...initial,runningIdentity:{...target,instanceId:'new-process'},diskIdentity:target};
  await runFollow('old-process-same-semver',{live:initial,payload:done,expected:'尚未确认目标代码运行'});
  await runFollow('old-instance-claims-target',{live:{...targetLive,runningIdentity:{...target,instanceId:old.instanceId}},payload:done,expected:'尚未确认目标代码运行'});
  await runFollow('missing-instance-id',{live:{...targetLive,runningIdentity:target},payload:done,expected:'尚未确认目标代码运行'});
  await runFollow('health-pending',{live:{...targetLive,health:'pending'},payload:done,expected:'尚未确认目标代码运行'});
  await runFollow('rollback',{live:{...initial,lastRollback:{at:'2026-10-15T16:01:00Z',failedSha:target.sha,failedInstallationId:target.installationId}},payload:done,expected:'更新失败，已自动回滚'});
  await runFollow('unknown-target',{live:targetLive,payload:{...done,result:{version:{version:'0.11.1'},restart:true}},expected:'尚未确认目标代码运行'});
  await runFollow('manual-restart',{live:initial,payload:{...done,result:{version:target,restart:false}},expected:'代码已安装，等待手动重启'});
  await runFollow('target-new-process-confirmed',{live:targetLive,payload:done,expected:'更新成功',success:true});
  await runFollow('progress-reset-keeps-target',{live:targetLive,payload:{state:'running',target:{version:target.version,sha:target.sha},previousInstanceId:old.instanceId},progress:{state:'idle'},expected:'更新成功',success:true});
  const unverifiedTarget = {...target,sha:null};
  await runFollow('unverified-upload-fingerprint-confirmed',{live:{...targetLive,runningIdentity:{...unverifiedTarget,instanceId:'new-process'},diskIdentity:unverifiedTarget},payload:{...done,result:{version:unverifiedTarget,restart:true}},expected:'更新成功',success:true});
  assert.deepEqual(errors,[]);
  const results = {browser:await browser.version(),checks,pageErrors:errors,evidence:out};
  writeFileSync(out+'/browser-results.json',JSON.stringify(results,null,2));
  console.log(JSON.stringify(results,null,2));
} finally { await browser?.close(); server.close(); rmSync(temp,{recursive:true,force:true}); }

// Synthetic, loopback-only fixture; no production data, jobs or generated API Keys.
process.env.NODE_ENV='test';process.env.DB_FILE=':memory:';
process.env.STATS_INTERNAL_USER_IDS='';process.env.STATS_INTERNAL_KEY_IDS='';
const {createServer}=await import('node:http');
const {sql}=await import('../src/db.js');
const {handle}=await import('../src/app.js');
const {createSession}=await import('../src/lib/auth.js');
const {initializeTrafficConfiguration}=await import('../src/lib/traffic.js');
const {logRequest}=await import('../src/lib/limits.js');
const {flushStats,recordCall}=await import('../src/lib/stats.js');
sql("INSERT INTO users(id,email,password_hash,is_admin) VALUES(1,'admin@preview.example','unused',1),(2,'shared@preview.example','unused',0),(3,'test@preview.example','unused',0)").run();
sql("INSERT INTO api_keys(id,user_id,name,prefix,key_hash) VALUES(700,2,'已有内部测试标签 <img src=x onerror=alert(1)>','fixture','non-credential-a'),(701,2,'已有业务标签','fixture','non-credential-b')").run();
process.env.STATS_INTERNAL_USER_IDS='3';process.env.STATS_INTERNAL_KEY_IDS='700';initializeTrafficConfiguration({force:true});
for(let i=0;i<14;i++)logRequest({user:{id:i<3?3:2},keyId:i<3?null:i<6?700:701,ip:'127.0.0.1',path:i%3?'/api/tools/uuid':'/api/tools/hash',status:i%5?200:400,ms:10+i,
  rid:`traffic${String(i).padStart(2,'0')}-0123456789`,headers:{origin:i%2?'https://shared.example':'http://localhost','x-internal-test':'true'}});
for(let i=0;i<2;i++) {
  sql("INSERT INTO request_log(ts,path,status,ms,referer,rid) VALUES(?,'/api/tools/uuid',200,8,'legacy.example',?)").run(Date.now(),`legacy${i}-0123456789`);
  recordCall({path:'/api/tools/uuid',status:200,ms:8,traffic:'legacy'});
  sql("INSERT INTO api_calls VALUES('/api/tools/uuid',1) ON CONFLICT(path) DO UPDATE SET total=total+1").run();
}
flushStats();
const adminSid=createSession(1),userSid=createSession(2);
export const server=createServer((req,res)=>{
  if(req.url==='/__preview/admin'||req.url==='/__preview/user'){
    res.writeHead(302,{'set-cookie':`sid=${req.url.endsWith('admin')?adminSid:userSid}; HttpOnly; SameSite=Lax; Path=/`,location:'/admin/stats'});res.end();return;
  }
  handle(req,res);
});
server.listen(Number(process.env.PREVIEW_PORT||3095),'127.0.0.1',()=>console.log('Synthetic traffic preview on loopback port '+server.address().port));

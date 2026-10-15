// Local synthetic-data preview only. No production data, credentials or background jobs.
process.env.NODE_ENV = 'test';
process.env.DB_FILE = ':memory:';
const { createServer } = await import('node:http');
const { sql } = await import('../src/db.js');
const { handle } = await import('../src/app.js');
const { createSession } = await import('../src/lib/auth.js');
const { requestSource } = await import('../src/lib/source.js');
const { recordCall, flushStats } = await import('../src/lib/stats.js');
sql("INSERT INTO users(id,email,password_hash,is_admin) VALUES (1,'admin@preview.example','unused',1),(2,'editor@preview.example','unused',0)").run();
sql("INSERT INTO api_keys(id,user_id,name,prefix,key_hash) VALUES (700,2,'内容站 · 正式网站','preview','synthetic-placeholder'),(701,2,'<img src=x onerror=alert(1)> 长中文测试标签','preview','another-placeholder')").run();
const insert=sql(`INSERT INTO request_log(ts,user_id,key_id,ip,path,status,ms,referer,source_basis,source_state,origin_host,referer_host,rid,client)
  VALUES (?,?,?,'127.0.0.1',?,?,?,?,?,?,?,?,?,'browser')`);
const now=Date.now();
sql('UPDATE source_meta SET started_at = ? WHERE id = 1').run(now-8*86400_000);
for(let i=0;i<95;i++) {
  const source=requestSource(i%11===0 ? {} : { origin:`https://${i%3===0?'blog.example.com':i%3===1?'shop.example.com':`site-${String(i%41).padStart(2,'0')}.example`}`,
    referer:i%7===0?'https://other.example/private?redacted=yes':undefined });
  const ts=now-i*2400_000, path=i%4===0?'/api/tools/hash':'/api/tools/uuid', status=i%9===0?502:i%5===0?400:200;
  insert.run(ts,i%11===0?null:2,i%11===0?null:i%2?700:701,path,status,30+i,source.host,source.basis,source.state,source.originHost,source.refererHost,`preview${i}-0123456789`);
  recordCall({ts,path,status,ms:30+i,via:i%11===0?'anon':'apikey'});
}
flushStats();
const sid=createSession(1), userSid=createSession(2);
const server=createServer((req,res)=>{
  if(req.url==='/__preview/admin'||req.url==='/__preview/user') {
    res.writeHead(302,{'set-cookie':`sid=${req.url.endsWith('admin')?sid:userSid}; HttpOnly; SameSite=Lax; Path=/`,location:'/admin/stats'}); res.end(); return;
  }
  handle(req,res);
});
export { server };
server.listen(Number(process.env.PREVIEW_PORT||3094),'127.0.0.1',()=>console.log('Synthetic source preview: http://127.0.0.1:'+server.address().port+'/__preview/admin'));

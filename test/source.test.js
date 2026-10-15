import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { requestSource, websiteHost } from '../src/lib/source.js';
import { migrateSources } from '../src/lib/source-migration.js';
import { sourceHost, checkKeySource } from '../src/lib/keysource.js';
import { refererHost } from '../src/lib/stats.js';
import { db, sql } from '../src/db.js';
import { logRequest, pruneLogs } from '../src/lib/limits.js';
import { sources, sourceAttribution } from '../src/lib/source-analytics.js';
import { audience, endpointDetail, parseRange } from '../src/lib/analytics.js';
import { handle } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';

test('shared parser: missing/null/malformed/forged/conflict/Unicode/long domains', () => {
  assert.equal(requestSource({}).state, 'missing');
  assert.equal(requestSource({ origin: 'null', referer: null }).state, 'opaque');
  for (const raw of ['javascript:alert(1)', 'file://example.com', 'https://good.com\\@evil.com', 'https://good.com,https://bad.com',
    'https://good.com\n', 'https://u:p@good.com', 'https://bad..com', 'https://bad_name.com', 'https://%65xample.com', ['https://good.com'], 'http:///good.com']) {
    assert.equal(websiteHost(raw), null, String(raw));
  }
  const r = requestSource({ origin: 'https://Origin.Example:443', referer: 'https://referer.example/a?private=secret' });
  assert.deepEqual(r, { host: 'origin.example', basis: 'origin', state: 'conflict', originHost: 'origin.example', refererHost: 'referer.example' });
  assert.equal(refererHost({ origin: 'https://a.test', referer: 'https://b.test' }), sourceHost({ origin: 'https://a.test', referer: 'https://b.test' }));
  assert.equal(requestSource({ origin: 'https://a.test/path', referer: 'https://b.test/path?q=x' }).host, 'b.test');
  assert.equal(requestSource({ origin: 'null', referer: 'https://b.test' }).state, 'fallback');
  assert.equal(requestSource({ origin: 'https://例子.中国', referer: 'https://xn--fsqu00a.xn--fiqs8s/post' }).state, 'matched');
  const long = `${'a'.repeat(63)}.${'b'.repeat(63)}.example`;
  assert.equal(refererHost({ origin: `https://${long}` }), long);
  assert.equal(websiteHost(`https://${'x'.repeat(64)}.com`), null);
  assert.equal(websiteHost('http://[2001:db8::1]:8080/a'), '[2001:db8::1]');
  assert.equal(websiteHost('https://Example.com.'), 'example.com');
  // A forged but syntactically valid header is intentionally not treated as proof of identity.
  assert.equal(sourceHost({ origin: 'https://forged.example' }), 'forged.example');
  assert.doesNotThrow(() => checkKeySource('*.example.com\n1.2.3.0/24', { headers: { origin: 'https://sub.example.com' }, ip: '8.8.8.8' }));
  assert.doesNotThrow(() => checkKeySource('example.com', { headers: { origin: 'null', referer: 'https://example.com/a' }, ip: '8.8.8.8' }));
  assert.throws(() => checkKeySource('example.com', { headers: { origin: 'https://other.com', referer: 'https://example.com' }, ip: '8.8.8.8' }), { status: 403 });
});

test('transactional legacy backfill, repeated migration, uncertain truncated names, rollback and raw deletion', () => {
  const old = new DatabaseSync(':memory:');
  old.exec('CREATE TABLE request_log (id INTEGER PRIMARY KEY, ts INTEGER, user_id INTEGER, key_id INTEGER, path TEXT, status INTEGER, referer TEXT)');
  const add = old.prepare("INSERT INTO request_log(ts,path,status,referer) VALUES (?, '/api/a', ?, ?)");
  add.run(1000, 200, 'old.example'); add.run(2000, 500, null); add.run(3000, 400, 'a'.repeat(96)+'.com');
  migrateSources(old, 4000); migrateSources(old, 5000);
  assert.equal(old.prepare('SELECT SUM(calls) AS n FROM source_daily').get().n, 3);
  assert.deepEqual({ ...old.prepare('SELECT * FROM source_meta').get() }, { id: 1, started_at: 4000, backfilled_from: 1000, backfilled_to: 3000 });
  assert.equal(old.prepare("SELECT source_state FROM request_log WHERE id = 3").get().source_state, 'legacy_unverifiable');
  old.exec('BEGIN'); add.run(5000, 503, 'rollback.test'); old.exec('ROLLBACK');
  assert.equal(old.prepare('SELECT SUM(calls) AS n FROM source_daily').get().n, 3);
  add.run(6000, 200, 'new.example'); old.exec('DELETE FROM request_log'); migrateSources(old, 7000);
  assert.equal(old.prepare('SELECT SUM(calls) AS n FROM source_daily').get().n, 4);
  old.close();
});

test('failed migration rolls back columns, marker and trigger, then can be retried safely', () => {
  const old = new DatabaseSync(':memory:');
  old.exec('CREATE TABLE request_log (id INTEGER PRIMARY KEY, ts INTEGER, user_id INTEGER, key_id INTEGER, path TEXT, status INTEGER, referer TEXT); CREATE TABLE source_daily (bad TEXT)');
  assert.throws(() => migrateSources(old));
  assert.equal(old.prepare('PRAGMA table_info(request_log)').all().some(c=>c.name==='source_basis'),false);
  assert.equal(old.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('source_meta','source_log_insert')").get().n,0);
  old.exec('DROP TABLE source_daily'); migrateSources(old); migrateSources(old);
  assert.equal(old.prepare('SELECT COUNT(*) AS n FROM source_meta').get().n,1);
  old.close();
});

const admin = Number(sql("INSERT INTO users(email,password_hash,is_admin) VALUES ('source-admin@example.test','unused',1)").run().lastInsertRowid);
const user = Number(sql("INSERT INTO users(email,password_hash) VALUES ('source-user@example.test','unused')").run().lastInsertRowid);
sql("INSERT INTO api_keys(id,user_id,name,prefix,key_hash) VALUES (700,?,'<img src=x onerror=alert(1)> 测试标签','dummy','synthetic-non-credential')").run(user);
const adminSid = createSession(admin), userSid = createSession(user);
const server = createServer(handle).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());
const query = s => new URLSearchParams(s);
const range = () => ({ ...parseRange(query('range=7d')), to: Date.now() + 1 });
async function get(path, sid = adminSid) {
  const res = await fetch(base + path, { headers: sid ? { cookie: `sid=${sid}` } : {} });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

test('log ingestion, durable ranks/pagination/search/filter, labels, failures and full denominator', async () => {
  for (let i = 0; i < 27; i++) logRequest({ user: { id: user }, keyId: 700, ip: '127.0.0.1', path: '/api/tools/uuid', status: i % 3 ? 200 : 503, ms: 1,
    headers: { origin: `https://site${String(i).padStart(2,'0')}.example`, referer: 'https://conflict.example/private?secret=yes', cookie: 'secret', authorization: 'secret', 'x-api-key': 'secret' }, rid: `source${i}-0123456789` });
  logRequest({ ip: '127.0.0.1', path: '/api/tools/hash', status: 400, ms: 1, headers: { origin: 'null' } });
  const row = sql('SELECT * FROM request_log WHERE key_id = 700 LIMIT 1').get();
  assert.equal(row.source_state, 'conflict'); assert.equal(row.source_basis, 'origin');
  assert.doesNotMatch(JSON.stringify(row), /private|secret|Cookie|Authorization/);
  const d = sources(range(), query('size=10'));
  assert.equal(d.total, 28); assert.equal(d.totals.calls, 28); assert.equal(d.totals.errors, 10); assert.equal(d.totals.conflicts, 27);
  assert.equal(d.otherCalls, 18); assert.equal(d.items.length, 10); assert.equal(d.items[0].share, 3.57);
  const next = sources(range(), query('size=10&page=2'));
  assert.equal(new Set([...d.items,...next.items].map(r=>r.host)).size, 20);
  assert.equal(sources(range(), query('q=site01')).totals.calls, 1);
  assert.equal(sources(range(), query('q=%25')).totals.calls, 0, 'LIKE wildcards are literal');
  assert.equal(sources(range(), query('user='+user+'&key=700&path=/api/tools/uuid&basis=origin&state=conflict')).totals.calls, 27);
  const a = sourceAttribution(range(), query('host=site01.example'));
  assert.equal(a.items[0].keyName, '<img src=x onerror=alert(1)> 测试标签');
  assert.equal(a.items[0].email, 'source-user@example.test');
  const au = audience(range()); assert.equal(au.refererTotal,28); assert.equal(au.otherReferer,7);
  const ep = endpointDetail(range(), '/api/tools/uuid'); assert.equal(ep.refererTotal,27); assert.equal(ep.otherReferer,17);
  const res = await get('/admin/analytics/source-requests?range=7d&host=site01.example');
  assert.equal(res.status,200); assert.equal(res.body.data.items[0].basis,'origin');
  assert.doesNotMatch(JSON.stringify(res.body), /key_hash|password|synthetic-non-credential|private|secret/);
  const detail = await get('/admin/request?rid=source1-0123456789');
  assert.equal(detail.body.data.source.state, 'conflict');
});

test('admin authentication before validation, parameter validation and no-store', async () => {
  for (const route of ['sources','source-attribution','source-requests']) {
    assert.equal((await get(`/admin/analytics/${route}?range=bad`, '')).status,401);
    assert.equal((await get(`/admin/analytics/${route}?range=bad`, userSid)).status,403);
    const r = await get(`/admin/analytics/${route}?range=7d`);
    assert.equal(r.status,200); assert.equal(r.headers.get('cache-control'),'no-store');
    for (const value of ['page=0','page=1e2','size=101','user=-1','key=1.5','sort=drop','state=nope','host=x.com%2Fa','user=1%20OR%201=1'])
      assert.equal((await get(`/admin/analytics/${route}?${value}`)).status,400,value);
  }
  assert.equal((await get('/admin/analytics/sources?range=custom&from=2026-02-30&to=2026-03-02')).status,400);
});

test('Beijing midnight and half-open ranges combine full-day and raw boundaries without duplication', () => {
  const start=Date.parse(new Date(Date.now()+8*3600_000).toISOString().slice(0,10)+'T00:00:00+08:00')-86400_000;
  for(const ts of [start-1,start,start+1,start+86400_000-1,start+86400_000])
    sql("INSERT INTO request_log(ts,path,status,ms,referer) VALUES (?, '/api/boundary',200,1,'boundary.example')").run(ts);
  const q=query('host=boundary.example');
  assert.equal(sources({from:start,to:start+86400_000},q).totals.calls,3);
  assert.equal(sources({from:start+1,to:start+86400_000-1},q).totals.calls,1);
  assert.equal(sources({from:start-1,to:start+86400_000+1},q).totals.calls,5);
});

test('whole day aggregates survive raw expiry; partial day gaps and source retention are explicit', () => {
  const now = Date.now(), oldTs = now - 40*86400_000;
  const day = new Date(oldTs + 8*3600_000).toISOString().slice(0,10);
  sql("INSERT INTO request_log(ts,path,status,ms,referer) VALUES (?, '/api/tools/uuid',503,1,'retained.example')").run(oldTs);
  const oldRange = parseRange(query(`range=custom&from=${day}&to=${day}`));
  pruneLogs();
  assert.equal(sql("SELECT COUNT(*) AS n FROM request_log WHERE referer = 'retained.example'").get().n,0);
  assert.equal(sources(oldRange,query('host=retained.example')).totals.calls,1);
  assert.equal(sources({ ...oldRange, from: oldRange.from+1 },query('host=retained.example')).coverage.missing[0].reason,'raw_boundary_expired');
  const tooOld = now-400*86400_000;
  sql("INSERT INTO request_log(ts,path,status,ms,referer) VALUES (?, '/api/tools/uuid',200,1,'expired.example')").run(tooOld);
  pruneLogs();
  assert.equal(sql("SELECT COUNT(*) AS n FROM source_daily WHERE host = 'expired.example'").get().n,0);
});

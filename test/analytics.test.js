// 详细统计与运行状态：采集维度、按小时 / 按天汇总、限流计数、各统计接口、自动检测与故障记录
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

process.env.ANON_DAILY_LIMIT = '1000';
process.env.ANON_MINUTE_LIMIT = '8';
const { handle } = await import('../src/app.js');
const { sql } = await import('../src/db.js');
const { flushStats, percentile, clientOf, refererHost, regionOf, recordCall, latBucket } = await import('../src/lib/stats.js');
const { parseRange, statusData } = await import('../src/lib/analytics.js');
const { runHealthCheck, updateIncidents, passed } = await import('../src/lib/health.js');

let server, base;
before(async () => {
  server = createServer(handle).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function client() {
  let cookie = '';
  return async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie?.() ?? []) cookie = c.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { status: res.status, body: json };
  };
}

test('耗时分桶与百分位估算', () => {
  assert.equal(latBucket(10), 0);
  assert.equal(latBucket(50), 0);
  assert.equal(latBucket(51), 1);
  assert.equal(latBucket(99999), 9);
  assert.equal(percentile([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0.95), null);
  // 100 次全在 50~100ms：P50 在区间中间
  assert.equal(percentile([0, 100, 0, 0, 0, 0, 0, 0, 0, 0], 0.5), 75);
  // 95 次很快、5 次很慢：P95 仍在快的那一档
  assert.ok(percentile([95, 0, 0, 0, 0, 0, 0, 0, 0, 5], 0.95, 9000) <= 50);
  assert.equal(percentile([0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 0.99, 8000) > 5000, true);
});

test('客户端类型、来源域名、IP 属地', () => {
  assert.equal(clientOf('curl/8.4.0'), 'curl');
  assert.equal(clientOf('python-requests/2.31'), 'python');
  assert.equal(clientOf('Mozilla/5.0 (compatible; Baiduspider/2.0)'), 'bot');
  assert.equal(clientOf('Mozilla/5.0 (Windows NT 10.0) Chrome/128'), 'browser');
  assert.equal(clientOf('Mozilla/5.0 ... MicroMessenger/8.0'), 'app');
  assert.equal(clientOf(''), 'unknown');
  assert.equal(refererHost({ referer: 'https://Blog.Example.com/post/1?x=1' }), 'blog.example.com', '只记域名');
  assert.equal(refererHost({ origin: 'https://site.cn' }), 'site.cn');
  assert.equal(refererHost({ referer: 'javascript:alert(1)' }), null);
  assert.equal(refererHost({}), null);
  assert.equal(regionOf('114.114.114.114').region, '江苏省');
  assert.equal(regionOf('8.8.8.8').region, 'United States');
  assert.deepEqual(regionOf('::1'), { region: null, isp: null });
});

test('完整流程：调用记录各维度，按小时 / 按天汇总，限流单独计数，各统计接口可用', async () => {
  const admin = client();
  assert.equal((await admin('POST', '/auth/register', { email: 'admin@example.com', password: 'password123' })).status, 200);
  const key = (await admin('POST', '/account/keys', { name: '测试' })).body.data.key;

  const anon = client();
  // 匿名：浏览器 + 来源网站
  for (let i = 0; i < 3; i++) {
    assert.equal((await anon('GET', '/api/tools/uuid', undefined, { referer: 'https://blog.example.com/a', 'user-agent': 'Mozilla/5.0 Chrome/128' })).status, 200);
  }
  // API Key + curl
  await anon('GET', '/api/tools/uuid', undefined, { 'x-api-key': key, 'user-agent': 'curl/8.0' });
  // 参数错误（4xx）
  assert.equal((await anon('GET', '/api/tools/hash', undefined, { 'user-agent': 'python-requests/2' })).status, 400);
  // 网页登录用户
  await admin('GET', '/api/tools/uuid');
  // 触发每分钟限流（匿名每分钟 8 次，前面已经用了 4 次）
  const results = [];
  for (let i = 0; i < 6; i++) results.push((await anon('GET', '/api/tools/uuid')).status);
  assert.ok(results.includes(429));
  const limitedCount = results.filter((s) => s === 429).length;

  const row = sql("SELECT * FROM request_log WHERE path = '/api/tools/uuid' AND referer IS NOT NULL LIMIT 1").get();
  assert.equal(row.referer, 'blog.example.com');
  assert.equal(row.client, 'browser');
  assert.equal(row.via, 'anon');
  assert.ok(row.bytes > 20, '记录返回字节数');
  assert.equal(row.cached, 0);
  assert.equal(sql("SELECT via FROM request_log WHERE client = 'curl'").get().via, 'apikey');
  assert.equal(sql('SELECT COUNT(*) AS n FROM request_log WHERE status = 429').get().n, 0, '限流不写明细');

  flushStats();
  const h = sql("SELECT SUM(calls) AS calls, SUM(limited) AS limited, SUM(anon) AS anon, SUM(apikey) AS apikey, SUM(session) AS session FROM stats_hourly WHERE path = '/api/tools/uuid'").get();
  assert.equal(h.limited, limitedCount);
  assert.equal(h.apikey, 1);
  assert.equal(h.session, 1);
  assert.equal(h.calls, h.anon + h.apikey + h.session);
  const d = sql("SELECT SUM(calls) AS calls FROM stats_daily WHERE path = '/api/tools/uuid'").get();
  assert.equal(d.calls, h.calls, '按天与按小时一致');
  assert.equal(sql("SELECT SUM(e4xx) AS n FROM stats_hourly WHERE path = '/api/tools/hash'").get().n, 1);
  assert.equal(sql("SELECT SUM(count) AS n FROM stats_limited WHERE subject = 'ip:127.0.0.1'").get().n, limitedCount);

  // 统计接口：只有管理员能看
  assert.equal((await anon('GET', '/admin/analytics/overview?range=24h')).status, 401);
  const ov = (await admin('GET', '/admin/analytics/overview?range=24h')).body.data;
  assert.equal(ov.range.gran, '5m');
  assert.ok(ov.kpi.cur.calls >= 6);
  assert.equal(ov.kpi.cur.limited, limitedCount);
  assert.equal(ov.kpi.cur.newUsers, 1);
  assert.ok(ov.kpi.cur.ips >= 1);
  assert.ok(ov.series.length === 288 || ov.series.length === 289, '24 小时按 5 分钟（首尾各有半个区间）');
  assert.equal(ov.series.reduce((n, p) => n + p.calls, 0), ov.kpi.cur.calls);
  assert.equal(ov.heatmap.data.length, 7);
  assert.equal(ov.heatmap.data[0].length, 24);
  assert.ok(ov.categories.find((c) => c.id === 'tools').calls >= 6);

  const ep = (await admin('GET', '/admin/analytics/endpoints?range=7d')).body.data;
  const uuid = ep.items.find((x) => x.path === '/api/tools/uuid');
  assert.equal(uuid.title, '开发小工具');
  assert.equal(uuid.limited, limitedCount);
  assert.equal(uuid.spark.length, 7, '7 天按天的迷你趋势');
  assert.ok(uuid.p95 != null && uuid.avgMs != null);

  const one = (await admin('GET', '/admin/analytics/endpoint?range=today&path=/api/tools/hash')).body.data;
  assert.equal(one.statuses[0].status, 400);
  assert.match(one.errors[0].error, /缺少参数/);
  assert.equal(one.clients[0].client, 'python');
  assert.equal((await admin('GET', '/admin/analytics/endpoint?range=today&path=/api/nope')).status, 404);

  const au = (await admin('GET', '/admin/analytics/audience?range=30d')).body.data;
  assert.equal(au.referers[0].host, 'blog.example.com');
  assert.ok(au.clients.some((c) => c.client === 'curl' && c.name === 'curl'));
  assert.equal(au.topKeys[0].name, '测试');
  assert.equal(au.topUsers[0].email, 'admin@example.com');
  assert.equal(au.ips.total, 1);
  assert.equal(au.ips.new, 1);

  const us = (await admin('GET', '/admin/analytics/users?range=7d')).body.data;
  assert.equal(us.totalUsers, 1);
  assert.equal(us.daily.length, 7);
  assert.equal(us.daily.at(-1).registrations, 1);
  assert.equal(us.dau, 1);

  const is = (await admin('GET', '/admin/analytics/issues?range=today')).body.data;
  assert.equal(is.limited.total, limitedCount);
  assert.equal(is.limited.subjects[0].type, 'ip');
  assert.equal(is.limited.subjects[0].label, '127.0.0.1');
  assert.ok(is.errors.some((e) => e.path === '/api/tools/hash' && e.status === 400));

  assert.equal((await admin('GET', '/admin/analytics/overview?range=1y')).status, 400);
  assert.equal((await admin('GET', '/admin/analytics/overview?range=custom&from=2026-01-01')).status, 400);
});

test('时间范围', () => {
  const now = Date.parse('2026-09-28T10:30:00+08:00');
  const q = (s) => new URLSearchParams(s);
  const t = parseRange(q('range=today'), now);
  assert.equal(t.from, Date.parse('2026-09-28T00:00:00+08:00'));
  assert.equal(t.prevTo, t.from);
  assert.equal(parseRange(q('range=7d'), now).from, Date.parse('2026-09-22T00:00:00+08:00'));
  assert.equal(parseRange(q('range=30d'), now).gran, 'day');
  const c = parseRange(q('range=custom&from=2026-09-01&to=2026-09-02'), now);
  assert.equal(c.gran, 'hour');
  assert.equal(c.to - c.from, 2 * 86400_000);
  assert.throws(() => parseRange(q('range=custom&from=2026-09-05&to=2026-09-01'), now), { status: 400 });
});

test('自动检测：结果写入并计入可用率；连续两次失败记为故障，恢复后自动结束', async () => {
  assert.equal(passed('ok'), true);
  assert.equal(passed('param'), true);
  assert.equal(passed('timeout'), false);
  const targets = [
    { module: 'uuid-demo', path: '/api/tools/uuid', method: 'GET', attempts: [{ query: {}, body: {} }] },
    { module: 'broken', path: '/api/__broken', method: 'GET', attempts: [{ query: {}, body: {} }] },
  ];
  const { apiRouter } = await import('../src/registry.js');
  const { HttpError } = await import('../src/lib/http.js');
  let fail = true;
  apiRouter.add('GET', '/api/__broken', () => { if (fail) throw new HttpError(502, '上游服务响应超时'); return { data: {} }; }, { route: { method: 'GET' }, module: { name: 'broken' } });

  const r1 = await runHealthCheck({ targets });
  assert.equal(r1.total, 2);
  assert.equal(r1.failed, 1);
  assert.equal(sql("SELECT COUNT(*) AS n FROM incidents WHERE module = 'broken'").get().n, 0, '第一次失败不算故障');
  await runHealthCheck({ targets });
  const inc = sql("SELECT * FROM incidents WHERE module = 'broken'").get();
  assert.ok(inc && inc.ended_at == null, '连续两次失败开始故障');
  assert.match(inc.reason, /上游服务响应超时/);
  fail = false;
  await runHealthCheck({ targets });
  assert.ok(sql('SELECT ended_at FROM incidents WHERE id = ?').get(inc.id).ended_at, '恢复后结束');
  const daily = sql("SELECT checks, fails FROM health_daily WHERE path = '/api/__broken'").get();
  assert.deepEqual({ ...daily }, { checks: 3, fails: 2 });
});

test('实际调用大面积失败也记为故障', () => {
  const now = Date.now();
  for (let i = 0; i < 12; i++) sql('INSERT INTO request_log (ts, ip, path, status, ms) VALUES (?, ?, ?, ?, ?)').run(now - 1000, '1.1.1.1', '/api/hot/weibo', 502, 100);
  updateIncidents(now, [], (p) => (p === '/api/hot/weibo' ? 'hot-weibo' : null));
  const inc = sql("SELECT * FROM incidents WHERE module = 'hot-weibo'").get();
  assert.equal(inc.source, 'traffic');
  assert.match(inc.reason, /12 次调用中 12 次失败/);
});

test('公开运行状态：整体可用率、90 天可用率条、故障记录，不含 IP 和用户', async () => {
  recordCall({ path: '/api/tools/uuid', status: 200, ms: 20 });
  const st = statusData();
  assert.equal(st.days.length, 90);
  assert.equal(st.hours.length, 24);
  const m = st.modules.find((x) => x.name === 'hot-weibo');
  assert.equal(m.status, 'down', '有未结束的故障');
  assert.ok(m.incidentSince);
  const dev = st.modules.find((x) => x.name === 'devtools');
  assert.equal(dev.days.length, 90);
  assert.ok(dev.days.at(-1) > 0);
  assert.equal(dev.spark.length, 24);
  assert.ok(st.uptime.d1 != null && st.uptime.d7 != null && st.uptime.d30 != null);
  assert.ok(st.incidents.some((i) => i.module === 'hot-weibo' && i.title === '微博热搜' && !i.endedAt));
  const text = JSON.stringify(st);
  assert.doesNotMatch(text, /127\.0\.0\.1|1\.1\.1\.1|admin@example\.com|blog\.example\.com/, '公开数据不含 IP、用户、来源');
  const res = await fetch(`${base}/status`);
  const body = await res.json();
  assert.equal(body.data.days.length, 90);
  assert.ok(Array.isArray(body.data.incidents));
});

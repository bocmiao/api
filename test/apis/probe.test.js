import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import probeModule, {
  POLL, API_BASE, RATE_LIMIT_MSG, buildLocations, checkProbeTarget, parseProbeUrl, summarize,
  normalizePing, normalizeHttp, normalizeDns, normalizeTraceroute, countryName,
} from '../../src/apis/net/probe.js';
import netModules from '../../src/apis/net/index.js';
import { cache } from '../../src/lib/cache.js';
import { HttpError } from '../../src/lib/http.js';
import { BLOCKED_MSG } from '../../src/apis/net/common.js';
import { assertFieldsDocumented } from '../helpers/fields.js';

const route = (path) => probeModule.routes.find((r) => r.path === path);
const q = (obj) => new URLSearchParams(obj);
const call = (path, obj) => route(path).handler({ query: q(obj) });

const SAVED = { ...POLL };
const savedToken = process.env.GLOBALPING_TOKEN;
beforeEach(() => {
  Object.assign(POLL, { intervalMs: 1, timeoutMs: 200, requestTimeoutMs: 1000 });
  cache.store.clear();
  delete process.env.GLOBALPING_TOKEN;
});
afterEach(() => {
  Object.assign(POLL, SAVED);
  if (savedToken === undefined) delete process.env.GLOBALPING_TOKEN;
  else process.env.GLOBALPING_TOKEN = savedToken;
});

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const PROBES = {
  bj: { continent: 'AS', region: 'Eastern Asia', country: 'CN', state: null, city: 'Beijing', asn: 4134, network: 'China Telecom', latitude: 39.9, longitude: 116.4, tags: [] },
  sh: { continent: 'AS', region: 'Eastern Asia', country: 'CN', state: null, city: 'Shanghai', asn: 4837, network: 'China Unicom', latitude: 31.2, longitude: 121.5, tags: [] },
  bj2: { continent: 'AS', region: 'Eastern Asia', country: 'CN', state: null, city: 'Beijing', asn: 9808, network: 'China Mobile', latitude: 39.9, longitude: 116.4, tags: [] },
  la: { continent: 'NA', region: 'Northern America', country: 'US', state: 'CA', city: 'Los Angeles', asn: 13335, network: 'Cloudflare', latitude: 34.05, longitude: -118.24, tags: [] },
};

const pingResult = (min, avg, max, total, rcv) => ({
  status: 'finished',
  rawOutput: 'PING ...',
  resolvedAddress: '110.242.68.66',
  resolvedHostname: '110.242.68.66',
  timings: Array.from({ length: rcv }, (_, i) => ({ ttl: 52, rtt: [min, avg, max][i] ?? avg })),
  stats: { min, avg, max, total, rcv, drop: total - rcv, loss: Math.round(((total - rcv) / total) * 10000) / 100 },
});

const PING_RESULTS = [
  { probe: PROBES.bj, result: pingResult(10, 12, 14, 3, 3) },
  { probe: PROBES.sh, result: pingResult(30, 32, 34, 3, 2) },
  { probe: PROBES.bj2, result: pingResult(20, 22, 24, 3, 3) },
  { probe: PROBES.la, result: { status: 'finished', rawOutput: 'PING ...', resolvedAddress: '110.242.68.66', timings: [], stats: { min: null, avg: null, max: null, total: 3, rcv: 0, drop: 3, loss: 100 } } },
];

// 模拟 Globalping：POST 返回 id，GET 前 n 次 in-progress，之后 finished
function mockGlobalping(t, { results, pollsBeforeDone = 1, postStatus = 202, postBody, getStatus = 200, neverFinish = false } = {}) {
  const calls = [];
  let polls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
    if ((init.method ?? 'GET') === 'POST') {
      return json(postStatus, postBody ?? { id: 'm123', probesCount: results?.length ?? 0 });
    }
    if (getStatus !== 200) return json(getStatus, { error: { type: 'x', message: 'err' } });
    polls++;
    const done = !neverFinish && polls > pollsBeforeDone;
    const rs = done ? results : results.map((r, i) => (i === 0 ? r : { ...r, result: { status: 'in-progress', rawOutput: '' } }));
    return json(200, { id: 'm123', type: 'ping', status: done ? 'finished' : 'in-progress', probesCount: results.length, results: rs });
  });
  return calls;
}

describe('参数与目标校验', () => {
  test('region 映射', () => {
    assert.deepEqual(buildLocations('china'), { region: 'china', locations: [{ country: 'CN' }] });
    assert.deepEqual(buildLocations('asia'), { region: 'asia', locations: [{ continent: 'AS' }] });
    assert.deepEqual(buildLocations('world'), { region: 'world', locations: undefined });
    assert.deepEqual(buildLocations('jp'), { region: 'JP', locations: [{ country: 'JP' }] });
    assert.throws(() => buildLocations('mars'), (e) => e instanceof HttpError && e.status === 400);
  });

  test('拒绝内网 / 保留地址、localhost、内网顶级域', () => {
    for (const bad of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '::1', 'localhost', 'a.localhost', 'nas.local', 'x.internal', 'router.lan', '0x7f.1']) {
      assert.throws(() => checkProbeTarget(bad), (e) => e.status === 400 && e.message === BLOCKED_MSG, bad);
    }
    for (const bad of ['foo', 'a b.com', '']) {
      assert.throws(() => checkProbeTarget(bad), (e) => e.status === 400, bad);
    }
    assert.equal(checkProbeTarget('WWW.Baidu.com'), 'www.baidu.com');
    assert.equal(checkProbeTarget('8.8.8.8'), '8.8.8.8');
    assert.equal(checkProbeTarget('https://例子.中国/x'), 'xn--fsqu00a.xn--fiqs8s');
  });

  test('parseProbeUrl', () => {
    assert.deepEqual(parseProbeUrl('example.com/a?b=1'), {
      url: 'https://example.com/a?b=1', host: 'example.com', protocol: 'HTTPS', port: 443, path: '/a', query: 'b=1',
    });
    assert.equal(parseProbeUrl('http://example.com:8080').port, 8080);
    assert.equal(parseProbeUrl('http://example.com').protocol, 'HTTP');
    assert.throws(() => parseProbeUrl('http://10.1.2.3/'), (e) => e.message === BLOCKED_MSG);
    assert.throws(() => parseProbeUrl('ftp://example.com/'), (e) => e.status === 400);
    assert.throws(() => parseProbeUrl('https://u:p@example.com/'), (e) => e.status === 400);
  });

  test('内网目标在请求上游前就被拒绝', async (t) => {
    const calls = mockGlobalping(t, { results: [] });
    await assert.rejects(call('/api/probe/ping', { target: '192.168.0.1' }), (e) => e.status === 400 && e.message === BLOCKED_MSG);
    await assert.rejects(call('/api/probe/http', { url: 'http://localhost:3000' }), (e) => e.status === 400);
    await assert.rejects(call('/api/probe/dns', { domain: 'printer.local' }), (e) => e.status === 400);
    await assert.rejects(call('/api/probe/dns', { domain: 'example.com', resolver: '10.0.0.1' }), (e) => e.status === 400);
    await assert.rejects(call('/api/probe/traceroute', { target: '100.64.0.1' }), (e) => e.status === 400);
    assert.equal(calls.length, 0);
  });

  test('limit 上限', async () => {
    await assert.rejects(call('/api/probe/ping', { target: 'example.com', limit: '21' }), (e) => e.status === 400);
    await assert.rejects(call('/api/probe/traceroute', { target: 'example.com', limit: '6' }), (e) => e.status === 400);
    await assert.rejects(call('/api/probe/dns', { domain: 'example.com', type: 'AXFR' }), (e) => e.status === 400);
  });
});

describe('测量流程', () => {
  test('创建 → 轮询 → 完成，请求体正确，聚合正确，字段有说明', async (t) => {
    const calls = mockGlobalping(t, { results: PING_RESULTS, pollsBeforeDone: 2 });
    const r = route('/api/probe/ping');
    const out = await r.handler({ query: q({ target: 'www.baidu.com', region: 'china', limit: '4' }) });
    assert.equal(out.cached, false);
    const d = out.data;

    assert.equal(calls[0].url, `${API_BASE}/measurements`);
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(calls[0].body, {
      type: 'ping', target: 'www.baidu.com', limit: 4, measurementOptions: { packets: 3, protocol: 'ICMP' }, locations: [{ country: 'CN' }],
    });
    assert.equal(calls[0].headers.authorization, undefined);
    assert.equal(calls.length, 4); // 1 POST + 3 GET
    assert.equal(calls[1].url, `${API_BASE}/measurements/m123`);

    assert.equal(d.status, 'finished');
    assert.equal(d.partial, false);
    assert.equal(d.measurementId, 'm123');
    assert.equal(d.results.length, 4);
    assert.equal(d.results[0].countryName, '中国');
    assert.equal(d.results[0].avg, 12);
    assert.deepEqual(d.results[0].times, [10, 12, 14]);
    assert.equal(d.results[3].ok, false);
    assert.equal(d.results[3].latency, null);
    assert.equal(d.results[3].lossRate, 100);

    const s = d.summary;
    assert.equal(s.probes, 4);
    assert.equal(s.ok, 3);
    assert.equal(s.failed, 1);
    assert.equal(s.pending, 0);
    assert.equal(s.avg, 22); // (12 + 32 + 22) / 3
    assert.equal(s.min, 12);
    assert.equal(s.max, 32);
    assert.equal(s.lossRate, 33.33); // 丢 1 + 3 / 共 12 包
    assert.equal(s.fastest.city, 'Beijing');
    assert.equal(s.fastest.network, 'China Telecom');
    assert.equal(s.slowest.city, 'Shanghai');
    assert.deepEqual(s.byCountry.map((c) => [c.country, c.probes, c.ok, c.avg, c.lossRate]), [['CN', 3, 3, 22, 11.11], ['US', 1, 0, null, 100]]);
    assert.deepEqual(s.byCity.map((c) => [c.city, c.probes, c.avg, c.min, c.max]), [
      ['Beijing', 2, 17, 12, 22], ['Shanghai', 1, 32, 32, 32], ['Los Angeles', 1, null, null, null],
    ]);
    assert.equal(s.byCity[2].state, 'CA');

    assertFieldsDocumented(r, d);

    // 60 秒内同样的请求命中缓存，不再请求上游
    const again = await r.handler({ query: q({ target: 'www.baidu.com', region: 'china', limit: '4' }) });
    assert.equal(again.cached, true);
    assert.equal(calls.length, 4);
  });

  test('TCP 模式与 Token 请求头', async (t) => {
    process.env.GLOBALPING_TOKEN = 'tok_abc';
    const calls = mockGlobalping(t, { results: PING_RESULTS.slice(0, 1) });
    const out = await call('/api/probe/ping', { target: '1.1.1.1', region: 'world', protocol: 'tcp', port: '443', packets: '2' });
    assert.deepEqual(calls[0].body, { type: 'ping', target: '1.1.1.1', limit: 5, measurementOptions: { packets: 2, protocol: 'TCP', port: 443 } });
    assert.equal(calls[0].headers.authorization, 'Bearer tok_abc');
    assert.equal(calls[1].headers.authorization, 'Bearer tok_abc');
    assert.equal(out.data.protocol, 'TCP');
    assert.equal(out.data.port, 443);
  });

  test('超时返回部分结果并标 partial，不缓存', async (t) => {
    Object.assign(POLL, { intervalMs: 5, timeoutMs: 30 });
    const calls = mockGlobalping(t, { results: PING_RESULTS, neverFinish: true });
    const r = route('/api/probe/ping');
    const { data } = await r.handler({ query: q({ target: 'example.com' }) });
    assert.equal(data.partial, true);
    assert.equal(data.status, 'in-progress');
    assert.equal(data.results[0].ok, true);
    assert.equal(data.results[1].status, 'in-progress');
    assert.equal(data.results[1].error, '超时未完成');
    assert.equal(data.summary.pending, 3);
    assert.equal(data.summary.failed, 0);
    assert.equal(data.summary.ok, 1);
    assertFieldsDocumented(r, data);
    const n = calls.length;
    await r.handler({ query: q({ target: 'example.com' }) });
    assert.ok(calls.length > n, 'partial 结果不应缓存');
  });

  test('429 → 503 并提示配置 Token', async (t) => {
    mockGlobalping(t, { results: [], postStatus: 429, postBody: { error: { type: 'rate_limit_exceeded', message: 'API rate limit exceeded.' } } });
    await assert.rejects(call('/api/probe/ping', { target: 'example.com' }), (e) => e.status === 503 && e.message === RATE_LIMIT_MSG && /GLOBALPING_TOKEN/.test(e.message));
  });

  test('轮询时 429 同样返回 503', async (t) => {
    mockGlobalping(t, { results: [], getStatus: 429 });
    await assert.rejects(call('/api/probe/ping', { target: 'example.com' }), (e) => e.status === 503);
  });

  test('上游错误', async (t) => {
    mockGlobalping(t, { results: [], postStatus: 422, postBody: { error: { type: 'no_probes_found', message: 'No suitable probes found.' } } });
    await assert.rejects(call('/api/probe/ping', { target: 'example.com', region: 'aq' }), (e) => e.status === 400 && /暂无可用探针/.test(e.message));
  });

  test('上游 400 / 500 / 网络错误 / 无 id', async (t) => {
    mockGlobalping(t, { results: [], postStatus: 400, postBody: { error: { type: 'validation_error', message: 'Parameter validation failed.' } } });
    await assert.rejects(call('/api/probe/ping', { target: 'example.com' }), (e) => e.status === 400 && /Parameter validation failed/.test(e.message));
    t.mock.restoreAll();

    mockGlobalping(t, { results: [], postStatus: 500, postBody: {} });
    await assert.rejects(call('/api/probe/ping', { target: 'example.com' }), (e) => e.status === 502);
    t.mock.restoreAll();

    mockGlobalping(t, { results: [], postBody: { probesCount: 1 } });
    await assert.rejects(call('/api/probe/ping', { target: 'example.com' }), (e) => e.status === 502);
    t.mock.restoreAll();

    t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
    await assert.rejects(call('/api/probe/ping', { target: 'example.com' }), (e) => e.status === 502 && /无法连接/.test(e.message));
  });
});

describe('各类型结果整理', () => {
  test('HTTP 测速', async (t) => {
    const results = [
      { probe: PROBES.bj, result: { status: 'finished', rawOutput: 'HTTP/1.1 200', resolvedAddress: '110.242.68.66', headers: {}, statusCode: 200, statusCodeName: 'OK', timings: { total: 120, dns: 10, tcp: 20, tls: 40, firstByte: 45, download: 5 }, tls: { protocol: 'TLSv1.3', authorized: true } } },
      { probe: PROBES.la, result: { status: 'failed', rawOutput: 'connect ETIMEDOUT 1.2.3.4:443\nmore', statusCode: null, timings: {} } },
    ];
    const calls = mockGlobalping(t, { results });
    const r = route('/api/probe/http');
    const { data } = await r.handler({ query: q({ url: 'https://www.example.com/p?x=1', region: 'world', limit: '2' }) });
    assert.deepEqual(calls[0].body, {
      type: 'http', target: 'www.example.com', limit: 2,
      measurementOptions: { request: { method: 'HEAD', host: 'www.example.com', path: '/p', query: 'x=1' }, protocol: 'HTTPS', port: 443 },
    });
    assert.equal(data.results[0].statusCode, 200);
    assert.deepEqual(data.results[0].timings, { dns: 10, tcp: 20, tls: 40, firstByte: 45, download: 5, total: 120 });
    assert.equal(data.results[0].tlsProtocol, 'TLSv1.3');
    assert.equal(data.results[1].ok, false);
    assert.equal(data.results[1].error, 'connect ETIMEDOUT 1.2.3.4:443');
    assert.equal(data.summary.avg, 120);
    assert.equal(data.summary.lossRate, null);
    assert.equal(data.summary.failed, 1);
    assertFieldsDocumented(r, data);
  });

  test('HTTP/2 只支持 https', async () => {
    await assert.rejects(call('/api/probe/http', { url: 'http://example.com', http2: '1' }), (e) => e.status === 400);
  });

  test('DNS', async (t) => {
    const results = [
      { probe: PROBES.bj, result: { status: 'finished', rawOutput: ';; ...', statusCode: 0, statusCodeName: 'NOERROR', resolver: '114.114.114.114', answers: [{ name: 'www.example.com.', type: 'A', ttl: 300, class: 'IN', value: '93.184.216.34' }], timings: { total: 15 } } },
      { probe: PROBES.sh, result: { status: 'finished', rawOutput: ';; ...', statusCode: 3, statusCodeName: 'NXDOMAIN', resolver: '223.5.5.5', answers: [], timings: { total: 25 } } },
    ];
    const calls = mockGlobalping(t, { results });
    const r = route('/api/probe/dns');
    const { data } = await r.handler({ query: q({ domain: 'www.example.com', type: 'aaaa', resolver: '223.5.5.5' }) });
    assert.deepEqual(calls[0].body.measurementOptions, { query: { type: 'AAAA' }, resolver: '223.5.5.5' });
    assert.equal(data.queryType, 'AAAA');
    assert.equal(data.results[0].answers[0].value, '93.184.216.34');
    assert.equal(data.results[1].statusCodeName, 'NXDOMAIN');
    assert.equal(data.summary.avg, 20);
    assertFieldsDocumented(r, data);
  });

  test('Traceroute', async (t) => {
    const results = [
      {
        probe: PROBES.bj,
        result: {
          status: 'finished', rawOutput: 'traceroute ...', resolvedAddress: '93.184.216.34', resolvedHostname: '93.184.216.34',
          hops: [
            { resolvedAddress: '10.0.0.1', resolvedHostname: '10.0.0.1', timings: [{ rtt: 1 }, { rtt: 2 }] },
            { resolvedAddress: null, resolvedHostname: null, timings: [] },
            { resolvedAddress: '93.184.216.34', resolvedHostname: 'example.com', asn: [15133], timings: [{ rtt: 150 }, { rtt: 152 }] },
          ],
        },
      },
      {
        probe: PROBES.sh,
        result: { status: 'finished', rawOutput: '', resolvedAddress: '93.184.216.34', hops: [{ resolvedAddress: '10.0.0.1', timings: [{ rtt: 1 }] }] },
      },
    ];
    const calls = mockGlobalping(t, { results });
    const r = route('/api/probe/traceroute');
    const { data } = await r.handler({ query: q({ target: 'example.com', protocol: 'tcp', port: '443' }) });
    assert.deepEqual(calls[0].body, { type: 'traceroute', target: 'example.com', limit: 3, measurementOptions: { protocol: 'TCP', port: 443 }, locations: [{ country: 'CN' }] });
    const [a, b] = data.results;
    assert.equal(a.hopCount, 3);
    assert.equal(a.reached, true);
    assert.equal(a.latency, 151);
    assert.deepEqual(a.hops[1], { hop: 2, ip: null, hostname: null, asn: null, rtts: [], avg: null });
    assert.equal(a.hops[2].asn, 15133);
    assert.equal(b.reached, false);
    assert.equal(b.latency, null);
    assert.equal(data.summary.fastest.city, 'Beijing');
    assertFieldsDocumented(r, data);
  });
});

describe('纯函数', () => {
  test('summarize 空列表', () => {
    const s = summarize([]);
    assert.deepEqual(s, { probes: 0, ok: 0, failed: 0, pending: 0, avg: null, min: null, max: null, lossRate: null, fastest: null, slowest: null, byCountry: [], byCity: [] });
  });

  test('normalize 容忍缺字段', () => {
    for (const fn of [normalizePing, normalizeHttp, normalizeDns, normalizeTraceroute]) {
      const x = fn({});
      assert.equal(x.ok, false);
      assert.equal(x.country, null);
      assert.equal(x.latency, null);
    }
    assert.equal(countryName(null), null);
    assert.equal(countryName('US'), '美国');
  });

  test('模块已注册到 net 分类', () => {
    assert.ok(netModules.includes(probeModule));
    assert.equal(probeModule.unofficial, false);
    assert.equal(probeModule.source, 'Globalping');
    for (const r of probeModule.routes) {
      for (const p of r.params) assert.ok(p.desc && p.example !== undefined, `${r.path} ${p.name}`);
    }
  });
});

// DNS 传播检测、批量检测、IP 信誉查询。
// 不访问外网：DoH 用注入的假 fetch，DNSBL / PTR 用注入的假 Resolver，TCP / HTTP(S) 用 127.0.0.1 上的测试服务器，Ping 用假的 execFile。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { generateKeyPairSync, sign } from 'node:crypto';

process.env.ANON_DAILY_LIMIT = '7';
const { handle } = await import('../../src/app.js');
const { default: netModules } = await import('../../src/apis/net/index.js');
const { isBlockedIP } = await import('../../src/lib/netguard.js');
const { BLOCKED_MSG } = await import('../../src/apis/net/common.js');
const {
  checkPropagation, parseDohJson, normalizeData, unquoteTxt, groupAnswers, parseDomain, DOH_SOURCES,
} = await import('../../src/apis/net/propagation.js');
const {
  parseTcpTarget, parseUrlTarget, parsePingTarget, splitTargets, prepareTargets, summarizeBatch, batchTcping, batchHttp, batchPing, MAX_TARGETS,
} = await import('../../src/apis/net/batch.js');
const {
  checkReputation, interpretDnsbl, scoreReputation, detectHosting, dnsblName, requirePublicIp, DNSBLS, SPAMHAUS, levelOf,
} = await import('../../src/apis/net/iprep.js');
const { assertFieldsDocumented, matcher } = await import('../helpers/fields.js');

const NEW = ['dns-propagation', 'batch-check', 'ip-reputation'];
const modules = netModules.filter((m) => NEW.includes(m.name));
const routes = modules.flatMap((m) => m.routes);
const route = (path, method = 'GET') => routes.find((r) => r.path === path && r.method === method);
const q = (obj) => new URLSearchParams(obj);
const allowLoopback = (ip) => ip !== '127.0.0.1' && isBlockedIP(ip);
const fixture = (name) => readFileSync(new URL(`../fixtures/net/${name}`, import.meta.url), 'utf8');

// ---------------- 字段说明：双向校验（与 net.test.js 相同） ----------------

const typeOf = (v) => (v == null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
function collectValues(value, prefix = '', out = new Map()) {
  const add = (p, v) => {
    if (!out.has(p)) out.set(p, []);
    out.get(p).push(v);
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      add(`${prefix}[]`, item);
      collectValues(item, `${prefix}[]`, out);
    }
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = prefix ? `${prefix}.${k}` : k;
      add(p, v);
      collectValues(v, p, out);
    }
  }
  return out;
}
const checked = new Set();
function checkFields(r, ...samples) {
  for (const s of samples) assertFieldsDocumented(r, s);
  const values = new Map();
  for (const s of samples) for (const [p, vs] of collectValues(s)) values.set(p, [...(values.get(p) ?? []), ...vs]);
  const uncovered = [];
  const wrongType = [];
  for (const f of r.fields) {
    const re = matcher(f.name);
    const vs = [...values].filter(([p]) => re.test(p)).flatMap(([, v]) => v);
    if (!vs.some((v) => v != null)) uncovered.push(f.name);
    const bad = [...new Set(vs.map(typeOf))].filter((t) => !f.type.split('|').includes(t));
    if (bad.length) wrongType.push(`${f.name}（声明 ${f.type}，实际出现 ${bad.join('/')}）`);
  }
  assert.deepEqual(uncovered, [], `${r.path} 的样例没有覆盖这些字段：${uncovered.join(', ')}`);
  assert.deepEqual(wrongType, [], `${r.path} 的字段类型与声明不符：${wrongType.join('；')}`);
  checked.add(`${r.method} ${r.path}`);
}

// ---------------- 自签名证书（最小 X.509 DER 编码，SAN 含 127.0.0.1） ----------------

function selfSignedCert() {
  const derLen = (n) => {
    if (n < 128) return Buffer.from([n]);
    const b = [];
    for (let v = n; v; v = Math.floor(v / 256)) b.unshift(v & 0xff);
    return Buffer.from([0x80 | b.length, ...b]);
  };
  const tlv = (tag, ...parts) => {
    const body = Buffer.concat(parts);
    return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
  };
  const seq = (...p) => tlv(0x30, ...p);
  const oid = (s) => {
    const p = s.split('.').map(Number);
    const out = [40 * p[0] + p[1]];
    for (const n of p.slice(2)) {
      const tmp = [];
      for (let v = n; ; v = Math.floor(v / 128)) {
        tmp.unshift((v & 0x7f) | (tmp.length ? 0x80 : 0));
        if (v < 128) break;
      }
      out.push(...tmp);
    }
    return tlv(0x06, Buffer.from(out));
  };
  const time = (d) => tlv(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const alg = seq(oid('1.2.840.10045.4.3.2'));
  const name = seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from('batch.test')))));
  const san = seq(oid('2.5.29.17'), tlv(0x04, seq(tlv(0x87, Buffer.from([127, 0, 0, 1])))));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, Buffer.from([1])), alg, name,
    seq(time(new Date(Date.now() - 86_400_000)), time(new Date(Date.now() + 86_400_000 * 30))), name,
    key.publicKey.export({ type: 'spki', format: 'der' }), tlv(0xa3, seq(san)),
  );
  const der = seq(tbs, alg, tlv(0x03, Buffer.from([0]), sign('sha256', tbs, key.privateKey)));
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`,
    key: key.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

// ---------------- DNS 传播检测 ----------------

const doh = (answers, status = 0) => ({ Status: status, TC: false, RD: true, RA: true, Question: [{ name: 'example.com.', type: 1 }], Answer: answers });
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/dns-json' } });

// 按 DoH 主机名返回不同答案；never 表示一直不响应（直到被 abort）
function fakeFetch(table, calls = []) {
  return async (url, opts) => {
    const u = new URL(url);
    calls.push({ url: u, accept: opts?.headers?.accept });
    const h = table[u.hostname];
    if (h === 'never') {
      return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }));
    }
    if (typeof h === 'function') return h(u);
    if (!h) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    return h;
  };
}

describe('DNS 传播检测', () => {
  test('解析 DoH JSON：只取查询类型的记录，规范化、去重、排序', () => {
    const r = parseDohJson('A', doh([
      { name: 'www.example.com.', type: 5, TTL: 300, data: 'example.com.' },
      { name: 'example.com.', type: 1, TTL: 60, data: '93.184.216.35' },
      { name: 'example.com.', type: 1, TTL: 60, data: '93.184.216.34' },
      { name: 'example.com.', type: 1, TTL: 60, data: '93.184.216.34' },
    ]));
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.records, [{ value: '93.184.216.34', ttl: 60 }, { value: '93.184.216.35', ttl: 60 }]);
    assert.equal(parseDohJson('A', doh(undefined, 3)).status, 'nxdomain');
    assert.equal(parseDohJson('A', doh([])).status, 'empty');
    const fail = parseDohJson('A', doh([], 2));
    assert.equal(fail.status, 'error');
    assert.match(fail.error, /SERVFAIL/);
    assert.equal(parseDohJson('A', { hello: 1 }).status, 'error');
  });

  test('记录值规范化：TXT 引号与分段、MX、AAAA、域名末尾点', () => {
    assert.equal(unquoteTxt('"v=spf1 " "-all"'), 'v=spf1 -all');
    assert.equal(unquoteTxt('"a \\"b\\""'), 'a "b"');
    assert.equal(unquoteTxt('v=spf1 -all'), 'v=spf1 -all');
    assert.equal(normalizeData('MX', '10 MX.Example.com.'), '10 mx.example.com');
    assert.equal(normalizeData('AAAA', '2606:4700:0:0:0:0:0:1111'), '2606:4700::1111');
    assert.equal(normalizeData('NS', 'NS1.Example.COM.'), 'ns1.example.com');
  });

  test('domain 校验：拒绝 IP、localhost 和非法域名，支持中文域名', () => {
    assert.throws(() => parseDomain('1.1.1.1'), /不能是 IP/);
    assert.throws(() => parseDomain('localhost'), { message: BLOCKED_MSG });
    assert.throws(() => parseDomain('not a domain'), /不是合法的域名/);
    assert.equal(parseDomain('例子.中国'), 'xn--fsqu00a.xn--fiqs8s');
    assert.equal(parseDomain('_dmarc.example.com'), '_dmarc.example.com');
  });

  test('答案分组：相同答案归为一组，出错的源不参与', () => {
    const g = groupAnswers([
      { id: 'a', status: 'ok', records: [{ value: '1.1.1.1' }] },
      { id: 'b', status: 'ok', records: [{ value: '2.2.2.2' }] },
      { id: 'c', status: 'ok', records: [{ value: '2.2.2.2' }] },
      { id: 'd', status: 'error', records: [] },
      { id: 'e', status: 'nxdomain', records: [] },
    ]);
    assert.deepEqual(g.map((x) => [x.status, x.values, x.sources]), [
      ['ok', ['2.2.2.2'], ['b', 'c']], ['ok', ['1.1.1.1'], ['a']], ['nxdomain', [], ['e']],
    ]);
  });

  test('一致与不一致、超时、HTTP 错误、非 JSON、连接失败互不影响', async () => {
    const calls = [];
    // Response 只能读一次，每次调用重新生成
    const table = Object.fromEntries(DOH_SOURCES.map((s) => [new URL(s.endpoint).hostname, () => json(doh([{ name: 'example.com.', type: 1, TTL: 100, data: '93.184.216.34' }]))]));
    const ok = await checkPropagation('Example.com', 'A', { fetchImpl: fakeFetch(table, calls) });
    assert.equal(ok.consistent, true);
    assert.equal(ok.responded, DOH_SOURCES.length);
    assert.equal(ok.groups.length, 1);
    assert.equal(ok.majority.tie, false);
    assert.ok(calls.every((c) => c.accept === 'application/dns-json'));
    // 阿里用数字类型，其他用类型名
    assert.equal(calls.find((c) => c.url.hostname === 'dns.alidns.com').url.searchParams.get('type'), '1');
    assert.equal(calls.find((c) => c.url.hostname === 'dns.google').url.searchParams.get('type'), 'A');
    assert.equal(calls[0].url.searchParams.get('name'), 'example.com');

    const mixed = await checkPropagation('example.com', 'A', {
      timeoutMs: 100,
      fetchImpl: fakeFetch({
        ...table,
        'cloudflare-dns.com': () => json(doh([{ name: 'example.com.', type: 1, TTL: 5, data: '1.2.3.4' }])),
        'dns.alidns.com': 'never',
        'doh.pub': () => new Response('<html>not json</html>', { status: 200 }),
        'dns.quad9.net': () => json({ error: 'bad' }, 400),
        'dns.nextdns.io': undefined,
      }),
    });
    assert.equal(mixed.consistent, false);
    assert.equal(mixed.responded, 3);
    assert.equal(mixed.failed, 4);
    assert.deepEqual(mixed.majority.sources, ['google', 'adguard']);
    const by = Object.fromEntries(mixed.sources.map((s) => [s.id, s]));
    assert.match(by.alidns.error, /超时/);
    assert.match(by.dnspod.error, /不是 JSON/);
    assert.equal(by.quad9.error, 'HTTP 400');
    assert.match(by.nextdns.error, /ECONNREFUSED/);
    assert.equal(by.cloudflare.records[0].value, '1.2.3.4');

    // 全部失败：majority 为 null，不一致
    const none = await checkPropagation('example.com', 'MX', { fetchImpl: fakeFetch({}) });
    assert.equal(none.majority, null);
    assert.equal(none.consistent, false);

    // 并列：各一半
    const tie = await checkPropagation('example.com', 'TXT', {
      sources: DOH_SOURCES.slice(0, 2),
      fetchImpl: fakeFetch({
        'dns.google': () => json(doh([{ name: 'example.com.', type: 16, TTL: 5, data: 'v=spf1 -all' }])),
        'cloudflare-dns.com': () => json(doh(undefined, 3)),
      }),
    });
    assert.equal(tie.majority.tie, true);
    assert.equal(tie.majority.sources[0], 'google');

    checkFields(route('/api/dns/propagation'), ok, mixed, none, tie);
  });

  test('路由：参数校验', async () => {
    const r = route('/api/dns/propagation');
    await assert.rejects(r.handler({ query: q({}) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ domain: 'example.com', type: 'SOA' }) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ domain: '10.0.0.1' }) }), { status: 400 });
  });
});

// ---------------- 批量检测 ----------------

let web; let secure; let tcp; let PORT; let SPORT; let TPORT; let CLOSED;
let tls;

before(async () => {
  web = http.createServer((req, res) => {
    if (req.url === '/missing') { res.writeHead(404, { server: 'miao-test' }); return res.end('no'); }
    res.writeHead(200, { server: 'miao-test', 'content-type': 'text/html' });
    res.end('<!doctype html>ok');
  });
  tls = selfSignedCert();
  secure = https.createServer(tls, (req, res) => { res.writeHead(200, { server: 'miao-tls' }); res.end('secure'); });
  tcp = net.createServer((s) => s.end());
  const closed = net.createServer();
  const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  [PORT, SPORT, TPORT, CLOSED] = await Promise.all([listen(web), listen(secure), listen(tcp), listen(closed)]);
  await new Promise((r) => closed.close(r));
});
after(() => {
  web.close();
  secure.close();
  tcp.close();
});

describe('批量检测', () => {
  test('目标解析：host、host:port、[IPv6]:port、IPv6、网址', () => {
    assert.deepEqual(parseTcpTarget('Example.com', 443), { host: 'example.com', port: 443, key: 'example.com:443' });
    assert.deepEqual(parseTcpTarget('example.com:22', 443), { host: 'example.com', port: 22, key: 'example.com:22' });
    assert.deepEqual(parseTcpTarget('[2606:4700::1111]:853', 443), { host: '2606:4700::1111', port: 853, key: '2606:4700::1111:853' });
    assert.equal(parseTcpTarget('2606:4700::1111', 80).port, 80);
    assert.equal(parseTcpTarget('https://example.com:8443/x', 443).port, 8443);
    assert.match(parseTcpTarget('example.com:70000', 443).error, /端口/);
    assert.match(parseTcpTarget('bad host!', 443).error, /不是合法/);
    assert.equal(parseUrlTarget('example.com/a#x').url, 'https://example.com/a');
    assert.equal(parseUrlTarget('http://example.com').url, 'http://example.com/');
    assert.match(parseUrlTarget('http://').error, /不是合法/);
    assert.equal(parsePingTarget('1.1.1.1').host, '1.1.1.1');
  });

  test('拆分、去重、数量上限', () => {
    assert.deepEqual(splitTargets('a.com, b.com，c.com\nd.com'), ['a.com', 'b.com', 'c.com', 'd.com']);
    assert.deepEqual(splitTargets([' a.com ', '', null, 'b.com']), ['a.com', 'b.com']);
    const p = prepareTargets('A.com,a.com,a.com:443,a.com:80', (t) => parseTcpTarget(t, 443));
    assert.deepEqual(p.map((x) => x.target), ['A.com', 'a.com:80']);
    assert.throws(() => prepareTargets('', parsePingTarget), { status: 400 });
    const many = Array.from({ length: MAX_TARGETS + 1 }, (_, i) => `h${i}.example.com`).join(',');
    assert.throws(() => prepareTargets(many, parsePingTarget), /最多同时检测 10 个/);
    // 去重后不超过 10 个即可
    const dup = Array.from({ length: MAX_TARGETS }, (_, i) => `h${i}.example.com`).concat('H0.example.com').join(',');
    assert.equal(prepareTargets(dup, parsePingTarget).length, 10);
  });

  test('汇总：成功数、最快、最慢、平均', () => {
    const s = summarizeBatch([
      { target: 'a', ok: true, ms: 10 }, { target: 'b', ok: true, ms: 30 }, { target: 'c', ok: false, ms: null },
    ]);
    assert.deepEqual(s, { total: 3, success: 2, failed: 1, fastest: { target: 'a', ms: 10 }, slowest: { target: 'b', ms: 30 }, avg: 20 });
    assert.deepEqual(summarizeBatch([{ target: 'x', ok: false, ms: null }]), { total: 1, success: 0, failed: 1, fastest: null, slowest: null, avg: null });
  });

  test('批量 TCPing：每个目标独立成功或失败，内网地址被拒绝', async () => {
    const prepared = prepareTargets([`127.0.0.1:${TPORT}`, `127.0.0.1:${CLOSED}`, '10.0.0.1:22', 'bad host!', 'localhost:80'], (t) => parseTcpTarget(t, 443));
    const r = await batchTcping(prepared, { count: 2, deps: { blocked: allowLoopback } });
    const [ok, refused, internal, bad, local] = r.items;
    assert.equal(ok.ok, true);
    assert.equal(ok.ip, '127.0.0.1');
    assert.equal(ok.received, 2);
    assert.equal(typeof ok.ms, 'number');
    assert.equal(refused.ok, false);
    assert.match(refused.error, /拒绝/);
    assert.equal(internal.error, BLOCKED_MSG);
    assert.match(bad.error, /不是合法/);
    assert.equal(local.error, BLOCKED_MSG);
    assert.equal(r.summary.success, 1);
    assert.equal(r.summary.fastest.target, `127.0.0.1:${TPORT}`);
    checkFields(route('/api/batch/tcping'), r);
    checkFields(route('/api/batch/tcping', 'POST'), r);
  });

  test('批量网站检测：200、404、HTTPS 自签名证书、内网、格式错误', async () => {
    const prepared = prepareTargets([
      `http://127.0.0.1:${PORT}/`, `http://127.0.0.1:${PORT}/missing`, `https://127.0.0.1:${SPORT}/`, 'http://10.0.0.1/', 'http://',
    ], parseUrlTarget);
    const r = await batchHttp(prepared, { deps: { blocked: allowLoopback } });
    const [ok, missing, tlsItem, internal, bad] = r.items;
    assert.equal(ok.ok, true);
    assert.equal(ok.status, 200);
    assert.equal(ok.server, 'miao-test');
    assert.equal(missing.ok, false);
    assert.equal(missing.reachable, true);
    assert.equal(missing.error, 'HTTP 404 未找到');
    assert.equal(tlsItem.ok, true);
    assert.equal(tlsItem.https, true);
    assert.equal(tlsItem.certValid, false);
    assert.equal(internal.reachable, false);
    assert.equal(internal.error, BLOCKED_MSG);
    assert.match(bad.error, /不是合法/);
    assert.equal(r.summary.success, 2);
    checkFields(route('/api/batch/http'), r);
    checkFields(route('/api/batch/http', 'POST'), r);
  });

  test('批量 Ping：复用 ping() 与输出解析', async () => {
    const outputs = { '1.1.1.1': fixture('ping-iputils.txt'), '8.8.8.8': fixture('ping-iputils-timeout.txt') };
    const execFileImpl = (cmd, args, opts, cb) => process.nextTick(cb, null, outputs[args.at(-1)], '');
    const r = await batchPing(prepareTargets('1.1.1.1,8.8.8.8,192.168.1.1,1.1.1.1', parsePingTarget), { count: 2, deps: { execFileImpl } });
    assert.equal(r.items.length, 3);
    const [ok, lost, internal] = r.items;
    assert.equal(ok.ok, true);
    assert.equal(ok.ttl, 57);
    assert.equal(lost.ok, false);
    assert.match(lost.error, /超时/);
    assert.equal(internal.error, BLOCKED_MSG);
    checkFields(route('/api/batch/ping'), r);
    checkFields(route('/api/batch/ping', 'POST'), r);
  });

  test('路由：GET / POST 取参，按目标数调用 charge', async () => {
    const charged = [];
    const charge = (n) => charged.push(n);
    const g = await route('/api/batch/tcping').handler({ query: q({ targets: '10.0.0.1,10.0.0.2,10.0.0.1', port: '22' }), charge });
    assert.deepEqual(charged, [1]);
    assert.equal(g.data.items.length, 2);
    assert.ok(g.data.items.every((i) => i.port === 22 && i.error === BLOCKED_MSG));

    const p = await route('/api/batch/tcping', 'POST').handler({ query: q({}), body: { targets: ['10.0.0.1', '10.0.0.2:80', '10.0.0.3'], count: 1 }, charge });
    assert.deepEqual(charged, [1, 2]);
    assert.equal(p.data.count, 1);
    assert.equal(p.data.items[1].port, 80);

    // 请求体直接是数组
    const arr = await route('/api/batch/ping', 'POST').handler({ query: q({}), body: ['10.0.0.1'], charge });
    assert.deepEqual(charged, [1, 2, 0]);
    assert.equal(arr.data.summary.failed, 1);

    const h = await route('/api/batch/http', 'POST').handler({ query: q({}), body: { urls: 'http://10.0.0.1/ http://192.168.0.1/' } });
    assert.equal(h.data.items.length, 2);

    await assert.rejects(route('/api/batch/http').handler({ query: q({}) }), { status: 400 });
    await assert.rejects(route('/api/batch/tcping', 'POST').handler({ query: q({}), body: { targets: { a: 1 } } }), { status: 400 });
    await assert.rejects(route('/api/batch/tcping').handler({ query: q({ targets: 'a.com', port: '0' }) }), { status: 400 });
  });

  test('平台计费：一批按目标数计次，额度不足整批拒绝', async () => {
    const server = http.createServer(handle).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      // 匿名额度 7 次：3 个目标用掉 3 次
      const r1 = await fetch(`${base}/api/batch/tcping?targets=10.0.0.1,10.0.0.2,10.0.0.3`);
      assert.equal(r1.status, 200);
      assert.equal(r1.headers.get('x-ratelimit-remaining'), '4');
      const body = await r1.json();
      assert.equal(body.data.summary.failed, 3);
      // POST 数组：2 个目标
      const r2 = await fetch(`${base}/api/batch/ping`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targets: ['10.0.0.1', '10.0.0.2'] }) });
      assert.equal(r2.status, 200);
      assert.equal(r2.headers.get('x-ratelimit-remaining'), '2');
      // 剩 2 次，再来 3 个目标：入口计 1 次后还需补扣 2 次，只剩 1 次 → 429
      const r3 = await fetch(`${base}/api/batch/tcping?targets=10.0.0.1,10.0.0.2,10.0.0.3`);
      assert.equal(r3.status, 429);
      assert.match((await r3.json()).message, /本次请求需要 2 次，剩余 1 次/);
    } finally {
      server.close();
    }
  });
});

// ---------------- IP 信誉 ----------------

// 假 Resolver：zones 为 { 区域: 返回码数组 | 'timeout' | 'servfail' }，未列出的区域返回 NXDOMAIN
function fakeResolver({ zones = {}, ptr = [] } = {}) {
  const asked = [];
  return {
    asked,
    create: () => ({
      async resolve4(name) {
        asked.push(name);
        const zone = Object.keys(zones).find((z) => name.endsWith(`.${z}`));
        const v = zones[zone];
        if (v === 'timeout') return new Promise(() => {});
        if (v === 'servfail') throw Object.assign(new Error('x'), { code: 'ESERVFAIL' });
        if (!v) throw Object.assign(new Error('x'), { code: 'ENOTFOUND' });
        return v;
      },
      async reverse() {
        if (ptr === 'error') throw Object.assign(new Error('x'), { code: 'ETIMEOUT' });
        if (!ptr.length) throw Object.assign(new Error('x'), { code: 'ENOTFOUND' });
        return ptr;
      },
    }),
  };
}
const geo = (asn, isp, org = isp) => async () => ({ data: { asn, isp, org, country: '美国', location: '美国 弗吉尼亚州 阿什本' } });

describe('IP 信誉查询', () => {
  test('ip 校验：只接受公网 IP', () => {
    assert.equal(requirePublicIp('::ffff:8.8.8.8'), '8.8.8.8');
    assert.equal(requirePublicIp('2606:4700::1111'), '2606:4700::1111');
    for (const bad of ['10.0.0.1', '127.0.0.1', '::1', '192.168.1.1', 'fe80::1', '100.64.0.1', 'abc']) {
      assert.throws(() => requirePublicIp(bad), { status: 400 }, bad);
    }
  });

  test('DNSBL 查询名与返回码解读', () => {
    assert.equal(dnsblName('1.2.3.4', 'bl.spamcop.net'), '4.3.2.1.bl.spamcop.net');
    const drone = DNSBLS.find((l) => l.zone === 'dnsbl.dronebl.org');
    assert.deepEqual(interpretDnsbl(drone, ['127.0.0.9']).meanings, ['HTTP 代理']);
    assert.equal(interpretDnsbl(drone, []).status, 'clean');
    const refused = interpretDnsbl(SPAMHAUS, ['127.255.255.254']);
    assert.equal(refused.status, 'unavailable');
    assert.match(refused.meanings[0], /公共/);
    assert.equal(interpretDnsbl(drone, ['10.1.1.1']).status, 'error');
    assert.match(interpretDnsbl(drone, ['127.0.0.99']).meanings[0], /127\.0\.0\.99/);
  });

  test('机房关键词', () => {
    assert.equal(detectHosting('AS16509 Amazon.com, Inc.'), 'Amazon AWS');
    assert.equal(detectHosting('AS45102 Alibaba (US) Technology Co., Ltd.'), '阿里云');
    assert.equal(detectHosting('AS24940 Hetzner Online GmbH'), 'Hetzner');
    assert.equal(detectHosting('AS4134 CHINANET-BACKBONE', 'Chinanet'), null);
    assert.equal(detectHosting('AS16591 Google Fiber Inc.'), null);
    assert.equal(detectHosting(null, undefined), null);
  });

  test('评分：黑名单封顶 70，机房 +20，无 PTR +10；PBL 只扣 5', () => {
    const lists = [...DNSBLS, SPAMHAUS];
    const listed = lists.map((l) => ({ name: l.name, status: 'listed', codes: ['127.0.0.2'], meanings: ['x'] }));
    const s = scoreReputation({ dnsbl: listed, lists, datacenter: true, provider: 'OVH', ptr: { status: 'none' } });
    assert.equal(s.riskScore, 100);
    assert.equal(s.level, '高');
    assert.ok(s.reasons.some((r) => r.rule === 'dnsbl-cap' && r.points < 0));
    const pbl = lists.map((l) => (l === SPAMHAUS ? { name: l.name, status: 'listed', codes: ['127.0.0.10'], meanings: ['PBL'] } : { status: 'clean' }));
    assert.equal(scoreReputation({ dnsbl: pbl, lists, datacenter: false, ptr: { status: 'ok' } }).riskScore, 5);
    assert.deepEqual([levelOf(0), levelOf(29), levelOf(30), levelOf(59), levelOf(60)], ['低', '低', '中', '中', '高']);
  });

  test('完整查询：列入、干净、超时、SERVFAIL、Spamhaus 被拒、机房、PTR', async () => {
    const fr = fakeResolver({
      zones: {
        'bl.spamcop.net': ['127.0.0.2'],
        'dnsbl.dronebl.org': ['127.0.0.8', '127.0.0.9'],
        'psbl.surriel.com': 'timeout',
        'all.s5h.net': 'servfail',
        'zen.spamhaus.org': ['127.255.255.254'],
      },
      ptr: ['Ec2-3-5-7-9.compute-1.amazonaws.com.'],
    });
    const bad = await checkReputation('9.7.5.3', { spamhaus: true, createResolver: fr.create, ipInfo: geo('AS16509 Amazon.com, Inc.', 'Amazon.com'), timeoutMs: 50 });
    assert.ok(fr.asked.includes('3.5.7.9.bl.spamcop.net'));
    assert.equal(bad.dnsbl.listed, 2);
    assert.equal(bad.dnsbl.unavailable, 3);
    assert.equal(bad.dnsbl.lists.length, DNSBLS.length + 1);
    const by = Object.fromEntries(bad.dnsbl.lists.map((l) => [l.zone, l]));
    assert.deepEqual(by['dnsbl.dronebl.org'].meanings, ['SOCKS 代理', 'HTTP 代理']);
    assert.match(by['psbl.surriel.com'].error, /超时/);
    assert.equal(by['zen.spamhaus.org'].status, 'unavailable');
    assert.equal(bad.network.datacenter, true);
    assert.equal(bad.network.provider, 'Amazon AWS');
    assert.deepEqual(bad.ptr.names, ['ec2-3-5-7-9.compute-1.amazonaws.com']);
    assert.equal(bad.riskScore, 25 + 35 + 20);
    assert.equal(bad.level, '高');
    assert.match(bad.disclaimer, /VPN/);

    // 干净的住宅 IP：默认不查 Spamhaus
    const fr2 = fakeResolver({ ptr: ['1.2.3.4.static.example.net'] });
    const clean = await checkReputation('1.2.3.4', { createResolver: fr2.create, ipInfo: geo('AS4134 CHINANET-BACKBONE', 'Chinanet') });
    assert.ok(!fr2.asked.some((n) => n.includes('spamhaus')));
    assert.equal(clean.riskScore, 0);
    assert.equal(clean.level, '低');
    assert.deepEqual(clean.reasons, []);
    assert.equal(clean.network.datacenter, false);

    // 归属查询失败 + 没有 PTR：不整体失败
    const noInfo = await checkReputation('5.6.7.8', {
      createResolver: fakeResolver().create, ipInfo: async () => { throw new Error('ip-api 查询失败'); },
    });
    assert.equal(noInfo.network.asn, null);
    assert.equal(noInfo.network.error, 'ip-api 查询失败');
    assert.equal(noInfo.ptr.status, 'none');
    assert.equal(noInfo.riskScore, 10);

    // IPv6：黑名单跳过，只查归属与 PTR（PTR 出错）
    const v6 = await checkReputation('2a01:4f8::1', { createResolver: fakeResolver({ ptr: 'error' }).create, ipInfo: geo('AS24940 Hetzner Online GmbH', 'Hetzner') });
    assert.equal(v6.version, 6);
    assert.ok(v6.dnsbl.lists.every((l) => l.status === 'skipped'));
    assert.equal(v6.ptr.status, 'error');
    assert.equal(v6.network.provider, 'Hetzner');

    checkFields(route('/api/ip/reputation'), bad, clean, noInfo, v6);
  });

  test('路由：参数校验', async () => {
    const r = route('/api/ip/reputation');
    await assert.rejects(r.handler({ query: q({}) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ ip: '10.1.2.3' }) }), /只支持公网 IP/);
    await assert.rejects(r.handler({ query: q({ ip: '8.8.8.8', spamhaus: 'maybe' }) }), { status: 400 });
  });
});

// ---------------- 注册与覆盖 ----------------

test('新模块已注册，路由有 params 与 fields，且每个路由都做了双向字段校验', () => {
  assert.deepEqual(modules.map((m) => m.name), NEW);
  assert.deepEqual(routes.map((r) => `${r.method} ${r.path}`), [
    'GET /api/dns/propagation',
    'GET /api/batch/tcping', 'POST /api/batch/tcping', 'GET /api/batch/http', 'POST /api/batch/http', 'GET /api/batch/ping', 'POST /api/batch/ping',
    'GET /api/ip/reputation',
  ]);
  for (const m of modules) {
    assert.equal(m.category, 'net');
    assert.ok(m.title && m.description && m.source, m.name);
    for (const r of m.routes) {
      assert.ok(r.params.length, `${r.path} 缺少 params`);
      for (const p of r.params) assert.ok(p.desc && p.example != null, `${r.path} ${p.name}`);
      for (const f of r.fields) assert.match(f.desc, /[一-龥]/, `${r.path} ${f.name} 的说明应为中文`);
    }
  }
  const expected = routes.map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(expected.filter((k) => !checked.has(k)), []);
});

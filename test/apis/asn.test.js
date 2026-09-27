// IP 网段与 ASN 查询（RDAP，mock fetch）
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import asnModule, {
  ipToBigInt, bigIntToIp, rangeToCidrs, serversForIp, serversForAsn, registryOf, parseIpNetwork, parseAutnum, readIp, readAsn,
} from '../../src/apis/net/asn.js';
import { cache } from '../../src/lib/cache.js';
import { assertFieldsDocumented, matcher } from '../helpers/fields.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/net/${name}`, import.meta.url), 'utf8');
const json = (name) => JSON.parse(fixture(name));
const q = (o) => new URLSearchParams(o);
const route = (path) => asnModule.routes.find((r) => r.path === path);

const BOOT = {
  'https://data.iana.org/rdap/ipv4.json': fixture('rdap-ipv4-bootstrap.json'),
  'https://data.iana.org/rdap/ipv6.json': fixture('rdap-ipv6-bootstrap.json'),
  'https://data.iana.org/rdap/asn.json': fixture('rdap-asn-bootstrap.json'),
};

// objects：RDAP 查询 URL 的后缀 -> 响应体（或 { status }），其余返回 404
function mockRdap(t, objects = {}, { bootstrap = true } = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    calls.push(u);
    if (BOOT[u]) {
      if (!bootstrap) throw new TypeError('fetch failed');
      return new Response(BOOT[u], { headers: { 'content-type': 'application/json' } });
    }
    for (const [suffix, body] of Object.entries(objects)) {
      if (u.endsWith(suffix)) {
        if (body instanceof Error) throw body;
        if (body?.status) return new Response('x', { status: body.status });
        return new Response(body, { headers: { 'content-type': 'application/rdap+json' } });
      }
    }
    return new Response('{"errorCode":404}', { status: 404 });
  });
  return calls;
}

beforeEach(() => cache.store.clear());

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
function checkFields(r, ...samples) {
  const seen = new Set();
  for (const data of samples) {
    assertFieldsDocumented(r, data);
    const visit = (value, path) => {
      if (Array.isArray(value)) return value.forEach((v) => visit(v, `${path}[]`));
      if (!value || typeof value !== 'object') {
        // 数组里的原始值（如 cidrs[]）也核对类型
        if (path.endsWith('[]')) {
          seen.add(path);
          const f = r.fields.find((x) => matcher(x.name).test(path));
          assert.ok(f?.type.split('|').includes(typeOf(value)), `${r.path} ${path} 实际为 ${typeOf(value)}`);
        }
        return;
      }
      for (const [k, v] of Object.entries(value)) {
        const p = path ? `${path}.${k}` : k;
        seen.add(p);
        const f = r.fields.find((x) => matcher(x.name).test(p));
        assert.ok(f.type.split('|').includes(typeOf(v)), `${r.path} ${p} 实际为 ${typeOf(v)}，说明写的是 ${f.type}`);
        visit(v, p);
      }
    };
    visit(data, '');
  }
  const unseen = r.fields.filter((f) => ![...seen].some((p) => matcher(f.name).test(p))).map((f) => f.name);
  assert.deepEqual(unseen, [], `${r.path} 的样例没有覆盖这些字段：${unseen.join(', ')}`);
}

test('地址换算与 CIDR 计算', () => {
  assert.equal(ipToBigInt('1.1.1.1'), 0x01010101n);
  assert.equal(bigIntToIp(ipToBigInt('2400:3200::1'), 6), '2400:3200::1');
  assert.equal(bigIntToIp(ipToBigInt('2001:db8:0:1:0:0:0:1'), 6), '2001:db8:0:1::1');
  assert.deepEqual(rangeToCidrs('1.1.1.0', '1.1.1.255'), ['1.1.1.0/24']);
  assert.deepEqual(rangeToCidrs('10.0.0.0', '10.0.2.255'), ['10.0.0.0/23', '10.0.2.0/24']);
  assert.deepEqual(rangeToCidrs('2a00:1450::', '2a00:1457:ffff:ffff:ffff:ffff:ffff:ffff'), ['2a00:1450::/29']);
  assert.deepEqual(rangeToCidrs('0.0.0.0', '255.255.255.255'), ['0.0.0.0/0']);
  assert.deepEqual(rangeToCidrs('1.1.1.9', '1.1.1.0'), []);
  assert.deepEqual(rangeToCidrs('1.1.1.0', '::1'), []);
});

test('引导文件：最长前缀匹配、https 优先、ASN 区间', () => {
  const v4 = json('rdap-ipv4-bootstrap.json');
  assert.deepEqual(serversForIp(v4, '1.1.1.1'), ['https://rdap.apnic.net/']);
  assert.deepEqual(serversForIp(v4, '8.8.8.8'), ['https://rdap.arin.net/registry/', 'http://rdap.arin.net/registry/']);
  assert.deepEqual(serversForIp(v4, '9.9.9.9'), []);
  const v6 = json('rdap-ipv6-bootstrap.json');
  assert.deepEqual(serversForIp(v6, '2400:3200::1'), ['https://rdap.apnic.net/']);
  assert.deepEqual(serversForIp(v6, '2a00:1450:4001::1'), ['https://rdap.db.ripe.net/']);
  const asn = json('rdap-asn-bootstrap.json');
  assert.deepEqual(serversForAsn(asn, 13335), ['https://rdap.arin.net/registry/', 'http://rdap.arin.net/registry/']);
  assert.deepEqual(serversForAsn(asn, 4134), ['https://rdap.apnic.net/']);
  assert.deepEqual(serversForAsn(asn, 999999999), []);
  assert.throws(() => serversForIp({}, '1.1.1.1'), { status: 502 });
  assert.equal(registryOf(null, 'whois.ripe.net'), 'RIPE NCC');
  assert.equal(registryOf('https://rdap.org/ip/1.1.1.1', 'whois.apnic.net'), 'APNIC');
});

test('解析 APNIC / ARIN / RIPE 网段', () => {
  const a = parseIpNetwork(json('rdap-ip-apnic.json'), { ip: '1.1.1.1', url: 'https://rdap.apnic.net/ip/1.1.1.1' });
  assert.equal(a.registry, 'APNIC');
  assert.equal(a.name, 'APNIC-LABS');
  assert.equal(a.country, 'AU');
  assert.deepEqual(a.cidrs, ['1.1.1.0/24']);
  assert.equal(a.org, 'APNIC Research and Development');
  assert.equal(a.abuseEmail, 'helpdesk@apnic.net');
  assert.equal(a.asn, null, 'APNIC 不带 AS 号引用');
  assert.ok(a.description.includes('Routed globally by AS13335/Cloudflare'));
  assert.equal(a.description.filter((d) => d === '---------------').length, 1, '去重');
  assert.equal(a.created, '2011-08-10T23:12:35.000Z');

  const g = parseIpNetwork(json('rdap-ip-arin.json'), { ip: '8.8.8.8', url: 'https://rdap.arin.net/registry/ip/8.8.8.8' });
  assert.equal(g.registry, 'ARIN');
  assert.equal(g.asn, 15169);
  assert.equal(g.country, null);
  assert.equal(g.org, 'Google LLC');
  assert.equal(g.abuseEmail, 'network-abuse@google.com', '嵌套在 registrant 下的 abuse 联系人');
  assert.equal(g.created, '2023-12-28T22:24:33.000Z');

  const r = parseIpNetwork(json('rdap-ip-ripe-v6.json'), { ip: '2a00:1450:4001::1' });
  assert.equal(r.registry, 'RIPE NCC');
  assert.equal(r.version, 'IPv6');
  assert.equal(r.country, 'IE');
  assert.deepEqual(r.cidrs, ['2a00:1450::/29'], '没有 cidr0 时由起止地址计算');
  assert.equal(r.org, 'ORG-GIL1-RIPE', '没有名称时用句柄');
  assert.deepEqual(r.description, []);
  assert.equal(r.created, null);

  assert.throws(() => parseIpNetwork({ objectClassName: 'domain' }, { ip: '1.1.1.1' }), { status: 502, message: /格式无法识别/ });
  assert.throws(() => parseAutnum({}, { asn: 1 }), { status: 502, message: /格式无法识别/ });
});

test('参数校验：非法、内网与保留地址被拒绝，映射地址按 IPv4 查询', () => {
  assert.equal(readIp(q({ ip: ' 1.1.1.1 ' })), '1.1.1.1');
  assert.equal(readIp(q({ ip: '[2400:3200:0:0::1]' })), '2400:3200::1');
  assert.equal(readIp(q({ ip: '::ffff:1.1.1.1' })), '1.1.1.1');
  for (const ip of ['', 'example.com', '1.1.1', '10.0.0.1', '192.168.1.1', '127.0.0.1', '100.64.0.1', '::1', 'fe80::1', '2001:db8::1', '::ffff:10.0.0.1']) {
    assert.throws(() => readIp(q({ ip })), { status: 400 }, ip);
  }
  assert.equal(readAsn(q({ asn: 'AS13335' })), 13335);
  assert.equal(readAsn(q({ asn: 'as4134' })), 4134);
  for (const asn of ['', '0', '-1', 'ASX', '4294967296', '1.5']) assert.throws(() => readAsn(q({ asn })), { status: 400 }, asn);
});

test('/api/ip/asn：直接查询 RIR 服务器，结果缓存', async (t) => {
  const calls = mockRdap(t, {
    '/ip/1.1.1.1': fixture('rdap-ip-apnic.json'),
    '/ip/8.8.8.8': fixture('rdap-ip-arin.json'),
    '/ip/2a00:1450:4001::1': fixture('rdap-ip-ripe-v6.json'),
  });
  const r = route('/api/ip/asn');
  const a = await r.handler({ query: q({ ip: '1.1.1.1' }) });
  assert.equal(a.data.registry, 'APNIC');
  assert.ok(calls.includes('https://rdap.apnic.net/ip/1.1.1.1'));
  assert.ok(!calls.some((u) => u.startsWith('https://rdap.org/')));
  const g = await r.handler({ query: q({ ip: '8.8.8.8' }) });
  assert.ok(calls.includes('https://rdap.arin.net/registry/ip/8.8.8.8'));
  assert.equal(g.data.asn, 15169);
  const v6 = await r.handler({ query: q({ ip: '2a00:1450:4001::1' }) });
  assert.ok(calls.includes('https://rdap.db.ripe.net/ip/2a00:1450:4001::1'));
  assert.equal((await r.handler({ query: q({ ip: '1.1.1.1' }) })).cached, true);
  checkFields(r, a.data, g.data, v6.data);
});

test('/api/ip/asn：RIR 失败或引导数据取不到时改用 rdap.org；404 与限流', async (t) => {
  let calls = mockRdap(t, { 'rdap.apnic.net/ip/1.1.1.1': { status: 503 }, 'rdap.org/ip/1.1.1.1': fixture('rdap-ip-apnic.json') });
  const r = route('/api/ip/asn');
  const a = await r.handler({ query: q({ ip: '1.1.1.1' }) });
  assert.equal(calls.at(-1), 'https://rdap.org/ip/1.1.1.1');
  assert.equal(a.data.registry, 'APNIC', '由 port43 判断注册机构');

  cache.store.clear();
  t.mock.restoreAll();
  calls = mockRdap(t, { 'rdap.org/ip/1.1.1.1': fixture('rdap-ip-apnic.json') }, { bootstrap: false });
  await r.handler({ query: q({ ip: '1.1.1.1' }) });
  assert.deepEqual(calls.filter((u) => !u.includes('data.iana.org')), ['https://rdap.org/ip/1.1.1.1']);

  cache.store.clear();
  t.mock.restoreAll();
  mockRdap(t, {});
  await assert.rejects(r.handler({ query: q({ ip: '1.1.1.1' }) }), { status: 404 });

  cache.store.clear();
  t.mock.restoreAll();
  mockRdap(t, { '/ip/1.1.1.1': { status: 429 } });
  await assert.rejects(r.handler({ query: q({ ip: '1.1.1.1' }) }), { status: 429 });

  cache.store.clear();
  t.mock.restoreAll();
  mockRdap(t, { '/ip/1.1.1.1': JSON.stringify({ objectClassName: 'entity' }) });
  await assert.rejects(r.handler({ query: q({ ip: '1.1.1.1' }) }), { status: 502, message: /格式无法识别/ });

  cache.store.clear();
  t.mock.restoreAll();
  mockRdap(t, { '/ip/1.1.1.1': new TypeError('fetch failed') });
  await assert.rejects(r.handler({ query: q({ ip: '1.1.1.1' }) }), { status: 502, message: /无法连接RDAP 服务/ });
});

test('/api/asn：ARIN 与 APNIC 的 AS 号', async (t) => {
  const calls = mockRdap(t, {
    '/autnum/13335': fixture('rdap-autnum-arin.json'),
    '/autnum/4134': fixture('rdap-autnum-apnic.json'),
  });
  const r = route('/api/asn');
  const cf = await r.handler({ query: q({ asn: 'AS13335' }) });
  assert.ok(calls.includes('https://rdap.arin.net/registry/autnum/13335'));
  assert.equal(cf.data.asn, 13335);
  assert.equal(cf.data.name, 'CLOUDFLARENET');
  assert.equal(cf.data.registry, 'ARIN');
  assert.equal(cf.data.country, null);
  assert.equal(cf.data.org, 'Cloudflare, Inc.');
  assert.equal(cf.data.abuseEmail, 'abuse@cloudflare.com');
  const ct = await r.handler({ query: q({ asn: '4134' }) });
  assert.ok(calls.includes('https://rdap.apnic.net/autnum/4134'));
  assert.equal(ct.data.country, 'CN');
  assert.equal(ct.data.org, 'China Telecom');
  assert.equal(ct.data.registry, 'APNIC');
  checkFields(r, cf.data, ct.data);
  await assert.rejects(r.handler({ query: q({ asn: '64512999' }) }), { status: 404 });
});

test('模块元数据：必填参数都有 example', () => {
  assert.equal(asnModule.name, 'asn');
  assert.equal(asnModule.category, 'net');
  for (const r of asnModule.routes) {
    for (const p of r.params) {
      assert.ok(p.desc);
      if (p.required) assert.ok(p.example, `${r.path} ${p.name}`);
    }
  }
});

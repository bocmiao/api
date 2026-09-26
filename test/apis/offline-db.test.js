import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { searchXdb, parseXdbRegion, lookupIpOffline, lookupPhoneOffline, phoneDatVersion } from '../../src/apis/life/offline-db.js';
import { loadIpInfo, fromIp2region, mergeIpInfo } from '../../src/apis/life/ip.js';
import { loadPhoneArea, fromPhoneDat } from '../../src/apis/life/phone.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
// 按 URL 片段返回预置响应的假 fetch；记录每次请求
function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    for (const [frag, body] of Object.entries(routes)) {
      if (String(url).includes(frag)) {
        if (body instanceof Error) throw body;
        if (typeof body === 'number') return new Response('err', { status: body });
        return new Response(JSON.stringify(body), { status: 200 });
      }
    }
    return new Response('no mock', { status: 500 });
  };
  return calls;
}

const IPAPI_AU = {
  status: 'success', country: '澳大利亚', countryCode: 'AU', regionName: '昆士兰州', city: '布里斯班', district: '', zip: '',
  lat: -27.47, lon: 153.02, timezone: 'Australia/Brisbane', isp: 'APNIC', org: 'APNIC Research', as: 'AS13335 Cloudflare, Inc.', query: '',
};
const IPAPI_CN = {
  status: 'success', country: '中国', countryCode: 'CN', regionName: '广东', city: '深圳', district: '', zip: '',
  lat: 22.54, lon: 114.06, timezone: 'Asia/Shanghai', isp: 'Chinanet', org: 'Chinanet GD', as: 'AS4134 CHINANET-BACKBONE', query: '',
};

describe('ip2region xdb 解析（真实数据文件）', () => {
  test('已知 IP 的原始 region 与解析结果', () => {
    assert.match(searchXdb('114.114.114.114'), /^中国\|江苏省\|南京市\|/);
    assert.match(searchXdb('223.5.5.5'), /^中国\|浙江省\|杭州市\|阿里\|CN$/);
    assert.match(searchXdb('1.2.3.4'), /^Australia\|.*\|AU$/);
    assert.deepEqual(lookupIpOffline('114.114.114.114'), { country: '中国', countryCode: 'CN', province: '江苏省', city: '南京市', isp: null });
    assert.equal(lookupIpOffline('1.2.3.4').countryCode, 'AU');
    // 保留地址、非 IPv4、数据不可用
    assert.equal(lookupIpOffline('0.0.0.1'), null);
    assert.equal(searchXdb('2400:3200::1'), null);
    assert.equal(searchXdb('114.114.114.114', null), null);
  });

  test('边界：段的起止地址都能命中', () => {
    for (const ip of ['0.0.0.0', '255.255.255.255', '1.0.1.0', '1.0.3.255']) assert.ok(searchXdb(ip), ip);
  });

  test('region 字符串：新旧格式，0 和空转 null', () => {
    assert.deepEqual(parseXdbRegion('中国|广东省|深圳市|电信|CN'), { country: '中国', countryCode: 'CN', province: '广东省', city: '深圳市', isp: '电信' });
    assert.deepEqual(parseXdbRegion('中国|0|广东省|深圳市|电信', 2), { country: '中国', countryCode: null, province: '广东省', city: '深圳市', isp: '电信' });
    assert.deepEqual(parseXdbRegion('Japan|Tokyo|0||JP'), { country: 'Japan', countryCode: 'JP', province: 'Tokyo', city: null, isp: null });
    assert.equal(parseXdbRegion('Reserved|Reserved|Reserved|0|0'), null);
    assert.equal(parseXdbRegion(''), null);
  });

  test('转成 /api/ip 结构：去后缀、运营商全称、港澳台代码', () => {
    const r = fromIp2region('113.88.1.1', { country: '中国', countryCode: 'CN', province: '广东省', city: '深圳市', isp: '电信' });
    assert.equal(r.region, '广东');
    assert.equal(r.city, '深圳');
    assert.equal(r.isp, '中国电信');
    assert.equal(r.timezone, 'Asia/Shanghai');
    assert.equal(r.lat, null);
    assert.equal(r.source, 'ip2region');
    assert.equal(fromIp2region('1.1.1.1', { country: '中国', countryCode: 'CN', province: '北京市', city: '北京市', isp: null }).location, '中国 北京');
    const hk = fromIp2region('1.32.192.1', { country: '中国', countryCode: 'CN', province: '香港特别行政区', city: null, isp: null });
    assert.equal(hk.region, '香港');
    assert.equal(hk.countryCode, 'HK');
    assert.equal(hk.timezone, null);
    assert.equal(fromIp2region('1.1.1.1', { country: '中国', countryCode: 'CN', province: '西藏', city: '阿里地区', isp: null }).city, '阿里地区');
  });

  test('查询很快（整个文件在内存里）', () => {
    searchXdb('1.1.1.1');
    const t0 = performance.now();
    for (let i = 0; i < 10000; i++) searchXdb(`${(i * 7) & 255}.${i & 255}.${(i >> 3) & 255}.1`);
    assert.ok(performance.now() - t0 < 1000);
  });
});

describe('loadIpInfo：本地优先、按需回落 ip-api', () => {
  test('国内 IP 本地命中，不请求外部', async () => {
    const calls = mockFetch({ 'ip-api.com': IPAPI_CN });
    const { data } = await loadIpInfo('223.5.5.5');
    assert.equal(calls.length, 0);
    assert.equal(data.source, 'ip2region');
    assert.equal(data.location, '中国 浙江 杭州');
    assert.equal(data.isp, '阿里');
    assert.equal(data.asn, null);
  });

  test('境外 IP 请求 ip-api 补全，地名以 ip-api 为准', async () => {
    const calls = mockFetch({ 'ip-api.com': { ...IPAPI_AU, query: '1.2.3.4' } });
    const { data } = await loadIpInfo('1.2.3.4');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].startsWith('http://ip-api.com/json/1.2.3.4?'));
    assert.equal(data.source, 'ip2region+ip-api');
    assert.equal(data.country, '澳大利亚');
    assert.equal(data.lat, -27.47);
    assert.equal(data.asn, 'AS13335 Cloudflare, Inc.');
  });

  test('ip-api 失败时仍返回本地结果', async () => {
    const calls = mockFetch({ 'ip-api.com': 500 });
    const { data } = await loadIpInfo('1.2.3.5');
    assert.equal(calls.length, 1);
    assert.equal(data.source, 'ip2region');
    assert.equal(data.countryCode, 'AU');
    assert.equal(data.lat, null);
  });

  test('需要 ASN 时国内 IP 也请求 ip-api，地名仍用本地', async () => {
    const calls = mockFetch({ 'ip-api.com': { ...IPAPI_CN, query: '114.114.114.114' } });
    const { data } = await loadIpInfo('114.114.114.114', { withAsn: true });
    assert.equal(calls.length, 1);
    assert.equal(data.source, 'ip2region+ip-api');
    assert.equal(data.city, '南京'); // 本地更准，不被 ip-api 覆盖
    assert.equal(data.asn, 'AS4134 CHINANET-BACKBONE');
    assert.equal(data.lat, 22.54);
  });

  test('IPv6 只走 ip-api，失败时报错', async () => {
    const calls = mockFetch({ '2408%3A8000%3A%3A20': { ...IPAPI_CN, query: '2408:8000::20' }, '2408%3A8000%3A%3A21': 500 });
    const { data } = await loadIpInfo('2408:8000::20');
    assert.equal(data.source, 'ip-api');
    assert.equal(calls.length, 1);
    await assert.rejects(loadIpInfo('2408:8000::21'), { status: 502 });
  });

  test('mergeIpInfo：两边互补', () => {
    const local = fromIp2region('9.9.9.9', { country: 'United States', countryCode: 'US', province: 'California', city: null, isp: 'Quad9' });
    const m = mergeIpInfo(local, { ...local, country: '美国', region: null, city: '伯克利', isp: null, lat: 1, lon: 2, asn: 'AS19281', org: 'Quad9', timezone: 'America/Los_Angeles', source: 'ip-api' });
    assert.equal(m.country, '美国');
    assert.equal(m.region, 'California');
    assert.equal(m.isp, 'Quad9');
    assert.equal(m.location, '美国 California 伯克利');
    assert.equal(m.source, 'ip2region+ip-api');
  });
});

describe('phone.dat 号段库（真实数据文件）', () => {
  test('已知号段', () => {
    assert.match(phoneDatVersion(), /^\d{4}$/);
    assert.deepEqual(lookupPhoneOffline('13800138000'), { province: '北京', city: '北京', zip: '100000', areaCode: '010', carrier: '中国移动', virtual: false });
    assert.deepEqual(lookupPhoneOffline('18957509123'), { province: '浙江', city: '绍兴', zip: '312000', areaCode: '0575', carrier: '中国电信', virtual: false });
    assert.equal(lookupPhoneOffline('19912345678').zip, '063000'); // 补回丢失的前导 0
    assert.equal(lookupPhoneOffline('19212345678').carrier, '中国广电');
    assert.equal(lookupPhoneOffline('14000000000'), null);
    assert.equal(lookupPhoneOffline('13800138000', null), null);
  });

  test('转成 /api/phone 结构', () => {
    const r = fromPhoneDat('17012345678', lookupPhoneOffline('17012345678'));
    assert.equal(r.virtual, true); // 170 号段
    assert.equal(r.source, 'phonedata');
    assert.equal(fromPhoneDat('14000000000', null), null);
  });

  test('本地命中不请求 360，未命中回落', async () => {
    const calls = mockFetch({ 'cx.shouji.360.cn': { code: 0, data: { province: '广东', city: '深圳', sp: '移动' } } });
    const a = (await loadPhoneArea('13800138000')).data;
    assert.equal(calls.length, 0);
    assert.equal(a.location, '北京');
    assert.equal(a.areaCode, '010');
    const b = (await loadPhoneArea('14010000001')).data;
    assert.equal(calls.length, 1);
    assert.equal(b.source, '360');
    assert.equal(b.city, '深圳');
    assert.equal(b.areaCode, null);
  });
});

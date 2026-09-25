// tools 分类：子网 / 进制 / Unicode / 经典密码 / JWT / TOTP / 密码强度 / 请求回显 / 测试数据 /
// 文本统计 / 人民币大写 / JSON / Cron / 正则 / 占位图 / 徽章 / 文字图片
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';

process.env.ANON_DAILY_LIMIT = '10000';
process.env.ANON_MINUTE_LIMIT = '10000';

import toolModules from '../../src/apis/tools/index.js';
import netcalcModule, { calcCidr, ipIntConvert, v6ToBig, bigToV6 } from '../../src/apis/tools/netcalc.js';
import codecModule, { convertRadix, unicodeConvert, runCipher, CIPHERS } from '../../src/apis/tools/codec.js';
import securityModule, {
  decodeJwt, EXAMPLE_TOKEN, hotp, totp, base32Decode, base32Encode, passwordStrength,
} from '../../src/apis/tools/security.js';
import debugModule, { echoRequest, MOCK } from '../../src/apis/tools/debug.js';
import textModule, { textStat, rmbCapital, jsonTool } from '../../src/apis/tools/texttools.js';
import svgModule, { renderPlaceholder, renderBadge, renderTextImage, wrapLines } from '../../src/apis/tools/svgimage.js';
import cronModule, { parseCron, nextRun, cronSchedule, parseFrom } from '../../src/apis/tools/cron.js';
import regexModule, { runRegex, shutdownRegexWorker, TIMEOUT_MS } from '../../src/apis/tools/regex.js';
import { bodyParams } from '../../src/apis/tools/inputs.js';
import { assertFieldsDocumented, collectPaths, matcher } from '../helpers/fields.js';

const MODULES = [netcalcModule, codecModule, securityModule, debugModule, textModule, svgModule, cronModule, regexModule];
const q = (obj = {}) => new URLSearchParams(obj);
const route = (mod, method, path) => mod.routes.find((r) => r.method === method && r.path === path);
const call = (mod, method, path, ctx) => route(mod, method, path).handler({ query: q(), ...ctx });

after(() => shutdownRegexWorker());

// 两个方向都校验：返回的每个字段都有说明；说明里的每个字段也都在样例中出现过
const checked = new Set();
function checkFields(r, ...samples) {
  for (const s of samples) assertFieldsDocumented(r, s);
  const paths = new Set();
  for (const s of samples) collectPaths(s, '', paths);
  const phantom = r.fields.map((f) => f.name).filter((name) => {
    if (name === '[]') return !samples.every(Array.isArray);
    const re = matcher(name.replace(/\[\]$/, ''));
    return ![...paths].some((p) => re.test(p));
  });
  assert.deepEqual(phantom, [], `${r.path} 的 fields 写了样例中没有出现的字段：${phantom.join(', ')}`);
  checked.add(`${r.method} ${r.path}`);
}

// SVG 只允许这些标签；文字都转义过、没有脚本
const ALLOWED_TAGS = new Set(['svg', 'rect', 'text', 'g', 'title', 'linearGradient', 'stop', 'clipPath']);
function assertSafeSvg(svg) {
  const tags = [...svg.matchAll(/<\/?([^\s/>]+)/g)].map((m) => m[1]);
  assert.deepEqual(tags.filter((t) => !ALLOWED_TAGS.has(t)), []);
  assert.doesNotMatch(svg, /&(?!(?:amp|lt|gt|quot|apos);)/);
  assert.doesNotMatch(svg, /<script|on\w+="|javascript:/i);
  for (const m of svg.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)) assert.doesNotMatch(m[1], /[<>]/);
}

// ---------------- 注册 ----------------

test('模块已注册到 tools，参数都有 desc 和 example，路径不重复', () => {
  const names = new Set();
  for (const m of MODULES) {
    assert.ok(toolModules.includes(m), m.name);
    assert.equal(m.category, 'tools');
    assert.ok(m.title && m.description && m.source, m.name);
    assert.ok(!names.has(m.name));
    names.add(m.name);
    for (const r of m.routes) {
      assert.ok(Array.isArray(r.params) && r.params.length, `${r.path} 缺少 params`);
      for (const p of r.params) assert.ok(p.desc && p.example != null, `${r.path} ${p.name}`);
      assert.ok(!r.public, `${r.path} 不应是 public`);
    }
  }
  const keys = toolModules.flatMap((m) => m.routes.map((r) => `${r.method} ${r.path}`));
  assert.equal(new Set(keys).size, keys.length);
  // 敏感参数：密码强度只有 POST；JWT、TOTP 同时提供 POST
  const methods = (p) => MODULES.flatMap((m) => m.routes).filter((r) => r.path === p).map((r) => r.method).sort();
  assert.deepEqual(methods('/api/tools/password-strength'), ['POST']);
  assert.deepEqual(methods('/api/tools/jwt'), ['GET', 'POST']);
  assert.deepEqual(methods('/api/tools/totp'), ['GET', 'POST']);
  assert.ok(route(securityModule, 'POST', '/api/tools/jwt').params.every((p) => p.in === 'body'));
  // 参数名不能用 key：会被当成本站的 API Key
  for (const r of MODULES.flatMap((m) => m.routes)) assert.ok(!r.params.some((p) => p.name === 'key'), r.path);
});

test('bodyParams：只接受 JSON 对象，数字布尔转字符串，null 视为未传', () => {
  const p = bodyParams({ a: 'x', b: 2, c: true, d: null });
  assert.deepEqual([...p], [['a', 'x'], ['b', '2'], ['c', 'true']]);
  assert.deepEqual([...bodyParams(undefined)], []);
  assert.throws(() => bodyParams([1]), { status: 400 });
  assert.throws(() => bodyParams('x'), { status: 400 });
  assert.throws(() => bodyParams({ a: { b: 1 } }), { status: 400 });
});

// ---------------- 子网与 IP ----------------

describe('子网与 IP 计算', () => {
  test('IPv4 子网', () => {
    const d = calcCidr('192.168.10.130/26', '192.168.10.190');
    assert.equal(d.cidr, '192.168.10.128/26');
    assert.equal(d.netmask, '255.255.255.192');
    assert.equal(d.wildcard, '0.0.0.63');
    assert.equal(d.broadcast, '192.168.10.191');
    assert.equal(d.firstHost, '192.168.10.129');
    assert.equal(d.lastHost, '192.168.10.190');
    assert.equal(d.totalAddresses, '64');
    assert.equal(d.usableHosts, '62');
    assert.equal(d.ipClass, 'C');
    assert.equal(d.type, '私有地址');
    assert.equal(d.contains, true);
    assert.equal(calcCidr('192.168.10.130/26', '192.168.10.192').contains, false);
    assert.equal(calcCidr('10.0.0.5 255.255.0.0').cidr, '10.0.0.0/16');
    assert.equal(calcCidr('10.0.0.5/255.255.255.0').cidr, '10.0.0.0/24');
    assert.equal(calcCidr('8.8.8.8').prefix, 32);
    assert.equal(calcCidr('8.8.8.8').type, '公网地址');
    assert.equal(calcCidr('0.0.0.0/0').totalAddresses, '4294967296');
    const p31 = calcCidr('10.0.0.0/31');
    assert.deepEqual([p31.firstHost, p31.lastHost, p31.usableHosts], ['10.0.0.0', '10.0.0.1', '2']);
    assert.equal(calcCidr('100.64.1.1/10').type, '运营商级 NAT 共享地址');
    for (const bad of ['1.2.3/24', '1.2.3.4/33', '1.2.3.4 255.0.255.0', '::1 255.0.0.0', 'abc', '1.2.3.4/24/1']) {
      assert.throws(() => calcCidr(bad), { status: 400 }, bad);
    }
    assert.throws(() => calcCidr('10.0.0.0/8', '::1'), { status: 400 });
  });

  test('IPv6 子网与地址转换', () => {
    const d = calcCidr('2001:db8:abcd::1/48', '2001:db8:abcd:ffff::1');
    assert.equal(d.cidr, '2001:db8:abcd::/48');
    assert.equal(d.netmask, 'ffff:ffff:ffff::');
    assert.equal(d.lastAddress, '2001:db8:abcd:ffff:ffff:ffff:ffff:ffff');
    assert.equal(d.networkExpanded, '2001:0db8:abcd:0000:0000:0000:0000:0000');
    assert.equal(d.totalAddresses, (2n ** 80n).toString());
    assert.equal(d.type, '文档示例地址');
    assert.equal(d.contains, true);
    assert.equal(calcCidr('fe80::1%eth0/64').type, '链路本地地址');
    assert.equal(bigToV6(v6ToBig('::ffff:1.2.3.4')), '::ffff:102:304');
    assert.equal(bigToV6(v6ToBig('1:0:0:1:0:0:0:1')), '1:0:0:1::1'); // 压缩最长的一段 0
    assert.equal(bigToV6(v6ToBig('1:0:1:0:1:0:1:0')), '1:0:1:0:1:0:1:0'); // 单个 0 不压缩
    assert.equal(bigToV6(0n), '::');
  });

  test('IP ↔ 整数', () => {
    assert.deepEqual(ipIntConvert('192.168.1.1'), { version: 4, ip: '192.168.1.1', int: 3232235777, hex: '0xc0a80101', binary: '11000000.10101000.00000001.00000001' });
    assert.equal(ipIntConvert('3232235777').ip, '192.168.1.1');
    assert.equal(ipIntConvert('0xc0a80101').ip, '192.168.1.1');
    assert.equal(ipIntConvert('4294967295').ip, '255.255.255.255');
    assert.equal(ipIntConvert('4294967296').ip, '::1:0:0');
    assert.equal(ipIntConvert('1', 6).ip, '::1');
    const v6 = ipIntConvert('2001:db8::1');
    assert.equal(v6.int, (0x20010db8n << 96n | 1n).toString());
    assert.equal(v6.expanded, '2001:0db8:0000:0000:0000:0000:0000:0001');
    assert.throws(() => ipIntConvert('4294967296', 4), { status: 400 });
    assert.throws(() => ipIntConvert('1.2.3.4', 6), { status: 400 });
    assert.throws(() => ipIntConvert('-1'), { status: 400 });
    assert.throws(() => ipIntConvert(String(2n ** 128n)), { status: 400 });
  });

  test('GET /api/tools/cidr、/api/tools/ip-int 字段', async () => {
    const r = route(netcalcModule, 'GET', '/api/tools/cidr');
    const a = await r.handler({ query: q({ cidr: '192.168.10.130/26', ip: '192.168.10.1' }) });
    const b = await r.handler({ query: q({ cidr: '2001:db8::/32' }) });
    assert.equal(a.data.contains, false);
    assert.equal(b.data.contains, null);
    checkFields(r, a.data, b.data);
    await assert.rejects(r.handler({ query: q() }), { status: 400 });

    const r2 = route(netcalcModule, 'GET', '/api/tools/ip-int');
    const c = await r2.handler({ query: q({ value: '10.0.0.1' }) });
    const d = await r2.handler({ query: q({ value: '1', version: '6' }) });
    checkFields(r2, c.data, d.data);
    await assert.rejects(r2.handler({ query: q({ value: '1', version: '5' }) }), { status: 400 });
  });
});

// ---------------- 进制 / Unicode / 经典密码 ----------------

describe('进制、Unicode 与经典密码', () => {
  test('进制转换（含大数、负数、前缀）', () => {
    assert.deepEqual(convertRadix('ff', 16), { input: 'ff', from: 16, to: null, result: null, binary: '11111111', octal: '377', decimal: '255', hex: 'ff' });
    assert.equal(convertRadix('0xFF', 16, 2).result, '11111111');
    assert.equal(convertRadix('-255', 10, 16).result, '-ff');
    assert.equal(convertRadix('zz', 36, 10).result, '1295');
    assert.equal(convertRadix('1_000_000', 10, 16).result, 'f4240');
    const big = '9'.repeat(200);
    assert.equal(convertRadix(convertRadix(big, 10, 36).result, 36, 10).result, big);
    assert.equal(convertRadix('0', 10, 2).result, '0');
    assert.throws(() => convertRadix('12', 2), { status: 400 });
    assert.throws(() => convertRadix('', 10), { status: 400 });
    assert.throws(() => convertRadix('0x10', 10), { status: 400 }); // 0x 只在 16 进制时当前缀
  });

  test('Unicode 编解码', () => {
    assert.equal(unicodeConvert('你好a', 'encode').result, '\\u4f60\\u597da');
    assert.equal(unicodeConvert('😀', 'encode').result, '\\ud83d\\ude00');
    assert.equal(unicodeConvert('😀', 'encode', 'u-brace').result, '\\u{1f600}');
    assert.equal(unicodeConvert('你a', 'encode', 'html-hex', 'all').result, '&#x4F60;&#x61;');
    assert.equal(unicodeConvert('你', 'encode', 'html-dec').result, '&#20320;');
    assert.equal(unicodeConvert('你好', 'encode', 'codepoint', 'all').result, 'U+4F60 U+597D');
    assert.equal(unicodeConvert('你好😀', 'encode').chars, 3);
    const dec = unicodeConvert('\\u4f60\\ud83d\\ude00|&#x597D;|&#65;|U+4F60 U+597D|\\u{1F600}|&#x110000;', 'decode');
    assert.equal(dec.result, '你😀|好|A|你好|😀|&#x110000;');
    assert.equal(dec.format, 'auto');
    // 单次扫描：解出来的 & 不会再被当成实体
    assert.equal(unicodeConvert('\\u0026#65;', 'decode').result, '&#65;');
    for (const format of ['u', 'u-brace', 'html-hex', 'html-dec', 'codepoint']) {
      const s = 'Hi 你好😀';
      assert.equal(unicodeConvert(unicodeConvert(s, 'encode', format, 'all').result, 'decode').result, s, format);
    }
  });

  test('经典密码：已知结果与往返', () => {
    const enc = (method, text, opts) => runCipher(method, 'encode', text, opts).result;
    assert.equal(enc('caesar', 'Hello, World!'), 'Khoor, Zruog!');
    assert.equal(enc('caesar', 'abc', { shift: -1 }), 'zab');
    assert.equal(enc('rot13', 'Hello'), 'Uryyb');
    assert.equal(enc('rot47', 'Hello'), 'w6==@');
    assert.equal(enc('atbash', 'abcXYZ'), 'zyxCBA');
    assert.equal(enc('vigenere', 'ATTACKATDAWN', { keyword: 'LEMON' }), 'LXFOPVEFRNHR');
    assert.equal(enc('railfence', 'WEAREDISCOVEREDFLEEATONCE', { rails: 3 }), 'WECRLTEERDSOEEFEAOCAIVDEN');
    assert.equal(enc('morse', 'SOS help'), '... --- ... / .... . .-.. .--.');
    assert.equal(runCipher('morse', 'decode', '··· −−− ···'.replace(/−/g, '-')).result, 'SOS');
    assert.equal(enc('bacon', 'AB'), 'AAAAA AAAAB');
    assert.throws(() => runCipher('bacon', 'decode', 'AAAA'), { status: 400 });
    assert.throws(() => enc('vigenere', 'x', { keyword: '123' }), { status: 400 });
    for (const method of Object.keys(CIPHERS)) {
      const text = method === 'morse' || method === 'bacon' ? 'HELLOWORLD' : 'Hello World, 你好!';
      const opts = { shift: 7, keyword: 'Key', rails: 4 };
      assert.equal(runCipher(method, 'decode', enc(method, text, opts), opts).result, text, method);
    }
  });

  test('GET /api/tools/radix、unicode、cipher 字段', async () => {
    const r1 = route(codecModule, 'GET', '/api/tools/radix');
    checkFields(r1, (await r1.handler({ query: q({ value: 'ff', from: '16', to: '36' }) })).data, (await r1.handler({ query: q({ value: '10' }) })).data);
    await assert.rejects(r1.handler({ query: q({ value: '1', from: '37' }) }), { status: 400 });
    await assert.rejects(r1.handler({ query: q({ value: '1'.repeat(1001) }) }), { status: 400 });

    const r2 = route(codecModule, 'GET', '/api/tools/unicode');
    checkFields(r2, (await r2.handler({ query: q({ text: '你好' }) })).data, (await r2.handler({ query: q({ text: '\\u4f60', action: 'decode' }) })).data);

    const r3 = route(codecModule, 'GET', '/api/tools/cipher');
    const c = await r3.handler({ query: q({ text: 'Hello', method: 'vigenere', keyword: 'LEMON' }) });
    assert.equal(c.data.methodName, '维吉尼亚密码');
    checkFields(r3, c.data);
    await assert.rejects(r3.handler({ query: q({ text: 'x', method: 'enigma' }) }), { status: 400 });
    await assert.rejects(r3.handler({ query: q({ text: 'x', shift: '26' }) }), { status: 400 });
  });
});

// ---------------- JWT / TOTP / 密码强度 ----------------

describe('JWT、TOTP 与密码强度', () => {
  const sign = (header, payload, secret, hash = 'sha256') => {
    const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    return `${input}.${createHmac(hash, secret).update(input).digest('base64url')}`;
  };

  test('JWT 解码与 HS 验签', () => {
    const now = 1_800_000_000_000;
    const skipped = decodeJwt(EXAMPLE_TOKEN, { now });
    assert.equal(skipped.verified, false);
    assert.equal(skipped.verification, 'skipped');
    assert.equal(skipped.payload.name, '张三');
    assert.equal(skipped.times.issuedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(skipped.expired, false);
    assert.equal(decodeJwt(`Bearer ${EXAMPLE_TOKEN}`, { secret: 'your-256-bit-secret' }).verified, true);
    assert.equal(decodeJwt(EXAMPLE_TOKEN, { secret: 'wrong' }).verification, 'invalid');

    for (const [alg, hash] of [['HS384', 'sha384'], ['HS512', 'sha512']]) {
      const t = sign({ alg, typ: 'JWT' }, { exp: 1, nbf: 2e9 }, 's3cret', hash);
      const d = decodeJwt(t, { secret: 's3cret', now });
      assert.equal(d.verified, true, alg);
      assert.equal(d.expired, true);
      assert.equal(d.notYetValid, true);
      assert.ok(d.expiresIn < 0);
    }
    // Base64 编码的密钥
    const raw = Buffer.from([1, 2, 3, 250, 251]);
    const t64 = sign({ alg: 'HS256' }, { a: 1 }, raw);
    assert.equal(decodeJwt(t64, { secret: raw.toString('base64'), encoding: 'base64' }).verified, true);
    assert.equal(decodeJwt(t64, { secret: raw.toString('base64') }).verified, false);

    // 篡改载荷后签名不再匹配
    const [h, , s] = EXAMPLE_TOKEN.split('.');
    const forged = `${h}.${Buffer.from('{"admin":true,"name":"李四"}').toString('base64url')}.${s}`;
    assert.equal(decodeJwt(forged, { secret: 'your-256-bit-secret' }).verified, false);

    const none = decodeJwt(`${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.`, { secret: 'x' });
    assert.deepEqual([none.verified, none.verification], [false, 'none']);
    const rs = decodeJwt(sign({ alg: 'RS256' }, {}, 'x'), { secret: 'x' });
    assert.deepEqual([rs.verified, rs.verification], [false, 'unsupported']);
    assert.equal(decodeJwt(sign({ alg: 'HS256' }, { sub: 'a' }, 'x')).expired, null);

    for (const bad of ['abc', 'a.b', `${EXAMPLE_TOKEN}.x`, '!!!.e30.x', 'e30.W10.x', 'bm90anNvbg.e30.x']) {
      assert.throws(() => decodeJwt(bad), (err) => {
        assert.equal(err.status, 400);
        assert.ok(!err.message.includes(bad), '报错信息不应回显令牌');
        return true;
      }, bad);
    }
  });

  test('GET / POST /api/tools/jwt 字段', async () => {
    for (const method of ['GET', 'POST']) {
      const r = route(securityModule, method, '/api/tools/jwt');
      const ctx = (o) => (method === 'GET' ? { query: q(o) } : { body: o });
      const a = await r.handler(ctx({ token: EXAMPLE_TOKEN, secret: 'your-256-bit-secret' }));
      const b = await r.handler(ctx({ token: sign({ alg: 'HS256', kid: 'k1' }, { exp: 4102444800, nbf: 1, iat: 1, roles: ['a'] }, 'k') }));
      assert.equal(a.data.verified, true);
      assert.equal(b.data.verified, false);
      checkFields(r, a.data, b.data);
      await assert.rejects(r.handler(ctx({})), { status: 400 });
      await assert.rejects(r.handler(ctx({ token: EXAMPLE_TOKEN, encoding: 'hex' })), { status: 400 });
    }
  });

  test('TOTP：RFC 6238 测试向量与 Base32', () => {
    // RFC 6238 附录 B，8 位，时间 59 秒
    const vectors = [['sha1', '12345678901234567890', '94287082'], ['sha256', '12345678901234567890123456789012', '46119246'],
      ['sha512', '1234567890123456789012345678901234567890123456789012345678901234', '90693936']];
    for (const [algo, seed, code] of vectors) {
      const secret = base32Encode(Buffer.from(seed));
      assert.equal(totp({ secret, digits: 8, algorithm: algo, time: 59 }).code, code, algo);
      assert.equal(hotp(Buffer.from(seed), 1, algo, 8), code);
    }
    const t = totp({ secret: base32Encode(Buffer.from('12345678901234567890')), time: 1111111109, digits: 8 });
    assert.equal(t.code, '07081804');
    assert.equal(t.remaining, 30 - (1111111109 % 30));
    // RFC 4226 附录 D：HOTP 计数器 0、1
    assert.equal(hotp(Buffer.from('12345678901234567890'), 0), '755224');
    assert.equal(hotp(Buffer.from('12345678901234567890'), 1), '287082');
    assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
    assert.equal(base32Decode('mzxw 6ytb-oi======').toString(), 'foobar');
    assert.throws(() => base32Decode('ABC1'), { status: 400 });
    assert.throws(() => totp({ secret: 'MZXW6YTBOI' }), { status: 400 }); // 太短
    const g = totp({});
    assert.equal(g.generated, true);
    assert.match(g.secret, /^[A-Z2-7]{32}$/);
    assert.ok(g.otpauthUrl.startsWith('otpauth://totp/'));
    assert.equal(totp({ secret: g.secret, time: 100 }).code, totp({ secret: g.secret, time: 119 }).code);
  });

  test('GET / POST /api/tools/totp 字段', async () => {
    for (const method of ['GET', 'POST']) {
      const r = route(securityModule, method, '/api/tools/totp');
      const ctx = (o) => (method === 'GET' ? { query: q(o) } : { body: o });
      const a = await r.handler(ctx({ secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', time: '59', digits: '7', algorithm: 'sha256' }));
      assert.equal(a.data.code.length, 7);
      assert.equal(a.data.remaining, 1);
      const b = await r.handler(ctx({}));
      checkFields(r, a.data, b.data);
      await assert.rejects(r.handler(ctx({ secret: 'JBSWY3DPEHPK3PXP', period: '5' })), { status: 400 });
    }
  });

  test('密码强度', () => {
    assert.equal(passwordStrength('123456').score, 0);
    assert.equal(passwordStrength('123456').isCommon, true);
    const weak = passwordStrength('P@ssw0rd1990');
    assert.ok(weak.score <= 1);
    assert.ok(weak.issues.some((i) => i.includes('常见单词')));
    assert.ok(weak.issues.some((i) => i.includes('年份')));
    assert.ok(passwordStrength('qwertyuiop').issues.some((i) => i.includes('键盘')));
    assert.ok(passwordStrength('aaaaaa').issues.some((i) => i.includes('重复')));
    assert.ok(passwordStrength('abcdefg').issues.some((i) => i.includes('顺序')));
    const strong = passwordStrength('correct-horse-battery-staple-9Q');
    assert.equal(strong.score, 4);
    assert.equal(strong.charset.symbols, true);
    assert.equal(passwordStrength('密码很长很长很长很长').charset.other, true);
  });

  test('POST /api/tools/password-strength 字段（没有 GET 路由）', async () => {
    assert.equal(route(securityModule, 'GET', '/api/tools/password-strength'), undefined);
    const r = route(securityModule, 'POST', '/api/tools/password-strength');
    const a = await r.handler({ body: { password: 'P@ssw0rd1990' } });
    const b = await r.handler({ body: { password: 'Tr0ub4dor&3' } });
    checkFields(r, a.data, b.data);
    await assert.rejects(r.handler({ body: {} }), { status: 400 });
    await assert.rejects(r.handler({ body: undefined, query: q({ password: 'x' }) }), { status: 400 }); // 查询参数里的密码不读
    await assert.rejects(r.handler({ body: { password: 'x'.repeat(129) } }), { status: 400 });
  });
});

// ---------------- 请求回显与测试数据 ----------------

describe('请求回显与测试数据', () => {
  const req = {
    url: '/api/tools/echo?a=1&a=2&key=abc&access_token=t&b=x',
    httpVersion: '1.1',
    headers: {
      host: 'api.test', 'user-agent': 'curl/8', cookie: 'sid=secret', authorization: 'Bearer k', 'x-api-key': 'k',
      'proxy-authorization': 'Basic x', 'x-auth-token': 't', 'x-session-id': 's', 'x-forwarded-for': '1.1.1.1',
    },
  };
  const query = new URLSearchParams('a=1&a=2&key=abc&access_token=t&b=x');

  test('去掉凭据类请求头和查询参数', () => {
    const d = echoRequest({ req, ip: '203.0.113.5', query }, 'GET', 0);
    assert.deepEqual(d.headers, { host: 'api.test', 'user-agent': 'curl/8', 'x-forwarded-for': '1.1.1.1' });
    assert.deepEqual(d.removedHeaders.sort(), ['authorization', 'cookie', 'proxy-authorization', 'x-api-key', 'x-auth-token', 'x-session-id']);
    assert.deepEqual(d.query, { a: ['1', '2'], b: 'x' });
    assert.deepEqual(d.removedQuery, ['key', 'access_token']);
    assert.equal(d.path, '/api/tools/echo');
    assert.equal(d.time, '1970-01-01T00:00:00.000Z');
    assert.equal(d.body, null);
    const json = JSON.stringify(d);
    for (const secret of ['sid=secret', 'Bearer k', 'abc']) assert.ok(!json.includes(secret), secret);
  });

  test('GET / POST /api/tools/echo 字段', async () => {
    const g = route(debugModule, 'GET', '/api/tools/echo');
    const p = route(debugModule, 'POST', '/api/tools/echo');
    const a = await g.handler({ req, ip: '1.2.3.4', query });
    const b = await p.handler({ req: { ...req, headers: { host: 'x' } }, ip: '1.2.3.4', query: q({ m: 'hi' }), body: { user: '张三', items: [1, 2] } });
    assert.equal(b.data.method, 'POST');
    assert.equal(b.data.body, '{"user":"张三","items":[1,2]}');
    checkFields(g, a.data, b.data);
    checkFields(p, a.data, b.data);
  });

  test('测试数据都是明显虚构的', () => {
    for (let i = 0; i < 50; i++) {
      assert.match(MOCK.phone(), /^100\d{8}$/);
      assert.match(MOCK.email(), /^[0-9a-f]+\d*@example\.(com|org|net)$/);
      assert.match(MOCK.ip(), /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/);
      assert.match(MOCK.ipv6(), /^2001:db8:/);
      assert.match(MOCK.mac(), /^02(:[0-9a-f]{2}){5}$/);
      assert.match(MOCK.address(), /(示例路|测试街|样例大道|演示路|虚拟巷)\d+号/);
      assert.match(MOCK.company(), /示例有限公司$/);
      assert.match(MOCK.name(), /^\p{Script=Han}{2,3}$/u);
      assert.match(MOCK.date(), /^\d{4}-\d{2}-\d{2}$/);
      assert.match(MOCK.color(), /^#[0-9a-f]{6}$/);
    }
    assert.ok(!('idcard' in MOCK) && !('id' in MOCK), '不生成身份证号');
  });

  test('GET /api/tools/mock 字段', async () => {
    const r = route(debugModule, 'GET', '/api/tools/mock');
    const a = await r.handler({ query: q({ count: '3' }) });
    const b = await r.handler({ query: q({ type: 'uuid', count: '2' }) });
    assert.equal(a.data.type, 'user');
    assert.equal(a.data.items.length, 3);
    assert.equal(b.data.items.length, 2);
    checkFields(r, a.data, b.data);
    await assert.rejects(r.handler({ query: q({ type: 'idcard' }) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ count: '51' }) }), { status: 400 });
  });
});

// ---------------- 文本统计 / 人民币大写 / JSON ----------------

describe('文本统计、人民币大写与 JSON', () => {
  test('文本统计', () => {
    const d = textStat("Hello 世界！\n这是第二行，don't 3.14。\n\n第三段 😀");
    assert.equal(d.chinese, 10);
    assert.equal(d.englishWords, 2);
    assert.equal(d.numbers, 1);
    assert.equal(d.words, 13);
    assert.equal(d.lines, 4);
    assert.equal(d.nonEmptyLines, 3);
    assert.equal(d.paragraphs, 2);
    assert.equal(d.chinesePunctuation, 3);
    assert.equal(d.punctuation, 5); // ！ ， ' . 。
    assert.equal(d.characters, [..."Hello 世界！\n这是第二行，don't 3.14。\n\n第三段 😀"].length);
    assert.equal(d.bytes, Buffer.byteLength("Hello 世界！\n这是第二行，don't 3.14。\n\n第三段 😀"));
    assert.equal(textStat('').lines, 0);
    assert.equal(textStat('a\r\nb\rc').lines, 3);
  });

  test('人民币大写', () => {
    const cases = {
      0: '零元整', '0.05': '伍分', '0.5': '伍角', '1.05': '壹元零伍分', 10: '壹拾元整', 15: '壹拾伍元整',
      '1234.56': '壹仟贰佰叁拾肆元伍角陆分', 1001: '壹仟零壹元整', 1010: '壹仟零壹拾元整', 10010: '壹万零壹拾元整',
      100000: '壹拾万元整', 100001: '壹拾万零壹元整', 101000: '壹拾万壹仟元整', 1000100: '壹佰万零壹佰元整',
      100000001: '壹亿零壹元整', 100010000: '壹亿零壹万元整', 110000000: '壹亿壹仟万元整',
      1000100000000: '壹万零壹亿元整', '-1,234,567.80': '负壹佰贰拾叁万肆仟伍佰陆拾柒元捌角', '¥ 20.3': '贰拾元叁角',
      '-0': '零元整',
    };
    for (const [input, capital] of Object.entries(cases)) assert.equal(rmbCapital(input).capital, capital, input);
    assert.equal(rmbCapital('1234567.8').formatted, '¥1,234,567.80');
    assert.equal(rmbCapital('007.1').amount, '7.10');
    for (const bad of ['1.234', 'abc', '1'.repeat(17), '', '1e5']) assert.throws(() => rmbCapital(bad), { status: 400 }, bad);
  });

  test('JSON 格式化 / 压缩 / 校验', () => {
    const f = jsonTool('{"b":1,"a":[1,{"c":null}]}', { sortKeys: true, indent: '4' });
    assert.equal(f.result, '{\n    "a": [\n        1,\n        {\n            "c": null\n        }\n    ],\n    "b": 1\n}');
    assert.deepEqual(f.stats, { inputBytes: 26, outputBytes: Buffer.byteLength(f.result), nodes: 6, keys: 3, depth: 3 });
    assert.equal(jsonTool('{ "a" : 1 }', { action: 'minify' }).result, '{"a":1}');
    assert.equal(jsonTool('[1]', { action: 'format', indent: 'tab' }).result, '[\n\t1\n]');
    assert.equal(jsonTool('"x"', { action: 'validate' }).result, null);
    assert.equal(jsonTool('"x"', { action: 'validate' }).stats.depth, 0);
    const bad = jsonTool('{\n  "a": 1,\n}');
    assert.equal(bad.valid, false);
    assert.equal(bad.error.line, 3);
    assert.equal(bad.error.column, 1);
    assert.throws(() => jsonTool('['.repeat(1000) + ']'.repeat(1000)), { status: 400 });
  });

  test('GET / POST /api/tools/text-stat、GET /api/tools/rmb、POST /api/tools/json 字段', async () => {
    for (const method of ['GET', 'POST']) {
      const r = route(textModule, method, '/api/tools/text-stat');
      const ctx = (o) => (method === 'GET' ? { query: q(o) } : { body: o });
      checkFields(r, (await r.handler(ctx({ text: '你好 world' }))).data);
      await assert.rejects(r.handler(ctx({})), { status: 400 });
    }
    const r2 = route(textModule, 'GET', '/api/tools/rmb');
    checkFields(r2, (await r2.handler({ query: q({ amount: '1234.56' }) })).data);

    assert.equal(route(textModule, 'GET', '/api/tools/json'), undefined);
    const r3 = route(textModule, 'POST', '/api/tools/json');
    const ok = await r3.handler({ body: { text: '{"a":[1,2]}', sortKeys: true } });
    const bad = await r3.handler({ body: { text: '{"a":', action: 'validate' } });
    checkFields(r3, ok.data, bad.data);
    await assert.rejects(r3.handler({ body: { text: '{}', action: 'to-yaml' } }), { status: 400 });
    await assert.rejects(r3.handler({ body: { text: 'x'.repeat(100_001) } }), { status: 400 });
  });
});

// ---------------- Cron ----------------

describe('Cron 表达式', () => {
  const from = parseFrom('2026-01-01 00:00:00'); // 北京时间周四
  const times = (expr, count = 3) => cronSchedule(expr, { count, from }).next.map((n) => n.time);

  test('解析与下一次执行时间（北京时间）', () => {
    assert.deepEqual(times('0 9 * * 1-5'), ['2026-01-01 09:00:00', '2026-01-02 09:00:00', '2026-01-05 09:00:00']);
    assert.deepEqual(times('*/15 * * * *'), ['2026-01-01 00:15:00', '2026-01-01 00:30:00', '2026-01-01 00:45:00']);
    assert.deepEqual(times('*/20 * * * * *'), ['2026-01-01 00:00:20', '2026-01-01 00:00:40', '2026-01-01 00:01:00']);
    assert.deepEqual(times('0 0 29 2 *', 2), ['2028-02-29 00:00:00', '2032-02-29 00:00:00']);
    assert.deepEqual(times('@monthly', 2), ['2026-02-01 00:00:00', '2026-03-01 00:00:00']);
    assert.deepEqual(times('5 4 * * 7', 1), ['2026-01-04 04:05:00']); // 7 也是周日
    assert.deepEqual(times('0 12 15 * MON', 3), ['2026-01-05 12:00:00', '2026-01-12 12:00:00', '2026-01-15 12:00:00']); // 日与周“或”
    assert.deepEqual(times('0 0 1 jan-mar *', 2), ['2026-02-01 00:00:00', '2026-03-01 00:00:00']);
    assert.deepEqual(times('59 23 31 12 *', 1), ['2026-12-31 23:59:00']);
    const first = cronSchedule('0 9 * * *', { count: 1, from }).next[0];
    assert.deepEqual(first, { time: '2026-01-01 09:00:00', weekday: '星期四', iso: '2026-01-01T01:00:00.000Z', timestamp: 1767229200 });
    // 严格晚于起点
    assert.equal(new Date(nextRun(parseCron('0 9 * * *').parsed, first.timestamp * 1000)).toISOString(), '2026-01-02T01:00:00.000Z');
  });

  test('中文说明', () => {
    const desc = (e) => cronSchedule(e, { count: 1, from }).description;
    assert.equal(desc('0 9 * * 1-5'), '每周一至周五 09:00 执行（北京时间）');
    assert.equal(desc('*/15 * * * *'), '每 15 分钟 执行（北京时间）');
    assert.equal(desc('30 8 1,15 * *'), '每月 1 号、15 号 08:30 执行（北京时间）');
    assert.equal(desc('@daily'), '每天 00:00 执行（北京时间）');
    assert.equal(desc('*/30 * * * * *'), '每 30 秒 执行（北京时间）');
    assert.equal(desc('0 12 1 * 1'), '每月 1 号或每周一 12:00 执行（北京时间）');
  });

  test('非法表达式', () => {
    for (const bad of ['', '* * * *', '* * * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8',
      '*/0 * * * *', '5-1 * * * *', '0 0 L * *', 'a b c d e', '0 0 30 2 *', '1-2-3 * * * *']) {
      assert.throws(() => cronSchedule(bad, { from }), { status: 400 }, bad);
    }
    assert.throws(() => parseFrom('2026-02-30'), { status: 400 });
    assert.equal(parseFrom('1767196800'), 1767196800000);
  });

  test('GET /api/tools/cron 字段', async () => {
    const r = route(cronModule, 'GET', '/api/tools/cron');
    const a = await r.handler({ query: q({ expression: '0 9 * * 1-5', count: '2', from: '2026-01-01 00:00:00' }) });
    const b = await r.handler({ query: q({ expression: '*/10 * * * * *' }) });
    assert.equal(a.data.next.length, 2);
    assert.equal(b.data.next.length, 5);
    checkFields(r, a.data, b.data);
    await assert.rejects(r.handler({ query: q({ expression: '* * * * *', count: '21' }) }), { status: 400 });
  });
});

// ---------------- 正则 ----------------

describe('正则测试（防 ReDoS）', () => {
  test('匹配、替换、分割', async () => {
    const m = await runRegex({ pattern: '(?<y>\\d{4})-(\\d{2})?', text: '2026-09 和 2027-', flags: 'g' });
    assert.equal(m.total, 2);
    assert.deepEqual(m.matches[0], { match: '2026-09', index: 0, end: 7, groups: ['2026', '09'], named: { y: '2026' } });
    assert.deepEqual(m.matches[1].groups, ['2027', null]);
    assert.equal((await runRegex({ pattern: 'a', text: 'aaa', flags: '' })).total, 1);
    assert.equal((await runRegex({ pattern: 'A', text: 'aaa', flags: 'gi' })).total, 3);
    const r = await runRegex({ pattern: '(\\w+)@', text: 'x@ y@', action: 'replace', replacement: '<$1>' });
    assert.equal(r.result, '<x> <y>');
    const s = await runRegex({ pattern: '(,)|;', text: 'a,b;c', action: 'split' });
    assert.deepEqual(s.parts, ['a', ',', 'b', null, 'c']);
    const many = await runRegex({ pattern: '.', text: 'x'.repeat(500) });
    assert.equal(many.matches.length, 200);
    assert.equal(many.truncated, true);
    await assert.rejects(runRegex({ pattern: '(', text: 'x' }), { status: 400 });
    await assert.rejects(runRegex({ pattern: 'a', text: 'x', flags: 'gg' }), { status: 400 });
    await assert.rejects(runRegex({ pattern: 'a', text: 'x', flags: 'uv' }), { status: 400 });
  });

  test('灾难性回溯被超时中断，主线程不被阻塞，之后仍可用', async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 10);
    const started = Date.now();
    await assert.rejects(runRegex({ pattern: '^(a+)+$', text: `${'a'.repeat(40)}!` }), { status: 422 });
    await assert.rejects(runRegex({ pattern: '(x+x+)+y', text: 'x'.repeat(5000), action: 'replace' }), { status: 422 });
    const took = Date.now() - started;
    clearInterval(timer);
    assert.ok(took < TIMEOUT_MS * 2 + 1500, `耗时 ${took}ms`);
    assert.ok(ticks >= 5, `执行期间主线程计时器只跑了 ${ticks} 次`);
    assert.equal((await runRegex({ pattern: 'b', text: 'abc' })).matched, true);
  });

  test('GET / POST /api/tools/regex 字段', async () => {
    for (const method of ['GET', 'POST']) {
      const r = route(regexModule, method, '/api/tools/regex');
      const ctx = (o) => (method === 'GET' ? { query: q(o) } : { body: o });
      const a = await r.handler(ctx({ pattern: '(?<year>\\d{4})-(\\d{2})', text: '开始于 2026-09。' }));
      const b = await r.handler(ctx({ pattern: '\\d', text: 'a1b2', action: 'replace', replacement: '#' }));
      const c = await r.handler(ctx({ pattern: ',', text: 'a,b', action: 'split' }));
      const d = await r.handler(ctx({ pattern: 'x', text: '', flags: '' }));
      assert.equal(b.data.result, 'a#b#');
      assert.equal(d.data.matched, false);
      checkFields(r, a.data, b.data, c.data, d.data);
      await assert.rejects(r.handler(ctx({ pattern: 'x' })), { status: 400 });
      await assert.rejects(r.handler(ctx({ pattern: 'x', text: 'y'.repeat(20_001) })), { status: 400 });
    }
  });
});

// ---------------- SVG 图片 ----------------

describe('占位图、徽章、文字图片（raw SVG）', () => {
  const EVIL = '<script>alert(1)</script>&"\'\u0001';

  test('渲染与转义', () => {
    const p = renderPlaceholder({ width: 300, height: 200, bg: '#fff', color: '#000' });
    assert.ok(p.includes('>300 × 200</text>'));
    assert.ok(p.includes('width="300" height="200"'));
    assertSafeSvg(renderPlaceholder({ width: 300, height: 200, text: EVIL }));

    const b = renderBadge({ label: 'build', message: 'passing', color: '#4c1' });
    assert.ok(b.includes('<title>build: passing</title>'));
    assertSafeSvg(b);
    assertSafeSvg(renderBadge({ label: EVIL, message: EVIL, style: 'flat-square' }));
    assert.equal(renderBadge({ message: 'a' }), renderBadge({ message: 'a' })); // 相同参数输出相同
    assert.notEqual(renderBadge({ message: 'a' }).match(/id="r(\w+)"/)[1], renderBadge({ message: 'b' }).match(/id="r(\w+)"/)[1]);

    const t = renderTextImage({ text: `第一行\n${EVIL}\n  缩进`, style: 'dark' });
    assertSafeSvg(t);
    assert.ok(t.includes('#111827'));
    assert.equal((t.match(/<text /g) ?? []).length, 3);
    assert.ok(t.includes('xml:space="preserve">  缩进'));
    assert.deepEqual(wrapLines('一二三四五', 10, 30), ['一二三', '四五']);
    assert.throws(() => renderTextImage({ text: '字'.repeat(1000), fontSize: 120, width: 200 }), { status: 400 });
  });

  test('路由：raw、returns、响应头、参数校验', async () => {
    for (const r of svgModule.routes) {
      assert.equal(r.raw, true);
      assert.equal(r.fields, undefined);
      assert.ok(typeof r.returns === 'string' && r.returns.length > 20);
    }
    const p = await call(svgModule, 'GET', '/api/placeholder', { query: q({ width: '320', height: '180', text: 'Banner', bg: '#dbeafe', color: '1e40af' }) });
    assert.equal(p.status, 200);
    assert.equal(p.headers['content-type'], 'image/svg+xml; charset=utf-8');
    assert.ok(p.body.includes('fill="#dbeafe"') && p.body.includes('fill="#1e40af"'));
    assertSafeSvg(p.body);
    const b = await call(svgModule, 'GET', '/api/badge', { query: q({ label: '文档', message: '中文', color: 'blue' }) });
    assert.ok(b.body.includes('#007ec6'));
    assertSafeSvg(b.body);
    const t = await call(svgModule, 'GET', '/api/text-image', { query: q({ text: '白日依山尽\n黄河入海流', align: 'center', bg: 'fff7ed' }) });
    assert.ok(t.body.includes('text-anchor="middle"') && t.body.includes('fill="#fff7ed"'));
    assertSafeSvg(t.body);

    const bad = [
      ['/api/placeholder', { width: '0' }], ['/api/placeholder', { width: '4001' }], ['/api/placeholder', { bg: 'red"/><script>' }],
      ['/api/placeholder', { color: '12345' }], ['/api/badge', {}], ['/api/badge', { message: '  ' }],
      ['/api/badge', { message: 'x', color: 'url(#a)' }], ['/api/badge', { message: 'x', style: '3d' }],
      ['/api/text-image', {}], ['/api/text-image', { text: ' ' }], ['/api/text-image', { text: 'x', style: 'ink' }],
      ['/api/text-image', { text: 'x', color: 'blue' }],
    ];
    for (const [path, params] of bad) await assert.rejects(call(svgModule, 'GET', path, { query: q(params) }), { status: 400 }, `${path} ${JSON.stringify(params)}`);
  });
});

// ---------------- 经由完整 HTTP 流程 ----------------

test('HTTP：POST 请求体、回显去凭据、调用日志不含查询参数', async () => {
  const { handle } = await import('../../src/app.js');
  const { sql } = await import('../../src/db.js');
  const server = createServer(handle).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const pw = await post('/api/tools/password-strength', { password: 'Tr0ub4dor&3' });
    assert.equal(pw.code, 200);
    assert.equal(typeof pw.data.score, 'number');
    const jwt = await post('/api/tools/jwt', { token: EXAMPLE_TOKEN, secret: 'your-256-bit-secret' });
    assert.equal(jwt.data.verified, true);
    const json = await post('/api/tools/json', { text: '[1,2]', action: 'minify' });
    assert.equal(json.data.result, '[1,2]');

    const echo = await fetch(`${base}/api/tools/echo?hello=1&token=zzz`, { headers: { cookie: 'sid=abc', 'x-custom': 'y' } }).then((r) => r.json());
    assert.equal(echo.data.headers['x-custom'], 'y');
    assert.equal(echo.data.headers.cookie, undefined);
    assert.deepEqual(echo.data.query, { hello: '1' });

    const svg = await fetch(`${base}/api/badge?message=ok`);
    assert.equal(svg.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
    assert.match(svg.headers.get('content-security-policy'), /default-src 'none'/);

    // 请求日志只有路径，没有查询参数和请求体
    await fetch(`${base}/api/tools/jwt?token=${encodeURIComponent(EXAMPLE_TOKEN)}&secret=topsecret`);
    const rows = sql('SELECT path FROM request_log').all().map((r) => r.path);
    assert.ok(rows.includes('/api/tools/jwt'));
    assert.ok(rows.every((p) => !p.includes('?') && !p.includes('topsecret')));
  } finally {
    server.close();
  }
});

// ---------------- 覆盖检查 ----------------

test('本文件负责的每个非 raw 路由都做了字段双向校验，raw 路由都有 returns', () => {
  const routes = MODULES.flatMap((m) => m.routes);
  const expected = routes.filter((r) => !r.raw).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(expected.filter((k) => !checked.has(k)), []);
  for (const r of routes.filter((x) => x.raw)) {
    assert.ok(typeof r.returns === 'string' && r.returns.length > 20, `${r.path} 缺少 returns`);
    assert.equal(r.fields, undefined, `${r.path} 是 raw 路由，用 returns 而不是 fields`);
  }
});

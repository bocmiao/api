import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { inflateSync, gzipSync } from 'node:zlib';

import qrModule, {
  rsEncode, formatBits, versionBits, encodeData, encodeQR, pickVersion, alignmentPositions,
  numDataCodewords, penalty, toPNG, toSVG, crc32,
} from '../../src/apis/tools/qrcode.js';
import shortModule, { normalizeTarget, publicOrigin, createShortLink, randomCode } from '../../src/apis/tools/shorturl.js';
import { isBlockedIP, parseIPv6, parseMeta, fetchPage, checkUrl, makeLookup, decodeBody } from '../../src/apis/tools/webmeta.js';
import { normalizeDomain, parseRdap } from '../../src/apis/tools/whois.js';
import {
  baiduSign, youdaoInput, youdaoSign, deeplEndpoint, parseDeepl, parseBaidu, parseYoudao, pickProvider,
} from '../../src/apis/tools/translate.js';
import { parseTimestamp, hashText, base64Convert, urlConvert, generatePassword } from '../../src/apis/tools/devtools.js';
import tools from '../../src/apis/tools/index.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/tools/${name}`, import.meta.url));
const q = (obj) => new URLSearchParams(obj);
const route = (mod, method, path) => mod.routes.find((r) => r.method === method && r.path === path);

// ---------------- 注册 ----------------

test('所有路由都声明了带 desc 和 example 的参数', () => {
  for (const mod of tools) {
    assert.equal(mod.category, 'tools');
    for (const r of mod.routes) {
      assert.ok(Array.isArray(r.params) && r.params.length, `${r.path} 缺少 params`);
      for (const p of r.params) assert.ok(p.desc && p.example != null, `${r.path} ${p.name}`);
    }
  }
  const publicRoutes = tools.flatMap((m) => m.routes).filter((r) => r.public).map((r) => r.path);
  assert.deepEqual(publicRoutes, ['/s/:code']);
});

// ---------------- 二维码 ----------------

describe('二维码编码器', () => {
  test('Reed-Solomon：教科书 HELLO WORLD 1-M 的 10 个纠错码字', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    assert.deepEqual(rsEncode(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  test('字节模式数据码字：模式、长度、终止符与 0xEC/0x11 填充', () => {
    const bytes = Buffer.from('HELLO WORLD');
    assert.deepEqual(
      encodeData(bytes, 1, 'M'),
      [0x40, 0xb4, 0x84, 0x54, 0xc4, 0xc4, 0xf2, 0x05, 0x74, 0xf5, 0x24, 0xc4, 0x40, 0xec, 0x11, 0xec],
    );
  });

  test('格式信息与标准表一致，且任意两个码字汉明距离 ≥ 7', () => {
    const table = {
      L: ['111011111000100', '111001011110011', '111110110101010', '111100010011101', '110011000101111', '110001100011000', '110110001000001', '110100101110110'],
      M: ['101010000010010', '101000100100101', '101111001111100', '101101101001011', '100010111111001', '100000011001110', '100111110010111', '100101010100000'],
    };
    for (const ecc of ['L', 'M']) {
      table[ecc].forEach((bits, mask) => assert.equal(formatBits(ecc, mask).toString(2).padStart(15, '0'), bits, `${ecc}${mask}`));
    }
    assert.equal(formatBits('Q', 0).toString(2).padStart(15, '0'), '011010101011111');
    assert.equal(formatBits('H', 0).toString(2).padStart(15, '0'), '001011010001001');
    const all = ['L', 'M', 'Q', 'H'].flatMap((e) => [0, 1, 2, 3, 4, 5, 6, 7].map((m) => formatBits(e, m)));
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const d = (all[i] ^ all[j]).toString(2).replace(/0/g, '').length;
        assert.ok(d >= 7, `distance ${d}`);
      }
    }
  });

  test('版本信息 BCH 码', () => {
    assert.equal(versionBits(7), 0x07c94);
    assert.equal(versionBits(8), 0x085bc);
    assert.equal(versionBits(40), 0x28c69);
  });

  test('校正图形位置与数据容量', () => {
    assert.deepEqual(alignmentPositions(1), []);
    assert.deepEqual(alignmentPositions(2), [6, 18]);
    assert.deepEqual(alignmentPositions(7), [6, 22, 38]);
    assert.deepEqual(alignmentPositions(32), [6, 34, 60, 86, 112, 138]);
    assert.deepEqual(alignmentPositions(40), [6, 30, 58, 86, 114, 142, 170]);
    assert.equal(numDataCodewords(1, 'L'), 19);
    assert.equal(numDataCodewords(1, 'H'), 9);
    assert.equal(numDataCodewords(40, 'L'), 2956);
    assert.equal(numDataCodewords(40, 'H'), 1276);
  });

  test('按字节长度自动选择最小版本（字节模式容量边界）', () => {
    assert.equal(pickVersion(17, 'L'), 1);
    assert.equal(pickVersion(18, 'L'), 2);
    assert.equal(pickVersion(7, 'H'), 1);
    assert.equal(pickVersion(8, 'H'), 2);
    assert.equal(pickVersion(2953, 'L'), 40);
    assert.equal(pickVersion(2954, 'L'), -1);
    assert.equal(pickVersion(1273, 'H'), 40);
    assert.throws(() => encodeQR('a'.repeat(1274), { ecc: 'H' }));
  });

  test('模块矩阵与参考实现（npm qrcode，指定掩码）逐位一致', () => {
    const { cases } = JSON.parse(fixture('qr-reference.json'));
    for (const c of cases) {
      const qr = encodeQR(c.text, { ecc: c.ecc, mask: c.mask });
      assert.equal(qr.version, c.version, c.text);
      assert.deepEqual(qr.modules.map((r) => r.join('')), c.rows, `${c.ecc}-${c.version} mask ${c.mask}`);
    }
  });

  test('自动掩码选择罚分最低的掩码', () => {
    for (const [text, ecc] of [['https://example.com', 'M'], ['中文二维码', 'H'], ['x'.repeat(200), 'L']]) {
      const auto = encodeQR(text, { ecc });
      const scores = [0, 1, 2, 3, 4, 5, 6, 7].map((m) => penalty(encodeQR(text, { ecc, mask: m }).modules));
      assert.equal(penalty(auto.modules), Math.min(...scores));
      assert.equal(auto.mask, scores.indexOf(Math.min(...scores)));
    }
  });

  test('CRC32 标准校验值', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
    assert.equal(crc32(Buffer.alloc(0)), 0);
  });

  test('PNG：签名、分块 CRC、尺寸与像素正确', () => {
    const qr = encodeQR('HELLO WORLD', { ecc: 'M' });
    const scale = 3;
    const margin = 2;
    const png = toPNG(qr, { scale, margin });
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let off = 8;
    const chunks = {};
    const types = [];
    while (off < png.length) {
      const len = png.readUInt32BE(off);
      const type = png.toString('ascii', off + 4, off + 8);
      const data = png.subarray(off + 8, off + 8 + len);
      assert.equal(png.readUInt32BE(off + 8 + len), crc32(png.subarray(off + 4, off + 8 + len)), `${type} CRC`);
      (chunks[type] ??= []).push(data);
      types.push(type);
      off += 12 + len;
    }
    assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND']);
    const dim = (qr.size + margin * 2) * scale;
    const ihdr = chunks.IHDR[0];
    assert.equal(ihdr.readUInt32BE(0), dim);
    assert.equal(ihdr.readUInt32BE(4), dim);
    assert.equal(ihdr[8], 1);
    assert.equal(ihdr[9], 0);
    const raw = inflateSync(Buffer.concat(chunks.IDAT));
    const rowBytes = Math.ceil(dim / 8);
    assert.equal(raw.length, (rowBytes + 1) * dim);
    const pixelDark = (x, y) => ((raw[y * (rowBytes + 1) + 1 + (x >> 3)] >> (7 - (x & 7))) & 1) === 0;
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        const px = (x + margin) * scale + 1;
        const py = (y + margin) * scale + 1;
        assert.equal(pixelDark(px, py), qr.modules[y][x] === 1);
      }
    }
    assert.equal(pixelDark(0, 0), false);
  });

  test('SVG 输出与路由', async () => {
    const qr = encodeQR('hi');
    const svg = toSVG(qr, { scale: 4, margin: 4 });
    assert.match(svg, /^<svg[^>]+viewBox="0 0 29 29"/);
    const r = route(qrModule, 'GET', '/api/qrcode');
    assert.equal(r.raw, true);
    const res = await r.handler({ query: q({ text: 'https://example.com', size: '300' }) });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^image\/svg\+xml/);
    const png = await r.handler({ query: q({ text: '你好', format: 'png', ecc: 'H' }) });
    assert.equal(png.headers['content-type'], 'image/png');
    assert.ok(Buffer.isBuffer(png.body));
    await assert.rejects(r.handler({ query: q({}) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ text: 'a', ecc: 'X' }) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ text: 'a'.repeat(1001) }) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ text: '汉'.repeat(500), ecc: 'H' }) }), { status: 400 });
  });
});

// ---------------- 短链 ----------------

describe('短链接', () => {
  const create = route(shortModule, 'POST', '/api/shorturl');
  const stats = route(shortModule, 'GET', '/api/shorturl/stats');
  const go = route(shortModule, 'GET', '/s/:code');
  const req = { headers: { host: 'hub.test:8080' } };

  test('网址校验', () => {
    assert.equal(normalizeTarget(' https://Example.com/a b '), 'https://example.com/a%20b');
    for (const bad of ['javascript:alert(1)', 'ftp://x.com/', 'data:text/html,hi', 'not a url', '', undefined, `https://a.com/${'x'.repeat(2048)}`]) {
      assert.throws(() => normalizeTarget(bad), { status: 400 }, String(bad).slice(0, 30));
    }
  });

  test('短码为 6 位 base62', () => {
    for (let i = 0; i < 50; i++) assert.match(randomCode(), /^[0-9A-Za-z]{6}$/);
  });

  test('origin：PUBLIC_URL 优先，否则取 Host', () => {
    const saved = process.env.PUBLIC_URL;
    delete process.env.PUBLIC_URL;
    assert.equal(publicOrigin(req), 'http://hub.test:8080');
    assert.equal(publicOrigin({ headers: { host: 'a.com', 'x-forwarded-proto': 'https' } }), 'https://a.com');
    assert.equal(publicOrigin({ headers: { host: 'evil.com/"><script>' } }), 'http://localhost');
    process.env.PUBLIC_URL = 'https://s.example.com/';
    assert.equal(publicOrigin(req), 'https://s.example.com');
    if (saved === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = saved;
  });

  test('创建、去重、跳转计数、统计', async () => {
    const saved = process.env.PUBLIC_URL;
    delete process.env.PUBLIC_URL;
    const a = await create.handler({ body: { url: 'https://github.com/nodejs/node' }, user: { id: 7, email: 'a@b.c' }, req });
    assert.match(a.data.code, /^[0-9A-Za-z]{6}$/);
    assert.equal(a.data.short, `http://hub.test:8080/s/${a.data.code}`);
    assert.equal(a.data.url, 'https://github.com/nodejs/node');
    const b = await create.handler({ body: { url: 'https://github.com/nodejs/node' }, user: null, req });
    assert.equal(b.data.code, a.data.code);
    const c = createShortLink('https://github.com/nodejs/node?x=1');
    assert.notEqual(c.code, a.data.code);

    const r1 = await go.handler({ params: { code: a.data.code } });
    assert.equal(r1.status, 302);
    assert.equal(r1.headers.location, 'https://github.com/nodejs/node');
    await go.handler({ params: { code: a.data.code } });

    const s = await stats.handler({ query: q({ code: a.data.code }), req });
    assert.equal(s.data.hits, 2);
    assert.equal(s.data.url, 'https://github.com/nodejs/node');
    assert.match(s.data.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    if (saved !== undefined) process.env.PUBLIC_URL = saved;
  });

  test('不存在的短码与非法参数', async () => {
    const r = await go.handler({ params: { code: 'zzzzzz' } });
    assert.equal(r.status, 404);
    assert.match(r.body, /短链接不存在/);
    assert.equal((await go.handler({ params: { code: '../etc' } })).status, 404);
    await assert.rejects(stats.handler({ query: q({ code: 'zzzzzz' }), req }), { status: 404 });
    await assert.rejects(stats.handler({ query: q({ code: '!!' }), req }), { status: 400 });
    await assert.rejects(create.handler({ body: { url: 'javascript:alert(1)' }, req }), { status: 400 });
    await assert.rejects(create.handler({ body: undefined, req }), { status: 400 });
  });
});

// ---------------- 网页信息 / SSRF ----------------

describe('SSRF 防护：IP 段检查', () => {
  const blocked = [
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.254', '127.0.0.1', '127.255.0.1',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.0.2.1', '192.88.99.1', '192.168.1.1',
    '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250', '240.0.0.1',
    '255.255.255.255',
    '::', '::1', '[::1]', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.1.2.3', '::ffff:169.254.169.254',
    '0:0:0:0:0:ffff:192.168.0.1', '::127.0.0.1', '::ffff:0:127.0.0.1', '64:ff9b::10.0.0.1', '64:ff9b:1::1',
    '2002:7f00:1::', '2002:c0a8:0101::1', '100::1', '2001::1', '2001:0:4136:e378::1', '2001:db8::1', '3fff::1',
    'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'febf::1', 'fec0::1', 'ff02::1', 'ff0e::1',
    'not-an-ip', '', '1.2.3', '01.2.3.4',
  ];
  const allowed = [
    '1.1.1.1', '8.8.8.8', '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0', '192.169.0.1',
    '198.17.255.255', '198.20.0.0', '223.255.255.255', '11.0.0.1', '126.255.255.255', '169.253.0.1',
    '2606:4700:4700::1111', '2001:4860:4860::8888', '2400:3200::1', '::ffff:8.8.8.8', '64:ff9b::808:808',
    '2002:0808:0808::1', '2001:200::1', '3fff:1000::1',
  ];
  for (const ip of blocked) test(`拒绝 ${ip || '(空)'}`, () => assert.equal(isBlockedIP(ip), true));
  for (const ip of allowed) test(`允许 ${ip}`, () => assert.equal(isBlockedIP(ip), false));

  test('IPv6 解析', () => {
    assert.deepEqual(parseIPv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(parseIPv6('::ffff:1.2.3.4'), [0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    assert.deepEqual(parseIPv6('2001:db8::'), [0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(parseIPv6('1:2:3:4:5:6:7:8'), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(parseIPv6('1:2:3:4:5:6:1.2.3.4'), [1, 2, 3, 4, 5, 6, 0x0102, 0x0304]);
    assert.equal(parseIPv6('1.2.3.4'), null);
  });

  test('URL 预检查', () => {
    for (const bad of ['file:///etc/passwd', 'gopher://x.com', 'http://127.0.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
      'http://2130706433/', 'http://0x7f.1/', 'http://017700000001/', 'http://localhost:3000/', 'http://a.localhost/',
      'http://intranet/', 'http://user:pw@example.com/', 'http://169.254.169.254/latest/meta-data/', 'not a url']) {
      assert.throws(() => checkUrl(bad), { status: 400 }, bad);
    }
    assert.equal(checkUrl('https://example.com/a#frag').href, 'https://example.com/a');
  });

  test('连接时 DNS 解析结果也会被检查（localhost → 127.0.0.1）', async () => {
    const lookup = makeLookup(isBlockedIP);
    const err = await new Promise((resolve) => lookup('localhost', { all: true }, (e) => resolve(e)));
    assert.equal(err?.code, 'EBLOCKED');
  });
});

describe('网页信息抓取', () => {
  test('解析标题、描述、分享图、图标、站点名', () => {
    const html = fixture('page.html').toString('utf8');
    const meta = parseMeta(html, 'https://www.example.com/path/page');
    assert.equal(meta.title, '示例站点 & 首页');
    assert.equal(meta.description, '这是一个用于测试的 "示例" 页面');
    assert.equal(meta.siteName, '示例网');
    assert.equal(meta.image, 'https://www.example.com/static/og.png?v=2&s=1');
    assert.equal(meta.favicon, 'https://cdn.example.com/favicon.ico');
    assert.equal(meta.type, 'website');
    assert.equal(meta.canonical, 'https://www.example.com/');
  });

  test('缺省值：无 favicon 时回退 /favicon.ico，无站点名时用域名', () => {
    const meta = parseMeta('<html><head><TITLE>T</TITLE></head></html>', 'https://a.example.org/x/y');
    assert.equal(meta.title, 'T');
    assert.equal(meta.description, null);
    assert.equal(meta.image, null);
    assert.equal(meta.favicon, 'https://a.example.org/favicon.ico');
    assert.equal(meta.siteName, 'a.example.org');
  });

  test('javascript: 图片地址被忽略', () => {
    const meta = parseMeta('<meta property="og:image" content="javascript:alert(1)">', 'https://a.com/');
    assert.equal(meta.image, null);
  });

  test('按 meta 声明的字符集解码 GBK 页面', () => {
    const gbk = Buffer.from('3c6d65746120636861727365743d6762323331323e3c7469746c653ec4e3bac33c2f7469746c653e', 'hex');
    assert.match(decodeBody(gbk, 'text/html'), /<title>你好<\/title>/);
  });

  // 本地服务器在 127.0.0.1，测试时替换 blocked 以允许回环，但仍拦截 10.0.0.0/8
  describe('请求流程（本地测试服务器）', () => {
    let server;
    let base;
    const blocked = (ip) => ip.startsWith('10.');
    before(async () => {
      server = createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        const hop = (n) => `${base}/redirect/${n}`;
        if (u.pathname === '/page') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end('<title>本地页面</title><meta name="description" content="desc">');
        }
        if (u.pathname.startsWith('/redirect/')) {
          const n = Number(u.pathname.split('/')[2]);
          res.writeHead(302, { location: n > 0 ? hop(n - 1) : '/page' });
          return res.end();
        }
        if (u.pathname === '/to-internal') {
          res.writeHead(301, { location: 'http://10.0.0.1/admin' });
          return res.end();
        }
        if (u.pathname === '/to-file') {
          res.writeHead(302, { location: 'file:///etc/passwd' });
          return res.end();
        }
        if (u.pathname === '/json') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end('{}');
        }
        if (u.pathname === '/huge') {
          res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
          return res.end(gzipSync(Buffer.alloc(5 * 1024 * 1024, 'a')));
        }
        if (u.pathname === '/slow') {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.write('<title>');
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => server.closeAllConnections?.() ?? server.close());

    test('默认拒绝回环地址', async () => {
      await assert.rejects(fetchPage(`${base}/page`), { status: 400 });
    });

    test('正常抓取 + 最多 3 次重定向', async () => {
      const page = await fetchPage(`${base}/redirect/2`, { blocked });
      assert.equal(page.url, `${base}/page`);
      assert.match(page.body.toString(), /本地页面/);
      await assert.rejects(fetchPage(`${base}/redirect/3`, { blocked }), { status: 502 });
    });

    test('重定向到内网或非 http 协议被拒绝', async () => {
      await assert.rejects(fetchPage(`${base}/to-internal`, { blocked }), { status: 400 });
      await assert.rejects(fetchPage(`${base}/to-file`, { blocked }), { status: 400 });
    });

    test('只解析 HTML，非 2xx 报错', async () => {
      await assert.rejects(fetchPage(`${base}/json`, { blocked }), { status: 415 });
      await assert.rejects(fetchPage(`${base}/missing`, { blocked }), { status: 502 });
    });

    test('解压后最多读取 1MB', async () => {
      const page = await fetchPage(`${base}/huge`, { blocked });
      assert.equal(page.body.length, 1024 * 1024);
    });

    test('超时返回 504', async () => {
      await assert.rejects(fetchPage(`${base}/slow`, { blocked, timeoutMs: 300 }), { status: 504 });
    });
  });
});

// ---------------- Whois ----------------

describe('Whois (RDAP)', () => {
  test('域名校验与规范化', () => {
    assert.equal(normalizeDomain('Example.COM'), 'example.com');
    assert.equal(normalizeDomain('https://www.github.com/path?q=1'), 'github.com');
    assert.equal(normalizeDomain('example.com.'), 'example.com');
    assert.equal(normalizeDomain('例子.中国'), 'xn--fsqu00a.xn--fiqs8s');
    assert.equal(normalizeDomain('sub.example.co.uk'), 'sub.example.co.uk');
    for (const bad of ['localhost', 'exa mple.com', '-a.com', 'a-.com', '1.2.3.4', 'a..com', `${'a'.repeat(64)}.com`, '', 'com']) {
      assert.equal(normalizeDomain(bad), null, bad);
    }
  });

  test('解析 RDAP 响应', () => {
    const d = parseRdap(JSON.parse(fixture('rdap-example.json')));
    assert.equal(d.domain, 'google.com');
    assert.equal(d.registrar.name, 'MarkMonitor Inc.');
    assert.equal(d.registrar.ianaId, '292');
    assert.equal(d.registrar.abuseEmail, 'abusecomplaints@markmonitor.com');
    assert.equal(d.created, '1997-09-15T04:00:00Z');
    assert.equal(d.updated, '2019-09-09T15:39:04Z');
    assert.equal(d.expires, '2028-09-14T04:00:00Z');
    assert.deepEqual(d.nameservers, ['ns1.google.com', 'ns2.google.com', 'ns3.google.com', 'ns4.google.com']);
    assert.ok(d.status.includes('client transfer prohibited'));
    assert.equal(d.dnssec, false);
  });

  test('格式异常时抛出 502', () => {
    assert.throws(() => parseRdap({ errorCode: 404 }), { status: 502 });
  });
});

// ---------------- 翻译 ----------------

describe('翻译', () => {
  const responses = JSON.parse(fixture('translate-responses.json'));

  test('百度签名：官方文档示例', () => {
    assert.equal(baiduSign('2015063000000001', 'apple', '1435660288', '12345678'), 'f89f9594663708c1605f3d736d01d2d4');
  });

  test('有道 v3 input 截断规则', () => {
    assert.equal(youdaoInput('hello'), 'hello');
    assert.equal(youdaoInput('a'.repeat(20)), 'a'.repeat(20));
    assert.equal(youdaoInput('0123456789abcdefghijKLMNOPQRST'), '012345678930KLMNOPQRST');
    assert.equal(youdaoInput('一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子'), '一二三四五六七八九十21乙丙丁戊己庚辛壬癸子');
  });

  test('有道 v3 签名 = sha256(appKey + input + salt + curtime + appSecret)', () => {
    const q2 = '0123456789abcdefghijKLMNOPQRST';
    const expected = createHash('sha256').update('KEY012345678930KLMNOPQRSTsalt1700000000SECRET').digest('hex');
    assert.equal(youdaoSign('KEY', q2, 'salt', '1700000000', 'SECRET'), expected);
  });

  test('DeepL 免费密钥使用 api-free 域名', () => {
    assert.equal(deeplEndpoint('abc:fx'), 'https://api-free.deepl.com/v2/translate');
    assert.equal(deeplEndpoint('abc'), 'https://api.deepl.com/v2/translate');
  });

  test('解析各家响应', () => {
    assert.deepEqual(parseDeepl(responses.deepl), { result: '你好，世界！', detected: 'en' });
    assert.deepEqual(parseBaidu(responses.baidu), { result: '你好，世界！', detected: 'en' });
    assert.deepEqual(parseYoudao(responses.youdao), { result: '你好，世界！', detected: 'en' });
    assert.throws(() => parseBaidu(responses.baiduError), { status: 502, message: /54001/ });
    assert.throws(() => parseYoudao(responses.youdaoError), { status: 502, message: /202/ });
    assert.throws(() => parseDeepl({}), { status: 502 });
  });

  test('按已配置的环境变量选择服务', () => {
    const keys = ['DEEPL_API_KEY', 'BAIDU_TRANSLATE_APPID', 'BAIDU_TRANSLATE_KEY', 'YOUDAO_APP_KEY', 'YOUDAO_APP_SECRET'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    try {
      assert.throws(() => pickProvider(), { status: 503 });
      process.env.YOUDAO_APP_KEY = 'k';
      assert.throws(() => pickProvider(), { status: 503 });
      process.env.YOUDAO_APP_SECRET = 's';
      assert.equal(pickProvider(), 'youdao');
      process.env.BAIDU_TRANSLATE_APPID = 'a';
      process.env.BAIDU_TRANSLATE_KEY = 'b';
      assert.equal(pickProvider(), 'baidu');
      assert.equal(pickProvider('youdao'), 'youdao');
      assert.throws(() => pickProvider('deepl'), { status: 503 });
      assert.throws(() => pickProvider('google'), { status: 400 });
    } finally {
      for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });
});

// ---------------- 开发小工具 ----------------

describe('开发小工具', () => {
  test('时间戳：秒 / 毫秒 / 日期字符串', () => {
    const s = parseTimestamp('1758700800');
    assert.equal(s.detected, 'seconds');
    assert.equal(s.milliseconds, 1758700800000);
    assert.equal(s.iso, '2025-09-24T08:00:00.000Z');
    assert.equal(s.beijing, '2025-09-24 16:00:00');
    assert.equal(s.weekday, '星期三');

    const ms = parseTimestamp('1758700800123');
    assert.equal(ms.detected, 'milliseconds');
    assert.equal(ms.seconds, 1758700800);

    const d = parseTimestamp('2025-09-24 16:00:00');
    assert.equal(d.detected, 'date');
    assert.equal(d.seconds, 1758700800);
    assert.equal(parseTimestamp('2025/9/24').iso, '2025-09-23T16:00:00.000Z');
    assert.equal(parseTimestamp('2025-09-24T08:00:00Z').seconds, 1758700800);
    assert.equal(parseTimestamp('0').iso, '1970-01-01T00:00:00.000Z');
    assert.equal(parseTimestamp('', 1000).detected, 'now');
    assert.throws(() => parseTimestamp('abc'), { status: 400 });
  });

  test('哈希已知值', () => {
    assert.equal(hashText('hello', 'md5').hex, '5d41402abc4b2a76b9719d911017c592');
    assert.equal(hashText('hello', 'sha1').hex, 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
    assert.equal(hashText('hello', 'sha256').hex, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    assert.equal(hashText('', 'sha512').hex.slice(0, 16), 'cf83e1357eefb8bd');
  });

  test('Base64 / URL 编解码', () => {
    assert.equal(base64Convert('你好，世界', 'encode'), '5L2g5aW977yM5LiW55WM');
    assert.equal(base64Convert('5L2g5aW977yM5LiW55WM', 'decode'), '你好，世界');
    assert.equal(base64Convert('aGk', 'decode'), 'hi');
    assert.equal(base64Convert('Pz8-', 'decode'), '??>');
    assert.throws(() => base64Convert('@@@', 'decode'), { status: 400 });
    assert.throws(() => base64Convert('/w==', 'decode'), { status: 400 });
    assert.equal(urlConvert('a=1&b=中文', 'encode'), 'a%3D1%26b%3D%E4%B8%AD%E6%96%87');
    assert.equal(urlConvert('a%3D1%26b%3D%E4%B8%AD%E6%96%87', 'decode'), 'a=1&b=中文');
    assert.throws(() => urlConvert('%E4%B8', 'decode'), { status: 400 });
  });

  test('随机密码', () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword(12, true);
      assert.equal(p.length, 12);
      assert.match(p, /[a-z]/);
      assert.match(p, /[A-Z]/);
      assert.match(p, /[0-9]/);
      assert.match(p, /[^A-Za-z0-9]/);
      assert.match(generatePassword(8, false), /^[A-Za-z0-9]{8}$/);
    }
  });
});

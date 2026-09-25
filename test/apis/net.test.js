import { test, describe, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import zlib from 'node:zlib';
import { generateKeyPairSync, sign, X509Certificate } from 'node:crypto';

import allNetModules from '../../src/apis/net/index.js';
import { isBlockedIP } from '../../src/lib/netguard.js';
import { cache } from '../../src/lib/cache.js';
import {
  parseHost, requireHost, resolvePublic, createGate, mapLimit, statusText, BLOCKED_MSG,
} from '../../src/apis/net/common.js';
import { lookupDns, normalizeRecords, reverseName, classifyDnsError, DNS_SERVERS } from '../../src/apis/net/dns.js';
import { inspectCert, parseSan, signatureAlgorithmOf, decodeOid } from '../../src/apis/net/ssl.js';
import { checkSite, probeHttp2 } from '../../src/apis/net/site.js';
import { tcping, summarize } from '../../src/apis/net/tcping.js';
import { parsePing, runPing, ping, UNSUPPORTED_MSG } from '../../src/apis/net/ping.js';
import { checkAvailability, registrableDomain, bootstrapTlds } from '../../src/apis/net/domain.js';
import {
  parseRobots, robotsMatch, isAllowed, selectGroups, normalizeRobotsPath, analyzeRobots,
} from '../../src/apis/net/robots.js';
import {
  findIcons, rankIcons, findFavicon, iconResponse, iconCacheStats, clearIconCache, _cacheSetForTest,
} from '../../src/apis/net/favicon.js';
import { stripNoise, scanTags, parseAttrs, textOf, safeDecode } from '../../src/lib/html.js';
import { extractLinks, checkLinks } from '../../src/apis/net/links.js';
import { parseTldList, classifyTld, searchTlds, toItem, resetTldState } from '../../src/apis/net/tld.js';
import { assertFieldsDocumented, matcher } from '../helpers/fields.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/net/${name}`, import.meta.url), 'utf8');
const q = (obj) => new URLSearchParams(obj);
// 站长类新接口（安全头、邮件、RSS、正文、整站抓取、App Store）在 test/apis/webmaster.test.js 中测试
const WEBMASTER = new Set(['site-headers', 'email-security', 'email-check', 'rss', 'web-content', 'crawl', 'appstore']);
const netModules = allNetModules.filter((m) => !WEBMASTER.has(m.name));
const routes = netModules.flatMap((m) => m.routes);
const route = (path) => routes.find((r) => r.path === path);

// 测试服务器都监听在 127.0.0.1。注入的 blocked 只放行 127.0.0.1，10.x、::1、192.168.x 等仍按默认规则拦截
const allowLoopback = (ip) => ip !== '127.0.0.1' && isBlockedIP(ip);

// ---------------- 假 DNS：替换 dns.lookup（netguard 的 lookup 钩子在连接时调用它） ----------------

const HOSTS = {
  'site.test.example': ['127.0.0.1'],
  'secure.test.example': ['127.0.0.1'],
  'expired.test.example': ['127.0.0.1'],
  'other.test.example': ['127.0.0.1'],
  'norobots.test.example': ['127.0.0.1'],
  'err.test.example': ['127.0.0.1'],
  'redir.test.example': ['127.0.0.1'],
  'big.test.example': ['127.0.0.1'],
  'gz.test.example': ['127.0.0.1'],
  'noicon.test.example': ['127.0.0.1'],
  'public.test.example': ['93.184.216.34'],
  'internal.test.example': ['10.0.0.5'],
  'mixed.test.example': ['93.184.216.34', '10.0.0.6'],
  'v6.test.example': ['::1'],
};
const lookedUp = [];
function fakeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  lookedUp.push(hostname);
  const list = net.isIP(hostname) ? [hostname] : HOSTS[hostname]; // server.listen('127.0.0.1') 也会调用 dns.lookup
  if (!list) return process.nextTick(callback, Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
  const addrs = list.map((address) => ({ address, family: net.isIP(address) }));
  return process.nextTick(() => (options.all ? callback(null, addrs) : callback(null, addrs[0].address, addrs[0].family)));
}

// ---------------- 用 node:crypto 生成测试证书（最小 X.509 DER 编码） ----------------

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
const set = (...p) => tlv(0x31, ...p);
const derInt = (buf) => {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  const b = buf.subarray(i);
  return tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
};
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
const derTime = (d) => {
  const s = `${d.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(s.slice(2))) : tlv(0x18, Buffer.from(s));
};
const derName = ({ CN, O, C }) => seq(...[
  C && set(seq(oid('2.5.4.6'), tlv(0x13, Buffer.from(C)))),
  O && set(seq(oid('2.5.4.10'), tlv(0x0c, Buffer.from(O)))),
  CN && set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(CN)))),
].filter(Boolean));

function makeCert({ subject, issuer = subject, key, signKey = key.privateKey, rsa = false, serial = 1, notBefore, notAfter, dnsNames = [], ips = [], ca = false }) {
  const alg = rsa ? seq(oid('1.2.840.113549.1.1.11'), tlv(0x05)) : seq(oid('1.2.840.10045.4.3.2'));
  const exts = [];
  if (dnsNames.length || ips.length) {
    const names = [...dnsNames.map((d) => tlv(0x82, Buffer.from(d))), ...ips.map((ip) => tlv(0x87, Buffer.from(ip.split('.').map(Number))))];
    exts.push(seq(oid('2.5.29.17'), tlv(0x04, seq(...names))));
  }
  if (ca) exts.push(seq(oid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq(tlv(0x01, Buffer.from([0xff]))))));
  const serialBuf = Buffer.alloc(8);
  serialBuf.writeBigUInt64BE(BigInt(serial));
  const tbs = seq(
    tlv(0xa0, derInt(Buffer.from([2]))), derInt(serialBuf), alg, derName(issuer), seq(derTime(notBefore), derTime(notAfter)), derName(subject),
    key.publicKey.export({ type: 'spki', format: 'der' }),
    ...(exts.length ? [tlv(0xa3, seq(...exts))] : []),
  );
  const der = seq(tbs, alg, tlv(0x03, Buffer.from([0]), sign('sha256', tbs, signKey)));
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}
const pemKey = (k) => k.privateKey.export({ type: 'pkcs8', format: 'pem' });

const DAY = 86_400_000;
const NOW = Date.now();
const ROOT_NAME = { CN: 'Miao Test Root CA', O: 'Miao Test', C: 'CN' };
const INTER_NAME = { CN: 'Miao Test Issuing CA', O: 'Miao Test', C: 'CN' };
const RSA_ROOT_NAME = { CN: 'Miao RSA Root', O: 'Miao Test', C: 'US' };
const keys = {
  root: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
  inter: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
  leaf: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
  rsaRoot: generateKeyPairSync('rsa', { modulusLength: 2048 }),
  // SNI 切换证书时 TLS 1.3 下 OpenSSL 不会从 EC 证书换成 RSA 证书，所以过期证书用 EC 公钥、由 RSA 根证书签名
  expired: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
};
const certs = {};
certs.root = makeCert({ subject: ROOT_NAME, key: keys.root, ca: true, serial: 1, notBefore: new Date(NOW - DAY), notAfter: new Date(NOW + 3650 * DAY) });
certs.inter = makeCert({ subject: INTER_NAME, issuer: ROOT_NAME, key: keys.inter, signKey: keys.root.privateKey, ca: true, serial: 2, notBefore: new Date(NOW - DAY), notAfter: new Date(NOW + 1000.5 * DAY) });
certs.leaf = makeCert({
  subject: { CN: 'secure.test.example', O: 'Miao', C: 'CN' }, issuer: INTER_NAME, key: keys.leaf, signKey: keys.inter.privateKey, serial: 0xabcdef,
  notBefore: new Date(NOW - DAY), notAfter: new Date(NOW + 30.5 * DAY),
  dnsNames: ['secure.test.example', 'site.test.example', '*.wild.test.example'], ips: ['127.0.0.1'],
});
certs.rsaRoot = makeCert({ subject: RSA_ROOT_NAME, key: keys.rsaRoot, rsa: true, ca: true, serial: 3, notBefore: new Date(NOW - DAY), notAfter: new Date(NOW + 3650 * DAY) });
certs.expired = makeCert({
  subject: { CN: 'expired.test.example' }, issuer: RSA_ROOT_NAME, key: keys.expired, signKey: keys.rsaRoot.privateKey, rsa: true, serial: 4,
  notBefore: new Date(NOW - 400 * DAY), notAfter: new Date(NOW - 10.5 * DAY), dnsNames: ['expired.test.example'],
});

// ---------------- 本地测试服务器 ----------------

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const ICO = Buffer.from('00000100010010100000010020006804000016000000', 'hex');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>alert(document.cookie)</script><rect width="1" height="1"/></svg>';
const SITE_BODY = '<!doctype html><title>ok</title>'.padEnd(4000, ' 你好 hello');

let web; // HTTP
let secure; // HTTPS（HTTP/2 + HTTP/1.1）
let tcp; // 纯 TCP
let PORT;
let SPORT;
let TPORT;
let CLOSED;
let hits = {};
let conns = { web: 0, secure: 0, tcp: 0 }; // 各测试服务器收到的 TCP 连接数，用于确认内网目标没有被连接

function compress(req, res, body, headers, forced) {
  const enc = forced ?? (/\bbr\b/.test(req.headers['accept-encoding'] ?? '') ? 'br' : /gzip/.test(req.headers['accept-encoding'] ?? '') ? 'gzip' : 'none');
  const data = enc === 'gzip' ? zlib.gzipSync(body) : enc === 'br' ? zlib.brotliCompressSync(body) : enc === 'deflate' ? zlib.deflateSync(body) : Buffer.from(body);
  res.writeHead(200, { ...headers, 'content-length': data.length, ...(enc === 'none' ? {} : { 'content-encoding': enc }) });
  res.end(req.method === 'HEAD' ? undefined : data);
}

function webHandler(req, res) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  hits[p] = (hits[p] ?? 0) + 1;
  const html = (body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
  const redirect = (code, location) => { res.writeHead(code, location ? { location } : {}); res.end(); };

  if (p === '/robots.txt') {
    if (host === 'norobots.test.example') { res.writeHead(404); return res.end('not found'); }
    if (host === 'err.test.example') { res.writeHead(503); return res.end(); }
    if (host === 'redir.test.example') return redirect(301, 'http://10.0.0.1/robots.txt');
    if (host === 'big.test.example') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(`User-agent: *\n${'Disallow: /x\n'.repeat(60_000)}Disallow: /after-limit\n`);
    }
    if (host === 'gz.test.example') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      return res.end(zlib.gzipSync('User-agent: *\nDisallow: /gz-only\n'));
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(fixture('robots.txt'));
  }

  // 网站检测
  if (p === '/site/ok') return compress(req, res, SITE_BODY, { 'content-type': 'text/html; charset=utf-8', server: 'miao-test/1.0' }, u.searchParams.get('enc') ?? undefined);
  const hop = /^\/site\/redirect\/(\d+)$/.exec(p);
  if (hop) return redirect(302, Number(hop[1]) > 1 ? `/site/redirect/${Number(hop[1]) - 1}` : '/site/ok?enc=gzip');
  if (p === '/site/relative') return redirect(301, 'ok?enc=none');
  if (p === '/site/to-internal') return redirect(302, 'http://10.0.0.1/');
  if (p === '/site/to-localhost') return redirect(302, `http://localhost:${PORT}/secret`);
  if (p === '/site/to-v6') return redirect(302, `http://[::1]:${PORT}/secret`);
  if (p === '/site/to-dns-internal') return redirect(302, `http://internal.test.example:${PORT}/secret`);
  if (p === '/site/to-mixed') return redirect(302, `http://mixed.test.example:${PORT}/secret`);
  if (p === '/site/to-metadata') return redirect(307, 'http://169.254.169.254/latest/meta-data/');
  if (p === '/site/to-file') return redirect(302, 'file:///etc/passwd');
  if (p === '/site/no-location') return redirect(302);
  if (p === '/site/missing') { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('nope'); }
  if (p === '/site/big') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    return res.end(Buffer.alloc(2 * 1024 * 1024, 1));
  }
  if (p === '/secret') { res.writeHead(200); return res.end('secret'); }

  // 死链检测
  if (p === '/links-page') return html(fixture('links.html').replaceAll('{{PORT}}', PORT).replaceAll('{{CLOSED}}', CLOSED));
  if (['/ok', '/base/rel', '/img'].includes(p)) return html(req.method === 'HEAD' ? undefined : 'ok');
  if (p === '/missing') { res.writeHead(404); return res.end(); }
  if (p === '/error') { res.writeHead(500); return res.end(); }
  if (p === '/head-405') {
    if (req.method === 'HEAD') { res.writeHead(405, { allow: 'GET' }); return res.end(); }
    return html('x'.repeat(100_000));
  }
  if (p === '/redirect-ok') return redirect(301, '/ok');
  if (p === '/redirect-internal') return redirect(302, 'http://10.0.0.1/');
  if (p === '/redirect-dns-internal') return redirect(302, `http://internal.test.example:${PORT}/secret`);
  if (p === '/slow') return undefined; // 永不响应
  if (p === '/page-to-internal') return redirect(302, 'http://10.0.0.1/');
  if (p === '/page-to-localhost') return redirect(302, `http://localhost:${PORT}/secret`);

  // 网站图标
  if (p === '/icons-page') return html(fixture('icons.html'));
  if (p === '/no-icons-page') return html('<title>没有图标</title>');
  if (p === '/big-icon-page') return html('<link rel="icon" href="/icons/big.png" sizes="64x64"><link rel="icon" href="/icons/big-chunked.png" sizes="48x48">');
  if (p === '/wrong-type-page') return html('<link rel="icon" href="/icons/not-image.png">');
  if (p === '/svg-page') return html('<link rel="icon" href="/icons/icon.svg">');
  if (p === '/icon-redirect-page') return html('<link rel="icon" href="/icons/to-internal.png" sizes="32x32">');
  if (p === '/json-page') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}'); }
  if (p === '/icons/16.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.concat([PNG, Buffer.from('16')])); }
  if (p === '/icons/32.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.concat([PNG, Buffer.from('32')])); }
  if (p === '/icons/icon.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8' }); return res.end(SVG); }
  if (p === '/icons/big.png') { res.writeHead(200, { 'content-type': 'image/png', 'content-length': 300 * 1024 }); return res.end(Buffer.alloc(300 * 1024)); }
  if (p === '/icons/big-chunked.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.alloc(300 * 1024)); }
  if (p === '/icons/not-image.png') return html('<p>not an image</p>');
  if (p === '/icons/to-internal.png') return redirect(302, 'http://10.0.0.1/icon.png');
  if (p === '/favicon.ico') {
    if (host === 'noicon.test.example') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'image/x-icon' });
    return res.end(ICO);
  }
  res.writeHead(404);
  return res.end();
}

before(async () => {
  mock.method(dns, 'lookup', fakeLookup);
  web = http.createServer(webHandler);
  web.on('connection', () => { conns.web++; });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  PORT = web.address().port;

  const defaultCtx = { key: pemKey(keys.leaf), cert: certs.leaf + certs.inter + certs.root };
  const expiredCtx = tls.createSecureContext({ key: pemKey(keys.expired), cert: certs.expired + certs.rsaRoot });
  secure = http2.createSecureServer({
    ...defaultCtx,
    allowHTTP1: true,
    SNICallback: (name, cb) => cb(null, name === 'expired.test.example' ? expiredCtx : tls.createSecureContext(defaultCtx)),
  }, (req, res) => {
    hits[`https:${req.url}`] = (hits[`https:${req.url}`] ?? 0) + 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', server: 'miao-secure/1.0' });
    res.end('<title>secure</title>');
  });
  secure.on('connection', () => { conns.secure++; });
  await new Promise((r) => secure.listen(0, '127.0.0.1', r));
  SPORT = secure.address().port;

  tcp = net.createServer((s) => s.end());
  tcp.on('connection', () => { conns.tcp++; });
  await new Promise((r) => tcp.listen(0, '127.0.0.1', r));
  TPORT = tcp.address().port;

  const tmp = net.createServer();
  await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
  CLOSED = tmp.address().port;
  await new Promise((r) => tmp.close(r));
});

after(() => {
  mock.restoreAll();
  for (const s of [web, secure, tcp]) {
    s?.closeAllConnections?.();
    s?.close();
  }
});

beforeEach(() => {
  hits = {};
  conns = { web: 0, secure: 0, tcp: 0 };
});

// ---------------- 字段说明：双向校验 ----------------

const typeOf = (v) => (v == null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// 收集每个字段路径上出现过的所有值（数组元素本身也记录在 xxx[] 下）
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
// 正向：返回的每个字段都有说明；反向：说明里的每个字段都在样例中出现过且至少有一个非 null 值，实际类型都在声明之内
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
    const allowed = f.type.split('|');
    const bad = [...new Set(vs.map(typeOf))].filter((t) => !allowed.includes(t));
    if (bad.length) wrongType.push(`${f.name}（声明 ${f.type}，实际出现 ${bad.join('/')}）`);
  }
  assert.deepEqual(uncovered, [], `${r.path} 的样例没有覆盖这些字段（不存在或只有 null）：${uncovered.join(', ')}`);
  assert.deepEqual(wrongType, [], `${r.path} 的字段类型与声明不符：${wrongType.join('；')}`);
  checked.add(`${r.method} ${r.path}`);
}

// ---------------- 注册 ----------------

test('net 分类的模块与路由', () => {
  assert.equal(netModules.length, 10);
  const paths = routes.map((r) => r.path);
  assert.deepEqual(paths, [
    '/api/dns', '/api/ssl', '/api/site/check', '/api/tcping', '/api/ping', '/api/domain/available',
    '/api/robots', '/api/favicon', '/api/links/check', '/api/tld',
  ]);
  assert.equal(new Set(netModules.map((m) => m.name)).size, netModules.length);
  for (const m of netModules) {
    assert.equal(m.category, 'net');
    assert.ok(m.title && m.description && m.source, m.name);
    for (const r of m.routes) {
      assert.equal(r.method, 'GET');
      assert.ok(Array.isArray(r.params) && r.params.length, `${r.path} 缺少 params`);
      for (const p of r.params) assert.ok(p.desc && p.example != null, `${r.path} ${p.name}`);
    }
  }
});

// ---------------- 公共工具 ----------------

describe('公共工具', () => {
  test('parseHost：域名、中文域名、IP、网址', () => {
    assert.deepEqual(parseHost('Example.COM.'), { host: 'example.com', ip: null, family: 0 });
    assert.equal(parseHost('例子.中国').host, 'xn--fsqu00a.xn--fiqs8s');
    assert.equal(parseHost('https://github.com/a?b=1').host, 'github.com');
    assert.equal(parseHost('_dmarc.example.com').host, '_dmarc.example.com');
    assert.deepEqual(parseHost('[::1]'), { host: '::1', ip: '::1', family: 6 });
    assert.deepEqual(parseHost('8.8.8.8'), { host: '8.8.8.8', ip: '8.8.8.8', family: 4 });
    // 简写的 IPv4 会被规范化成 IP，再按 IP 检查
    assert.equal(parseHost('127.1').ip, '127.0.0.1');
    assert.equal(parseHost('0x7f.1').ip, '127.0.0.1');
    assert.equal(parseHost('localhost').local, true);
    assert.equal(parseHost('a.b.localhost').local, true);
    for (const bad of ['', 'com', 'exa mple.com', '-a.com', 'a-.com', 'a..com', `${'a'.repeat(64)}.com`, 'x'.repeat(301), 'http://', 'a.123']) {
      assert.equal(parseHost(bad), null, bad);
    }
  });

  test('requireHost：内网、回环、链路本地、保留地址一律拒绝', () => {
    for (const bad of ['127.0.0.1', '10.1.2.3', 'localhost', '[::1]', '::1', '::ffff:127.0.0.1', '169.254.169.254', '127.1', '0x7f.1',
      'fe80::1%eth0', '0.0.0.0', '192.168.1.1', '100.64.0.1', '224.0.0.1', 'http://[::1]:8080/']) {
      assert.throws(() => requireHost(bad), { status: 400, message: BLOCKED_MSG }, bad);
    }
    assert.throws(() => requireHost('not a host'), { status: 400, message: /不是合法/ });
    assert.equal(requireHost('1.1.1.1').ip, '1.1.1.1');
    assert.equal(requireHost('127.0.0.1', allowLoopback).ip, '127.0.0.1');
  });

  test('resolvePublic：解析结果只要有一个内网地址就拒绝', async () => {
    const pub = await resolvePublic(parseHost('public.test.example'));
    assert.equal(pub.address, '93.184.216.34');
    assert.equal(typeof pub.dnsMs, 'number');
    await assert.rejects(resolvePublic(parseHost('internal.test.example')), { status: 400, message: BLOCKED_MSG });
    await assert.rejects(resolvePublic(parseHost('mixed.test.example')), { status: 400, message: BLOCKED_MSG });
    await assert.rejects(resolvePublic(parseHost('v6.test.example')), { status: 400, message: BLOCKED_MSG });
    await assert.rejects(resolvePublic(parseHost('nx.test.example')), { status: 400, message: /无法解析/ });
    assert.deepEqual(await resolvePublic(parseHost('8.8.8.8')), { address: '8.8.8.8', family: 4, dnsMs: null });
  });

  test('并发上限：超过后直接返回 503', async () => {
    const gate = createGate(2);
    let release;
    const hold = new Promise((r) => { release = r; });
    const a = gate(() => hold);
    const b = gate(() => hold);
    assert.equal(gate.active(), 2);
    await assert.rejects(gate(async () => 1), { status: 503 });
    release();
    await Promise.all([a, b]);
    assert.equal(await gate(async () => 42), 42);
    assert.equal(gate.active(), 0);
    await assert.rejects(gate(async () => { throw new Error('x'); }), /x/);
    assert.equal(gate.active(), 0, '出错后也要释放名额');
  });

  test('mapLimit：并发不超过上限，结果保持顺序', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 0, 6], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, n * 3));
      active--;
      return n * 10;
    });
    assert.deepEqual(out, [50, 10, 40, 20, 30, 0, 60]);
    assert.equal(peak, 3);
  });

  test('HTTP 状态码中文说明', () => {
    assert.equal(statusText(200), '成功');
    assert.equal(statusText(301), '永久重定向');
    assert.equal(statusText(404), '未找到');
    assert.equal(statusText(503), '服务不可用');
    assert.equal(statusText(299), '成功');
    assert.equal(statusText(499), '客户端错误');
    assert.equal(statusText(599), '服务器错误');
    assert.equal(statusText(999), '未知状态');
  });
});

// ---------------- DNS ----------------

// 假的 dns.promises.Resolver：table[name][type] 为记录；Error 表示抛错；'hang' 表示永不返回；缺失的类型为 ENODATA，缺失的域名为 ENOTFOUND
function fakeResolver(table, calls = []) {
  const err = (code) => Object.assign(new Error(code), { code });
  const q = (type) => async (name) => {
    calls.push({ type, name });
    const rec = table[name];
    if (!rec) throw err('ENOTFOUND');
    const v = rec[type];
    if (v === 'hang') return new Promise(() => {});
    if (v instanceof Error) throw v;
    if (v === undefined) throw err('ENODATA');
    return v;
  };
  return (opts) => {
    calls.push({ opts });
    return {
      setServers(s) { calls.push({ servers: s }); },
      cancel() { calls.push({ cancel: true }); },
      resolve4: q('A'), resolve6: q('AAAA'), resolveCname: q('CNAME'), resolveMx: q('MX'), resolveTxt: q('TXT'), resolveNs: q('NS'),
      resolveSoa: q('SOA'), resolveCaa: q('CAA'), resolveSrv: q('SRV'), resolvePtr: q('PTR'),
    };
  };
}
const DNS_TABLE = {
  'example.com': {
    A: [{ address: '93.184.216.34', ttl: 300 }],
    AAAA: [{ address: '2606:2800:220:1:248:1893:25c8:1946', ttl: 300 }],
    MX: [{ exchange: 'mx2.example.com', priority: 20 }, { exchange: 'mx1.example.com', priority: 10 }],
    TXT: [['v=spf1 -all'], ['google-site-verification=', 'abc123']],
    NS: ['a.iana-servers.net', 'b.iana-servers.net'],
    SOA: { nsname: 'ns.icann.org', hostmaster: 'noc.dns.icann.org', serial: 2026092401, refresh: 7200, retry: 3600, expire: 1209600, minttl: 3600 },
    CAA: [{ critical: 0, issue: 'letsencrypt.org' }, { critical: 128, iodef: 'mailto:security@example.com' }],
    SRV: Object.assign(new Error('ESERVFAIL'), { code: 'ESERVFAIL' }),
  },
  'www.example.com': { CNAME: ['example.com'] },
  '_sip._tcp.example.com': {
    SRV: [{ name: 'sip2.example.com', port: 5060, priority: 10, weight: 20 }, { name: 'sip1.example.com', port: 5060, priority: 10, weight: 60 }],
  },
  '8.8.8.8.in-addr.arpa': { PTR: ['dns.google'] },
  'slow.example.com': { A: [{ address: '1.2.3.4', ttl: 60 }], TXT: 'hang' },
};

describe('DNS 查询', () => {
  test('反向解析名称', () => {
    assert.equal(reverseName('8.8.4.4'), '4.4.8.8.in-addr.arpa');
    assert.equal(reverseName('2001:4860:4860::8888'), '8.8.8.8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.6.8.4.0.6.8.4.1.0.0.2.ip6.arpa');
  });

  test('各类型记录统一格式', () => {
    assert.deepEqual(normalizeRecords('MX', DNS_TABLE['example.com'].MX), [
      { value: 'mx1.example.com', priority: 10 }, { value: 'mx2.example.com', priority: 20 },
    ]);
    assert.deepEqual(normalizeRecords('MX', [{ exchange: '', priority: 0 }]), [{ value: '.', priority: 0 }], 'Null MX');
    assert.deepEqual(normalizeRecords('TXT', [['a', 'b'], ['c']]), [{ value: 'ab' }, { value: 'c' }]);
    assert.deepEqual(normalizeRecords('CAA', [{ critical: 128, issuewild: ';' }]), [{ value: ';', tag: 'issuewild', flags: 128 }]);
    assert.deepEqual(normalizeRecords('SRV', DNS_TABLE['_sip._tcp.example.com'].SRV).map((r) => r.value), ['sip1.example.com', 'sip2.example.com']);
    assert.equal(normalizeRecords('SOA', DNS_TABLE['example.com'].SOA)[0].value, 'ns.icann.org');
  });

  test('没有记录与查询出错区分开', () => {
    assert.deepEqual(classifyDnsError({ code: 'ENODATA' }), { status: 'empty', error: null });
    assert.deepEqual(classifyDnsError({ code: 'ENOTFOUND' }), { status: 'nxdomain', error: null });
    assert.equal(classifyDnsError({ code: 'ETIMEOUT' }).status, 'error');
    assert.match(classifyDnsError({ code: 'ESERVFAIL' }).error, /SERVFAIL/);
    assert.match(classifyDnsError({ code: 'EWHATEVER' }).error, /EWHATEVER/);
  });

  test('ALL：除 PTR 外全部查询，各类型互不影响；默认 Cloudflare', async () => {
    const calls = [];
    const d = await lookupDns({ domain: 'Example.com' }, { createResolver: fakeResolver(DNS_TABLE, calls) });
    assert.deepEqual(calls.find((c) => c.servers).servers, ['1.1.1.1']);
    assert.equal(d.server, 'cloudflare');
    assert.equal(d.domain, 'example.com');
    assert.deepEqual(d.results.map((r) => r.type), ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'CAA', 'SRV']);
    const by = Object.fromEntries(d.results.map((r) => [r.type, r]));
    assert.equal(by.A.status, 'ok');
    assert.deepEqual(by.A.records, [{ value: '93.184.216.34', ttl: 300 }]);
    assert.equal(by.CNAME.status, 'empty');
    assert.equal(by.CNAME.error, null);
    assert.equal(by.SRV.status, 'error');
    assert.match(by.SRV.error, /SERVFAIL/);
    assert.equal(by.TXT.records[1].value, 'google-site-verification=abc123');
    for (const r of d.results) assert.equal(typeof r.ms, 'number');
  });

  test('指定服务器、类型、PTR、不存在的域名', async () => {
    const calls = [];
    const make = fakeResolver(DNS_TABLE, calls);
    const mx = await lookupDns({ domain: 'example.com', type: 'MX', server: 'alidns' }, { createResolver: make });
    assert.deepEqual(calls.find((c) => c.servers).servers, ['223.5.5.5']);
    assert.equal(mx.results.length, 1);
    const ptr = await lookupDns({ domain: '8.8.8.8' }, { createResolver: make });
    assert.equal(ptr.query, '8.8.8.8.in-addr.arpa');
    assert.deepEqual(ptr.results[0].records, [{ value: 'dns.google' }]);
    const nx = await lookupDns({ domain: 'nope.example.org', type: 'A' }, { createResolver: make });
    assert.equal(nx.results[0].status, 'nxdomain');
    await assert.rejects(lookupDns({ domain: '8.8.8.8', type: 'MX' }, { createResolver: make }), { status: 400 });
    await assert.rejects(lookupDns({ domain: 'example.com', type: 'PTR' }, { createResolver: make }), { status: 400 });
    await assert.rejects(lookupDns({ domain: 'example.com', server: '10.0.0.1' }, { createResolver: make }), { status: 400 });
    for (const [name, ip] of Object.entries(DNS_SERVERS)) {
      const c = [];
      await lookupDns({ domain: 'example.com', type: 'A', server: name }, { createResolver: fakeResolver(DNS_TABLE, c) });
      assert.deepEqual(c.find((x) => x.servers).servers, [ip]);
    }
  });

  test('整体超时后取消未完成的查询，已完成的照常返回', async () => {
    const calls = [];
    const t0 = Date.now();
    const d = await lookupDns({ domain: 'slow.example.com' }, { createResolver: fakeResolver(DNS_TABLE, calls), timeoutMs: 100 });
    assert.ok(Date.now() - t0 < 1000);
    const by = Object.fromEntries(d.results.map((r) => [r.type, r]));
    assert.equal(by.A.status, 'ok');
    assert.equal(by.TXT.status, 'error');
    assert.equal(by.TXT.ms, null);
    assert.match(by.TXT.error, /超时/);
    assert.ok(calls.some((c) => c.cancel));
  });

  test('路由参数校验', async () => {
    const r = route('/api/dns');
    await assert.rejects(r.handler({ query: q({}) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ domain: 'example.com', type: 'ANY' }) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ domain: 'example.com', server: '8.8.4.4' }) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ domain: 'exa mple.com' }) }), { status: 400 });
  });

  test('字段说明', async () => {
    const make = fakeResolver(DNS_TABLE);
    const all = await lookupDns({ domain: 'example.com' }, { createResolver: make });
    const cname = await lookupDns({ domain: 'www.example.com', type: 'CNAME' }, { createResolver: make });
    const srv = await lookupDns({ domain: '_sip._tcp.example.com', type: 'SRV', server: 'google' }, { createResolver: make });
    const ptr = await lookupDns({ domain: '8.8.8.8', type: 'PTR' }, { createResolver: make });
    const slow = await lookupDns({ domain: 'slow.example.com' }, { createResolver: make, timeoutMs: 50 });
    checkFields(route('/api/dns'), all, cname, srv, ptr, slow);
  });
});

// ---------------- SSL 证书 ----------------

describe('SSL 证书查询', () => {
  test('DER：OID 解码与签名算法', () => {
    assert.equal(decodeOid(Buffer.from('2a864886f70d01010b', 'hex')), '1.2.840.113549.1.1.11');
    assert.equal(decodeOid(Buffer.from('2a8648ce3d040302', 'hex')), '1.2.840.10045.4.3.2');
    assert.equal(signatureAlgorithmOf(new X509Certificate(certs.leaf).raw), 'ecdsa-with-SHA256');
    assert.equal(signatureAlgorithmOf(new X509Certificate(certs.expired).raw), 'sha256WithRSAEncryption');
    assert.equal(signatureAlgorithmOf(new X509Certificate(certs.rsaRoot).raw), 'sha256WithRSAEncryption');
    assert.equal(signatureAlgorithmOf(Buffer.from('3003020100', 'hex')), null);
    assert.equal(signatureAlgorithmOf(Buffer.alloc(0)), null);
    assert.equal(signatureAlgorithmOf('not a buffer'), null);
  });

  test('SAN 解析（含加引号的值）', () => {
    assert.deepEqual(parseSan('DNS:a.com, DNS:*.a.com, IP Address:1.2.3.4, email:x@a.com, DNS:"b,c.com"'), {
      dns: ['a.com', '*.a.com', 'b,c.com'], ip: ['1.2.3.4'],
    });
    assert.deepEqual(parseSan(undefined), { dns: [], ip: [] });
  });

  test('证书链、SAN、指纹、协议与可信状态（本地 TLS 服务器）', async () => {
    const d = await inspectCert('secure.test.example', SPORT, { blocked: allowLoopback });
    assert.equal(d.ip, '127.0.0.1');
    assert.equal(d.servername, 'secure.test.example');
    assert.equal(d.protocol, 'TLSv1.3');
    assert.match(d.cipher, /^TLS_/);
    assert.equal(d.alpn, 'h2');
    assert.equal(d.authorized, false);
    assert.equal(d.authorizationError, 'SELF_SIGNED_CERT_IN_CHAIN');
    assert.match(d.authorizationErrorText, /自签名/);
    assert.equal(d.hostMatch, true);
    assert.deepEqual(d.subject, { cn: 'secure.test.example', o: 'Miao', c: 'CN' });
    assert.deepEqual(d.issuer, { cn: 'Miao Test Issuing CA', o: 'Miao Test', c: 'CN' });
    assert.deepEqual(d.san, ['secure.test.example', 'site.test.example', '*.wild.test.example']);
    assert.deepEqual(d.sanIps, ['127.0.0.1']);
    assert.equal(d.serialNumber, 'ABCDEF');
    assert.equal(d.fingerprint256, new X509Certificate(certs.leaf).fingerprint256);
    assert.equal(d.signatureAlgorithm, 'ecdsa-with-SHA256');
    assert.equal(d.publicKey, 'EC P-256');
    assert.equal(d.daysRemaining, 30);
    assert.equal(d.expired, false);
    assert.match(d.validFrom, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
    assert.equal(Date.parse(d.validTo), Math.floor((NOW + 30.5 * DAY) / 1000) * 1000);
    assert.deepEqual(d.chain.map((c) => [c.cn, c.issuer, c.selfSigned]), [
      ['secure.test.example', 'Miao Test Issuing CA', false],
      ['Miao Test Issuing CA', 'Miao Test Root CA', false],
      ['Miao Test Root CA', 'Miao Test Root CA', true],
    ]);
    assert.equal(d.chain[1].daysRemaining, 1000);
  });

  test('信任测试根证书后为可信；通配符与 IP；不匹配与过期', async () => {
    const trusted = await inspectCert('secure.test.example', SPORT, { blocked: allowLoopback, ca: certs.root });
    assert.equal(trusted.authorized, true);
    assert.equal(trusted.authorizationError, null);
    const byIp = await inspectCert('127.0.0.1', SPORT, { blocked: allowLoopback, ca: certs.root });
    assert.equal(byIp.servername, null);
    assert.equal(byIp.hostMatch, true);
    const other = await inspectCert('other.test.example', SPORT, { blocked: allowLoopback, ca: certs.root });
    assert.equal(other.hostMatch, false);
    assert.equal(other.authorized, false);
    assert.equal(other.authorizationError, 'ERR_TLS_CERT_ALTNAME_INVALID');
    assert.equal(other.authorizationErrorText, '证书与域名不匹配');
    const expired = await inspectCert('expired.test.example', SPORT, { blocked: allowLoopback, ca: certs.rsaRoot });
    assert.equal(expired.expired, true);
    assert.equal(expired.daysRemaining, -11);
    assert.equal(expired.authorizationError, 'CERT_HAS_EXPIRED');
    assert.equal(expired.authorizationErrorText, '证书已过期');
    assert.equal(expired.signatureAlgorithm, 'sha256WithRSAEncryption');
    assert.equal(expired.publicKey, 'EC P-256');
    assert.equal(expired.subject.o, null);
    assert.deepEqual(expired.chain.map((c) => c.cn), ['expired.test.example', 'Miao RSA Root']);
    checkFields(route('/api/ssl'), trusted, byIp, other, expired, await inspectCert('secure.test.example', SPORT, { blocked: allowLoopback }));
  });

  test('非 TLS 端口、未开放端口、参数错误', async () => {
    await assert.rejects(inspectCert('127.0.0.1', PORT, { blocked: allowLoopback }), { status: 502, message: /TLS/ });
    await assert.rejects(inspectCert('127.0.0.1', CLOSED, { blocked: allowLoopback }), { status: 502, message: /连接被拒绝/ });
    await assert.rejects(inspectCert('nx.test.example', 443), { status: 400, message: /无法解析/ });
    const r = route('/api/ssl');
    await assert.rejects(r.handler({ query: q({}) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ host: 'github.com', port: '0' }) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ host: 'github.com', port: '65536' }) }), { status: 400 });
  });
});

// ---------------- 网站检测 ----------------

describe('网站检测', () => {
  const base = () => `http://127.0.0.1:${PORT}`;
  const opts = { blocked: allowLoopback };

  test('压缩方式：gzip / br / deflate / 无', async () => {
    for (const enc of ['gzip', 'br', 'deflate', 'none']) {
      const d = await checkSite(`${base()}/site/ok?enc=${enc}`, opts);
      assert.equal(d.status, 200);
      assert.equal(d.compression, enc);
      assert.equal(d.compressed, enc !== 'none');
      assert.equal(d.bodyBytes, d.contentLength);
      assert.equal(d.truncated, false);
    }
    const auto = await checkSite(`${base()}/site/ok`, opts);
    assert.equal(auto.compression, 'br', '请求时应带 Accept-Encoding: gzip, deflate, br');
  });

  test('基本信息与耗时', async () => {
    const d = await checkSite(`http://site.test.example:${PORT}/site/ok?enc=gzip#frag`, opts);
    assert.equal(d.url, `http://site.test.example:${PORT}/site/ok?enc=gzip`);
    assert.equal(d.statusText, '成功');
    assert.equal(d.ok, true);
    assert.equal(d.server, 'miao-test/1.0');
    assert.equal(d.contentType, 'text/html; charset=utf-8');
    assert.equal(d.ip, '127.0.0.1');
    assert.equal(d.https, false);
    assert.equal(d.http2, null);
    assert.equal(d.tlsProtocol, null);
    assert.equal(d.certValid, null);
    assert.equal(d.timing.tls, null);
    for (const k of ['total', 'dns', 'connect', 'ttfb', 'download']) assert.equal(typeof d.timing[k], 'number', k);
    assert.ok(d.timing.total >= d.timing.ttfb);
    const byIp = await checkSite(`${base()}/site/ok`, opts);
    assert.equal(byIp.timing.dns, null, '直接写 IP 时没有 DNS 解析');
  });

  test('手动跟随跳转：每一跳的状态码与耗时，最多 5 次', async () => {
    const d = await checkSite(`${base()}/site/redirect/3`, opts);
    assert.equal(d.redirects, 3);
    assert.deepEqual(d.hops.map((h) => h.status), [302, 302, 302, 200]);
    assert.equal(d.hops[0].statusText, '临时重定向');
    assert.equal(d.finalUrl, `${base()}/site/ok?enc=gzip`);
    assert.equal(d.compression, 'gzip');
    assert.equal((await checkSite(`${base()}/site/redirect/5`, opts)).redirects, 5);
    await assert.rejects(checkSite(`${base()}/site/redirect/6`, opts), { status: 502, message: /重定向次数/ });
    const rel = await checkSite(`${base()}/site/relative`, opts);
    assert.equal(rel.finalUrl, `${base()}/site/ok?enc=none`);
    const noLoc = await checkSite(`${base()}/site/no-location`, opts);
    assert.equal(noLoc.status, 302);
    assert.equal(noLoc.redirects, 0);
  });

  test('404 与超过 1MB 的响应体', async () => {
    const d = await checkSite(`${base()}/site/missing`, opts);
    assert.equal(d.status, 404);
    assert.equal(d.statusText, '未找到');
    assert.equal(d.ok, false);
    const big = await checkSite(`${base()}/site/big`, opts);
    assert.equal(big.bodyBytes, 1024 * 1024);
    assert.equal(big.truncated, true);
    assert.equal(big.contentLength, null);
    await assert.rejects(checkSite(`http://127.0.0.1:${CLOSED}/`, opts), { status: 502, message: /连接被拒绝/ });
    await assert.rejects(checkSite('http://nx.test.example/', opts), { status: 400, message: /无法解析/ });
  });

  test('HTTPS：TLS 版本、HTTP/2（ALPN）、证书是否可信', async () => {
    const url = `https://site.test.example:${SPORT}/site/ok`;
    const d = await checkSite(url, { ...opts, ca: certs.root });
    assert.equal(d.https, true);
    assert.equal(d.http2, true);
    assert.equal(d.tlsProtocol, 'TLSv1.3');
    assert.equal(d.certValid, true);
    assert.equal(d.certError, null);
    assert.equal(typeof d.timing.tls, 'number');
    assert.equal(d.server, 'miao-secure/1.0');
    const untrusted = await checkSite(url, opts);
    assert.equal(untrusted.certValid, false);
    assert.equal(untrusted.certError, 'SELF_SIGNED_CERT_IN_CHAIN');
    assert.equal(await probeHttp2(new URL(`https://127.0.0.1:${CLOSED}/`), opts), null);
    assert.equal(await probeHttp2(new URL(`https://10.0.0.1/`), opts), null);
    const plain = await checkSite(`http://site.test.example:${PORT}/site/ok?enc=deflate`, opts);
    checkFields(route('/api/site/check'), d, untrusted, plain, await checkSite(`${base()}/site/redirect/2`, opts));
  });

  test('路由参数校验', async () => {
    const r = route('/api/site/check');
    await assert.rejects(r.handler({ query: q({}) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ url: 'ftp://example.com/' }) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ url: 'http://user:pw@example.com/' }) }), { status: 400 });
  });
});

// ---------------- TCPing ----------------

describe('TCPing', () => {
  test('连接成功：每次耗时与统计', async () => {
    const d = await tcping('127.0.0.1', { port: TPORT, count: 3, blocked: allowLoopback });
    assert.equal(d.results.length, 3);
    assert.deepEqual(d.results.map((r) => r.seq), [1, 2, 3]);
    assert.ok(d.results.every((r) => r.ok && typeof r.ms === 'number' && r.error === null));
    assert.equal(d.lossRate, 0);
    assert.equal(d.received, 3);
    assert.ok(d.min <= d.avg && d.avg <= d.max);
    const byName = await tcping('site.test.example', { port: TPORT, count: 1, blocked: allowLoopback });
    assert.equal(byName.ip, '127.0.0.1');
    assert.equal(byName.host, 'site.test.example');
  });

  test('端口未开放：失败原因与 100% 丢失', async () => {
    const d = await tcping('127.0.0.1', { port: CLOSED, count: 2, blocked: allowLoopback });
    assert.equal(d.lossRate, 100);
    assert.equal(d.min, null);
    assert.equal(d.avg, null);
    assert.ok(d.results.every((r) => !r.ok && r.ms === null && /连接被拒绝/.test(r.error)));
    checkFields(route('/api/tcping'), d, await tcping('127.0.0.1', { port: TPORT, count: 2, blocked: allowLoopback }));
  });

  test('统计：部分失败', () => {
    const s = summarize([{ ok: true, ms: 10 }, { ok: false, ms: null }, { ok: true, ms: 20.5 }, { ok: false, ms: null }]);
    assert.deepEqual(s, { sent: 4, received: 2, lossRate: 50, min: 10, max: 20.5, avg: 15.25 });
    assert.deepEqual(summarize([{ ok: false }, { ok: false }, { ok: true, ms: 1 }]).lossRate, 66.67);
  });

  test('参数校验：端口 1~65535、次数 1~4、只测一个端口', async () => {
    const r = route('/api/tcping');
    for (const bad of [{ host: 'github.com', port: '0' }, { host: 'github.com', port: '65536' }, { host: 'github.com', port: '80,443' },
      { host: 'github.com', port: '80-90' }, { host: 'github.com', count: '5' }, { host: 'github.com', count: '0' }, {}]) {
      await assert.rejects(r.handler({ query: q(bad) }), { status: 400 }, JSON.stringify(bad));
    }
  });
});

// ---------------- Ping ----------------

describe('Ping', () => {
  test('解析 iputils 输出', () => {
    const d = parsePing(fixture('ping-iputils.txt'));
    assert.equal(d.format, 'iputils');
    assert.deepEqual([d.sent, d.received, d.lossRate, d.min, d.avg, d.max], [4, 4, 0, 1.38, 1.487, 1.61]);
    assert.deepEqual(d.results[0], { seq: 1, ok: true, ttl: 57, ms: 1.52 });
    assert.equal(d.results.length, 4);
  });

  test('iputils：丢包、重复包、错误行、主机名显示', () => {
    const d = parsePing(fixture('ping-iputils-loss.txt'));
    assert.equal(d.sent, 4);
    assert.equal(d.received, 2);
    assert.equal(d.lossRate, 50);
    assert.deepEqual(d.results.map((r) => r.ok), [true, false, false, true]);
    assert.equal(d.results[0].ms, 12.3, '重复包（DUP!）不能覆盖第一次的结果');
    assert.deepEqual(d.results[1], { seq: 2, ok: false, ttl: null, ms: null });
    assert.deepEqual([d.min, d.avg, d.max], [11.9, 12.1, 12.3]);
  });

  test('iputils：IPv6 与全部超时', () => {
    const v6 = parsePing(fixture('ping-iputils-v6.txt'));
    assert.deepEqual(v6.results.map((r) => r.ms), [2.05, 1.98]);
    assert.equal(v6.results[0].ttl, 58);
    const lost = parsePing(fixture('ping-iputils-timeout.txt'));
    assert.equal(lost.format, 'iputils');
    assert.deepEqual([lost.sent, lost.received, lost.lossRate, lost.min, lost.avg, lost.max], [3, 0, 100, null, null, null]);
    assert.ok(lost.results.every((r) => !r.ok));
  });

  test('busybox：seq 从 0 开始、round-trip 统计', () => {
    const d = parsePing(fixture('ping-busybox.txt'));
    assert.equal(d.format, 'busybox');
    assert.deepEqual(d.results.map((r) => [r.seq, r.ok, r.ms]), [[1, true, 1.523], [2, true, 1.38], [3, false, null], [4, true, 1.61]]);
    assert.deepEqual([d.sent, d.received, d.lossRate, d.min, d.avg, d.max], [4, 3, 25, 1.38, 1.504, 1.61]);
    const lost = parsePing(fixture('ping-busybox-timeout.txt'));
    assert.equal(lost.format, 'busybox');
    assert.deepEqual([lost.sent, lost.received, lost.lossRate, lost.avg], [2, 0, 100, null]);
  });

  test('无法识别的输出返回 null', () => {
    assert.equal(parsePing(''), null);
    assert.equal(parsePing('ping: unknown host'), null);
  });

  // 模拟 child_process.execFile：记录参数，按 behavior 回调
  const fakeExec = (behavior, calls) => (file, args, options, cb) => {
    calls.push({ file, args, options });
    process.nextTick(() => behavior(cb));
  };

  test('用 execFile 调用，参数固定为数组，只传已校验的 IP', async () => {
    const calls = [];
    const out = await runPing('1.1.1.1', 2, { execFileImpl: fakeExec((cb) => cb(null, fixture('ping-iputils.txt'), ''), calls) });
    assert.match(out, /packets transmitted/);
    assert.equal(calls[0].file, 'ping');
    assert.deepEqual(calls[0].args, ['-c', '2', '-W', '2', '1.1.1.1']);
    assert.equal(calls[0].options.shell, undefined);
    assert.equal(calls[0].options.env.LC_ALL, 'C');
    for (const bad of ['1.1.1.1; rm -rf /', '$(id)', '-f', 'example.com', '1.1.1.1 -f']) {
      await assert.rejects(runPing(bad, 1, { execFileImpl: fakeExec((cb) => cb(null, '', ''), calls) }), { status: 400 });
    }
    assert.equal(calls.length, 1, '非法参数不会执行命令');
  });

  test('没有 ping 命令或没有权限时返回 503', async () => {
    const enoent = Object.assign(new Error('spawn ping ENOENT'), { code: 'ENOENT' });
    await assert.rejects(runPing('1.1.1.1', 1, { execFileImpl: fakeExec((cb) => cb(enoent, '', ''), []) }), { status: 503, message: UNSUPPORTED_MSG });
    const eperm = Object.assign(new Error('Command failed'), { code: 2 });
    for (const stderr of ['ping: socket: Operation not permitted', 'ping: permission denied (are you root?)']) {
      await assert.rejects(runPing('1.1.1.1', 1, { execFileImpl: fakeExec((cb) => cb(eperm, '', stderr), []) }), { status: 503, message: UNSUPPORTED_MSG });
    }
    // 全部丢包时 iputils 退出码为 1，但仍然有统计输出
    const exit1 = Object.assign(new Error('Command failed'), { code: 1 });
    assert.match(await runPing('1.2.3.4', 3, { execFileImpl: fakeExec((cb) => cb(exit1, fixture('ping-iputils-timeout.txt'), ''), []) }), /100% packet loss/);
    const killed = Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' });
    await assert.rejects(runPing('1.1.1.1', 1, { execFileImpl: fakeExec((cb) => cb(killed, '', ''), []) }), { status: 504 });
    await assert.rejects(runPing('1.1.1.1', 1, { execFileImpl: fakeExec((cb) => cb(exit1, '', 'ping: sendmsg: Network is unreachable'), []) }), { status: 502 });
  });

  test('完整流程与字段说明', async () => {
    const calls = [];
    const d = await ping('1.1.1.1', { count: 4, execFileImpl: fakeExec((cb) => cb(null, fixture('ping-iputils.txt'), ''), calls) });
    assert.equal(d.host, '1.1.1.1');
    assert.equal(d.ip, '1.1.1.1');
    const byName = await ping('public.test.example', { count: 4, execFileImpl: fakeExec((cb) => cb(null, fixture('ping-busybox.txt'), ''), calls) });
    assert.equal(byName.ip, '93.184.216.34');
    assert.equal(calls.at(-1).args.at(-1), '93.184.216.34', '只把解析后的 IP 传给 ping');
    const lost = await ping('1.2.3.4', { count: 3, execFileImpl: fakeExec((cb) => cb({ code: 1 }, fixture('ping-iputils-timeout.txt'), ''), calls) });
    checkFields(route('/api/ping'), d, byName, lost);
    const r = route('/api/ping');
    await assert.rejects(r.handler({ query: q({ host: '1.1.1.1', count: '5' }) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({}) }), { status: 400 });
  });
});

// ---------------- 域名注册查询 ----------------

describe('域名注册查询', () => {
  const BOOT = fixture('rdap-bootstrap.json');
  const REG = fixture('rdap-registered.json');
  beforeEach(() => cache.store.clear());

  // RDAP 的 mock：引导文件 + rdap.org/domain/<d>；registered 中的域名返回注册信息，其余 404
  function mockRdap(t, { registered = ['example.com'], bootstrap = BOOT, status } = {}) {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
      const u = String(url);
      calls.push(u);
      if (u === 'https://data.iana.org/rdap/dns.json') {
        return bootstrap instanceof Error ? Promise.reject(bootstrap) : new Response(bootstrap, { headers: { 'content-type': 'application/json' } });
      }
      const m = /^https:\/\/rdap\.org\/domain\/(.+)$/.exec(u);
      if (!m) throw new Error(`unexpected ${u}`);
      if (status) return new Response('x', { status });
      if (registered.includes(m[1])) return new Response(REG, { headers: { 'content-type': 'application/rdap+json' } });
      return new Response('{"errorCode":404}', { status: 404 });
    });
    return calls;
  }

  test('主域名提取与引导文件解析', () => {
    assert.equal(registrableDomain('a.b.example.com'), 'example.com');
    assert.equal(registrableDomain('shop.example.com.cn'), 'example.com.cn');
    assert.equal(registrableDomain('example.co.uk'), 'example.co.uk');
    assert.equal(registrableDomain('example.cn'), 'example.cn');
    assert.deepEqual([...bootstrapTlds(JSON.parse(BOOT))], ['com', 'net', 'org', 'xn--55qx5d', 'xn--io0a7i']);
    assert.throws(() => bootstrapTlds({}), { status: 502 });
  });

  test('已注册：返回注册商与到期时间', async (t) => {
    const calls = mockRdap(t);
    const d = await checkAvailability('https://www.Example.com/path');
    assert.equal(d.status, 'registered');
    assert.equal(d.available, false);
    assert.equal(d.registrar, 'RESERVED-Internet Assigned Numbers Authority');
    assert.equal(d.created, '1995-08-14T04:00:00.000Z');
    assert.equal(d.expires, '2027-08-13T04:00:00.000Z');
    assert.ok(calls.includes('https://rdap.org/domain/example.com'));
  });

  test('RDAP 404 视为未注册；子域名按主域名查询', async (t) => {
    const calls = mockRdap(t);
    const d = await checkAvailability('shop.miao-available-12345.com');
    assert.equal(d.domain, 'miao-available-12345.com');
    assert.equal(d.status, 'available');
    assert.equal(d.available, true);
    assert.equal(d.registrar, null);
    assert.ok(calls.includes('https://rdap.org/domain/miao-available-12345.com'));
  });

  test('RDAP 没有覆盖的后缀返回 unknown 并说明原因', async (t) => {
    const calls = mockRdap(t);
    const d = await checkAvailability('example.cn');
    assert.equal(d.status, 'unknown');
    assert.equal(d.available, null);
    assert.match(d.reason, /\.cn 后缀.*没有提供 RDAP/);
    assert.ok(!calls.some((u) => u.startsWith('https://rdap.org/')), '不支持的后缀不查询 rdap.org');
    const idn = await checkAvailability('例子.公司');
    assert.equal(idn.unicode, '例子.公司');
    assert.equal(idn.tld, 'xn--55qx5d');
    assert.equal(idn.status, 'available');
  });

  test('引导数据取不到时 404 只能判为 unknown；限流与上游错误', async (t) => {
    mockRdap(t, { bootstrap: new Error('down') });
    const d = await checkAvailability('miao-available-12345.com');
    assert.equal(d.status, 'unknown');
    const reg = await checkAvailability('example.com');
    assert.equal(reg.status, 'registered');
    cache.store.clear();
    t.mock.restoreAll();
    mockRdap(t, { status: 429 });
    await assert.rejects(checkAvailability('example.com'), { status: 429 });
    cache.store.clear();
    t.mock.restoreAll();
    mockRdap(t, { status: 500 });
    await assert.rejects(checkAvailability('example.com'), { status: 502 });
    cache.store.clear();
    t.mock.restoreAll();
    mockRdap(t, { status: 400 });
    assert.equal((await checkAvailability('example.com')).status, 'unknown');
  });

  test('路由与字段说明', async (t) => {
    mockRdap(t);
    const r = route('/api/domain/available');
    const reg = await r.handler({ query: q({ domain: 'example.com' }) });
    const free = await r.handler({ query: q({ domain: 'miao-available-12345.com' }) });
    const unknown = await r.handler({ query: q({ domain: 'example.cn' }) });
    assert.equal((await r.handler({ query: q({ domain: 'www.example.com' }) })).cached, true);
    checkFields(r, reg.data, free.data, unknown.data);
    for (const bad of ['', 'com', 'exa mple.com', 'a..com']) await assert.rejects(r.handler({ query: q({ domain: bad }) }), { status: 400 }, bad);
  });
});

// ---------------- Robots ----------------

describe('Robots 分析', () => {
  const parsed = parseRobots(fixture('robots.txt'), 'https://example.com/robots.txt');

  test('按 User-agent 分组，Crawl-delay 与 Sitemap', () => {
    assert.deepEqual(parsed.groups.map((g) => g.agents), [['*'], ['Googlebot', 'Bingbot'], ['googlebot-news'], ['Baiduspider/2.0'], ['tiebot']]);
    assert.deepEqual(parsed.groups[0].rules, [
      { type: 'disallow', path: '/admin/' }, { type: 'disallow', path: '/search' }, { type: 'allow', path: '/search/about' }, { type: 'disallow', path: '/*.pdf$' },
    ], '空的 Disallow 被忽略');
    assert.equal(parsed.groups[0].crawlDelay, 2);
    assert.equal(parsed.groups[3].crawlDelay, 10.5);
    assert.equal(parsed.groups[1].crawlDelay, null);
    assert.deepEqual(parsed.sitemaps, ['https://example.com/sitemap.xml', 'https://example.com/sitemap-news.xml']);
    assert.ok(!JSON.stringify(parsed).includes('before-any-agent'), '出现在任何 User-agent 之前的规则被忽略');
  });

  test('通配符 * 与 $', () => {
    const cases = [
      ['/', '/a', true], ['/a', '/a', true], ['/a', '/ab', true], ['/a$', '/ab', false], ['/a$', '/a', true],
      ['/*.pdf$', '/x/y.pdf', true], ['/*.pdf$', '/x/y.pdf?x=1', false], ['/*.pdf', '/x/y.pdf?x=1', true],
      ['/fish*', '/fishheads', true], ['/fish*', '/Fish', false], ['/*/b', '/a/b', true], ['*', '/x', true],
      ['/$', '/', true], ['/$', '/a', false], ['/a*b*c', '/aXbYc', true], ['/a*b*c', '/aXcYb', false], ['/a**', '/a', true],
    ];
    for (const [p, path, want] of cases) assert.equal(robotsMatch(p, path), want, `${p} vs ${path}`);
    const p40 = `/${'x'.repeat(40)}`;
    assert.equal(robotsMatch(`${p40}$`, p40), true, '跨 32 位边界');
    assert.equal(robotsMatch(`/${'x'.repeat(31)}$`, `/${'x'.repeat(31)}`), true);
    assert.equal(robotsMatch(`/${'x'.repeat(30)}$`, `/${'x'.repeat(31)}`), false);
  });

  test('恶意规则不会拖慢匹配（不使用正则回溯）', () => {
    const t0 = performance.now();
    assert.equal(robotsMatch(`/${'*a'.repeat(20_000)}b`, `/${'a'.repeat(2000)}`), false);
    assert.ok(performance.now() - t0 < 1000);
  });

  test('按 Google 规范判断：最长匹配、Allow 优先、分组选择', () => {
    const check = (agent, path) => isAllowed(parsed, agent, path);
    assert.equal(check('*', '/admin/users').allowed, false);
    assert.deepEqual(check('*', '/search/about').rule, { type: 'allow', path: '/search/about' });
    assert.equal(check('*', '/search?q=1').allowed, false);
    assert.equal(check('*', '/docs/a.pdf').allowed, false);
    assert.equal(check('*', '/docs/a.pdf?download=1').allowed, true);
    assert.deepEqual(check('SomeBot', '/other'), { group: '*', allowed: true, rule: null });
    assert.equal(check('Googlebot', '/private/x').allowed, false);
    assert.equal(check('googlebot', '/admin/').allowed, true, 'Googlebot 组没有禁止 /admin/，不再看 * 组');
    assert.equal(check('Googlebot', '/fishheads').allowed, false);
    assert.equal(check('Googlebot', '/Fish').allowed, true, '路径区分大小写');
    assert.equal(check('Googlebot/2.1', '/private').allowed, false);
    assert.equal(check('bingbot', '/private').allowed, false);
    assert.equal(check('Googlebot-News', '/anything').group, 'googlebot-news');
    assert.equal(check('Googlebot-News', '/anything').allowed, false);
    assert.equal(check('Googlebot-Image', '/private').group, 'googlebot', '没有专门的组时找名称是其前缀的组');
    assert.equal(check('Baiduspider', '/x').allowed, false);
    assert.equal(check('tiebot', '/page').allowed, true, '同样长时 Allow 优先');
    assert.equal(check('tiebot', '/%e4%b8%ad%e6%96%87/x').allowed, false, '百分号编码与非 ASCII 字符按同一形式比较');
    assert.equal(check('tiebot', '/中文/x').allowed, false);
    assert.equal(check('Baiduspider', '/robots.txt').allowed, true, '/robots.txt 本身总是允许');
    assert.equal(normalizeRobotsPath('/中?a=%2f'), '/%E4%B8%AD?a=%2F');
    assert.deepEqual(selectGroups(parseRobots('User-agent: a\nDisallow: /').groups, 'b'), { name: null, groups: [] });
  });

  test('抓取 robots.txt：存在、404、5xx、gzip、超过 500KB', async () => {
    const opts = { blocked: allowLoopback };
    const d = await analyzeRobots(`http://127.0.0.1:${PORT}/some/page?x=1`, { ...opts, path: '/search/about', agent: 'Googlebot' });
    assert.equal(d.url, `http://127.0.0.1:${PORT}/robots.txt`);
    assert.equal(d.found, true);
    assert.equal(d.policy, 'rules');
    assert.equal(d.groups.length, 5);
    assert.deepEqual(d.check, { agent: 'Googlebot', path: '/search/about', group: 'googlebot', allowed: true, rule: { type: 'allow', path: '/' } });
    const star = await analyzeRobots(`http://127.0.0.1:${PORT}/`, { ...opts, path: `http://127.0.0.1:${PORT}/admin/x?y=1` });
    assert.deepEqual(star.check, { agent: '*', path: '/admin/x?y=1', group: '*', allowed: false, rule: { type: 'disallow', path: '/admin/' } });
    assert.equal((await analyzeRobots(`http://127.0.0.1:${PORT}/`, opts)).check, null);

    const none = await analyzeRobots(`http://norobots.test.example:${PORT}/`, { ...opts, path: '/admin' });
    assert.equal(none.status, 404);
    assert.equal(none.found, false);
    assert.equal(none.policy, 'allow-all');
    assert.match(none.note, /允许所有爬虫抓取全部路径/);
    assert.equal(none.check.allowed, true);
    const err = await analyzeRobots(`http://err.test.example:${PORT}/`, { ...opts, agent: 'Googlebot' });
    assert.equal(err.policy, 'disallow-all');
    assert.equal(err.check.allowed, false);
    const gz = await analyzeRobots(`http://gz.test.example:${PORT}/`, opts);
    assert.deepEqual(gz.groups, [{ agents: ['*'], rules: [{ type: 'disallow', path: '/gz-only' }], crawlDelay: null }]);
    const big = await analyzeRobots(`http://big.test.example:${PORT}/`, { ...opts, path: '/after-limit' });
    assert.equal(big.truncated, true);
    assert.equal(big.size, 500 * 1024);
    assert.equal(big.check.allowed, true, '超出 500KB 的规则不生效');
    checkFields(route('/api/robots'), d, star, none, err, big);
  });

  test('路由参数校验', async () => {
    const r = route('/api/robots');
    await assert.rejects(r.handler({ query: q({}) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ url: 'javascript:alert(1)' }) }), { status: 400 });
  });
});

// ---------------- 网站图标 ----------------

describe('网站图标', () => {
  const opts = { blocked: allowLoopback };
  const base = () => `http://127.0.0.1:${PORT}`;

  test('解析 <link rel="icon"> 并按尺寸排序', () => {
    const icons = findIcons(fixture('icons.html'), 'https://example.com/a/b');
    assert.deepEqual(icons.map((i) => [i.href, i.rel, i.size]), [
      ['https://example.com/icons/16.png', 'icon', 16],
      ['https://example.com/icons/32.png', 'icon', 32],
      ['https://example.com/icons/icon.svg', 'icon', Infinity],
      ['https://example.com/icons/apple.png', 'apple-touch-icon', 180],
      ['https://example.com/favicon.ico', 'icon', null],
      ['http://10.0.0.1/internal.png', 'icon', 48],
    ]);
    const fb = 'https://example.com/favicon.ico';
    const path = (list) => list.map((u) => new URL(u).pathname);
    assert.deepEqual(path(rankIcons(icons, 32, fb)), ['/icons/32.png', '/internal.png', '/icons/apple.png', '/icons/icon.svg', '/icons/16.png', '/favicon.ico']);
    assert.deepEqual(path(rankIcons(icons, 200, fb)), ['/icons/icon.svg', '/icons/apple.png', '/internal.png', '/icons/32.png', '/icons/16.png', '/favicon.ico']);
    assert.deepEqual(path(rankIcons([], 32, fb)), ['/favicon.ico']);
  });

  test('按 size 挑选并下载，SVG 带禁止脚本的响应头', async () => {
    const png32 = await findFavicon(`${base()}/icons-page`, { ...opts, size: 32 });
    assert.equal(png32.url, `${base()}/icons/32.png`);
    assert.equal(png32.type, 'image/png');
    assert.ok(png32.body.subarray(0, 8).equals(PNG.subarray(0, 8)));
    const png16 = await findFavicon(`${base()}/icons-page`, { ...opts, size: 16 });
    assert.equal(png16.url, `${base()}/icons/16.png`);
    // 40：48×48 的候选指向内网被跳过（不连接），180 的 apple-touch-icon 404，选中 SVG
    const svg = await findFavicon(`${base()}/icons-page`, { ...opts, size: 40 });
    assert.equal(svg.type, 'image/svg+xml');
    assert.equal(hits['/icons/apple.png'], 1);
    const res = iconResponse(svg);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/svg+xml');
    assert.equal(res.headers['content-security-policy'], "default-src 'none'; style-src 'unsafe-inline'");
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['cache-control'], 'public, max-age=86400');
    assert.equal(res.headers['x-favicon-url'], `${base()}/icons/icon.svg`);
    assert.ok(Buffer.isBuffer(res.body));
  });

  test('回退到 /favicon.ico；超过 200KB、类型不是图片的都不接受', async () => {
    for (const page of ['/no-icons-page', '/big-icon-page', '/wrong-type-page', '/json-page', '/icon-redirect-page']) {
      const icon = await findFavicon(`${base()}${page}`, opts);
      assert.equal(icon.url, `${base()}/favicon.ico`, page);
      assert.equal(icon.type, 'image/x-icon');
    }
    assert.equal(hits['/icons/big-chunked.png'], 1, '没有 Content-Length 的大文件边读边限制');
    await assert.rejects(findFavicon(`http://noicon.test.example:${PORT}/no-icons-page`, opts), { status: 404 });
  });

  test('raw 路由参数校验', async () => {
    const r = route('/api/favicon');
    assert.equal(r.raw, true);
    assert.ok(r.returns.length > 20);
    await assert.rejects(r.handler({ query: q({}) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ url: 'https://example.com', size: '8' }) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ url: 'https://example.com', size: '1024' }) }), { status: 400 });
  });
});

// ---------------- 死链检测 ----------------

describe('死链检测', () => {
  test('提取链接：base、去重、只要 http/https、忽略注释和脚本', () => {
    const links = extractLinks(fixture('links.html').replaceAll('{{PORT}}', '8080').replaceAll('{{CLOSED}}', '9'), 'https://example.com/dir/page');
    assert.deepEqual(links.map((l) => l.url), [
      'https://example.com/ok', 'https://example.com/base/rel', 'https://example.com/missing', 'https://example.com/error',
      'https://example.com/head-405', 'https://example.com/redirect-ok', 'https://example.com/redirect-internal',
      'https://example.com/redirect-dns-internal', 'https://example.com/slow', 'http://10.0.0.1/admin', 'http://localhost:8080/secret',
      'http://[::1]:8080/secret', 'http://internal.test.example:8080/secret', 'http://nx.test.example/', 'http://127.0.0.1:9/',
      'https://example.com/img',
    ]);
    assert.equal(links[0].text, '正常 链接');
    assert.equal(links.at(-1).text, '图片链接');
  });

  test('逐个检测：状态码、HEAD 405 改用 GET、跳转、超时、内网跳过', async () => {
    const d = await checkLinks(`http://127.0.0.1:${PORT}/links-page`, { blocked: allowLoopback, timeoutMs: 500 });
    const by = Object.fromEntries(d.links.map((l) => [new URL(l.url).pathname + (new URL(l.url).hostname === '127.0.0.1' ? '' : `@${new URL(l.url).hostname}`), l]));
    assert.equal(d.found, 16);
    assert.equal(d.links.length, 16);
    assert.deepEqual([by['/ok'].status, by['/ok'].ok, by['/ok'].dead], [200, true, false]);
    assert.equal(by['/base/rel'].status, 200);
    assert.deepEqual([by['/missing'].status, by['/missing'].dead, by['/missing'].error], [404, true, 'HTTP 404 未找到']);
    assert.equal(by['/error'].dead, true);
    assert.equal(by['/head-405'].status, 200, 'HEAD 返回 405 时改用 GET');
    assert.equal(by['/redirect-ok'].finalUrl, `http://127.0.0.1:${PORT}/ok`);
    assert.equal(by['/slow'].dead, true);
    assert.match(by['/slow'].error, /超时/);
    assert.equal(by['/@nx.test.example'].dead, true);
    assert.match(by['/@nx.test.example'].error, /无法解析/);
    assert.match(by['/'].error, /连接被拒绝/);
    for (const k of ['/admin@10.0.0.1', '/secret@localhost', '/secret@[::1]', '/secret@internal.test.example', '/redirect-internal', '/redirect-dns-internal']) {
      assert.equal(by[k].skipped, true, k);
      assert.equal(by[k].dead, false, k);
      assert.equal(by[k].status, null, k);
      assert.match(by[k].error, /内网|保留地址/, k);
    }
    assert.equal(hits['/secret'], undefined, '指向内网的链接不会被访问');
    assert.deepEqual(d.summary, { total: 16, ok: 5, dead: 5, skipped: 6 });
    const limited = await checkLinks(`http://127.0.0.1:${PORT}/links-page`, { blocked: allowLoopback, limit: 3 });
    assert.equal(limited.found, 16);
    assert.equal(limited.links.length, 3);
    checkFields(route('/api/links/check'), d, limited);
  });

  test('路由参数校验', async () => {
    const r = route('/api/links/check');
    await assert.rejects(r.handler({ query: q({}) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ url: 'https://example.com', limit: '51' }) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ url: 'https://example.com', limit: '0' }) }), { status: 400 });
  });
});

// ---------------- 域名后缀列表 ----------------

describe('域名后缀列表', () => {
  const IANA = fixture('tlds-alpha-by-domain.txt');
  beforeEach(() => {
    cache.store.clear();
    resetTldState();
  });
  const mockIana = (t, body = IANA) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
      calls.push(String(url));
      if (body instanceof Error) throw body;
      return new Response(body);
    });
    return calls;
  };

  test('解析 IANA 列表与分类', () => {
    const { version, tlds } = parseTldList(IANA);
    assert.equal(version, 'Version 2026092400, Last Updated Wed Sep 24 07:07:01 2026 UTC');
    assert.equal(tlds.length, 175);
    assert.ok(tlds.includes('xn--fiqs8s'));
    assert.equal(classifyTld('com'), 'gTLD');
    assert.equal(classifyTld('cn'), 'ccTLD');
    assert.equal(classifyTld('xn--fiqs8s'), 'IDN');
    assert.deepEqual(toItem('xn--fiqs8s'), { tld: 'xn--fiqs8s', unicode: '中国', type: 'IDN', note: '中国大陆中文国家和地区顶级域（简体），与 .cn 同由 CNNIC 管理' });
    assert.equal(toItem('xn--p1ai').unicode, 'рф');
    assert.equal(toItem('google').note, null);
    assert.throws(() => parseTldList('<html>error</html>'), { status: 502 });
  });

  test('搜索与过滤', () => {
    const items = parseTldList(IANA).tlds.map(toItem);
    assert.equal(searchTlds(items, { q: 'cn' })[0].tld, 'cn');
    assert.equal(searchTlds(items, { q: '.CN' })[0].tld, 'cn');
    assert.equal(searchTlds(items, { q: '中国' })[0].unicode, '中国');
    assert.equal(searchTlds(items, { q: 'xn--fiqs8s' })[0].unicode, '中国');
    assert.ok(searchTlds(items, { q: '电商' }).some((i) => i.tld === 'shop'), '按中文说明搜索');
    assert.ok(searchTlds(items, { type: 'idn' }).every((i) => i.type === 'IDN'));
    assert.ok(searchTlds(items, { type: 'cctld', q: 'c' }).every((i) => i.type === 'ccTLD' && i.tld.includes('c')));
    assert.deepEqual(searchTlds(items, { q: 'zzzz' }), []);
  });

  test('路由：IANA 数据缓存 1 天，type 参数校验', async (t) => {
    const calls = mockIana(t);
    const r = route('/api/tld');
    const all = await r.handler({ query: q({}) });
    assert.equal(all.data.source, 'iana');
    assert.equal(all.data.fallback, false);
    assert.equal(all.data.total, 175);
    assert.deepEqual(all.data.stats, { gTLD: 68, ccTLD: 92, IDN: 15 });
    const idn = await r.handler({ query: q({ type: 'IDN', q: '中' }) });
    assert.ok(idn.data.items.every((i) => i.type === 'IDN'));
    assert.equal(idn.cached, true);
    assert.deepEqual(calls, ['https://data.iana.org/TLD/tlds-alpha-by-domain.txt'], '1 天内只请求一次');
    await assert.rejects(r.handler({ query: q({ type: 'sld' }) }), { status: 400 });
    checkFields(r, all.data, idn.data);
  });

  test('上游失败时回退到内置列表，10 分钟内不重复请求', async (t) => {
    const calls = mockIana(t, new Error('down'));
    const r = route('/api/tld');
    const res = await r.handler({ query: q({ q: '公司' }) });
    assert.equal(res.data.source, 'builtin');
    assert.equal(res.data.fallback, true);
    assert.equal(res.data.version, null);
    assert.equal(res.data.total, 107);
    assert.equal(res.data.items[0].unicode, '公司');
    await r.handler({ query: q({}) });
    assert.equal(calls.length, 1);
    // 内置列表没有 version，这里只做正向校验（反向覆盖在上一个用例中完成）
    assertFieldsDocumented(r, res.data);
  });
});

// ---------------- 线性时间解析 ----------------

describe('HTML / robots / 证书解析：恶意内容不会拖慢服务器', () => {
  test('HTML 扫描工具', () => {
    assert.equal(stripNoise('a<!-- x -->b<script>var s="<a href=/x>";</script>c<STYLE>p{}</STYLE>d<!-- 没有结尾'), 'abcd');
    assert.deepEqual(parseAttrs('<a HREF="/x?a=1&amp;b=2" data-x=\'y\' disabled title=t>'), { href: '/x?a=1&b=2', 'data-x': 'y', disabled: '', title: 't' });
    assert.deepEqual(parseAttrs('<a href="/first" href="/second">'), { href: '/first' }, '同名属性以第一个为准');
    assert.deepEqual(parseAttrs('<a href="没有结尾的引号>'), { href: '没有结尾的引号>' });
    assert.equal(textOf(' 你好 <b>世界</b>&amp;<i>!</i> '), '你好 世界&!');
    assert.equal(safeDecode('&#99999999999;'), '&#99999999999;', '超出范围的实体不会抛错');
    assert.deepEqual([...scanTags('<A href=1><abbr><a\nhref=2><link rel=icon>', ['a'])].map((t) => t.attrs.href), ['1', '2']);
    assert.deepEqual(extractLinks('<a href="/&#99999999999;">x</a>', 'https://e.com/').length, 1);
  });

  const N = 1024 * 1024;
  const timed = (label, fn) => {
    const t0 = performance.now();
    fn();
    const ms = performance.now() - t0;
    assert.ok(ms < 2000, `${label} 用了 ${Math.round(ms)}ms`);
  };

  test('1MB 恶意页面：大量没有结尾的标签、注释、脚本、属性', () => {
    const pages = {
      '<a ': '<a '.repeat(N / 3),
      '<!--': '<!--'.repeat(N / 4),
      '<script>': '<script>'.repeat(N / 8),
      '<link ': '<link '.repeat(N / 6),
      '<a href>': '<a href="/x">'.repeat(N / 13),
      '长属性': `<a ${'x=" '.repeat(N / 4)}>`,
      '锚文本里的 <': `<a href="/x">${'<'.repeat(N - 20)}`,
      '<a> 无 </a>': '<a href=/y>t'.repeat(N / 12),
      '引号': `<link rel=icon href=${'"'.repeat(N / 2)}>`,
    };
    for (const [label, html] of Object.entries(pages)) {
      timed(`extractLinks ${label}`, () => extractLinks(html, 'https://e.com/'));
      timed(`findIcons ${label}`, () => findIcons(html, 'https://e.com/'));
    }
  });

  test('500KB 恶意 robots.txt 与超长 SAN', () => {
    timed('robots 长行', () => parseRobots(`a${' '.repeat(500 * 1024)}`, 'https://e.com/robots.txt'));
    timed('robots 大量 Sitemap', () => parseRobots(Array.from({ length: 20_000 }, (_, i) => `Sitemap: /s${i}.xml`).join('\n'), 'https://e.com/robots.txt'));
    timed('robots 大量规则', () => {
      const p = parseRobots(`User-agent: *\n${'Disallow: /*a*a*a*a*a*a*a*a*a*a*b\n'.repeat(15_000)}`, 'https://e.com/robots.txt');
      isAllowed(p, '*', `/${'a'.repeat(2000)}`);
    });
    timed('SAN 长空白', () => parseSan(`${' '.repeat(200_000)}x`));
    timed('SAN 未闭合引号', () => parseSan(`DNS:"${'\\"'.repeat(100_000)}`));
  });

  test('图标缓存有上限（条数与总字节数）', () => {
    clearIconCache();
    for (let i = 0; i < 200; i++) _cacheSetForTest(`k${i}`, { url: 'x', type: 'image/png', body: Buffer.alloc(200 * 1024) }, 60_000);
    const s = iconCacheStats();
    assert.ok(s.bytes <= 20 * 1024 * 1024, `${s.bytes}`);
    for (let i = 0; i < 400; i++) _cacheSetForTest(`n${i}`, null, 60_000);
    assert.ok(iconCacheStats().entries <= 300);
    clearIconCache();
    assert.deepEqual(iconCacheStats(), { entries: 0, bytes: 0 });
  });
});

// ---------------- SSRF 防护：每个接口 ----------------

describe('SSRF 防护', () => {
  // 直接传入的内网 / 回环 / 链路本地 / 保留地址，以及解析到内网的域名
  const HOST_TARGETS = [
    '127.0.0.1', '10.0.0.1', '10.255.255.254', 'localhost', 'a.localhost', '[::1]', '::1', '0.0.0.0', '169.254.169.254', '192.168.1.1',
    '172.16.0.1', '100.64.0.1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'fe80::1', 'fd00::1', '127.1', '0x7f.1',
    'internal.test.example', 'mixed.test.example', 'v6.test.example',
  ];
  const urlTargets = () => [
    'http://127.0.0.1/', `http://127.0.0.1:${PORT}/secret`, 'http://10.0.0.1/', 'https://10.1.2.3:8443/', 'http://localhost/', `http://localhost:${PORT}/secret`,
    'http://a.localhost/', 'http://[::1]/', `http://[::1]:${PORT}/secret`, 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest/meta-data/',
    'http://192.168.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://127.1/', 'http://intranet/', `http://internal.test.example:${PORT}/secret`,
    `http://mixed.test.example:${PORT}/secret`, `http://v6.test.example:${PORT}/secret`,
  ];
  // 跳转到内网（测试服务器本身在 127.0.0.1，用 allowLoopback 放行它，跳转目标仍按默认规则检查）
  const REDIRECTS = ['/site/to-internal', '/site/to-localhost', '/site/to-v6', '/site/to-dns-internal', '/site/to-mixed', '/site/to-metadata'];

  const rejects400 = async (p, label) => assert.rejects(p, (err) => {
    assert.equal(err.status, 400, `${label}：${err.message}`);
    return true;
  }, label);

  test('/api/dns：IP 与 localhost 被拒绝，DNS 服务器不能自定义', async () => {
    const r = route('/api/dns');
    const calls = [];
    for (const domain of ['127.0.0.1', '10.0.0.1', 'localhost', '[::1]', '::1', '::ffff:10.0.0.1', '169.254.169.254', '192.168.1.1']) {
      await rejects400(r.handler({ query: q({ domain }) }), domain);
      await rejects400(lookupDns({ domain }, { createResolver: fakeResolver({}, calls) }), domain);
    }
    for (const server of ['127.0.0.1', '10.0.0.1', 'localhost', '[::1]', '192.168.1.1:53', 'https://dns.example/dns-query']) {
      await rejects400(r.handler({ query: q({ domain: 'example.com', server }) }), server);
    }
    assert.deepEqual(calls, [], '没有发出任何 DNS 查询');
  });

  test('/api/ssl：内网目标在连接前被拒绝', async () => {
    const r = route('/api/ssl');
    for (const host of HOST_TARGETS) await rejects400(r.handler({ query: q({ host, port: String(SPORT) }) }), host);
    assert.equal(conns.secure, 0, '没有建立任何 TLS 连接');
  });

  test('/api/site/check：内网网址与跳转到内网', async () => {
    const r = route('/api/site/check');
    for (const url of urlTargets()) await rejects400(r.handler({ query: q({ url }) }), url);
    assert.equal(conns.web, 0, '直接传入的内网网址没有建立连接');
    for (const p of [...REDIRECTS, '/site/to-file']) await rejects400(checkSite(`http://127.0.0.1:${PORT}${p}`, { blocked: allowLoopback }), p);
    assert.equal(conns.web, REDIRECTS.length + 1, '只连接了发起跳转的那一跳');
    assert.equal(hits['/secret'], undefined, '内网目标没有被访问');
  });

  test('/api/tcping：内网目标在连接前被拒绝', async () => {
    const r = route('/api/tcping');
    for (const host of HOST_TARGETS) await rejects400(r.handler({ query: q({ host, port: String(TPORT) }) }), host);
    assert.equal(conns.tcp, 0, '没有建立任何 TCP 连接');
  });

  test('/api/ping：内网目标被拒绝，不会执行 ping', async () => {
    const r = route('/api/ping');
    let executed = 0;
    const exec = (file, args, options, cb) => { executed++; cb(null, fixture('ping-iputils.txt'), ''); };
    for (const host of HOST_TARGETS) {
      await rejects400(r.handler({ query: q({ host }) }), host);
      await rejects400(ping(host, { count: 1, execFileImpl: exec }), host);
    }
    assert.equal(executed, 0);
  });

  test('/api/domain/available：IP 与 localhost 被拒绝，不会请求 RDAP', async (t) => {
    const r = route('/api/domain/available');
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should not fetch'); });
    for (const domain of ['127.0.0.1', '10.0.0.1', 'localhost', '[::1]', '::1', '169.254.169.254', 'http://127.0.0.1/']) {
      await rejects400(r.handler({ query: q({ domain }) }), domain);
    }
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  test('/api/robots：内网网址与跳转到内网', async () => {
    const r = route('/api/robots');
    for (const url of urlTargets()) await rejects400(r.handler({ query: q({ url }) }), url);
    assert.equal(conns.web, 0);
    await rejects400(analyzeRobots(`http://redir.test.example:${PORT}/`, { blocked: allowLoopback }), 'robots.txt 跳转到 10.0.0.1');
  });

  test('/api/favicon：内网网址、页面跳转到内网被拒绝，图标指向内网时跳过', async () => {
    const r = route('/api/favicon');
    for (const url of urlTargets()) await rejects400(r.handler({ query: q({ url }) }), url);
    assert.equal(conns.web, 0);
    await rejects400(findFavicon(`http://127.0.0.1:${PORT}/page-to-internal`, { blocked: allowLoopback }), '页面跳转到 10.0.0.1');
    await rejects400(findFavicon(`http://127.0.0.1:${PORT}/page-to-localhost`, { blocked: allowLoopback }), '页面跳转到 localhost');
    assert.equal(hits['/secret'], undefined);
  });

  test('/api/links/check：内网网址、页面跳转到内网被拒绝，页面中的内网链接跳过不访问', async () => {
    const r = route('/api/links/check');
    for (const url of urlTargets()) await rejects400(r.handler({ query: q({ url }) }), url);
    assert.equal(conns.web, 0);
    await rejects400(checkLinks(`http://127.0.0.1:${PORT}/page-to-internal`, { blocked: allowLoopback }), '页面跳转到 10.0.0.1');
    await rejects400(checkLinks(`http://127.0.0.1:${PORT}/page-to-localhost`, { blocked: allowLoopback }), '页面跳转到 localhost');
    assert.equal(hits['/secret'], undefined);
  });

  test('/api/tld：没有用户可控的出站目标，只请求 IANA', async (t) => {
    cache.store.clear();
    resetTldState();
    const urls = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
      urls.push(String(url));
      return new Response(fixture('tlds-alpha-by-domain.txt'));
    });
    const r = route('/api/tld');
    for (const x of ['127.0.0.1', 'localhost', '[::1]', 'http://10.0.0.1/', 'internal.test.example']) {
      const res = await r.handler({ query: q({ q: x }) });
      assert.ok(Array.isArray(res.data.items));
    }
    assert.deepEqual([...new Set(urls)], ['https://data.iana.org/TLD/tlds-alpha-by-domain.txt']);
  });

  test('DNS 重绑定：只在连接时由 lookup 钩子检查解析结果', async () => {
    lookedUp.length = 0;
    await rejects400(checkSite(`http://127.0.0.1:${PORT}/site/to-dns-internal`, { blocked: allowLoopback }), 'site');
    assert.ok(lookedUp.includes('internal.test.example'), '跳转目标的域名在连接时被解析并检查');
    await rejects400(inspectCert('internal.test.example', 443), 'ssl');
    await rejects400(tcping('mixed.test.example', { port: 443, count: 1 }), 'tcping：解析结果中只要有一个内网地址就拒绝');
  });
});

// ---------------- 覆盖检查 ----------------

test('net 分类的每个非 raw 路由都做了双向字段校验，raw 路由有 returns', () => {
  const expected = routes.filter((r) => !r.raw).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(expected.filter((k) => !checked.has(k)), []);
  for (const r of routes.filter((x) => x.raw)) {
    assert.ok(typeof r.returns === 'string' && r.returns.length > 20, `${r.path} 缺少 returns`);
    assert.equal(r.fields, undefined, `${r.path} 是 raw 路由，用 returns 而不是 fields`);
  }
});

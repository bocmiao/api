import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { proxyConfig, shouldProxy, proxyFetch, outboundFetch, DEFAULT_PROXY_HOSTS } from '../src/lib/proxy.js';
import { upstreamError } from '../src/lib/http.js';

// 本地模拟一个 HTTP 代理：明文请求转发给本地目标服务器，CONNECT 一律拒绝
let target, proxy, targetUrl, proxyUrl;
const seen = [];
before(async () => {
  target = http.createServer((req, res) => {
    if (req.url === '/moved') { res.writeHead(302, { location: '/gz' }); return res.end(); }
    if (req.url === '/gz') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'set-cookie': ['a=1', 'b=2'] });
      return res.end(zlib.gzipSync(JSON.stringify({ ok: true, ua: req.headers['user-agent'] })));
    }
    res.writeHead(404); res.end('nope');
  }).listen(0, '127.0.0.1');
  proxy = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers['proxy-authorization'] ?? null });
    const u = new URL(req.url);
    const up = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    req.pipe(up);
  }).listen(0, '127.0.0.1');
  proxy.on('connect', (req, socket) => { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  await Promise.all([target, proxy].map((s) => new Promise((r) => s.once('listening', r))));
  targetUrl = `http://127.0.0.1:${target.address().port}`;
  proxyUrl = `http://user:p%40ss@127.0.0.1:${proxy.address().port}`;
});
after(() => { target.close(); proxy.close(); });

test('代理配置：只接受 http://，域名列表含子域名，* 表示全部', () => {
  assert.equal(proxyConfig({}), null);
  assert.equal(proxyConfig({ OUTBOUND_PROXY: 'socks5://1.2.3.4:1080' }), null);
  const cfg = proxyConfig({ OUTBOUND_PROXY: 'http://127.0.0.1:7890' });
  assert.deepEqual(cfg.hosts, DEFAULT_PROXY_HOSTS.split(','));
  assert.equal(shouldProxy('https://store.steampowered.com/api', cfg), true);
  assert.equal(shouldProxy('https://www.v2ex.com/api/topics/hot.json', cfg), true);
  assert.equal(shouldProxy('https://api.bilibili.com/x', cfg), false);
  assert.equal(shouldProxy('https://notsteampowered.com/', cfg), false, '只匹配整段域名');
  const all = proxyConfig({ OUTBOUND_PROXY: 'http://127.0.0.1:7890', OUTBOUND_PROXY_HOSTS: '*' });
  assert.equal(shouldProxy('https://api.bilibili.com/x', all), true);
});

test('通过代理请求：带代理认证、自动解压、跟随跳转，返回标准 Response', async () => {
  const cfg = proxyConfig({ OUTBOUND_PROXY: proxyUrl, OUTBOUND_PROXY_HOSTS: '127.0.0.1' });
  const res = await proxyFetch(`${targetUrl}/moved`, { headers: { 'user-agent': 'miao-test' } }, cfg);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, ua: 'miao-test' });
  assert.deepEqual(res.headers.getSetCookie(), ['a=1', 'b=2']);
  assert.equal(seen.length, 2, '跳转后的请求也走代理');
  assert.equal(seen[0].auth, `Basic ${Buffer.from('user:p@ss').toString('base64')}`);
});

test('代理拒绝 CONNECT 时给出明确原因', async () => {
  const cfg = proxyConfig({ OUTBOUND_PROXY: proxyUrl, OUTBOUND_PROXY_HOSTS: '*' });
  await assert.rejects(proxyFetch('https://store.steampowered.com/', {}, cfg), /代理服务器拒绝连接（HTTP 403）/);
  const dead = proxyConfig({ OUTBOUND_PROXY: 'http://127.0.0.1:1', OUTBOUND_PROXY_HOSTS: '*' });
  await assert.rejects(proxyFetch('https://store.steampowered.com/', {}, dead), /无法连接代理服务器/);
});

test('没配代理时照常直连', async () => {
  const prev = process.env.OUTBOUND_PROXY;
  delete process.env.OUTBOUND_PROXY;
  try {
    const res = await outboundFetch(`${targetUrl}/gz`);
    assert.equal((await res.json()).ok, true);
  } finally {
    if (prev != null) process.env.OUTBOUND_PROXY = prev;
  }
});

test('网络错误说明具体原因，境外数据源提示配置代理', () => {
  const dns = upstreamError(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }), 'https://box.maoyan.com/x');
  assert.equal(dns.status, 502);
  assert.equal(dns.message, '无法连接上游服务（box.maoyan.com：域名解析失败）');
  const reset = upstreamError(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }), 'https://www.v2ex.com/api');
  assert.match(reset.message, /www\.v2ex\.com：连接被重置.*系统设置 → 网络/);
  const timeout = upstreamError(Object.assign(new Error('t'), { name: 'TimeoutError' }), 'https://store.steampowered.com/api');
  assert.equal(timeout.status, 504);
  assert.match(timeout.message, /响应超时（store\.steampowered\.com）.*配置代理/);
});

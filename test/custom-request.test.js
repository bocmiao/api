import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns';
import { mock } from 'node:test';
import { createCustomRequester } from '../src/lib/custom-request.js';

afterEach(() => mock.restoreAll());
const localLookup = (_host, options, callback) => callback(null, options.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4);
async function fixture(handler, run) {
  const server = http.createServer(handler).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://fixture.example:${server.address().port}`;
  try { await run(url, createCustomRequester({ lookup: localLookup })); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

test('默认通道在连接时拒绝 DNS 内网和混合地址，不发起私网 HTTP', async () => {
  let hits = 0;
  await fixture((_req, res) => { hits++; res.end('{}'); }, async (url) => {
    for (const addresses of [[{ address: '127.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 4 }, { address: '10.1.2.3', family: 4 }]]) {
      const m = mock.method(dns, 'lookup', (_host, _options, callback) => callback(null, addresses));
      await assert.rejects(createCustomRequester()(url), { status: 400 });
      m.mock.restore();
    }
  });
  assert.equal(hits, 0);
});

test('原生传输正常读 JSON 与 POST 正文；不使用全局 fetch/代理', async () => {
  let hits = 0;
  await fixture(async (req, res) => {
    hits++;
    let body = ''; for await (const chunk of req) body += chunk;
    assert.equal(req.method, 'POST'); assert.equal(body, '{"x":1}');
    assert.equal(req.headers['accept-encoding'], 'identity');
    res.end('{"value":"ok"}');
  }, async (url, request) => {
    mock.method(globalThis, 'fetch', () => { throw new Error('不得使用通用 fetch'); });
    assert.deepEqual(await request(url, { method: 'POST', body: '{"x":1}' }), { value: 'ok' });
  });
  assert.equal(hits, 1);
});

test('跳转从未被跟随，认证头不会发给下一个地址', async () => {
  let hits = 0;
  await fixture((_req, res) => { hits++; res.writeHead(302, { location: 'http://169.254.169.254/latest' }); res.end(); }, async (url, request) => {
    await assert.rejects(request(url, { headers: { authorization: 'dummy-only' } }), { status: 502 });
  });
  assert.equal(hits, 1);
});

test('503 不自动重试，错误响应被释放', async () => {
  let hits = 0;
  await fixture((_req, res) => { hits++; res.writeHead(503); res.end('not JSON'); }, async (url, request) => {
    await assert.rejects(request(url), { status: 502 });
  });
  assert.equal(hits, 1);
});

test('超时贯穿响应正文，外部取消停止等待', async () => {
  await fixture((_req, res) => { res.writeHead(200); res.write('{'); }, async (url, request) => {
    await assert.rejects(request(url, { timeoutMs: 35 }), { status: 504 });
    const controller = new AbortController();
    const pending = request(url, { timeoutMs: 1000, signal: controller.signal });
    controller.abort(new Error('fixture cancellation'));
    await assert.rejects(pending, /fixture cancellation/);
  });
});

test('无长度响应、伪报长度、压缩及非 JSON 均不会无限读取', async () => {
  for (const type of ['stream-large', 'declared-large', 'compressed', 'bad-json', 'truncated']) {
    await fixture((_req, res) => {
      if (type === 'declared-large') { res.writeHead(200, { 'content-length': 2000000 }); res.end(); }
      else if (type === 'compressed') { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end('compressed'); }
      else if (type === 'stream-large') res.end('x'.repeat(1024 * 1024 + 1));
      else if (type === 'truncated') { res.writeHead(200, { 'content-length': 50 }); res.write('{'); setImmediate(() => res.destroy()); }
      else res.end('bad JSON');
    }, async (url, request) => { await assert.rejects(request(url), { status: 502 }, type); });
  }
});

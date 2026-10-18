import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { fetchJSON, fetchText, HttpError } = await import('../src/lib/http.js');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const jsonRes = (body) => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
});

test('GET：网络错误后重试一次并成功', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    return jsonRes({ ok: true });
  };
  const data = await fetchJSON('https://example.com/x', { retry: true });
  assert.deepEqual(data, { ok: true });
  assert.equal(calls, 2);
});

test('GET：上游 503 后重试一次并成功', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1 ? new Response('busy', { status: 503 }) : jsonRes({ ok: 1 });
  };
  const data = await fetchJSON('https://example.com/x', { retry: true });
  assert.deepEqual(data, { ok: 1 });
  assert.equal(calls, 2);
});

test('GET：4xx 不重试，直接变成 502', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('nope', { status: 404 }); };
  await assert.rejects(fetchJSON('https://example.com/x', { retry: true }), (e) => e instanceof HttpError && e.status === 502);
  assert.equal(calls, 1);
});

test('GET：两次都失败时只报一次错', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('busy', { status: 503 }); };
  await assert.rejects(fetchJSON('https://example.com/x', { retry: true }), (e) => e.status === 502 && /503/.test(e.message));
  assert.equal(calls, 2);
});

test('POST：失败不重试（非幂等）', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
  };
  await assert.rejects(
    fetchJSON('https://example.com/x', { method: 'POST', body: '{}', retry: true }),
    (e) => e.status === 502,
  );
  assert.equal(calls, 1);
});

test('外部取消：AbortSignal 触发后不再重试', async () => {
  const controller = new AbortController();
  controller.abort(new Error('用户取消'));
  let calls = 0;
  globalThis.fetch = async (url, opts) => {
    calls++;
    if (opts?.signal?.aborted) throw opts.signal.reason ?? new Error('aborted');
    return jsonRes({ ok: true });
  };
  await assert.rejects(fetchJSON('https://example.com/x', { signal: controller.signal, retry: true }));
  assert.equal(calls, 0);
});


test('未知GET和显式关闭的请求不重试，避免重放有配额或副作用的GET', async () => {
  for (const opts of [{}, { retry: false }]) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); };
    await assert.rejects(fetchJSON('https://example.com/usage', opts), (e) => e.status === 502);
    assert.equal(calls, 1);
  }
});

test('HEAD可显式重试，两个尝试共用一个总预算信号', async () => {
  const signals = [];
  globalThis.fetch = async (_url, opts) => {
    signals.push(opts.signal); assert.equal(opts.method, 'HEAD');
    return signals.length === 1 ? new Response(null, { status: 503 }) : new Response(null);
  };
  assert.equal(await fetchText('https://example.com/x', { method: 'head', retry: true }), '');
  assert.equal(signals.length, 2); assert.equal(signals[0], signals[1]);
});

test('退避期间用户取消立即结束，不发第二次请求', async () => {
  const controller = new AbortController(); const reason = new Error('用户停止等待'); let calls = 0;
  globalThis.fetch = async () => { calls++; setTimeout(() => controller.abort(reason), 20); return new Response('busy', { status: 503 }); };
  await assert.rejects(fetchJSON('https://example.com/x', { retry: true, signal: controller.signal }), (e) => e === reason);
  assert.equal(calls, 1);
});

test('总预算覆盖退避，短预算耗尽后不发第二次请求', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('busy', { status: 503 }); };
  await assert.rejects(fetchJSON('https://example.com/x', { retry: true, timeoutMs: 45 }), (e) => e.status === 504);
  assert.equal(calls, 1);
});

test('即使事件循环延迟了超时事件，已过总截止时间也不能重试', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++; const until = performance.now() + 30;
    while (performance.now() < until) { /* 模拟同步解码占用 */ }
    return new Response('busy', { status: 503 });
  };
  await assert.rejects(fetchJSON('https://example.com/x', { retry: true, timeoutMs: 10 }), (e) => e.status === 504);
  assert.equal(calls, 1);
});

test('最终5xx和4xx的响应体也释放；429与Retry-After不重试', async () => {
  let cancels = 0, calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(new ReadableStream({ cancel() { cancels++; } }), { status: 503 }); };
  await assert.rejects(fetchJSON('https://example.com/x', { retry: true }), (e) => e.status === 502);
  assert.equal(calls, 2); assert.equal(cancels, 2);
  for (const status of [401, 429, 503]) {
    calls = 0; cancels = 0;
    globalThis.fetch = async () => { calls++; return new Response(new ReadableStream({ cancel() { cancels++; } }), { status, headers: status === 503 ? { 'Retry-After': '60' } : {} }); };
    await assert.rejects(fetchJSON('https://example.com/x', { retry: true }), (e) => e.status === 502);
    assert.equal(calls, 1); assert.equal(cancels, 1);
  }
});

test('响应体cancel不结束也不能拖住总预算', { timeout: 1000 }, async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(new ReadableStream({ cancel() { return new Promise(() => {}); } }), { status: 503 }); };
  await assert.rejects(fetchJSON('https://example.com/x', { retry: true, timeoutMs: 45 }), (e) => e.status === 504);
  assert.equal(calls, 1);
});

test('证书与URL等永久错误不重试', async () => {
  for (const code of ['CERT_HAS_EXPIRED', 'ERR_INVALID_URL']) {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw Object.assign(new Error('bad configuration'), { code }); };
    await assert.rejects(fetchJSON('https://example.com/x', { retry: true }), (e) => e.status === 502);
    assert.equal(calls, 1);
  }
});

test('请求体流只消费一次，POST及带body的GET都不重放', async () => {
  for (const method of ['POST', 'GET']) {
    let calls = 0;
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('only once')); c.close(); } });
    globalThis.fetch = async (_url, opts) => {
      calls++; assert.equal(await new Response(opts.body).text(), 'only once');
      throw Object.assign(new Error('reset after send'), { code: 'ECONNRESET' });
    };
    await assert.rejects(fetchJSON('https://example.com/x', { method, body, retry: true }), (e) => e.status === 502);
    assert.equal(calls, 1);
  }
});

test('真实本地传输：超时不重试，预算也约束读取正文', async () => {
  const { createServer } = await import('node:http');
  const counts = { headers: 0, body: 0 };
  const server = createServer((req, res) => {
    if (req.url === '/headers') { counts.headers++; return; }
    counts.body++; res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); res.write('{');
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  globalThis.fetch = realFetch;
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const path of ['headers', 'body']) await assert.rejects(fetchJSON(base + '/' + path, { retry: true, timeoutMs: 250 }), (e) => e.status === 504);
    assert.deepEqual(counts, { headers: 1, body: 1 });
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { fetchJSON, HttpError } = await import('../src/lib/http.js');

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
  const data = await fetchJSON('https://example.com/x');
  assert.deepEqual(data, { ok: true });
  assert.equal(calls, 2);
});

test('GET：上游 503 后重试一次并成功', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1 ? new Response('busy', { status: 503 }) : jsonRes({ ok: 1 });
  };
  const data = await fetchJSON('https://example.com/x');
  assert.deepEqual(data, { ok: 1 });
  assert.equal(calls, 2);
});

test('GET：4xx 不重试，直接变成 502', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('nope', { status: 404 }); };
  await assert.rejects(fetchJSON('https://example.com/x'), (e) => e instanceof HttpError && e.status === 502);
  assert.equal(calls, 1);
});

test('GET：两次都失败时只报一次错', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('busy', { status: 503 }); };
  await assert.rejects(fetchJSON('https://example.com/x'), (e) => e.status === 502 && /503/.test(e.message));
  assert.equal(calls, 2);
});

test('POST：失败不重试（非幂等）', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
  };
  await assert.rejects(
    fetchJSON('https://example.com/x', { method: 'POST', body: '{}' }),
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
  await assert.rejects(fetchJSON('https://example.com/x', { signal: controller.signal }));
  assert.equal(calls, 0);
});

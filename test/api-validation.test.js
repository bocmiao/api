import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { apiRouter } = await import('../src/registry.js');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// 参数校验应在请求上游之前完成；这里让 fetch 直接抛错，若校验没拦住会表现为上游错误而非 400
const blockUpstream = () => {
  globalThis.fetch = async () => { throw new Error('参数校验失败时不应请求上游'); };
};

const handlerOf = (path) => {
  const hit = apiRouter.match('GET', path);
  assert.ok(hit?.route, `${path} 应存在`);
  return hit.route.handler;
};

const call = (path, qs) => handlerOf(path)({
  query: new URLSearchParams(qs), params: {}, ip: '127.0.0.1', req: { headers: {} },
});

test('epic 免费游戏：locale / country 不合法直接 400', async () => {
  blockUpstream();
  await assert.rejects(call('/api/epic/free', 'locale=bad!!'), (e) => e.status === 400);
  await assert.rejects(call('/api/epic/free', 'country=chn'), (e) => e.status === 400);
  await assert.rejects(call('/api/epic/free', 'country=1X'), (e) => e.status === 400);
});

test('游戏限免汇总：未知平台直接 400', async () => {
  blockUpstream();
  await assert.rejects(call('/api/games/free', 'platform=nope'), (e) => e.status === 400);
  await assert.rejects(call('/api/games/free', 'platform=epic,nope'), (e) => e.status === 400);
});

test('音乐歌词：歌曲 ID 必须是纯数字', async () => {
  blockUpstream();
  await assert.rejects(call('/api/music/lyric', 'id=abc'), (e) => e.status === 400);
  await assert.rejects(call('/api/music/lyric', 'id=1%20or%201'), (e) => e.status === 400);
  await assert.rejects(call('/api/music/lyric', ''), (e) => e.status === 400);
});

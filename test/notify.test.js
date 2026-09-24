import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sql } from '../src/db.js';
import { runChecks } from '../src/notify/scheduler.js';
import { cache } from '../src/lib/cache.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/epic.json', import.meta.url), 'utf8'));
const sent = [];
let epicData = fixture;

mock.method(globalThis, 'fetch', async (url, opts) => {
  const u = String(url);
  if (u.includes('epicgames.com')) return Response.json(epicData);
  if (u.includes('oapi.dingtalk.com')) {
    sent.push(JSON.parse(opts.body));
    return Response.json({ errcode: 0 });
  }
  return new Response('not mocked', { status: 500 });
});

// 让 fixture 里的促销窗口覆盖"现在"
function shiftWindows(data, ids) {
  const copy = structuredClone(data);
  const start = new Date(Date.now() - 86400_000).toISOString();
  const end = new Date(Date.now() + 86400_000).toISOString();
  for (const el of copy.data.Catalog.searchStore.elements) {
    const offers = el.promotions?.promotionalOffers?.[0]?.promotionalOffers ?? [];
    for (const o of offers) Object.assign(o, { startDate: start, endDate: end });
    if (ids && !ids.includes(el.id)) el.promotions = null;
  }
  return copy;
}

test('首次检查只记录状态，内容变化后推送给订阅者', async () => {
  const { lastInsertRowid: uid } = sql("INSERT INTO users (email, password_hash) VALUES ('n@example.com', 'x')").run();
  const { lastInsertRowid: cid } = sql("INSERT INTO channels (user_id, type, name, config) VALUES (?, 'dingtalk', 'g', ?)")
    .run(uid, JSON.stringify({ webhook: 'https://oapi.dingtalk.com/robot/send?access_token=t' }));
  sql("INSERT INTO subscriptions (user_id, topic, channel_id) VALUES (?, 'epic-free', ?)").run(uid, cid);

  epicData = shiftWindows(fixture, ['g1']);
  await runChecks();
  assert.equal(sent.length, 0, '首次检查不推送旧内容');
  assert.ok(sql("SELECT fingerprint FROM topic_state WHERE topic = 'epic-free'").get().fingerprint.includes('g1'));

  await runChecks();
  assert.equal(sent.length, 0, '内容未变化不推送');

  epicData = shiftWindows(fixture, ['g1', 'g4']);
  cache.store.clear();
  await runChecks();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].msgtype, 'markdown');
  assert.match(sent[0].markdown.title, /Current Free Game/);
  assert.match(sent[0].markdown.text, /Free Bundle/);
});

test('停用用户不再收到推送', async () => {
  sql("UPDATE users SET disabled = 1 WHERE email = 'n@example.com'").run();
  epicData = shiftWindows(fixture, ['g4']);
  cache.store.clear();
  const before = sent.length;
  await runChecks();
  assert.equal(sent.length, before);
});

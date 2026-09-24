import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFreeGames } from '../src/apis/epic.js';

const raw = JSON.parse(readFileSync(new URL('./fixtures/epic.json', import.meta.url)));
const now = new Date('2026-09-20T00:00:00Z');

test('区分当前免费与即将免费，忽略打折和无促销的游戏', () => {
  const { current, upcoming } = parseFreeGames(raw, { now });
  assert.deepEqual(current.map((g) => g.id), ['g1', 'g4']);
  assert.deepEqual(upcoming.map((g) => g.id), ['g2']);
});

test('输出字段：价格、时间、图片、商店链接', () => {
  const [g1, g4] = parseFreeGames(raw, { now }).current;
  assert.equal(g1.title, 'Current Free Game');
  assert.equal(g1.seller, 'Studio A');
  assert.equal(g1.originalPrice, '¥88.00');
  assert.equal(g1.endDate, '2026-09-24T15:00:00.000Z');
  assert.equal(g1.image.wide, 'https://img/wide1');
  assert.equal(g1.image.tall, 'https://img/thumb1');
  assert.equal(g1.url, 'https://store.epicgames.com/zh-CN/p/current-free-game');
  assert.equal(g4.url, 'https://store.epicgames.com/zh-CN/bundles/cool-bundle');

  const [g2] = parseFreeGames(raw, { now, locale: 'en-US' }).upcoming;
  assert.equal(g2.url, 'https://store.epicgames.com/en-US/p/next-week-game');
});

test('按当前时间判断：周期切换后，下周游戏变为当前免费', () => {
  const { current, upcoming } = parseFreeGames(raw, { now: new Date('2026-09-25T00:00:00Z') });
  assert.deepEqual(current.map((g) => g.id), ['g2']);
  assert.deepEqual(upcoming.map((g) => g.id), []);
});

test('上游格式异常时抛出 502', () => {
  assert.throws(() => parseFreeGames({ errors: [] }), { status: 502 });
});

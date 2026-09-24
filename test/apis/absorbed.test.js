// 从另一个项目吸收过来的一批接口：垃圾分类、成语词典 / 接龙、歇后语、脑筋急转弯、冷知识、彩虹屁、笑话、Minecraft 服务器状态。
// 本地数据接口不访问网络；Minecraft 用本地假服务器测试，DNS 与 SRV 查询全部替换成假的。
import { test, describe, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dns from 'node:dns';

import funModules from '../../src/apis/fun/index.js';
import lifeModules from '../../src/apis/life/index.js';
import gamesModules from '../../src/apis/games/index.js';
import { isBlockedIP } from '../../src/lib/netguard.js';
import { BLOCKED_MSG } from '../../src/apis/net/common.js';
import { assertFieldsDocumented, collectPaths, matcher } from '../helpers/fields.js';

import { GARBAGE_CATEGORIES, GARBAGE_ITEMS, NOTES } from '../../src/apis/life/data/garbage.js';
import { lookupGarbage, matchGarbage, normalize, GARBAGE_INDEX } from '../../src/apis/life/garbage.js';
import { IDIOMS } from '../../src/apis/fun/data/idioms.js';
import { lookupIdiom, idiomChain, toneless, IDIOM_ITEMS } from '../../src/apis/fun/idiom.js';
import { XIEHOUYU } from '../../src/apis/fun/data/xiehouyu.js';
import { pickXiehouyu } from '../../src/apis/fun/xiehouyu.js';
import { BRAIN_TEASERS } from '../../src/apis/fun/data/brain-teasers.js';
import { pickTeasers, teaserAnswer } from '../../src/apis/fun/brain-teaser.js';
import { COLD_FACTS, COLD_FACT_TAGS } from '../../src/apis/fun/data/cold-facts.js';
import { COMPLIMENTS } from '../../src/apis/fun/data/compliments.js';
import { JOKES } from '../../src/apis/fun/data/jokes.js';
import { pickItems } from '../../src/apis/fun/pool.js';
import {
  encodeVarInt, decodeVarInt, readPacket, buildHandshake, buildStatusRequest, buildPing, encodePacket,
  parseStatusPacket, stripFormatting, chatToText, parseMotd, normalizeStatus, splitHostPort, lookupSrv, mcStatus,
  McProtocolError, MAX_BYTES,
} from '../../src/apis/games/mc-server.js';

const ALL_MODULES = [...funModules, ...lifeModules, ...gamesModules];
const NEW_MODULES = {
  garbage: 'life', idiom: 'fun', xiehouyu: 'fun', 'brain-teaser': 'fun', 'cold-fact': 'fun', compliment: 'fun', joke: 'fun', 'mc-server': 'games',
};
const NEW_PATHS = [
  '/api/garbage', '/api/idiom', '/api/idiom/chain', '/api/xiehouyu', '/api/brain-teaser', '/api/brain-teaser/answer',
  '/api/cold-fact', '/api/compliment', '/api/joke', '/api/mc/server',
];

function route(path) {
  for (const m of ALL_MODULES) for (const r of m.routes) if (r.path === path) return r;
  throw new Error(`no route ${path}`);
}
const call = async (path, qs = '') => (await route(path).handler({ query: new URLSearchParams(qs), params: {}, body: null, ip: '127.0.0.1', user: null, req: null })).data;
const seq = (n) => { let i = 0; return () => (i++ % n) / n; }; // 可预测的“随机数”

// 默认断网：任何意外的外网请求都会失败
const offline = async (url) => { throw new TypeError(`offline: ${url}`); };
globalThis.fetch = offline;
afterEach(() => { globalThis.fetch = offline; });

// ---- 双向字段校验（与 fun-local.test.js 相同）----
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function* entries(value, prefix = '') {
  if (Array.isArray(value)) {
    for (const item of value) yield* entries(item, `${prefix}[]`);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = prefix ? `${prefix}.${k}` : k;
      yield [p, v];
      yield* entries(v, p);
    }
  }
}

// 每个样例：字段都有说明，且实际类型在说明的 type 之内；所有样例合起来：说明里的每个字段都至少出现一次
function checkFields(r, samples) {
  for (const data of samples) {
    assertFieldsDocumented(r, data);
    for (const [p, v] of entries(data)) {
      const f = r.fields.find((x) => matcher(x.name).test(p));
      assert.ok(f.type.split('|').includes(typeOf(v)), `${r.path} ${p} 实际类型 ${typeOf(v)}，说明里是 ${f.type}`);
    }
  }
  const seen = [...new Set(samples.flatMap((d) => [...collectPaths(d)]))];
  const unseen = r.fields.filter((f) => !seen.some((p) => matcher(f.name).test(p))).map((f) => f.name);
  assert.deepEqual(unseen, [], `${r.path} 说明了但样例中没有出现的字段：${unseen.join(', ')}`);
}

const rejects = (p, status, message) => assert.rejects(p, (err) => {
  assert.equal(err.status, status, `期望 ${status}，实际 ${err.status} ${err.message}`);
  if (message) assert.match(err.message, message);
  return true;
});

// ================= 元数据 =================

test('新模块已注册到对应分类，元数据与参数说明完整', () => {
  for (const [name, category] of Object.entries(NEW_MODULES)) {
    const m = ALL_MODULES.find((x) => x.name === name);
    assert.ok(m, `${name} 没有注册`);
    assert.equal(m.category, category, name);
    assert.ok(m.title && m.description && m.source, name);
    assert.ok(!m.env?.length, `${name} 不应依赖环境变量`);
    for (const r of m.routes) {
      assert.ok(NEW_PATHS.includes(r.path), r.path);
      assert.equal(r.method, 'GET');
      assert.ok(r.summary && Array.isArray(r.params), r.path);
      for (const p of r.params) assert.ok(p.name && p.desc, `${r.path} ${p.name}`);
      assert.ok(!r.raw && r.fields.length && r.fields.every((f) => f.desc.trim()), `${r.path} 缺少 fields`);
    }
  }
  assert.ok(lifeModules.some((m) => m.name === 'garbage'));
  assert.ok(gamesModules.some((m) => m.name === 'mc-server'));
  const paths = ALL_MODULES.flatMap((m) => m.routes.map((r) => r.path));
  assert.equal(new Set(paths).size, paths.length, '路由路径重复');
  for (const p of NEW_PATHS) assert.ok(paths.includes(p), p);
});

test('本地数据接口不访问网络', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new TypeError('offline'); };
  await call('/api/garbage', 'name=电池');
  await call('/api/idiom');
  await call('/api/idiom', 'word=画龙点睛');
  await call('/api/idiom/chain', 'word=一鸣惊人');
  await call('/api/xiehouyu', 'count=10');
  await call('/api/brain-teaser', 'count=10&hide=1');
  await call('/api/brain-teaser/answer', 'id=1');
  await call('/api/cold-fact', 'count=10');
  await call('/api/compliment', 'count=10');
  await call('/api/joke', 'count=10');
  assert.equal(calls, 0);
});

// ================= 数据 =================

const HAS_TONE = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü]/;

test('数据规模与格式', () => {
  const garbageNames = Object.values(GARBAGE_ITEMS).flat();
  assert.ok(garbageNames.length >= 300, `垃圾分类只有 ${garbageNames.length} 种`);
  assert.equal(new Set(garbageNames).size, garbageNames.length, '垃圾分类物品重复（或同一物品出现在两个分类）');
  assert.deepEqual(Object.keys(GARBAGE_ITEMS).sort(), GARBAGE_CATEGORIES.map((c) => c.name).sort());
  for (const c of GARBAGE_CATEGORIES) {
    assert.match(c.color, /^#[0-9A-F]{6}$/);
    assert.ok(c.alias && c.guide && c.desc, c.name);
  }
  assert.deepEqual(GARBAGE_CATEGORIES.map((c) => c.alias), ['可回收物', '有害垃圾', '湿垃圾', '干垃圾']);
  for (const [k, v] of Object.entries(NOTES)) {
    assert.ok(garbageNames.includes(k), `NOTES 里的 ${k} 不在词库中`);
    assert.ok(typeof v === 'string' && v.length > 5, k);
  }

  assert.ok(IDIOMS.length >= 300, `成语只有 ${IDIOMS.length} 条`);
  assert.equal(new Set(IDIOMS.map((x) => x[0])).size, IDIOMS.length, '成语重复');
  for (const [word, pinyin, explanation, source, example] of IDIOMS) {
    assert.match(word, /^\p{Script=Han}{4}$/u, word);
    const syllables = pinyin.split(' ');
    assert.equal(syllables.length, 4, `${word} 拼音音节数不对：${pinyin}`);
    assert.ok(syllables.every((s) => /^[a-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü]+$/.test(s)), `${word} 拼音含非法字符：${pinyin}`);
    assert.ok(syllables.filter((s) => HAS_TONE.test(s)).length >= 3, `${word} 拼音缺声调：${pinyin}`);
    assert.ok(explanation.length >= 4 && /[。）]$/.test(explanation), `${word} 释义：${explanation}`);
    assert.ok(source === null || (typeof source === 'string' && /《/.test(source)), `${word} 出处：${source}`);
    assert.ok(example.includes(word) || word === '塞翁失马', `${word} 的例句里没有出现该成语：${example}`);
  }

  assert.ok(XIEHOUYU.length >= 100, `歇后语只有 ${XIEHOUYU.length} 条`);
  assert.equal(new Set(XIEHOUYU.map((x) => x[0])).size, XIEHOUYU.length, '歇后语谜面重复');
  assert.ok(BRAIN_TEASERS.length >= 80, `脑筋急转弯只有 ${BRAIN_TEASERS.length} 道`);
  assert.equal(new Set(BRAIN_TEASERS.map((x) => x[0])).size, BRAIN_TEASERS.length, '脑筋急转弯重复');
  assert.ok(COLD_FACTS.length >= 100, `冷知识只有 ${COLD_FACTS.length} 条`);
  assert.equal(new Set(COLD_FACTS.map((x) => x[0])).size, COLD_FACTS.length, '冷知识重复');
  assert.ok(COLD_FACTS.every(([, tag]) => COLD_FACT_TAGS.includes(tag)));
  assert.ok(COMPLIMENTS.length >= 60, `彩虹屁只有 ${COMPLIMENTS.length} 条`);
  assert.equal(new Set(COMPLIMENTS).size, COMPLIMENTS.length, '彩虹屁重复');
  assert.ok(JOKES.length >= 60, `笑话只有 ${JOKES.length} 条`);
  assert.equal(new Set(JOKES).size, JOKES.length, '笑话重复');
  for (const list of [XIEHOUYU, BRAIN_TEASERS]) {
    assert.ok(list.every((x) => x.length === 2 && x.every((s) => typeof s === 'string' && s.trim() === s && s.length)));
  }
  for (const list of [COMPLIMENTS, JOKES, COLD_FACTS.map((x) => x[0])]) {
    assert.ok(list.every((s) => typeof s === 'string' && s.trim() === s && s.length >= 8), '条目为空或首尾有空白');
  }
});

// ================= 垃圾分类 =================

describe('垃圾分类', () => {
  test('精确匹配、别名与补充说明', async () => {
    const d = await call('/api/garbage', 'name=纽扣电池');
    assert.equal(d.exact, true);
    assert.equal(d.name, '纽扣电池');
    assert.equal(d.category, '有害垃圾');
    assert.equal(d.color, '#D8342B');
    assert.match(d.note, /有害垃圾/);
    assert.equal(d.matches[0].name, '纽扣电池');

    const wet = await call('/api/garbage', 'name=西瓜皮');
    assert.deepEqual([wet.category, wet.alias, wet.exact, wet.ambiguous], ['厨余垃圾', '湿垃圾', true, false]);
    assert.equal((await call('/api/garbage', 'name=大骨头')).alias, '干垃圾');
    assert.equal((await call('/api/garbage', 'name=干电池')).category, '其他垃圾');
    assert.equal((await call('/api/garbage', 'name=利乐包')).category, '可回收物');
    assert.equal((await call('/api/garbage', 'name=过期药品')).category, '有害垃圾');
  });

  test('模糊匹配：查“电池”同时列出干电池、纽扣电池，并标记分类有分歧', async () => {
    const d = await call('/api/garbage', 'name=电池');
    assert.equal(d.exact, false);
    assert.equal(d.ambiguous, true);
    const names = d.matches.map((m) => m.name);
    assert.ok(names.includes('干电池') && names.includes('纽扣电池'), names.join(','));
    assert.ok(d.matches.length <= 10);
    assert.equal(d.name, d.matches[0].name);
    // 名称越接近越靠前
    const lens = d.matches.map((m) => m.name.length);
    assert.deepEqual(lens, [...lens].sort((a, b) => a - b));
    // 查询词包含物品名
    const phone = await call('/api/garbage', 'name=旧手机');
    assert.equal(phone.name, '手机');
    assert.equal(phone.category, '可回收物');
    // 忽略空白、大小写和全角
    assert.equal((await call('/api/garbage', 'name=x光片')).name, 'X光片');
    assert.equal((await call('/api/garbage', 'name=Ｕ盘')).name, 'U盘');
    assert.equal((await call('/api/garbage', 'name= 蛋 壳 ')).name, '蛋壳');
    assert.equal(normalize(' Ａb C '), 'abc');
    // 完全相同的排第一
    assert.equal(matchGarbage('鱼')[0].name, '鱼');
    assert.equal(GARBAGE_INDEX.length, Object.values(GARBAGE_ITEMS).flat().length);
  });

  test('查不到返回 404 并附上相近候选；缺参数 400', async () => {
    await assert.rejects(call('/api/garbage', 'name=手表'), (err) => {
      assert.equal(err.status, 404);
      assert.ok(err.candidates.length > 0 && err.candidates.length <= 5);
      assert.ok(err.candidates.includes('手机'), err.candidates.join(','));
      assert.match(err.message, /没有找到「手表」.*手机/);
      return true;
    });
    await assert.rejects(call('/api/garbage', 'name=zzz'), (err) => {
      assert.equal(err.status, 404);
      assert.deepEqual(err.candidates, []);
      assert.match(err.message, /可回收物.*有害垃圾.*厨余垃圾.*其他垃圾/);
      return true;
    });
    assert.throws(() => lookupGarbage('qqq'), { status: 404 });
    await rejects(call('/api/garbage'), 400, /name/);
    await rejects(call('/api/garbage', 'name=%20%20'), 400);
    await rejects(call('/api/garbage', `name=${'长'.repeat(31)}`), 400);
  });

  test('字段说明（双向）', async () => {
    checkFields(route('/api/garbage'), [
      await call('/api/garbage', 'name=纽扣电池'),
      await call('/api/garbage', 'name=电池'),
      await call('/api/garbage', 'name=西瓜皮'),
    ]);
  });
});

// ================= 成语 =================

describe('成语词典', () => {
  test('查询、随机与 404 候选', async () => {
    const d = await call('/api/idiom', 'word=画龙点睛');
    assert.deepEqual(
      { word: d.word, pinyin: d.pinyin, random: d.random },
      { word: '画龙点睛', pinyin: 'huà lóng diǎn jīng', random: false },
    );
    assert.match(d.source, /历代名画记/);
    assert.ok(d.example.includes('画龙点睛'));
    assert.equal(IDIOM_ITEMS[d.id - 1].word, '画龙点睛');
    assert.equal((await call('/api/idiom', 'word=%20画龙点睛%20')).word, '画龙点睛');

    const r = await call('/api/idiom');
    assert.equal(r.random, true);
    assert.ok(IDIOMS.some((x) => x[0] === r.word));
    assert.equal(lookupIdiom(null, () => 0).word, IDIOMS[0][0]);
    assert.equal((await call('/api/idiom', 'word=')).random, true);

    await assert.rejects(call('/api/idiom', 'word=画龙'), (err) => {
      assert.equal(err.status, 404);
      assert.equal(err.candidates[0], '画龙点睛');
      assert.match(err.message, /相近的成语：画龙点睛/);
      return true;
    });
    await assert.rejects(call('/api/idiom', 'word=abc'), (err) => err.status === 404 && err.candidates.length === 0);
    await rejects(call('/api/idiom', `word=${'一'.repeat(21)}`), 400);
  });

  test('成语接龙：同字接龙 + 同音备选', async () => {
    const d = await call('/api/idiom/chain', 'word=一鸣惊人');
    assert.equal(d.tail, '人');
    assert.equal(d.known, true);
    assert.equal(d.tailPinyin, 'rén');
    assert.ok(d.count > 0 && d.count === d.items.length);
    assert.ok(d.items.every((x) => x.word[0] === '人'));
    assert.ok(d.items.some((x) => x.word === '人山人海'));
    assert.ok(d.homophones.length > 0);
    assert.ok(d.homophones.every((x) => x.word[0] !== '人' && toneless(x.pinyin.split(' ')[0]) === 'ren'));

    // 不在词库里的成语也能接（只看尾字），但没有读音和同音备选
    const u = await call('/api/idiom/chain', 'word=天下无双');
    assert.deepEqual([u.known, u.tail, u.tailPinyin, u.homophones], [false, '双', null, []]);
    assert.ok(u.items.every((x) => x.word[0] === '双'));
    // 接不上时 count 为 0
    const none = idiomChain('一去不回');
    assert.equal(none.count, 0);
    assert.deepEqual(none.items, []);
    // 不把自己接回来：人山人海 → 海 ……
    const self = idiomChain('海阔天空');
    assert.ok(!self.items.some((x) => x.word === '海阔天空'));

    assert.equal(toneless('lǘ'), 'lv');
    assert.equal(toneless('lù'), 'lu');
    await rejects(call('/api/idiom/chain'), 400, /word/);
    await rejects(call('/api/idiom/chain', 'word=abc'), 400, /汉字/);
    await rejects(call('/api/idiom/chain', 'word=一'), 400);
  });

  test('字段说明（双向）', async () => {
    checkFields(route('/api/idiom'), [
      await call('/api/idiom', 'word=画龙点睛'),
      await call('/api/idiom', 'word=山清水秀'), // 出处为 null
      await call('/api/idiom'),
    ]);
    checkFields(route('/api/idiom/chain'), [
      await call('/api/idiom/chain', 'word=一鸣惊人'),
      await call('/api/idiom/chain', 'word=天下无双'),
    ]);
  });
});

// ================= 歇后语 / 脑筋急转弯 / 冷知识 / 彩虹屁 / 笑话 =================

describe('随机文本类接口', () => {
  test('count 参数：1~10，互不重复，越界 400', async () => {
    for (const path of ['/api/xiehouyu', '/api/brain-teaser', '/api/cold-fact', '/api/compliment', '/api/joke']) {
      const one = await call(path);
      assert.equal(one.count, 1, path);
      assert.equal(one.items.length, 1, path);
      const ten = await call(path, 'count=10');
      assert.equal(ten.items.length, 10, path);
      assert.equal(new Set(ten.items.map((x) => x.id)).size, 10, `${path} 返回了重复条目`);
      for (const bad of ['0', '11', 'abc', '1.5', '-1']) await rejects(call(path, `count=${bad}`), 400, /count/);
    }
    assert.throws(() => pickItems([1, 2], 0), { status: 400 });
    assert.deepEqual(pickItems([{ a: 1 }, { a: 2 }], 5, seq(2)).length, 2);
  });

  test('歇后语：谜面 / 谜底与关键字搜索', async () => {
    const d = await call('/api/xiehouyu', 'keyword=猪八戒&count=10');
    assert.equal(d.keyword, '猪八戒');
    assert.ok(d.matched >= 3 && d.count === Math.min(10, d.matched));
    assert.ok(d.items.every((x) => x.riddle.includes('猪八戒') || x.answer.includes('猪八戒')));
    assert.ok(d.items.every((x) => x.text === `${x.riddle}——${x.answer}`));
    // 也能搜谜底
    const byAnswer = await call('/api/xiehouyu', 'keyword=一场空');
    assert.equal(byAnswer.items[0].riddle, '竹篮打水');
    // 搜不到返回空列表
    const none = await call('/api/xiehouyu', 'keyword=不存在的关键字');
    assert.deepEqual([none.matched, none.count, none.items], [0, 0, []]);
    const all = await call('/api/xiehouyu');
    assert.equal(all.keyword, null);
    assert.equal(all.matched, XIEHOUYU.length);
    assert.deepEqual(pickXiehouyu({ count: 1, rand: () => 0 }).items[0], {
      id: 1, riddle: XIEHOUYU[0][0], answer: XIEHOUYU[0][1], text: `${XIEHOUYU[0][0]}——${XIEHOUYU[0][1]}`,
    });
    await rejects(call('/api/xiehouyu', `keyword=${'字'.repeat(21)}`), 400);
  });

  test('脑筋急转弯：hide=1 隐藏答案，再按 id 查答案', async () => {
    const hidden = await call('/api/brain-teaser', 'hide=1&count=5');
    assert.equal(hidden.hidden, true);
    assert.equal(hidden.total, BRAIN_TEASERS.length);
    for (const x of hidden.items) {
      assert.deepEqual(Object.keys(x), ['id', 'question']);
      const a = await call('/api/brain-teaser/answer', `id=${x.id}`);
      assert.equal(a.question, x.question);
      assert.equal(a.answer, BRAIN_TEASERS[x.id - 1][1]);
    }
    const shown = await call('/api/brain-teaser', 'hide=0');
    assert.equal(shown.hidden, false);
    assert.ok(shown.items[0].answer);
    assert.deepEqual(teaserAnswer(1), { id: 1, question: BRAIN_TEASERS[0][0], answer: BRAIN_TEASERS[0][1] });
    assert.equal(pickTeasers({ rand: () => 0 }).items[0].id, 1);
    await rejects(call('/api/brain-teaser/answer', `id=${BRAIN_TEASERS.length + 1}`), 404, /没有编号/);
    await rejects(call('/api/brain-teaser/answer'), 400, /id/);
    await rejects(call('/api/brain-teaser/answer', 'id=abc'), 400);
    await rejects(call('/api/brain-teaser/answer', 'id=0'), 400);
    await rejects(call('/api/brain-teaser', 'hide=yes'), 400, /hide/);
  });

  test('冷知识：按分类筛选', async () => {
    const d = await call('/api/cold-fact', 'tag=宇宙&count=10');
    assert.equal(d.tag, '宇宙');
    assert.equal(d.total, COLD_FACTS.filter((x) => x[1] === '宇宙').length);
    assert.ok(d.items.every((x) => x.tag === '宇宙'));
    const all = await call('/api/cold-fact');
    assert.deepEqual([all.tag, all.total], [null, COLD_FACTS.length]);
    await rejects(call('/api/cold-fact', 'tag=八卦'), 400, /tag/);
  });

  test('字段说明（双向）', async () => {
    checkFields(route('/api/xiehouyu'), [await call('/api/xiehouyu', 'count=3'), await call('/api/xiehouyu', 'keyword=没有这个')]);
    checkFields(route('/api/brain-teaser'), [await call('/api/brain-teaser', 'count=3'), await call('/api/brain-teaser', 'hide=1')]);
    checkFields(route('/api/brain-teaser/answer'), [await call('/api/brain-teaser/answer', 'id=3')]);
    checkFields(route('/api/cold-fact'), [await call('/api/cold-fact', 'count=3'), await call('/api/cold-fact', 'tag=人体')]);
    checkFields(route('/api/compliment'), [await call('/api/compliment', 'count=3')]);
    checkFields(route('/api/joke'), [await call('/api/joke', 'count=3')]);
  });
});

// ================= Minecraft：协议编解码 =================

describe('Minecraft 协议编解码', () => {
  const CASES = [
    [0, [0x00]], [1, [0x01]], [2, [0x02]], [127, [0x7f]], [128, [0x80, 0x01]], [255, [0xff, 0x01]],
    [300, [0xac, 0x02]], [25565, [0xdd, 0xc7, 0x01]], [2097151, [0xff, 0xff, 0x7f]],
    [2147483647, [0xff, 0xff, 0xff, 0xff, 0x07]], [-1, [0xff, 0xff, 0xff, 0xff, 0x0f]],
    [-2147483648, [0x80, 0x80, 0x80, 0x80, 0x08]],
  ];

  test('VarInt 编解码（含负数、边界值）', () => {
    for (const [n, bytes] of CASES) {
      assert.deepEqual([...encodeVarInt(n)], bytes, `encode ${n}`);
      assert.deepEqual(decodeVarInt(Buffer.from(bytes)), { value: n, size: bytes.length }, `decode ${n}`);
      // 带偏移、后面还有别的数据
      assert.deepEqual(decodeVarInt(Buffer.from([0xaa, ...bytes, 0x55]), 1), { value: n, size: bytes.length });
    }
    assert.equal(decodeVarInt(Buffer.from([0x80])), null, '数据不完整返回 null');
    assert.equal(decodeVarInt(Buffer.alloc(0)), null);
    assert.throws(() => decodeVarInt(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x01])), McProtocolError);
    assert.throws(() => encodeVarInt(2 ** 31), RangeError);
    assert.throws(() => encodeVarInt(1.5), RangeError);
  });

  test('握手包、状态请求、Ping 包的结构', () => {
    const hs = buildHandshake('mc.example.com', 25565);
    const pkt = readPacket(hs);
    assert.equal(pkt.size, hs.length);
    assert.equal(pkt.id, 0x00);
    let off = 0;
    const proto = decodeVarInt(pkt.data, off); off += proto.size;
    assert.equal(proto.value, -1);
    const hlen = decodeVarInt(pkt.data, off); off += hlen.size;
    assert.equal(pkt.data.subarray(off, off + hlen.value).toString(), 'mc.example.com'); off += hlen.value;
    assert.equal(pkt.data.readUInt16BE(off), 25565); off += 2;
    assert.deepEqual(decodeVarInt(pkt.data, off), { value: 1, size: 1 });
    assert.equal(off + 1, pkt.data.length);

    assert.deepEqual([...buildStatusRequest()], [0x01, 0x00]);
    const payload = Buffer.from('12345678');
    assert.deepEqual([...buildPing(payload)], [0x09, 0x01, ...payload]);

    // 不完整的包返回 null，长度越界抛错
    assert.equal(readPacket(hs.subarray(0, hs.length - 1)), null);
    assert.throws(() => readPacket(Buffer.from([0x00])), McProtocolError);
    assert.throws(() => readPacket(encodeVarInt(MAX_BYTES + 1)), /长度不合法/);

    const json = JSON.stringify({ description: '你好' });
    const body = Buffer.from(json);
    assert.deepEqual(parseStatusPacket(Buffer.concat([encodeVarInt(body.length), body])), { description: '你好' });
    assert.throws(() => parseStatusPacket(Buffer.concat([encodeVarInt(body.length + 5), body])), /不完整/);
    assert.throws(() => parseStatusPacket(Buffer.concat([encodeVarInt(3), Buffer.from('{x}')])), /JSON/);
  });

  test('MOTD：§ 颜色代码与 JSON 聊天组件都转成纯文本，保留原始内容', () => {
    assert.equal(stripFormatting('§aHello §l§cWorld§r!'), 'Hello World!');
    assert.equal(stripFormatting('§x§f§f§0§0§0§0红色'), '红色'); // 1.16+ 十六进制颜色
    assert.equal(stripFormatting('结尾§'), '结尾');

    const legacy = parseMotd('  §6§l喵喵服务器§r  \n §7欢迎回来 ');
    assert.deepEqual(legacy, { text: '喵喵服务器\n欢迎回来', raw: '  §6§l喵喵服务器§r  \n §7欢迎回来 ' });

    const component = {
      text: '', extra: [
        { text: 'Hypixel ', color: 'green', bold: true },
        { text: 'Network', color: 'red', extra: [{ text: ' [1.8-1.21]', color: 'gray' }] },
        '\n',
        { text: '§e新地图上线！' },
      ],
    };
    const m = parseMotd(component);
    assert.equal(m.text, 'Hypixel Network [1.8-1.21]\n新地图上线！');
    assert.deepEqual(JSON.parse(m.raw), component);

    assert.equal(chatToText(['A', { text: 'B' }, [{ text: 'C' }]]), 'ABC');
    assert.equal(chatToText({ translate: 'multiplayer.status.unknown', fallback: '未知' }), '未知');
    assert.equal(chatToText({ translate: 'k', with: ['x', { text: 'y' }] }), 'k x y');
    assert.equal(chatToText({ text: 42 }), '42');
    assert.equal(chatToText(null), '');
    // 恶意的深层嵌套不会爆栈
    let deep = { text: 'x' };
    for (let i = 0; i < 10000; i++) deep = { text: '', extra: [deep] };
    assert.equal(chatToText(deep), '');
  });

  test('状态信息规范化', () => {
    const s = normalizeStatus({
      version: { name: '§cPaper 1.21.4', protocol: 769 },
      players: { online: 3, max: 20, sample: [{ name: '§aSteve', id: '069a79f4-44e9-4726-a5be-fca90e38aaf5' }, { name: 'Alex' }, null] },
      description: '服务器',
      favicon: 'data:image/png;base64,iVBORw0KGgo=',
    });
    assert.deepEqual(s.version, { name: 'Paper 1.21.4', protocol: 769 });
    assert.deepEqual(s.players, {
      online: 3, max: 20, sample: [{ name: 'Steve', id: '069a79f4-44e9-4726-a5be-fca90e38aaf5' }, { name: 'Alex', id: null }],
    });
    assert.equal(s.favicon, 'data:image/png;base64,iVBORw0KGgo=');
    const bare = normalizeStatus({});
    assert.deepEqual(bare.players, { online: 0, max: 0, sample: [] });
    assert.deepEqual(bare.version, { name: '', protocol: null });
    assert.equal(normalizeStatus({ favicon: 'javascript:alert(1)' }).favicon, null);
    assert.throws(() => normalizeStatus(null), McProtocolError);
    assert.throws(() => normalizeStatus([1]), McProtocolError);
  });

  test('host:port 拆分', () => {
    assert.deepEqual(splitHostPort('mc.example.com'), { host: 'mc.example.com', port: null });
    assert.deepEqual(splitHostPort('mc.example.com:25566'), { host: 'mc.example.com', port: 25566 });
    assert.deepEqual(splitHostPort('[2001:db8::1]:25565'), { host: '2001:db8::1', port: 25565 });
    assert.deepEqual(splitHostPort('2001:db8::1'), { host: '2001:db8::1', port: null });
  });
});

// ================= Minecraft：假服务器 =================

// 注入的 blocked 只放行 127.0.0.1，10.x、::1、192.168.x 等仍按默认规则拦截
const allowLoopback = (ip) => ip !== '127.0.0.1' && isBlockedIP(ip);

const HOSTS = {
  'mc.test.example': ['127.0.0.1'],
  'srv.test.example': ['127.0.0.1'],
  'internal.test.example': ['10.0.0.5'],
  'mixed.test.example': ['93.184.216.34', '10.0.0.6'],
};
function fakeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const list = net.isIP(hostname) ? [hostname] : HOSTS[hostname];
  if (!list) return process.nextTick(callback, Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
  const addrs = list.map((address) => ({ address, family: net.isIP(address) }));
  return process.nextTick(() => (options.all ? callback(null, addrs) : callback(null, addrs[0].address, addrs[0].family)));
}

const FAVICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const STATUS = {
  version: { name: 'Paper 1.21.4', protocol: 769 },
  players: { online: 2, max: 100, sample: [{ name: '§bSteve', id: '069a79f4-44e9-4726-a5be-fca90e38aaf5' }, { name: 'Alex' }] },
  description: { text: '', extra: [{ text: '喵喵', color: 'gold' }, { text: '服务器', color: 'aqua', bold: true }, '\n', '§7欢迎'] },
  favicon: FAVICON,
};
const statusPacket = (obj) => {
  const json = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
  return encodePacket(0x00, encodeVarInt(json.length), json);
};

describe('Minecraft 服务器状态（本地假服务器）', () => {
  let server;
  let PORT;
  let CLOSED;
  let mode = 'normal';
  const conns = { count: 0 };
  const handshakes = [];
  const sockets = new Set();
  const srvCalls = [];

  // 按 mode 模拟各种服务器行为
  function onConnection(socket) {
    conns.count++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buf = Buffer.alloc(0);
    let stage = 'handshake';
    const m = mode;
    if (m === 'http') {
      socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const pkt = readPacket(buf);
        if (!pkt) return;
        buf = buf.subarray(pkt.size);
        if (stage === 'handshake') {
          let off = 0;
          const proto = decodeVarInt(pkt.data, off); off += proto.size;
          const hl = decodeVarInt(pkt.data, off); off += hl.size;
          const host = pkt.data.subarray(off, off + hl.value).toString(); off += hl.value;
          const port = pkt.data.readUInt16BE(off); off += 2;
          const next = decodeVarInt(pkt.data, off).value;
          handshakes.push({ id: pkt.id, protocol: proto.value, host, port, next });
          stage = 'status';
        } else if (stage === 'status') {
          assert.equal(pkt.id, 0x00);
          stage = 'ping';
          if (m === 'silent') continue;
          if (m === 'huge') {
            // 声明的包长刚好等于上限，加上包头就超过 64KB 读取上限
            socket.write(encodeVarInt(MAX_BYTES));
            for (let i = 0; i < 20; i++) socket.write(Buffer.alloc(8192, 0x61));
            continue;
          }
          if (m === 'badlen') { socket.write(encodeVarInt(MAX_BYTES * 4)); continue; }
          if (m === 'wrong-id') { socket.write(encodePacket(0x05, Buffer.from('x'))); continue; }
          if (m === 'bad-json') { socket.write(statusPacket('{not json')); continue; }
          if (m === 'legacy') {
            socket.end(statusPacket({ version: { name: '1.8.9', protocol: 47 }, players: { online: 0, max: 20 }, description: '§a§l老服务器§r\n§7欢迎' }));
            continue;
          }
          const bytes = statusPacket(STATUS);
          if (m === 'split') {
            // 一个字节一个字节地发，测试分片拼包
            let i = 0;
            const tick = () => { if (i < bytes.length && !socket.destroyed) { socket.write(bytes.subarray(i, i + 1)); i++; setImmediate(tick); } };
            tick();
          } else {
            socket.write(bytes);
          }
        } else if (stage === 'ping') {
          assert.equal(pkt.id, 0x01);
          assert.equal(pkt.data.length, 8);
          if (m === 'no-pong') continue;
          socket.write(encodePacket(0x01, pkt.data));
        }
      }
    });
  }

  const fakeResolveSrv = async (name) => {
    srvCalls.push(name);
    const table = {
      '_minecraft._tcp.srv.test.example': [
        { name: 'nowhere.test.example', port: 1, priority: 20, weight: 100 },
        { name: 'mc.test.example', port: PORT, priority: 5, weight: 10 },
      ],
      '_minecraft._tcp.srv-internal.test.example': [{ name: 'internal.test.example', port: 25565, priority: 0, weight: 0 }],
      '_minecraft._tcp.srv-ip.test.example': [{ name: '10.1.2.3', port: 25565, priority: 0, weight: 0 }],
      '_minecraft._tcp.srv-loopback.test.example': [{ name: '127.0.0.1', port: PORT, priority: 0, weight: 0 }],
      '_minecraft._tcp.srv-localhost.test.example': [{ name: 'localhost.', port: 25565, priority: 0, weight: 0 }],
      '_minecraft._tcp.srv-mixed.test.example': [{ name: 'mixed.test.example', port: 25565, priority: 0, weight: 0 }],
      '_minecraft._tcp.srv-lowport.test.example': [{ name: 'mc.test.example', port: 80, priority: 0, weight: 0 }],
      '_minecraft._tcp.srv-dot.test.example': [{ name: '.', port: 0, priority: 0, weight: 0 }],
    };
    if (table[name]) return table[name];
    throw Object.assign(new Error(`querySrv ENODATA ${name}`), { code: 'ENODATA' });
  };

  const opts = (extra = {}) => ({ blocked: allowLoopback, resolveSrv: fakeResolveSrv, ...extra });

  before(async () => {
    mock.method(dns, 'lookup', fakeLookup);
    server = net.createServer(onConnection);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    PORT = server.address().port;
    const tmp = net.createServer();
    await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
    CLOSED = tmp.address().port;
    await new Promise((r) => tmp.close(r));
    assert.ok(PORT >= 1024 && CLOSED >= 1024);
  });

  after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
    mock.restoreAll();
  });

  const results = {};

  test('在线：版本、人数、玩家样例、MOTD、图标、延迟', async () => {
    mode = 'normal';
    handshakes.length = 0;
    const d = await mcStatus('127.0.0.1', opts({ port: PORT }));
    results.online = d;
    assert.equal(d.online, true);
    assert.equal(d.error, null);
    assert.deepEqual([d.host, d.ip, d.port, d.srv], ['127.0.0.1', '127.0.0.1', PORT, null]);
    assert.deepEqual(d.version, { name: 'Paper 1.21.4', protocol: 769 });
    assert.deepEqual(d.players, {
      online: 2, max: 100, sample: [{ name: 'Steve', id: '069a79f4-44e9-4726-a5be-fca90e38aaf5' }, { name: 'Alex', id: null }],
    });
    assert.equal(d.motd.text, '喵喵服务器\n欢迎');
    assert.deepEqual(JSON.parse(d.motd.raw), STATUS.description);
    assert.equal(d.favicon, FAVICON);
    assert.equal(typeof d.latency, 'number');
    assert.ok(d.latency >= 0 && d.latency < 5000);
    // 握手包内容
    assert.deepEqual(handshakes.at(-1), { id: 0, protocol: -1, host: '127.0.0.1', port: PORT, next: 1 });

    // host:port 写法
    const inline = await mcStatus(`127.0.0.1:${PORT}`, opts());
    assert.equal(inline.online, true);
    assert.equal(inline.port, PORT);
    // 域名（假 DNS 解析到 127.0.0.1），握手包里写的是用户查询的域名
    const byName = await mcStatus('mc.test.example', opts({ port: PORT }));
    assert.deepEqual([byName.online, byName.host, byName.ip], [true, 'mc.test.example', '127.0.0.1']);
    assert.equal(handshakes.at(-1).host, 'mc.test.example');
  });

  test('分片到达的响应能正确拼包', async () => {
    mode = 'split';
    const d = await mcStatus('127.0.0.1', opts({ port: PORT }));
    assert.equal(d.online, true);
    assert.equal(d.motd.text, '喵喵服务器\n欢迎');
  });

  test('服务器返回状态后直接断开（不回 Pong）：在线，延迟为 null', async () => {
    mode = 'legacy';
    const d = await mcStatus('127.0.0.1', opts({ port: PORT }));
    results.legacy = d;
    assert.equal(d.online, true);
    assert.equal(d.latency, null);
    assert.deepEqual(d.motd, { text: '老服务器\n欢迎', raw: '§a§l老服务器§r\n§7欢迎' });
    assert.deepEqual(d.players, { online: 0, max: 20, sample: [] });
    assert.equal(d.favicon, null);

    mode = 'no-pong';
    const t0 = Date.now();
    const n = await mcStatus('127.0.0.1', opts({ port: PORT, timeoutMs: 400 }));
    assert.equal(n.online, true);
    assert.equal(n.latency, null);
    assert.ok(Date.now() - t0 < 2000);
  });

  test('SRV 记录：取优先级最高的一条，按 SRV 指向的主机和端口连接', async () => {
    mode = 'normal';
    srvCalls.length = 0;
    const d = await mcStatus('srv.test.example', opts());
    results.srv = d;
    assert.deepEqual(srvCalls, ['_minecraft._tcp.srv.test.example']);
    assert.equal(d.online, true);
    assert.deepEqual(d.srv, { target: 'mc.test.example', port: PORT });
    assert.deepEqual([d.host, d.port, d.ip], ['srv.test.example', PORT, '127.0.0.1']);
    assert.equal(handshakes.at(-1).host, 'srv.test.example');

    // 显式指定端口时不查 SRV
    srvCalls.length = 0;
    const direct = await mcStatus('srv.test.example', opts({ port: PORT }));
    assert.deepEqual(srvCalls, []);
    assert.equal(direct.srv, null);
    // IP 不查 SRV
    await mcStatus('127.0.0.1', opts({ port: PORT }));
    assert.deepEqual(srvCalls, []);

    assert.equal(await lookupSrv('none.test.example', { resolveSrv: fakeResolveSrv }), null, '没有 SRV 记录');
    assert.equal(await lookupSrv('srv-dot.test.example', { resolveSrv: fakeResolveSrv }), null, 'SRV 目标为 "." 视为没有');
    assert.equal(await lookupSrv('x.test.example', { resolveSrv: () => new Promise(() => {}), timeoutMs: 50 }), null, 'SRV 查询超时');
  });

  test('连不上、超时、不是 MC 服务器：返回 online: false 和原因（不是 502）', async () => {
    const closed = await mcStatus('127.0.0.1', opts({ port: CLOSED }));
    results.closed = closed;
    assert.equal(closed.online, false);
    assert.match(closed.error, /连接被拒绝/);
    assert.deepEqual([closed.version, closed.players, closed.motd, closed.favicon, closed.latency], [null, null, null, null, null]);
    assert.equal(closed.ip, '127.0.0.1');

    const cases = [
      ['silent', /超时/],
      ['http', /不是 Minecraft|关闭/],
      ['huge', /64KB/],
      ['badlen', /长度不合法/],
      ['wrong-id', /没有返回状态信息/],
      ['bad-json', /JSON/],
    ];
    for (const [m, re] of cases) {
      mode = m;
      const d = await mcStatus('127.0.0.1', opts({ port: PORT, timeoutMs: 400 }));
      assert.equal(d.online, false, m);
      assert.match(d.error, re, `${m}: ${d.error}`);
    }

    // 域名解析失败：ip 为 null
    const nx = await mcStatus('nx.test.example', opts({ port: PORT }));
    results.nx = nx;
    assert.deepEqual([nx.online, nx.ip], [false, null]);
    assert.match(nx.error, /无法解析/);
  });

  test('SSRF：内网、回环、localhost 以及 SRV 指向内网都在连接前被拒绝', async () => {
    mode = 'normal';
    const before = conns.count;
    const r = route('/api/mc/server');
    // 默认规则（不注入 blocked）：127.0.0.1 也要拒绝
    for (const host of ['127.0.0.1', '10.0.0.1', '10.255.1.2', '192.168.1.1', '172.16.0.1', '169.254.169.254', 'localhost', 'LOCALHOST', 'a.localhost', '[::1]', '0.0.0.0', '127.1']) {
      await rejects(r.handler({ query: new URLSearchParams({ host, port: String(PORT) }) }), 400, /内网|保留/);
      await rejects(mcStatus(host, { port: PORT, resolveSrv: fakeResolveSrv }), 400, /内网|保留/);
    }
    await rejects(r.handler({ query: new URLSearchParams({ host: `127.0.0.1:${PORT}` }) }), 400, /内网|保留/);
    // 域名解析到内网（含“部分解析到内网”）
    for (const host of ['internal.test.example', 'mixed.test.example']) {
      await rejects(r.handler({ query: new URLSearchParams({ host, port: String(PORT) }) }), 400, /内网|保留/);
    }
    // SRV 指向内网 IP、解析到内网的域名、localhost；注入的 blocked 放行了 127.0.0.1 也照样拦住 10.x
    for (const host of ['srv-internal.test.example', 'srv-ip.test.example', 'srv-localhost.test.example', 'srv-mixed.test.example']) {
      await rejects(mcStatus(host, opts()), 400, new RegExp(BLOCKED_MSG), host);
    }
    // 默认规则下 SRV 指向回环地址也被拒绝
    await rejects(mcStatus('srv-loopback.test.example', { resolveSrv: fakeResolveSrv }), 400, /内网|保留/);
    assert.equal(conns.count, before, '被拒绝的目标没有建立任何连接');
  });

  test('端口只允许 1024~65535（含 SRV 指向的端口）', async () => {
    const before = conns.count;
    const r = route('/api/mc/server');
    for (const port of ['80', '1023', '0', '65536', 'abc']) {
      await rejects(r.handler({ query: new URLSearchParams({ host: 'mc.test.example', port }) }), 400, /port/);
    }
    await rejects(r.handler({ query: new URLSearchParams({ host: 'mc.test.example:22' }) }), 400, /port/);
    await rejects(mcStatus('srv-lowport.test.example', opts()), 400, /SRV 记录指向的端口/);
    await rejects(r.handler({ query: new URLSearchParams() }), 400, /host/);
    await rejects(r.handler({ query: new URLSearchParams({ host: 'not a host!' }) }), 400);
    assert.equal(conns.count, before);
  });

  test('路由 handler：域名解析失败时照常返回 200 和 online: false', async () => {
    const d = await call('/api/mc/server', `host=nx.test.example&port=${PORT}`);
    assert.equal(d.online, false);
    assert.equal(d.port, PORT);
  });

  test('字段说明（双向）', () => {
    checkFields(route('/api/mc/server'), [results.online, results.legacy, results.srv, results.closed, results.nx]);
  });
});

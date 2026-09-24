// 娱乐类本地内容接口：答案之书、今日运势、灵签、号码吉凶、语录、温馨提示、随机头像。
// 这些接口全部本地计算，不访问外网（温馨提示读取的节假日数据在测试里一律 mock）。
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import registered from '../../src/apis/fun/index.js';
import lingqianModule from '../../src/apis/fun/lingqian.js';
import { cache } from '../../src/lib/cache.js';
import { assertFieldsDocumented, collectPaths, matcher } from '../helpers/fields.js';
import { fallbackYear, holidayInfoFrom } from '../../src/apis/life/holiday.js';
import { ANSWERS } from '../../src/apis/fun/data/answers.js';
import { drawAnswer, normalizeQuestion } from '../../src/apis/fun/answer.js';
import {
  FORTUNE_LEVELS, FORTUNE_SIGNS, FORTUNE_ASPECTS, ASPECT_COMMENTS, LUCKY_COLORS, FORTUNE_YI, FORTUNE_JI,
} from '../../src/apis/fun/data/fortune.js';
import { buildFortune, levelOf } from '../../src/apis/fun/fortune.js';
import { GUANYIN, WENCHANG, LINGQIAN_SETS } from '../../src/apis/fun/data/lingqian.js';
import { drawLingqian, availableItems } from '../../src/apis/fun/lingqian.js';
import { NUMEROLOGY } from '../../src/apis/fun/data/numerology.js';
import { shuliOf, numerologyOf } from '../../src/apis/fun/numerology.js';
import { QUOTE_TYPES } from '../../src/apis/fun/data/quotes.js';
import { pickQuotes } from '../../src/apis/fun/quotes.js';
import { GREETING_PERIODS } from '../../src/apis/fun/data/greeting.js';
import { periodOf, buildGreeting, loadGreeting } from '../../src/apis/fun/greeting.js';
import { renderAvatar, initialOf, escapeXml, parseHexColor, hslToHex } from '../../src/apis/fun/avatar.js';

const LOCAL_PATHS = [
  '/api/answer', '/api/fortune', '/api/lingqian', '/api/numerology',
  '/api/quotes', '/api/quotes/types', '/api/greeting', '/api/avatar',
];
const LOCAL_MODULES = ['answer', 'fortune', 'lingqian', 'numerology', 'quotes', 'greeting', 'avatar'];
// 灵签暂未注册上线（签文待校订），但代码照常测试
const funModules = [...registered, lingqianModule];

test('灵签在签文校订前不对外注册', () => {
  assert.ok(!registered.some((m) => m.name === 'lingqian'));
});

// 默认断网：任何意外的外网请求都会失败
const offline = async (url) => { throw new TypeError(`offline: ${url}`); };
globalThis.fetch = offline;
afterEach(() => { globalThis.fetch = offline; });

function route(path) {
  for (const m of funModules) for (const r of m.routes) if (r.path === path) return r;
  throw new Error(`no route ${path}`);
}
const call = (path, qs = '', ip = '127.0.0.1') => route(path).handler({ query: new URLSearchParams(qs), params: {}, body: null, ip, user: null, req: null });
const bj = (s) => Date.parse(`${s}+08:00`); // 北京时间 → 时间戳
const seq = (n) => { let i = 0; return () => (i++ % n) / n; }; // 可预测的“随机数”

// ---- 与 fun.test.js 相同的双向字段校验 ----
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

// 每个样例：字段都有说明，且实际类型在说明的 type 之内；
// 所有样例合起来：说明里的每个字段都至少出现一次（避免写了不存在的字段）
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

// ---- 元数据 ----

test('新模块元数据：分类、标题、来源、参数说明、路由不重复', () => {
  const mods = funModules.filter((m) => LOCAL_MODULES.includes(m.name));
  assert.deepEqual(mods.map((m) => m.name).sort(), [...LOCAL_MODULES].sort());
  const paths = funModules.flatMap((m) => m.routes.map((r) => r.path));
  assert.equal(new Set(paths).size, paths.length, '路由路径重复');
  for (const m of mods) {
    assert.equal(m.category, 'fun');
    assert.ok(m.title && m.description && m.source, m.name);
    assert.ok(!m.env?.length, `${m.name} 是本地接口，不应依赖环境变量`);
    for (const r of m.routes) {
      assert.ok(LOCAL_PATHS.includes(r.path), r.path);
      assert.equal(r.method, 'GET');
      assert.ok(r.summary && Array.isArray(r.params), r.path);
      for (const p of r.params) assert.ok(p.name && p.desc, `${r.path} ${p.name}`);
      if (r.raw) assert.ok(r.returns?.length > 50, `${r.path} 缺少 returns`);
      else assert.ok(r.fields.length && r.fields.every((f) => f.desc.trim()), `${r.path} 缺少 fields`);
    }
  }
  for (const name of ['fortune', 'numerology']) {
    assert.match(funModules.find((m) => m.name === name).description, /仅供娱乐/, name);
  }
  assert.match(funModules.find((m) => m.name === 'numerology').description, /后四位除以 80.*小数部分乘 80.*四舍五入.*为 0 时按 80 计/);
});

test('非温馨提示的本地接口不访问网络', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new TypeError('offline'); };
  await call('/api/answer', 'question=hi');
  await call('/api/fortune', 'name=a');
  await call('/api/lingqian');
  await call('/api/numerology', 'number=13800138000');
  await call('/api/quotes', 'count=10');
  await call('/api/quotes/types');
  await call('/api/avatar', 'seed=a&style=pixel');
  assert.equal(calls, 0);
});

// ---- 答案之书 ----

test('答案之书：数据完整、同一问题同一天答案固定', async () => {
  assert.ok(ANSWERS.length >= 150, `答案只有 ${ANSWERS.length} 条`);
  assert.equal(new Set(ANSWERS).size, ANSWERS.length, '答案有重复');
  assert.ok(ANSWERS.every((a) => typeof a === 'string' && a.trim() === a && a.length >= 2));

  const a = drawAnswer({ question: '我该换工作吗？', date: '2026-09-24' });
  assert.deepEqual(drawAnswer({ question: '我该换工作吗？', date: '2026-09-24' }), a);
  assert.equal(drawAnswer({ question: '  我该换工作吗?? ', date: '2026-09-24' }).answer, a.answer);
  assert.equal(a.fixed, true);
  assert.equal(ANSWERS[a.no - 1], a.answer);
  assert.equal(normalizeQuestion(' Hello   World?! '), 'hello world');

  // 不同问题、不同日期会得到不同答案
  const byQuestion = new Set(Array.from({ length: 30 }, (_, i) => drawAnswer({ question: `问题${i}`, date: '2026-09-24' }).answer));
  assert.ok(byQuestion.size >= 15, `30 个问题只得到 ${byQuestion.size} 种答案`);
  const byDate = new Set(Array.from({ length: 10 }, (_, i) => drawAnswer({ question: '同一个问题', date: `2026-10-${String(i + 10)}` }).answer));
  assert.ok(byDate.size > 1);

  const r1 = (await call('/api/answer', 'question=今天适合表白吗')).data;
  const r2 = (await call('/api/answer', 'question=今天适合表白吗')).data;
  assert.deepEqual(r1, r2);
  assert.equal(r1.question, '今天适合表白吗');
  const free = (await call('/api/answer')).data;
  assert.equal(free.fixed, false);
  assert.equal(free.question, null);
  assert.ok(ANSWERS.includes(free.answer));
});

test('答案之书：参数校验与字段说明', async () => {
  await assert.rejects(call('/api/answer', `question=${'问'.repeat(201)}`), { status: 400 });
  await assert.rejects(call('/api/answer', 'question=？？！'), { status: 400 });
  const r = route('/api/answer');
  checkFields(r, [(await call('/api/answer', 'question=要不要去旅行')).data, (await call('/api/answer')).data]);
});

// ---- 今日运势 ----

test('今日运势：同名同日固定，不同名字/日期/IP 不同', async () => {
  const a = buildFortune('name:小明', '2026-09-24', { name: '小明' });
  assert.deepEqual(buildFortune('name:小明', '2026-09-24', { name: '小明' }), a);
  assert.notDeepEqual(buildFortune('name:小明', '2026-09-25', { name: '小明' }), a);
  const names = new Set(Array.from({ length: 20 }, (_, i) => JSON.stringify(buildFortune(`name:用户${i}`, '2026-09-24'))));
  assert.equal(names.size, 20);

  const h1 = (await call('/api/fortune', 'name=小明')).data;
  const h2 = (await call('/api/fortune', 'name=%20%E5%B0%8F%E6%98%8E%20')).data; // " 小明 "
  assert.deepEqual(h1, h2);
  assert.equal(h1.name, '小明');
  assert.equal(h1.basis, 'name');
  const upper = (await call('/api/fortune', 'name=Tom')).data;
  const lower = (await call('/api/fortune', 'name=tom')).data;
  assert.equal(upper.score, lower.score);
  assert.deepEqual(upper.aspects, lower.aspects);

  const ip1 = (await call('/api/fortune', '', '10.0.0.1')).data;
  assert.deepEqual((await call('/api/fortune', '', '10.0.0.1')).data, ip1);
  assert.equal(ip1.basis, 'ip');
  assert.equal(ip1.name, null);
  const ips = new Set();
  for (let i = 0; i < 10; i++) ips.add(JSON.stringify((await call('/api/fortune', '', `10.0.0.${i}`)).data));
  assert.equal(ips.size, 10);
});

test('今日运势：结构、等级区间与分布', () => {
  const cases = [[100, '大吉'], [90, '大吉'], [89, '吉'], [75, '吉'], [74, '中吉'], [60, '中吉'], [59, '小吉'], [45, '小吉'], [44, '平'], [30, '平'], [29, '小凶'], [0, '小凶']];
  for (const [score, level] of cases) assert.equal(levelOf(score), level, String(score));

  const seenLevels = new Set();
  for (let i = 0; i < 3000; i++) {
    const f = buildFortune(`name:${i}`, '2026-09-24');
    assert.ok(Number.isInteger(f.score) && f.score >= 0 && f.score <= 100);
    assert.equal(f.level, levelOf(f.score));
    assert.ok(FORTUNE_SIGNS[f.level].includes(f.sign));
    assert.deepEqual(f.aspects.map((x) => x.name), ['事业', '财富', '感情', '健康', '学业']);
    for (const x of f.aspects) {
      assert.ok(Number.isInteger(x.stars) && x.stars >= 1 && x.stars <= 5);
      assert.ok(ASPECT_COMMENTS[x.key][x.stars - 1].includes(x.comment));
    }
    assert.ok(f.luckyNumber >= 1 && f.luckyNumber <= 9);
    assert.equal(new Set(f.yi).size, 3);
    assert.equal(new Set(f.ji).size, 3);
    assert.match(f.notice, /仅供娱乐/);
    seenLevels.add(f.level);
  }
  assert.deepEqual([...seenLevels].sort(), FORTUNE_LEVELS.map((l) => l.level).sort(), '六个等级都应该能出现');

  // 文案完整
  for (const { level } of FORTUNE_LEVELS) assert.ok(FORTUNE_SIGNS[level]?.length >= 3, level);
  for (const { key } of FORTUNE_ASPECTS) {
    assert.equal(ASPECT_COMMENTS[key].length, 5, key);
    assert.ok(ASPECT_COMMENTS[key].every((tier) => tier.length >= 2), key);
  }
  assert.ok(LUCKY_COLORS.every((c) => /^#[0-9A-F]{6}$/.test(c.hex) && c.name));
  assert.ok(!FORTUNE_YI.some((x) => FORTUNE_JI.includes(x)), '宜与忌不能有相同项');
});

test('今日运势：参数校验与字段说明', async () => {
  await assert.rejects(call('/api/fortune', `name=${'名'.repeat(21)}`), { status: 400 });
  await assert.rejects(call('/api/fortune', 'name=%20%20%20'), { status: 400 });
  checkFields(route('/api/fortune'), [(await call('/api/fortune', 'name=小红')).data, (await call('/api/fortune', '', '8.8.8.8')).data]);
});

// ---- 灵签 ----

test('灵签数据：观音灵签签号 1~100 连续完整，字段规范', () => {
  assert.equal(LINGQIAN_SETS.guanyin.total, 100);
  assert.equal(GUANYIN.length, 100);
  GUANYIN.forEach((x, i) => assert.equal(x.no, i + 1, `第 ${i + 1} 项签号错误`));
  // 每个已收录的种类都必须签号连续、与 total 一致
  for (const [type, set] of Object.entries(LINGQIAN_SETS)) {
    if (!set.items.length) continue;
    assert.equal(set.items.length, set.total, type);
    set.items.forEach((x, i) => assert.equal(x.no, i + 1, `${type} 第 ${i + 1} 项签号错误`));
  }
  for (const x of GUANYIN) {
    assert.equal(typeof x.verified, 'boolean', `第 ${x.no} 签缺少 verified`);
    if (x.poem) {
      assert.equal(x.poem.length, 4, `第 ${x.no} 签签诗应为 4 句`);
      for (const line of x.poem) assert.match(line, /^[一-鿿]{7}$/, `第 ${x.no} 签：${line}`);
      assert.ok(x.detail, `第 ${x.no} 签缺少白话解读`);
    } else {
      // 未收录原文的签：传统字段全部为空，且不能标记为已核对
      assert.deepEqual([x.level, x.title, x.explain, x.detail, x.verified], [null, null, null, null, false], `第 ${x.no} 签`);
    }
    if (x.verified) assert.ok(x.poem && x.title && x.level, `第 ${x.no} 签标记为已核对，但签诗/签题/吉凶不全`);
  }
  assert.ok(availableItems('guanyin').length >= 50);
  // 文昌帝君灵签原文尚未收录
  assert.deepEqual(WENCHANG, []);
});

test('灵签：按签号查询、随机抽签、未收录与参数校验', async () => {
  const one = (await call('/api/lingqian', 'no=1')).data;
  assert.equal(one.title, '钟离成道');
  assert.equal(one.level, '上上');
  assert.deepEqual(one.poem, ['开天辟地作良缘', '吉日良时万物全', '若得此签非小可', '人行忠正帝王宣']);
  assert.equal(one.random, false);
  assert.equal(one.verified, true);

  const unverified = (await call('/api/lingqian', 'type=guanyin&no=9')).data;
  assert.equal(unverified.verified, false);
  assert.equal(unverified.title, null);
  assert.match(unverified.notice, /尚未与底本逐字核对/);

  // 随机只从已收录原文的签里抽
  const drawn = new Set();
  for (let i = 0; i < 200; i++) {
    const d = (await call('/api/lingqian')).data;
    assert.equal(d.random, true);
    assert.ok(d.poem.length === 4);
    drawn.add(d.no);
  }
  assert.ok(drawn.size > 20);
  const pool = availableItems('guanyin');
  assert.equal(drawLingqian('guanyin', null, () => 0).no, pool[0].no);
  assert.equal(drawLingqian('guanyin', null, () => 0.9999).no, pool.at(-1).no);

  await assert.rejects(call('/api/lingqian', 'no=6'), { status: 404 }); // 原文未收录
  await assert.rejects(call('/api/lingqian', 'no=0'), { status: 400 });
  await assert.rejects(call('/api/lingqian', 'no=101'), { status: 400 });
  await assert.rejects(call('/api/lingqian', 'no=abc'), { status: 400 });
  await assert.rejects(call('/api/lingqian', 'no=1.5'), { status: 400 });
  await assert.rejects(call('/api/lingqian', 'type=guandi'), { status: 400 });
  await assert.rejects(call('/api/lingqian', 'type=wencheng'), { status: 503 });
  await assert.rejects(call('/api/lingqian', 'type=wencheng&no=1'), { status: 503 });

  const fieldDesc = route('/api/lingqian').fields.find((f) => f.name === 'verified').desc;
  assert.match(fieldDesc, /true/);
  assert.match(fieldDesc, /false/);
  checkFields(route('/api/lingqian'), [one, unverified, (await call('/api/lingqian')).data]);
});

// ---- 号码吉凶 ----

test('号码吉凶：81 数理表完整', () => {
  assert.deepEqual(Object.keys(NUMEROLOGY).map(Number), Array.from({ length: 81 }, (_, i) => i + 1));
  for (const [n, e] of Object.entries(NUMEROLOGY)) {
    assert.ok(['吉', '半吉', '凶'].includes(e.level), `${n} 吉凶不合法：${e.level}`);
    assert.match(e.sign, /^[一-鿿]{4}(，[一-鿿]{4})+$/, `${n} 签语格式`);
    assert.ok(e.detail.length >= 10, `${n} 缺少解释`);
  }
});

test('号码吉凶：算法与字面描述（÷80 取小数 ×80 四舍五入，0 按 80）逐一等价', () => {
  for (let n = 0; n <= 9999; n++) {
    const q = n / 80;
    let expected = Math.round((q - Math.floor(q)) * 80);
    if (expected === 0) expected = 80;
    assert.equal(shuliOf(String(n).padStart(4, '0')).value, expected, String(n));
  }
  assert.equal(shuliOf('1234').formula, '1234 ÷ 80 = 15.425，小数部分 0.425 × 80 = 34');
  assert.equal(shuliOf('8000').formula, '8000 ÷ 80 = 100，小数部分为 0，按 80 计');
  assert.equal(shuliOf('0081').value, 1);

  const p = numerologyOf('phone', '13912341234');
  assert.deepEqual([p.digits, p.value, p.level], ['1234', 34, NUMEROLOGY[34].level]);
  assert.equal(numerologyOf('phone', '13800138000').value, 80);
  assert.equal(numerologyOf('phone', '13800000080').digits, '0080');
  // QQ 号用同样规则；10000 是 80 的倍数，所以与整号计算一致
  assert.equal(numerologyOf('qq', '12345').value, 12345 % 80);
  assert.equal(numerologyOf('qq', '10001234').value, 34);
  assert.equal(numerologyOf('qq', '98765432101').value, 98765432101 % 80 || 80);
});

test('号码吉凶：严格校验号码格式', async () => {
  const bad = [
    'number=12345', 'number=23800138000', 'number=1380013800a', 'number=138001380001', 'number=1380013800',
    'number=%2B8613800138000', 'number=138%200013%208000', 'number=138-0013-8000', 'number=%EF%BC%91%EF%BC%93%EF%BC%98%EF%BC%90%EF%BC%90%EF%BC%91%EF%BC%93%EF%BC%98%EF%BC%90%EF%BC%90%EF%BC%90',
    'type=qq&number=1234', 'type=qq&number=012345', 'type=qq&number=123456789012', 'type=qq&number=12a45',
    'type=wechat&number=13800138000', 'number=',
  ];
  for (const qs of bad) await assert.rejects(call('/api/numerology', qs), { status: 400 }, qs);
  await assert.rejects(call('/api/numerology'), { status: 400 });
  const phone = (await call('/api/numerology', 'number=13800138000')).data;
  const qq = (await call('/api/numerology', 'type=qq&number=10001')).data;
  assert.equal(phone.typeName, '手机号');
  assert.equal(qq.typeName, 'QQ 号');
  assert.match(phone.notice, /仅供娱乐/);
  const valueDesc = route('/api/numerology').fields.find((f) => f.name === 'value').desc;
  assert.match(valueDesc, /后四位 ÷ 80.*小数部分 × 80.*四舍五入.*为 0 时按 80 计/);
  checkFields(route('/api/numerology'), [phone, qq, (await call('/api/numerology', 'number=13912341234')).data]);
});

// ---- 语录 ----

test('语录：分类齐全、每类不少于 40 条且不重复', () => {
  const required = ['毒鸡汤', '舔狗日记', '情话', 'KFC 疯狂星期四', '我在人间凑数的日子', '神回复', '人生建议', '励志', '温柔文案', '伤感'];
  const names = QUOTE_TYPES.map((t) => t.name);
  for (const n of required) assert.ok(names.includes(n), `缺少分类 ${n}`);
  assert.equal(new Set(QUOTE_TYPES.map((t) => t.id)).size, QUOTE_TYPES.length);
  const all = [];
  for (const t of QUOTE_TYPES) {
    assert.match(t.id, /^[a-z]+$/);
    assert.ok(t.desc, t.id);
    assert.ok(t.items.length >= 40, `${t.name} 只有 ${t.items.length} 条`);
    assert.equal(new Set(t.items).size, t.items.length, `${t.name} 有重复`);
    assert.ok(t.items.every((s) => typeof s === 'string' && s.trim() === s && s.length >= 6), t.name);
    all.push(...t.items);
  }
  assert.equal(new Set(all).size, all.length, '不同分类之间有重复语录');
  const shen = QUOTE_TYPES.find((t) => t.id === 'shenhuifu');
  assert.ok(shen.items.every((s) => /^问：.+答：.+/.test(s)), '神回复应为 问：……答：…… 格式');
  const kfc = QUOTE_TYPES.find((t) => t.id === 'kfc');
  assert.ok(kfc.items.every((s) => /星期四|周四/.test(s)), 'KFC 疯狂星期四 每条都应点题');
});

test('语录：按分类取、随机取、条数与参数校验', async () => {
  const k = (await call('/api/quotes', 'type=kfc&count=5')).data;
  assert.equal(k.type, 'kfc');
  assert.equal(k.count, 5);
  assert.ok(k.items.every((x) => x.type === 'kfc' && x.typeName === 'KFC 疯狂星期四'));
  assert.equal(new Set(k.items.map((x) => x.content)).size, 5);

  const mixed = (await call('/api/quotes', 'count=10')).data;
  assert.equal(mixed.type, null);
  assert.equal(mixed.items.length, 10);
  assert.equal(new Set(mixed.items.map((x) => x.content)).size, 10);
  assert.equal((await call('/api/quotes')).data.count, 1);
  // 固定随机数时结果可复现
  assert.deepEqual(pickQuotes('lizhi', 3, seq(7)), pickQuotes('lizhi', 3, seq(7)));

  for (const qs of ['count=0', 'count=11', 'count=abc', 'count=2.5', 'type=unknown', 'type=KFC']) {
    await assert.rejects(call('/api/quotes', qs), { status: 400 }, qs);
  }

  const types = (await call('/api/quotes/types')).data;
  assert.deepEqual(types.map((t) => t.id), QUOTE_TYPES.map((t) => t.id));
  assert.deepEqual(types.map((t) => t.count), QUOTE_TYPES.map((t) => t.items.length));

  checkFields(route('/api/quotes'), [k, mixed]);
  checkFields(route('/api/quotes/types'), [types]);
});

// ---- 温馨提示 ----

test('温馨提示：24 小时都有且只有一个时段', () => {
  const expected = ['lingchen', 'lingchen', 'lingchen', 'lingchen', 'lingchen', 'zaoshang', 'zaoshang', 'zaoshang',
    'shangwu', 'shangwu', 'shangwu', 'zhongwu', 'zhongwu', 'xiawu', 'xiawu', 'xiawu', 'xiawu',
    'bangwan', 'bangwan', 'wanshang', 'wanshang', 'wanshang', 'shenye', 'shenye'];
  assert.deepEqual(Array.from({ length: 24 }, (_, h) => periodOf(h).key), expected);
  assert.deepEqual(GREETING_PERIODS.map((p) => p.name), ['凌晨', '早上', '上午', '中午', '下午', '傍晚', '晚上', '深夜']);
  for (const p of GREETING_PERIODS) assert.ok(p.greetings.length && p.work.length && p.off.length, p.key);
});

test('温馨提示：放假、调休、周末、工作日与数据缺失', () => {
  const y2026 = fallbackYear(2026);
  const info = (d) => holidayInfoFrom(y2026, d);

  const holiday = buildGreeting(bj('2026-10-01T08:30:00'), info('2026-10-01'));
  assert.deepEqual(
    [holiday.period, holiday.periodName, holiday.time, holiday.date, holiday.weekday, holiday.dayType, holiday.isOffDay, holiday.holidayName, holiday.holidayData],
    ['shangwu', '上午', '08:30', '2026-10-01', '星期四', 'holiday', true, '国庆节', true],
  );
  assert.match(holiday.tip, /国庆节/);
  assert.doesNotMatch(holiday.tip, /快乐/);

  // 2026-09-20 周日是国庆调休上班日
  const workday = buildGreeting(bj('2026-09-20T07:00:00'), info('2026-09-20'));
  assert.deepEqual([workday.dayType, workday.isOffDay, workday.holidayName, workday.weekday], ['workday', false, '国庆节', '星期日']);
  assert.match(workday.tip, /^【调休提醒】.*国庆节/);
  assert.match(workday.tip, /星期日/);
  const workdayNight = buildGreeting(bj('2026-09-20T21:00:00'), info('2026-09-20'));
  assert.match(workdayNight.tip, /^【调休提醒】/);
  assert.doesNotMatch(workdayNight.tip, /别睡过头/);

  const weekend = buildGreeting(bj('2026-09-19T13:00:00'), info('2026-09-19'), () => 0);
  assert.deepEqual([weekend.dayType, weekend.isOffDay, weekend.holidayName, weekend.period], ['weekend', true, null, 'xiawu']);
  assert.equal(weekend.tip, periodOf(13).off[0]);

  const normal = buildGreeting(bj('2026-09-24T23:30:00'), info('2026-09-24'), () => 0);
  assert.deepEqual([normal.dayType, normal.isOffDay, normal.period, normal.tip], ['normal', false, 'shenye', periodOf(23).work[0]]);
  const dawn = buildGreeting(bj('2026-09-25T00:10:00'), info('2026-09-25'));
  assert.deepEqual([dawn.period, dawn.date, dawn.dayType, dawn.holidayName], ['lingchen', '2026-09-25', 'holiday', '中秋节']);

  // 节假日数据取不到：照常返回，只按周末判断
  const noDataSat = buildGreeting(bj('2026-10-03T10:00:00'), null);
  assert.deepEqual([noDataSat.dayType, noDataSat.isOffDay, noDataSat.holidayName, noDataSat.holidayData], ['weekend', true, null, false]);
  const noDataWorkday = buildGreeting(bj('2026-09-20T10:00:00'), null);
  assert.deepEqual([noDataWorkday.dayType, noDataWorkday.isOffDay], ['weekend', true]);
  const noDataThu = buildGreeting(bj('2026-10-01T10:00:00'), null);
  assert.deepEqual([noDataThu.dayType, noDataThu.isOffDay], ['normal', false]);
  // 日期对不上、当年未公布的数据都不采用
  assert.equal(buildGreeting(bj('2026-10-02T10:00:00'), info('2026-10-01')).holidayData, false);
  const unpublished = holidayInfoFrom({ year: 2099, papers: [], days: [] }, '2099-01-01');
  assert.equal(buildGreeting(bj('2099-01-01T10:00:00'), unpublished).holidayData, false);

  checkFields(route('/api/greeting'), [holiday, workday, weekend, normal, noDataSat]);
});

test('温馨提示：节假日数据源出错或超时都不报错', async () => {
  // 正常：离线时使用 holiday.js 的内置安排
  cache.store.clear();
  const ok = await loadGreeting(bj('2026-10-01T09:00:00'));
  assert.deepEqual([ok.dayType, ok.holidayName, ok.holidayData], ['holiday', '国庆节', true]);

  // 缓存里是坏数据 → getHolidayInfo 抛错 → 按周末/工作日处理
  cache.store.clear();
  cache.set('holiday:2026', { days: null }, 60_000);
  const broken = await loadGreeting(bj('2026-10-01T09:00:00'));
  assert.deepEqual([broken.dayType, broken.isOffDay, broken.holidayData], ['normal', false, false]);

  // 数据源一直不响应 → 超时后照常返回
  cache.store.clear();
  cache.pending.set('holiday:2026', new Promise(() => {}));
  const started = Date.now();
  const slow = await loadGreeting(bj('2026-10-03T09:00:00'), { timeoutMs: 50 });
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual([slow.dayType, slow.holidayData], ['weekend', false]);
  cache.pending.clear();

  // 没有内置数据的年份，上游又失败 → 照常返回
  cache.store.clear();
  const far = await loadGreeting(bj('2031-05-01T09:00:00'));
  assert.equal(far.holidayData, false);
  assert.equal(far.dayType, 'normal');

  cache.store.clear();
  const live = (await call('/api/greeting')).data;
  assert.equal(typeof live.holidayData, 'boolean');
  assertFieldsDocumented(route('/api/greeting'), live);
});

// ---- 随机头像 ----

const rects = (svg) => [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="\d+" fill="(#[0-9A-F]{6})"\/>/g)]
  .map((m) => ({ x: +m[1], y: +m[2], w: +m[3], fill: m[4] }));

test('随机头像：返回 SVG、同一 seed 固定、不同 seed 不同', async () => {
  for (const style of ['identicon', 'initials', 'pixel']) {
    const a = await call('/api/avatar', `seed=alice&style=${style}&size=96`);
    assert.equal(a.status, 200);
    assert.equal(a.headers['content-type'], 'image/svg+xml; charset=utf-8');
    assert.equal(a.headers['cache-control'], 'public, max-age=86400');
    assert.equal(a.headers['x-avatar-seed'], undefined);
    assert.match(a.body, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="96" height="96" viewBox="[\d ]+"/);
    assert.ok(a.body.endsWith('</svg>'));
    assert.equal((await call('/api/avatar', `seed=alice&style=${style}&size=96`)).body, a.body, style);
    const others = new Set(['bob', 'carol', 'dave', 'erin'].map((s) => renderAvatar({ seed: s, style, size: 96 })));
    assert.equal(others.size, 4, `${style} 不同 seed 应得到不同图`);
    assert.ok(!others.has(a.body));
  }
  // 不传 seed：随机，并通过响应头回传 seed，可复现
  const rnd = await call('/api/avatar', 'style=pixel');
  assert.equal(rnd.headers['cache-control'], 'no-store');
  assert.match(rnd.headers['x-avatar-seed'], /^[0-9a-f]{16}$/);
  assert.equal(renderAvatar({ seed: rnd.headers['x-avatar-seed'], style: 'pixel' }), rnd.body);
  assert.notEqual((await call('/api/avatar', 'style=pixel')).body, rnd.body);
  // 默认 identicon、128 像素
  assert.match((await call('/api/avatar', 'seed=x')).body, /width="128" height="128" viewBox="0 0 12 12"/);
});

test('随机头像：identicon 5×5 对称、pixel 8×8 对称带眼睛', () => {
  for (const seed of ['a', 'b', '张三', 'github']) {
    const cells = rects(renderAvatar({ seed, style: 'identicon' })).filter((r) => r.w === 2);
    assert.ok(cells.length > 0);
    const key = new Set(cells.map((c) => `${c.x},${c.y}`));
    for (const c of cells) {
      assert.ok(c.x >= 1 && c.x <= 9 && c.y >= 1 && c.y <= 9 && (c.x - 1) % 2 === 0);
      assert.ok(key.has(`${10 - c.x},${c.y}`), `${seed} identicon 不对称`);
    }
    assert.equal(new Set(cells.map((c) => c.fill)).size, 1);

    const px = rects(renderAvatar({ seed, style: 'pixel' }));
    const pk = new Map(px.map((c) => [`${c.x},${c.y}`, c.fill]));
    for (const c of px) {
      assert.ok(c.x >= 1 && c.x <= 8 && c.y >= 1 && c.y <= 8);
      assert.equal(pk.get(`${9 - c.x},${c.y}`), c.fill, `${seed} pixel 不对称`);
    }
    assert.equal(px.filter((c) => c.fill === '#1F1F1F').length, 2, '应有一对眼睛');
  }
});

test('随机头像：首字支持中文，文字与颜色不能原样插入 SVG', async () => {
  assert.equal(initialOf('张三'), '张');
  assert.equal(initialOf('alice'), 'A');
  assert.equal(initialOf('  bob'), 'B');
  assert.equal(initialOf('👍🏽ok'), '👍🏽');
  assert.equal(initialOf('\u0001‮'), '?');
  assert.equal(initialOf(''), '?');
  assert.equal(escapeXml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.match((await call('/api/avatar', 'seed=王小明&style=initials')).body, />王<\/text>/);

  const attacks = ['<script>alert(1)</script>', '"><script>alert(1)</script>', "'><svg onload=alert(1)>", '&lt;script&gt;', ']]><script>'];
  for (const seed of attacks) {
    for (const style of ['identicon', 'initials', 'pixel']) {
      const { body } = await call('/api/avatar', new URLSearchParams({ seed, style }).toString());
      assert.doesNotMatch(body, /<script/i, `${style} ${seed}`);
      assert.doesNotMatch(body, /onload/i, `${style} ${seed}`);
      assert.equal(body.match(/<svg/g).length, 1, `${style} ${seed}`);
      if (style === 'initials') {
        const text = /<text[^>]*>([^<]*)<\/text>/.exec(body);
        assert.ok(text, `${seed} 文字节点应完整`);
        assert.doesNotMatch(text[1], /[<>"']|&(?!(lt|gt|amp|quot|#39);)/, `${seed} 文字未转义`);
      }
    }
  }
  assert.match((await call('/api/avatar', 'seed=%3Cscript%3E&style=initials')).body, />&lt;<\/text>/);
  assert.match((await call('/api/avatar', 'seed=%26&style=initials')).body, />&amp;<\/text>/);
});

test('随机头像：bg / size / style / seed 参数校验', async () => {
  assert.match((await call('/api/avatar', 'seed=a&bg=ff8800')).body, /<rect width="12" height="12" fill="#FF8800"\/>/);
  assert.match((await call('/api/avatar', 'seed=a&bg=%23ff8800&style=initials')).body, /fill="#FF8800"/);
  assert.match((await call('/api/avatar', 'seed=a&bg=AbCdEf&style=pixel')).body, /fill="#ABCDEF"/);
  assert.equal(parseHexColor('#00ff00'), '#00FF00');
  assert.throws(() => parseHexColor('red'), { status: 400 });
  assert.equal(hslToHex(0, 100, 50), '#FF0000');
  assert.equal(hslToHex(120, 100, 25), '#008000');

  const bad = [
    'bg=red', 'bg=ff880', 'bg=ff88000', 'bg=%23%23ff8800', 'bg=ff8800%22%2F%3E%3Cscript%3E', 'bg=ff8800;', 'bg=rgb(1,2,3)', 'bg=gggggg',
    'size=31', 'size=513', 'size=abc', 'size=64.5', 'style=robot', `seed=${'x'.repeat(65)}`,
  ];
  for (const qs of bad) await assert.rejects(call('/api/avatar', qs), { status: 400 }, qs);
  assert.throws(() => renderAvatar({ seed: 'a', style: 'nope' }), { status: 400 });
  assert.throws(() => renderAvatar({ seed: 'a', bg: '"/><script>' }), { status: 400 });
  assert.match((await call('/api/avatar', 'seed=a&size=32')).body, /width="32" height="32"/);
  assert.match((await call('/api/avatar', 'seed=a&size=512')).body, /width="512" height="512"/);
});

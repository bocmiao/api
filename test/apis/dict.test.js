// 本地词典数据：新华词典成语 / 歇后语 / 汉字（chinese-xinhua）与唐诗宋词（chinese-poetry）。
// 全部是本地数据，不访问网络；大文件惰性加载，这里也校验“不用就不读盘”。
import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import funModules from '../../src/apis/fun/index.js';
import { assertFieldsDocumented, collectPaths, matcher } from '../helpers/fields.js';
import { IDIOMS } from '../../src/apis/fun/data/idioms.js';
import { XIEHOUYU } from '../../src/apis/fun/data/xiehouyu.js';
import { XIEHOUYU_BLOCKLIST, isBlockedXiehouyu } from '../../src/apis/fun/data/dict/blocklist.js';
import { lookupIdiom, idiomChain, xinhuaIdioms, IDIOM_ITEMS, CHAIN_LIMIT, toneless } from '../../src/apis/fun/idiom.js';
import { pickXiehouyu, xinhuaXiehouyu } from '../../src/apis/fun/xiehouyu.js';
import { lookupHanzi, hanziCount } from '../../src/apis/fun/hanzi.js';
import { searchPoems, randomPoems, localPoems, POEM_TYPES } from '../../src/apis/fun/poetry.js';
import { pickFallbackPoem, parsePoem, localCouplets, FALLBACK_POEMS } from '../../src/apis/fun/poem.js';

function route(path) {
  for (const m of funModules) for (const r of m.routes) if (r.path === path) return r;
  throw new Error(`no route ${path}`);
}
const call = async (path, qs = '') => (await route(path).handler({ query: new URLSearchParams(qs), params: {}, body: null, ip: '127.0.0.1', user: null, req: null })).data;
const rejects = (p, status, message) => assert.rejects(p, (err) => {
  assert.equal(err.status, status, `期望 ${status}，实际 ${err.status} ${err.message}`);
  if (message) assert.match(err.message, message);
  return true;
});

globalThis.fetch = async (url) => { throw new TypeError(`offline: ${url}`); };

// 双向字段校验：样例字段都有说明且类型相符；说明里的字段在样例中都出现过
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

// ================= 惰性加载（放在最前面：此时还没有任何测试触发过加载） =================

test('大文件惰性加载：只查精校数据时不读盘，第一次用到才读且只读一次', async () => {
  const reads = [];
  const original = fs.readFileSync;
  const spy = mock.method(fs, 'readFileSync', (file, ...rest) => {
    reads.push(String(file));
    return original(file, ...rest);
  });
  try {
    await call('/api/idiom', 'word=画龙点睛');
    await call('/api/idiom');
    await call('/api/idiom/chain', 'word=一鸣惊人&scope=curated');
    await call('/api/xiehouyu', 'count=3');
    assert.deepEqual(reads, []);
    assert.equal((await call('/api/idiom', 'word=阿鼻地狱')).dataSource, 'xinhua');
    await call('/api/idiom', 'word=阿党比周');
    assert.equal(reads.filter((f) => f.endsWith('idioms.json')).length, 1);
    await call('/api/hanzi', 'word=乐');
    await call('/api/hanzi', 'word=好');
    assert.equal(reads.filter((f) => f.endsWith('hanzi.json')).length, 1);
  } finally {
    spy.mock.restore();
  }
});

test('新接口已注册，元数据完整，路由不重复', () => {
  for (const name of ['idiom', 'xiehouyu', 'hanzi', 'poetry', 'poem']) {
    const m = funModules.find((x) => x.name === name);
    assert.ok(m, name);
    assert.equal(m.category, 'fun');
    assert.ok(m.title && m.description && m.source, name);
    for (const r of m.routes) for (const p of r.params) assert.ok(p.name && p.desc && p.example, `${r.path} ${p.name}`);
  }
  const paths = funModules.flatMap((m) => m.routes.map((r) => r.path));
  assert.equal(new Set(paths).size, paths.length);
  for (const p of ['/api/hanzi', '/api/poem/search', '/api/poem/random']) assert.ok(paths.includes(p), p);
  for (const f of ['dict/LICENSE', 'poetry/LICENSE']) {
    const text = fs.readFileSync(new URL(`../../src/apis/fun/data/${f}`, import.meta.url), 'utf8');
    assert.match(text, /MIT License/);
    assert.match(text, f.startsWith('dict') ? /Copyright \(c\) 2018 PWXCOO/ : /Copyright \(c\) 2016 JackeyGao/);
  }
});

// ================= 成语 =================

describe('成语：精校优先，查不到回落新华词典', () => {
  test('数据：去重、拼音逐字对应、清理了脏字符', () => {
    const list = xinhuaIdioms();
    assert.ok(list.length > 29000, `新华成语 ${list.length} 条`);
    const curated = new Set(IDIOMS.map((x) => x[0]));
    const words = new Set();
    for (const x of list) {
      assert.ok(!curated.has(x.word) && !words.has(x.word), `重复：${x.word}`);
      words.add(x.word);
      assert.equal(x.dataSource, 'xinhua');
      assert.match(x.word, /^\p{Script=Han}{3,12}$/u);
      assert.equal(x.pinyin.split(' ').length, [...x.word].length, x.word);
      assert.ok(!/ɡ/.test(x.pinyin), x.word);
      for (const s of [x.explanation, x.source, x.example]) {
        if (s == null) continue;
        assert.ok(!/[～★◇∶]/.test(s), `${x.word}：${s}`);
        assert.equal((s.match(/“/g) ?? []).length, (s.match(/”/g) ?? []).length, `${x.word} 引号不配对：${s}`);
      }
    }
    assert.equal(list[0].id, IDIOMS.length + 1);
  });

  test('查询：精校命中时 dataSource=curated，否则回落新华词典', async () => {
    const c = await call('/api/idiom', 'word=画龙点睛');
    assert.deepEqual([c.dataSource, c.random], ['curated', false]);
    const x = await call('/api/idiom', 'word=阿鼻地狱');
    assert.equal(x.dataSource, 'xinhua');
    assert.equal(x.pinyin, 'ā bí dì yù');
    assert.ok(x.id > IDIOMS.length);
    // 原数据“意译为无间”，即……”丢了前引号，清理后不留孤零零的后引号；例句的 ～ 换回成语、★ 出处改成括号
    assert.ok(!x.explanation.includes('”'));
    assert.equal(x.example, '但也有少数意志薄弱的……逐步上当，终至堕入阿鼻地狱。（《上饶集中营·炼狱杂记》）');
    // 两个词库都没有：404，候选里精校在前
    await assert.rejects(call('/api/idiom', 'word=画龙'), (err) => err.status === 404 && err.candidates[0] === '画龙点睛' && err.candidates.length === 5);
    await rejects(call('/api/idiom', 'scope=xinhua'), 400, /scope/);
  });

  test('随机：默认只抽精校，scope=all 从两个词库合起来抽', async () => {
    assert.equal(lookupIdiom(null, () => 0.999999, { scope: 'curated' }).dataSource, 'curated');
    const last = lookupIdiom(null, () => 0.999999, { scope: 'all' });
    assert.equal(last.dataSource, 'xinhua');
    assert.equal(last.word, xinhuaIdioms().at(-1).word);
    assert.equal(lookupIdiom(null, () => 0, { scope: 'all' }).word, IDIOM_ITEMS[0].word);
    const r = await call('/api/idiom', 'scope=all');
    assert.equal(r.random, true);
    assert.ok(['curated', 'xinhua'].includes(r.dataSource));
  });

  test('接龙：scope=all 用上大词库，按首字索引，精校在前，最多返回 CHAIN_LIMIT 条', async () => {
    const small = await call('/api/idiom/chain', 'word=一鸣惊人&scope=curated');
    assert.equal(small.scope, 'curated');
    assert.ok(small.items.every((x) => x.dataSource === 'curated'));
    assert.equal(small.total, small.count);

    const big = await call('/api/idiom/chain', 'word=一鸣惊人');
    assert.equal(big.scope, 'all'); // 默认用全部词库
    assert.ok(big.total > small.total && big.total > CHAIN_LIMIT);
    assert.equal(big.count, CHAIN_LIMIT);
    assert.equal(big.items.length, CHAIN_LIMIT);
    assert.ok(big.items.every((x) => x.word[0] === '人'));
    assert.deepEqual(big.items.slice(0, small.count).map((x) => x.word), small.items.map((x) => x.word));
    assert.ok(big.homophoneTotal > small.homophoneTotal);
    assert.ok(big.homophones.every((x) => x.word[0] !== '人' && toneless(x.pinyin.split(' ')[0]) === 'ren'));

    // 只在新华词典里的成语：curated 范围内 known=false，all 范围内能给出尾字读音
    assert.equal(idiomChain('阿鼻地狱', { scope: 'curated' }).known, false);
    const x = idiomChain('阿鼻地狱', { scope: 'all' });
    assert.deepEqual([x.known, x.tail, x.tailPinyin], [true, '狱', 'yù']);
    // 精校词库里接不上的，大词库里能接上
    assert.equal(idiomChain('一去不回', { scope: 'curated' }).count, 0);
    assert.ok(idiomChain('一去不回', { scope: 'all' }).count > 0);
    await rejects(call('/api/idiom/chain', 'word=一鸣惊人&scope=big'), 400, /scope/);
  });

  test('字段说明（双向）', async () => {
    checkFields(route('/api/idiom'), [
      await call('/api/idiom', 'word=画龙点睛'),
      await call('/api/idiom', 'word=山清水秀'),
      await call('/api/idiom', 'word=阿鼻地狱'),
      await call('/api/idiom', 'word=决疣溃痈'), // 新华词条，出处、例句都为 null
      await call('/api/idiom', 'scope=all'),
    ]);
    checkFields(route('/api/idiom/chain'), [
      await call('/api/idiom/chain', 'word=一鸣惊人&scope=all'),
      await call('/api/idiom/chain', 'word=天下无双'),
    ]);
  });
});

// ================= 歇后语 =================

describe('歇后语：合并新华词典数据并过滤歧视性内容', () => {
  test('数据：无屏蔽词、无空项、无重复、不与精校数据重复', () => {
    const list = xinhuaXiehouyu();
    assert.ok(list.length > 12000, `新华歇后语 ${list.length} 条`);
    assert.ok(XIEHOUYU_BLOCKLIST.length >= 50);
    for (const w of ['瞎子', '聋子', '哑巴', '瘸子', '拐子', '驼子', '麻子', '秃子', '傻子', '疯子', '癞', '残废', '寡妇', '婊', '娘们']) {
      assert.ok(isBlockedXiehouyu(w, ''), w);
    }
    assert.ok(isBlockedXiehouyu('广东人说北京话', '南腔北调'));
    assert.ok(!isBlockedXiehouyu('外甥打灯笼', '照舅（旧）'));
    const curated = new Set(XIEHOUYU.map(([r]) => r));
    const seen = new Set();
    for (const x of list) {
      assert.ok(x.riddle && x.answer, `空项 #${x.id}`);
      assert.ok(!isBlockedXiehouyu(x.riddle, x.answer), `未过滤：${x.text}`);
      assert.ok(!/[a-z]/i.test(x.text), `带拼音残片：${x.text}`);
      assert.ok(!curated.has(x.riddle), `与精校重复：${x.text}`);
      assert.ok(!seen.has(x.text), `重复：${x.text}`);
      seen.add(x.text);
      assert.equal(x.text, `${x.riddle}——${x.answer}`);
    }
    assert.equal(list[0].id, XIEHOUYU.length + 1);
  });

  test('scope：默认只用精校数据，all 合并；关键字在合并后的范围内搜索', async () => {
    const d = await call('/api/xiehouyu');
    assert.deepEqual([d.scope, d.matched], ['curated', XIEHOUYU.length]);
    const all = await call('/api/xiehouyu', 'scope=all&count=10');
    assert.equal(all.matched, XIEHOUYU.length + xinhuaXiehouyu().length);
    assert.equal(new Set(all.items.map((x) => x.id)).size, 10);
    const kw = await call('/api/xiehouyu', 'scope=all&keyword=猪八戒&count=10');
    assert.ok(kw.matched > (await call('/api/xiehouyu', 'keyword=猪八戒')).matched);
    assert.ok(kw.items.every((x) => x.text.includes('猪八戒')));
    assert.equal(pickXiehouyu({ scope: 'all', rand: () => 0.999999 }).items[0].id, XIEHOUYU.length + xinhuaXiehouyu().length);
    await rejects(call('/api/xiehouyu', 'scope=xinhua'), 400, /scope/);
  });

  test('字段说明（双向）', async () => {
    checkFields(route('/api/xiehouyu'), [await call('/api/xiehouyu', 'scope=all&count=5'), await call('/api/xiehouyu', 'keyword=没有这个')]);
  });
});

// ================= 汉字 =================

describe('汉字字典', () => {
  test('多音字、繁体、部首笔画', async () => {
    const d = await call('/api/hanzi', 'word=乐');
    assert.deepEqual(d, {
      word: '乐',
      pinyin: ['lè', 'yuè', 'yào', 'luò'],
      radical: '丿',
      strokes: 5,
      traditional: ['樂'],
      explanation: d.explanation,
      unicode: 'U+4E50',
    });
    assert.match(d.explanation, /^乐（樂）lè\n/);
    assert.deepEqual(lookupHanzi('发').traditional, ['發', '髮']);
    assert.deepEqual(lookupHanzi('行').pinyin, ['xíng', 'háng', 'hàng', 'héng']);
    assert.deepEqual(lookupHanzi('的').pinyin, ['de', 'dí', 'dì']);
    // 原数据 old 字段错位（“长”记作“閘”），不采用
    assert.deepEqual(lookupHanzi('长').traditional, []);
    assert.equal(lookupHanzi(' 好 ').word, '好');
    // 部首缺失的生僻字，笔画也不可靠（原数据把“龘”记作 6 画）
    const rare = lookupHanzi('龘');
    assert.deepEqual([rare.radical, rare.strokes, rare.pinyin], [null, null, ['dá']]);
  });

  test('数据清理：读音用标准 g，释义没有乱码符号；错位的繁体条目已丢弃', () => {
    assert.ok(hanziCount() > 14000);
    for (const w of ['中', '国', '长', '行']) {
      const x = lookupHanzi(w);
      assert.ok(x.pinyin.every((p) => /^[a-zāáǎàēéěèīíǐìōóǒòūúǔùüǖǘǚǜ]+$/.test(p)), `${w} ${x.pinyin}`);
      assert.ok(!/[ɡ♂≮]/.test(x.explanation), w);
    }
    assert.equal(lookupHanzi('国').pinyin[0], 'guó');
    // 原数据“發”条目的内容其实是另一个字（wéi，足上疮），与“发”的读音对不上，已丢弃
    assert.throws(() => lookupHanzi('發'), { status: 404 });
  });

  test('参数：只接受 1 个汉字', async () => {
    await rejects(call('/api/hanzi'), 400, /word/);
    for (const bad of ['ab', '乐乐', 'a', '1', '，', '乐a']) await rejects(call('/api/hanzi', `word=${encodeURIComponent(bad)}`), 400, /1 个汉字/);
    await rejects(call('/api/hanzi', `word=${encodeURIComponent('𠀀')}`), 404, /没有收录/);
  });

  test('字段说明（双向）', async () => {
    checkFields(route('/api/hanzi'), [await call('/api/hanzi', 'word=乐'), await call('/api/hanzi', 'word=龘')]);
  });
});

// ================= 古诗词 =================

describe('古诗词库', () => {
  test('数据：600 首，标题只留正题，异文注释抽到 notes', () => {
    const list = localPoems();
    assert.equal(list.length, 600);
    assert.equal(list.filter((p) => p.dynasty === '唐').length, 320);
    assert.equal(list.filter((p) => p.dynasty === '宋').length, 280);
    for (const p of list) {
      assert.ok(p.title && p.author && p.paragraphs.length, p.id);
      assert.ok(!p.title.includes(' / ') && !p.title.includes('・'), `${p.id} ${p.title}`);
      assert.ok(POEM_TYPES.includes(p.type), p.type);
      for (const line of p.paragraphs) assert.ok(!/[()（）,?!:]/.test(line), `${p.id} ${line}`);
    }
    const p = list.find((x) => x.id === 'tang-8');
    assert.equal(p.title, '山中送别');
    assert.deepEqual(p.notes, ['明年 一作：年年']);
    assert.equal(p.paragraphs[1], '春草明年绿，王孙归不归？');
  });

  test('检索：关键词、作者、朝代、体裁、分页', async () => {
    const d = await call('/api/poem/search', 'keyword=明月&size=5');
    assert.ok(d.total > 10);
    assert.equal(d.count, 5);
    assert.ok(d.items.every((x) => x.title.includes('明月') || x.content.includes('明月')));
    const p2 = await call('/api/poem/search', 'keyword=明月&size=5&page=2');
    assert.notEqual(p2.items[0].id, d.items[0].id);
    const libai = searchPoems({ author: '李白', size: 50 });
    assert.ok(libai.total > 20 && libai.items.every((x) => x.author === '李白' && x.dynasty === '唐'));
    const su = await call('/api/poem/search', 'author=苏轼&dynasty=宋&type=词');
    assert.ok(su.items.some((x) => x.title === '水调歌头'));
    const jqs = (await call('/api/poem/search', 'keyword=静夜思')).items[0];
    assert.equal(jqs.content, jqs.paragraphs.join('\n'));
    assert.deepEqual((await call('/api/poem/search', 'author=李白&dynasty=宋')).items, []);
    await rejects(call('/api/poem/search', 'dynasty=元'), 400, /dynasty/);
    await rejects(call('/api/poem/search', 'type=散文'), 400, /type/);
    await rejects(call('/api/poem/search', 'size=51'), 400, /size/);
  });

  test('随机：count 条互不重复，可限定范围', async () => {
    const d = await call('/api/poem/random', 'dynasty=宋&count=5');
    assert.equal(d.count, 5);
    assert.equal(d.matched, 280);
    assert.equal(new Set(d.items.map((x) => x.id)).size, 5);
    assert.ok(d.items.every((x) => x.dynasty === '宋'));
    assert.deepEqual(randomPoems({ keyword: '不存在的句子' }).items, []);
    await rejects(call('/api/poem/random', 'count=11'), 400, /count/);
  });

  test('/api/poem 兜底：一半内置名句，一半本地唐诗对句；朝代可按本地数据补全', () => {
    assert.equal(pickFallbackPoem(() => 0).title, FALLBACK_POEMS[0].title);
    const local = pickFallbackPoem(() => 0.5);
    assert.deepEqual(local, { ...localCouplets()[0], category: null, fallback: true });
    assert.ok(localCouplets().length > 1000);
    assert.ok(pickFallbackPoem(() => 0.999999).content);
    assert.equal(parsePoem({ content: '渺空烟四远，是何年、青天坠长星？', author: '吴文英' }).dynasty, '宋');
    assert.equal(parsePoem({ content: '青青子衿', author: '无名氏' }).dynasty, null);
  });

  test('字段说明（双向）', async () => {
    checkFields(route('/api/poem/search'), [await call('/api/poem/search', 'keyword=明月&size=3'), await call('/api/poem/search', 'author=没有这个人')]);
    checkFields(route('/api/poem/random'), [await call('/api/poem/random', 'count=3&author=王维'), await call('/api/poem/random', 'type=词&dynasty=宋&keyword=月')]);
  });
});

// tools 分类：汉字转拼音 / 简繁转换 / 条形码 / 随机工具。全部本地计算，不访问网络。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

import pinyinModule, { toPinyin, formatSyllable, readingsOf } from '../../src/apis/tools/pinyin.js';
import convertModule, { convertChinese, toSimplifiedChar, PHRASES_S2T } from '../../src/apis/tools/chinese-convert.js';
import barcodeModule, {
  encodeCode128, code128Modules, CODE128_PATTERNS, eanCheckDigit, normalizeEan, eanModules, encodeBarcode, toBarcodeSVG, toBarcodePNG,
} from '../../src/apis/tools/barcode.js';
import randomModule, { randomNumbers, parseItems, pickItems, shuffle, randomStrings, CHARSETS } from '../../src/apis/tools/random.js';
import { assertFieldsDocumented, collectPaths, matcher } from '../helpers/fields.js';

const MODULES = [pinyinModule, convertModule, barcodeModule, randomModule];
const q = (obj = {}) => new URLSearchParams(obj);
const route = (mod, method, path) => mod.routes.find((r) => r.method === method && r.path === path);
const call = async (mod, path, query) => (await route(mod, 'GET', path).handler({ query: q(query) })).data;
const rejects400 = (p, message) => assert.rejects(p, (err) => {
  assert.equal(err.status, 400, `期望 400，实际 ${err.status} ${err.message}`);
  if (message) assert.match(err.message, message);
  return true;
});

// 两个方向都校验：返回的每个字段都有说明；说明里的每个字段也都在样例中出现过
const checked = new Set();
function checkFields(r, ...samples) {
  for (const s of samples) assertFieldsDocumented(r, s);
  const paths = new Set();
  for (const s of samples) collectPaths(s, '', paths);
  const phantom = r.fields.map((f) => f.name).filter((name) => ![...paths].some((p) => matcher(name).test(p)));
  assert.deepEqual(phantom, [], `${r.path} 的 fields 写了样例中没有出现的字段：${phantom.join(', ')}`);
  checked.add(`${r.method} ${r.path}`);
}

// ---------------- 注册信息 ----------------

test('模块元信息齐全，参数都有 desc，必填参数都有 example，路径不重复', () => {
  const names = new Set();
  const keys = [];
  for (const m of MODULES) {
    assert.equal(m.category, 'tools');
    assert.ok(m.title && m.description && m.source, m.name);
    assert.ok(!names.has(m.name));
    names.add(m.name);
    for (const r of m.routes) {
      assert.equal(r.method, 'GET');
      assert.match(r.path, /^\/api\//);
      assert.ok(Array.isArray(r.params) && r.params.length, `${r.path} 缺少 params`);
      for (const p of r.params) assert.ok(p.desc && p.example != null && p.example !== '', `${r.path} ${p.name}`);
      keys.push(`${r.method} ${r.path}`);
    }
  }
  assert.deepEqual([...names], ['pinyin', 'chinese-convert', 'barcode', 'random']);
  assert.equal(new Set(keys).size, keys.length);
});

test('用文档里的示例参数调用每个路由都成功（模拟巡检）', async () => {
  for (const m of MODULES) {
    for (const r of m.routes) {
      const query = q(Object.fromEntries(r.params.filter((p) => p.example != null).map((p) => [p.name, p.example])));
      const res = await r.handler({ query, params: {}, ip: '127.0.0.1' });
      if (r.raw) assert.equal(res.status, 200, r.path);
      else assert.ok(res.data, r.path);
    }
  }
});

// ---------------- 汉字转拼音 ----------------

describe('汉字转拼音', () => {
  test('四种风格', () => {
    assert.equal(toPinyin('中国').pinyin, 'zhōng guó');
    assert.equal(toPinyin('中国', { style: 'number' }).pinyin, 'zhong1 guo2');
    assert.equal(toPinyin('中国', { style: 'none' }).pinyin, 'zhong guo');
    assert.equal(toPinyin('中国', { style: 'initial' }).pinyin, 'z g');
    assert.equal(toPinyin('中国').abbr, 'ZG');
    assert.equal(toPinyin('中华人民共和国').abbr, 'ZHRMGHG');
  });

  test('ü 与轻声：数字/无声调风格 ü 写作 v，轻声不加数字', () => {
    assert.equal(toPinyin('绿女', { style: 'number' }).pinyin, 'lv4 nv3');
    assert.equal(toPinyin('绿', { style: 'tone' }).pinyin, 'lǜ');
    assert.equal(formatSyllable('de', 'number'), 'de');
    assert.equal(formatSyllable('lüè', 'number'), 'lve4');
    assert.equal(formatSyllable('zhuàng', 'initial'), 'z');
    assert.equal(toPinyin('我们的', { style: 'number' }).pinyin, 'wo3 men de');
  });

  test('非汉字原样保留，连续的成一段；空白只保留换行；分隔符可自定义或为空', () => {
    assert.equal(toPinyin('Hello 世界2024！').pinyin, 'Hello shì jiè 2024！');
    assert.equal(toPinyin('你好\n世界').pinyin, 'nǐ hǎo\nshì jiè');
    assert.equal(toPinyin('你好', { separator: '-' }).pinyin, 'nǐ-hǎo');
    assert.equal(toPinyin('你好', { separator: '' }).pinyin, 'nǐhǎo');
    const r = toPinyin('A中');
    assert.deepEqual(r.chars[0], { char: 'A', pinyin: null, readings: [], polyphonic: false });
    assert.equal(r.hanCount, 1);
    assert.equal(r.abbr, 'Z');
  });

  test('多音字：默认取常用读音，heteronym 列出全部；按风格去重', () => {
    const r = toPinyin('银行');
    assert.equal(r.pinyin, 'yín xíng');
    assert.ok(r.chars[1].polyphonic);
    assert.ok(r.chars[1].readings.includes('háng'));
    assert.equal(toPinyin('中', { heteronym: true }).pinyin, 'zhōng/zhòng');
    // 带声调时“中”有两个读音，无声调时去重后只剩一个
    assert.deepEqual(toPinyin('中', { style: 'none' }).chars[0].readings, ['zhong']);
    assert.equal(toPinyin('中', { style: 'none' }).chars[0].polyphonic, false);
  });

  test('常用字读音修正与繁体回退', () => {
    assert.equal(toPinyin('我们').pinyin, 'wǒ men');
    assert.ok(readingsOf('长').includes('zhǎng'));
    assert.equal(toSimplifiedChar('國'), '国');
    assert.equal(toPinyin('中國').pinyin, 'zhōng guó');
  });

  test('参数校验', async () => {
    await rejects400(call(pinyinModule, '/api/pinyin', {}), /text/);
    await rejects400(call(pinyinModule, '/api/pinyin', { text: '中', style: 'x' }), /style/);
    await rejects400(call(pinyinModule, '/api/pinyin', { text: '中', separator: '------' }), /separator/);
    await rejects400(call(pinyinModule, '/api/pinyin', { text: '中', heteronym: 'yes' }), /heteronym/);
    await rejects400(call(pinyinModule, '/api/pinyin', { text: '中'.repeat(1001) }), /过长/);
    assert.throws(() => toPinyin(''), { status: 400 });
  });

  test('字段说明', async () => {
    const r = route(pinyinModule, 'GET', '/api/pinyin');
    const d = await call(pinyinModule, '/api/pinyin', { text: '重力 abc', heteronym: 'true', style: 'number' });
    assert.equal(d.pinyin, 'zhong4/chong2 li4 abc');
    checkFields(r, d);
  });
});

// ---------------- 简繁转换 ----------------

describe('简繁转换', () => {
  test('逐字转换与常用词修正', () => {
    const r = convertChinese('头发和面条的发展时间，我们的国家', 'traditional');
    assert.equal(r.text, '頭髮和麵條的發展時間，我們的國家');
    assert.equal(r.to, 'traditional');
    assert.ok(r.phraseMatches >= 3);
    assert.equal(convertChinese('干净的饼干', 'traditional').text, '乾淨的餅乾');
    assert.equal(convertChinese('台风来了，打开台灯', 'traditional').text, '颱風來了，打開檯燈');
    assert.equal(convertChinese('皇后在后面', 'traditional').text, '皇后在後面');
    assert.equal(convertChinese('Hello 123', 'traditional').text, 'Hello 123');
  });

  test('繁→简', () => {
    assert.equal(convertChinese('頭髮和麵條的發展時間，我們的國家', 'simplified').text, '头发和面条的发展时间，我们的国家');
    assert.equal(convertChinese('乾隆瞭解乾淨', 'simplified').text, '乾隆了解干净');
    assert.equal(convertChinese('臺灣', 'simplified').text, '台湾');
  });

  test('改动计数与多候选提示（被词表处理的不计入）', () => {
    const r = convertChinese('发财，头发', 'traditional');
    assert.equal(r.text, '發財，頭髮');
    assert.equal(r.changed, 4);
    assert.deepEqual(r.ambiguous, [{ char: '发', chosen: '發', candidates: ['發', '髮'] }]);
    assert.deepEqual(convertChinese('头发', 'traditional').ambiguous, []);
    assert.equal(convertChinese('abc', 'traditional').changed, 0);
  });

  test('词表里的每个词都能整词命中', () => {
    for (const [s, t] of Object.entries(PHRASES_S2T)) assert.equal(convertChinese(s, 'traditional').text, t, s);
  });

  test('参数校验', async () => {
    await rejects400(call(convertModule, '/api/chinese/convert', {}), /text/);
    await rejects400(call(convertModule, '/api/chinese/convert', { text: '中', to: 'hk' }), /to/);
    assert.throws(() => convertChinese('中'.repeat(5001)), { status: 400 });
  });

  test('字段说明', async () => {
    const r = route(convertModule, 'GET', '/api/chinese/convert');
    const d = await call(convertModule, '/api/chinese/convert', { text: '发展里面的头发' });
    assert.ok(d.ambiguous.length);
    checkFields(r, d);
  });
});

// ---------------- 条形码 ----------------

describe('条形码', () => {
  test('Code 128 码表：每个符号 11 个模块、条的模块数为偶数、互不相同；终止符 13 个模块', () => {
    assert.equal(CODE128_PATTERNS.length, 107);
    for (const [i, p] of CODE128_PATTERNS.entries()) {
      const w = [...p].map(Number);
      assert.equal(w.reduce((a, b) => a + b), i === 106 ? 13 : 11, `符号 ${i}`);
      assert.equal(w.filter((_, k) => k % 2 === 0).reduce((a, b) => a + b) % 2, 0, `符号 ${i}`);
    }
    assert.equal(new Set(CODE128_PATTERNS).size, 107);
  });

  test('Code 128 编码与校验符（与 python-barcode 输出比对过）', () => {
    // Start B(104) + P J J 1 2 3 C，校验 = (104 + 48×1 + 42×2 + 42×3 + 17×4 + 18×5 + 19×6 + 35×7) mod 103 = 55
    assert.deepEqual(encodeCode128('PJJ123C'), { codes: [104, 48, 42, 42, 17, 18, 19, 35, 55], checksum: 55 });
    assert.deepEqual(encodeCode128('Wikipedia').codes, [104, 55, 73, 75, 73, 80, 69, 68, 73, 65, 88]);
    // 全数字用 C 字符集，两位一个符号
    assert.deepEqual(encodeCode128('123456').codes, [105, 12, 34, 56, 44]);
    // 奇数位数字：C 编完成对的，最后一位切回 B
    assert.deepEqual(encodeCode128('1234567').codes, [105, 12, 34, 56, 100, 23, 44]);
    // 字母后接长串数字：中途切到 C
    assert.deepEqual(encodeCode128('AB1234567890').codes, [104, 33, 34, 99, 12, 34, 56, 78, 90, 56]);
    assert.equal(
      code128Modules('Wikipedia').join(''),
      '11010010000111010001101000011010011000010010100001101001010011110010110010000100001001101000011010010010110000111100100101100011101011',
    );
    assert.equal(code128Modules('123456').join(''), '11010011100101100111001000101100011100010110100011011101100011101011');
  });

  test('Code 128 字符校验', () => {
    assert.throws(() => encodeCode128('中文'), { status: 400 });
    assert.throws(() => encodeCode128('a\tb'), { status: 400 });
    assert.throws(() => encodeCode128(''), { status: 400 });
  });

  test('EAN 校验位：补全与校验', () => {
    assert.equal(eanCheckDigit('690123456789'), 2);
    assert.equal(normalizeEan('690123456789', 13), '6901234567892');
    assert.equal(normalizeEan('6901234567892', 13), '6901234567892');
    assert.equal(normalizeEan('400638133393', 13), '4006381333931');
    assert.equal(normalizeEan('9638507', 8), '96385074');
    assert.throws(() => normalizeEan('6901234567890', 13), (e) => e.status === 400 && /应为 2/.test(e.message));
    assert.throws(() => normalizeEan('12345', 13), { status: 400 });
    assert.throws(() => normalizeEan('69012345678a', 13), { status: 400 });
  });

  test('EAN-13 / EAN-8 模块序列（与 python-barcode 输出比对过）', () => {
    const e13 = eanModules('6901234567892');
    assert.equal(e13.modules.length, 95);
    assert.equal(
      e13.modules.join(''),
      '10100010110100111011001100110110111101010001101010100111010100001000100100100011101001101100101',
    );
    assert.deepEqual([...e13.guards], [0, 1, 2, 45, 46, 47, 48, 49, 92, 93, 94]);
    const e8 = eanModules('96385074');
    assert.equal(e8.modules.length, 67);
    assert.equal(e8.modules.join(''), '1010001011010111101111010110111010101001110111001010001001011100101');
  });

  test('SVG：每根条一个 rect，文字已转义', () => {
    const svg = toBarcodeSVG(encodeBarcode('<a&"b\'>', 'code128'), { scale: 2, height: 50, margin: 10 });
    assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    assert.ok((svg.match(/<rect /g) ?? []).length > 10);
    assert.match(svg, /&lt;a&amp;&quot;b&#39;&gt;/);
    assert.doesNotMatch(svg, /<a|<script/);
    // EAN-13：3 组文字，护线加长
    const ean = toBarcodeSVG(encodeBarcode('690123456789', 'ean13'));
    assert.equal((ean.match(/<text /g) ?? []).length, 3);
    assert.match(ean, />6<\/text>.*>901234<\/text>.*>567892<\/text>/);
    assert.equal(toBarcodeSVG(encodeBarcode('1', 'code128'), { showText: false }).includes('<text'), false);
  });

  test('PNG：签名、尺寸与像素', () => {
    const code = encodeBarcode('96385074', 'ean8');
    const png = toBarcodePNG(code, { scale: 2, height: 30, margin: 10 });
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    assert.equal(width, (67 + 20) * 2);
    assert.equal(height, 30 + 2 * 10 * 2);
    // 取出 IDAT 解压，检查条区中间一行的像素与模块一致
    let off = 8;
    const idat = [];
    while (off < png.length) {
      const len = png.readUInt32BE(off);
      const type = png.toString('ascii', off + 4, off + 8);
      if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
      off += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(idat));
    const rowBytes = Math.ceil(width / 8);
    const dark = (x, y) => ((raw[y * (rowBytes + 1) + 1 + (x >> 3)] >> (7 - (x & 7))) & 1) === 0;
    const y = 20 + 15;
    for (let m = 0; m < 67; m++) assert.equal(dark((m + 10) * 2, y), code.modules[m] === 1, `模块 ${m}`);
    assert.equal(dark(0, y), false);
    assert.equal(dark(30, 0), false); // 上边距为白
  });

  test('路由：Content-Type 与参数校验', async () => {
    const r = route(barcodeModule, 'GET', '/api/barcode');
    assert.equal(r.raw, true);
    assert.ok(typeof r.returns === 'string' && r.returns.length > 20);
    assert.equal(r.fields, undefined);
    const svg = await r.handler({ query: q({ text: 'Hello-123' }) });
    assert.equal(svg.status, 200);
    assert.match(svg.headers['content-type'], /^image\/svg\+xml/);
    assert.match(svg.body, /<rect /);
    const png = await r.handler({ query: q({ text: '690123456789', type: 'ean13', format: 'png' }) });
    assert.equal(png.headers['content-type'], 'image/png');
    assert.ok(Buffer.isBuffer(png.body));
    await rejects400(r.handler({ query: q({}) }), /text/);
    await rejects400(r.handler({ query: q({ text: '中文' }) }), /ASCII/);
    await rejects400(r.handler({ query: q({ text: '6901234567890', type: 'ean13' }) }), /校验位/);
    await rejects400(r.handler({ query: q({ text: '123', type: 'ean8' }) }), /EAN-8/);
    await rejects400(r.handler({ query: q({ text: 'a', type: 'qr' }) }), /type/);
    await rejects400(r.handler({ query: q({ text: 'a', scale: '0' }) }), /scale/);
    await rejects400(r.handler({ query: q({ text: 'a', height: '5000' }) }), /height/);
    await rejects400(r.handler({ query: q({ text: 'a'.repeat(81) }) }), /过长/);
  });
});

// ---------------- 随机工具 ----------------

describe('随机工具', () => {
  test('随机整数：范围、个数、不重复', () => {
    for (const n of randomNumbers({ min: -5, max: 5, count: 500 })) assert.ok(Number.isInteger(n) && n >= -5 && n <= 5);
    const all = randomNumbers({ min: 1, max: 10, count: 10, unique: true });
    assert.deepEqual([...all].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const some = randomNumbers({ min: 1, max: 1e12, count: 1000, unique: true });
    assert.equal(new Set(some).size, 1000);
    assert.deepEqual(randomNumbers({ min: 7, max: 7, count: 3 }), [7, 7, 7]);
    // 分布大致均匀：1~4 各约 2500 次
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 10; i++) for (const n of randomNumbers({ min: 0, max: 3, count: 1000 })) counts[n]++;
    for (const c of counts) assert.ok(c > 2000 && c < 3000, String(counts));
    assert.throws(() => randomNumbers({ min: 5, max: 1 }), { status: 400 });
    assert.throws(() => randomNumbers({ min: 1, max: 5, count: 6, unique: true }), { status: 400 });
    assert.throws(() => randomNumbers({ min: 0, max: 2e12 }), { status: 400 });
  });

  test('选项解析：逗号（中英文）或换行', () => {
    assert.deepEqual(parseItems('a, b，c,,'), ['a', 'b', 'c']);
    assert.deepEqual(parseItems('一等奖, 1 名\n二等奖\r\n\n三等奖'), ['一等奖, 1 名', '二等奖', '三等奖']);
    assert.throws(() => parseItems(' , ,'), { status: 400 });
    assert.throws(() => parseItems(Array.from({ length: 1001 }, (_, i) => i).join(',')), { status: 400 });
  });

  test('抽签不放回、洗牌是原列表的排列', () => {
    const items = ['a', 'b', 'c', 'd'];
    const picked = pickItems(items, 4);
    assert.deepEqual(picked.map((p) => p.item).sort(), items);
    for (const p of picked) assert.equal(items[p.index], p.item);
    assert.throws(() => pickItems(items, 5), { status: 400 });
    const s = shuffle(items);
    assert.deepEqual([...s].sort(), items);
    assert.deepEqual(items, ['a', 'b', 'c', 'd']);
  });

  test('随机字符串：长度与字符集', () => {
    for (const [name, chars] of Object.entries(CHARSETS)) {
      const [s] = randomStrings({ length: 200, charset: name });
      assert.equal(s.length, 200);
      assert.ok([...s].every((c) => chars.includes(c)), name);
    }
    assert.doesNotMatch(CHARSETS.readable, /[0O1lIiLo]/);
    assert.throws(() => randomStrings({ charset: 'emoji' }), { status: 400 });
  });

  test('路由参数校验', async () => {
    await rejects400(call(randomModule, '/api/random/number', { min: '10', max: '1' }), /min/);
    await rejects400(call(randomModule, '/api/random/number', { count: '1001' }), /count/);
    await rejects400(call(randomModule, '/api/random/number', { min: '1.5' }), /min/);
    await rejects400(call(randomModule, '/api/random/number', { unique: 'yes' }), /unique/);
    await rejects400(call(randomModule, '/api/random/number', { max: '3', count: '5', unique: 'true' }), /不能超过/);
    await rejects400(call(randomModule, '/api/random/pick', {}), /items/);
    await rejects400(call(randomModule, '/api/random/pick', { items: 'a,b', count: '3' }), /count/);
    await rejects400(call(randomModule, '/api/random/shuffle', { items: ',' }), /items/);
    await rejects400(call(randomModule, '/api/random/string', { length: '0' }), /length/);
    await rejects400(call(randomModule, '/api/random/string', { charset: 'x' }), /charset/);
    await rejects400(call(randomModule, '/api/random/string', { count: '101' }), /count/);
  });

  test('字段说明', async () => {
    const num = await call(randomModule, '/api/random/number', { min: '1', max: '6', count: '3', unique: 'true' });
    assert.equal(num.numbers.length, 3);
    assert.equal(num.unique, true);
    checkFields(route(randomModule, 'GET', '/api/random/number'), num);
    const pick = await call(randomModule, '/api/random/pick', { items: '张三,李四,王五', count: '2' });
    assert.equal(pick.picked.length, 2);
    checkFields(route(randomModule, 'GET', '/api/random/pick'), pick);
    const sh = await call(randomModule, '/api/random/shuffle', { items: '1\n2\n3' });
    assert.equal(sh.items.length, 3);
    checkFields(route(randomModule, 'GET', '/api/random/shuffle'), sh);
    const str = await call(randomModule, '/api/random/string', { length: '8', charset: 'hex', count: '2' });
    assert.match(str.strings[0], /^[0-9a-f]{8}$/);
    checkFields(route(randomModule, 'GET', '/api/random/string'), str);
  });
});

test('本文件负责的每个非 raw 路由都做了字段校验，raw 路由都有 returns', () => {
  const routes = MODULES.flatMap((m) => m.routes);
  const expected = routes.filter((r) => !r.raw).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(expected.filter((k) => !checked.has(k)), []);
  for (const r of routes.filter((x) => x.raw)) {
    assert.ok(typeof r.returns === 'string' && r.returns.length > 20, `${r.path} 缺少 returns`);
    assert.equal(r.fields, undefined);
  }
});

// tools 分类新增：文本对比 / 格式转换（JSON、YAML、CSV）/ Markdown 转 HTML / 开发速查（状态码、MIME、端口）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import diffModule, { diffText, myersDiff, splitLines, splitWords, MAX_BYTES, MAX_TOKENS } from '../../src/apis/tools/diff.js';
import convertModule, { parseYaml, toYaml, parseCsv, csvToValue, valueToCsv, convertFormat, resolvePlain, MAX_INPUT as CONVERT_MAX } from '../../src/apis/tools/convert.js';
import markdownModule, { markdownToHtml, renderInline, safeUrl, MAX_INPUT as MD_MAX } from '../../src/apis/tools/markdown.js';
import devrefModule, { lookupStatus, lookupMime, lookupPort, DATA } from '../../src/apis/tools/devref.js';
import { assertFieldsDocumented, collectPaths, matcher } from '../helpers/fields.js';

const MODULES = [diffModule, convertModule, markdownModule, devrefModule];
const q = (obj = {}) => new URLSearchParams(obj);
const route = (mod, method, path) => mod.routes.find((r) => r.method === method && r.path === path);

// 两个方向都校验：返回的每个字段都有说明；说明里的每个字段也都在样例中出现过
function checkFields(r, ...samples) {
  for (const s of samples) assertFieldsDocumented(r, s);
  const paths = new Set();
  for (const s of samples) collectPaths(s, '', paths);
  const phantom = r.fields.map((f) => f.name).filter((name) => {
    const re = matcher(name.replace(/\[\]$/, ''));
    return ![...paths].some((p) => re.test(p));
  });
  assert.deepEqual(phantom, [], `${r.path} 的 fields 写了样例中没有出现的字段：${phantom.join(', ')}`);
}

// 按巡检的方式用文档示例调用：GET 放查询参数，in: 'body' 的放请求体
function callWithExamples(r, onlyRequired = false) {
  const query = {};
  const body = {};
  for (const p of r.params) {
    if (onlyRequired && !p.required) continue;
    (p.in === 'body' ? body : query)[p.name] = p.example;
  }
  return r.handler({ query: q(query), body: r.method === 'GET' ? undefined : body, params: {} });
}

const timed = (fn) => {
  const t = performance.now();
  const out = fn();
  return { out, ms: performance.now() - t };
};

// ---------------- 注册与文档 ----------------

test('模块元信息完整，参数都有 desc 和 example，路径不重复', () => {
  const names = new Set();
  const keys = new Set();
  for (const m of MODULES) {
    assert.equal(m.category, 'tools');
    assert.ok(m.title && m.description && m.source, m.name);
    assert.ok(!names.has(m.name));
    names.add(m.name);
    for (const r of m.routes) {
      assert.ok(r.path.startsWith('/api/'));
      assert.ok(r.summary);
      assert.ok(Array.isArray(r.fields) && r.fields.length, r.path);
      for (const p of r.params) assert.ok(p.desc && p.example != null && p.example !== '', `${r.path} ${p.name}`);
      if (r.method === 'POST' && r.params.some((p) => p.in === 'body')) assert.ok(r.params.every((p) => p.in === 'body'), r.path);
      const key = `${r.method} ${r.path}`;
      assert.ok(!keys.has(key), key);
      keys.add(key);
    }
  }
  assert.deepEqual([...names], ['diff', 'format-convert', 'markdown', 'devref']);
  assert.deepEqual([...keys].sort(), [
    'GET /api/devref/http-status', 'GET /api/devref/mime', 'GET /api/devref/port',
    'GET /api/tools/diff', 'POST /api/tools/convert', 'POST /api/tools/diff', 'POST /api/tools/markdown',
  ]);
});

test('每个接口用文档示例都能调用成功（只带必填 / 带全部示例）', async () => {
  for (const m of MODULES) {
    for (const r of m.routes) {
      for (const only of [true, false]) {
        const res = await callWithExamples(r, only);
        assert.ok(res && res.data, `${r.method} ${r.path}`);
        assertFieldsDocumented(r, res.data);
      }
    }
  }
});

// ---------------- 文本对比 ----------------

// 把 ops 依次应用到 a 上应当得到 b
function applyOps(ops, mode) {
  const sep = mode === 'line' ? '\n' : '';
  return ops.filter((o) => o.type !== 'delete').map((o) => o.value).join(sep);
}

// 朴素 LCS 长度，用来验证 Myers 结果是最短编辑
function lcs(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  return dp[0][0];
}

describe('文本对比', () => {
  test('Myers 结果合法且编辑距离最短（随机数组对比朴素 LCS）', () => {
    let seed = 42;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let t = 0; t < 1500; t++) {
      const A = Int32Array.from({ length: Math.floor(rnd() * 25) }, () => Math.floor(rnd() * 4));
      const B = Int32Array.from({ length: Math.floor(rnd() * 25) }, () => Math.floor(rnd() * 4));
      const runs = myersDiff(A, B);
      let ia = 0; let ib = 0; let eq = 0;
      for (const [type, n] of runs) {
        for (let k = 0; k < n; k++) {
          if (type === 0) { assert.equal(A[ia], B[ib]); ia++; ib++; eq++; }
          else if (type === 1) ib++;
          else ia++;
        }
      }
      assert.equal(ia, A.length);
      assert.equal(ib, B.length);
      assert.equal(eq, lcs([...A], [...B]), `${[...A]} | ${[...B]}`);
    }
  });

  test('按行对比：统计、ops 与 unified', () => {
    const r = diffText('a\nb\nc\n', 'a\nB\nc\nd\n');
    assert.equal(r.mode, 'line');
    assert.equal(r.identical, false);
    assert.deepEqual(r.stats, { added: 2, removed: 1, unchanged: 2, oldCount: 3, newCount: 4, similarity: 57.14 });
    assert.deepEqual(r.ops.map((o) => [o.type, o.oldStart, o.newStart, o.lines]), [
      ['equal', 1, 1, ['a']], ['delete', 2, 2, ['b']], ['insert', 3, 2, ['B']], ['equal', 3, 3, ['c']], ['insert', 4, 4, ['d']],
    ]);
    assert.equal(r.unified, '--- a\n+++ b\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n c\n+d\n');
    assert.equal(applyOps(r.ops, 'line'), 'a\nB\nc\nd');
  });

  test('unified 按上下文行数拆分 hunk，行数为 0 / 1 的写法与 diff -u 一致', () => {
    const a = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
    const b = a.replace('L2\n', 'X2\n').replace('L18\n', 'X18\n');
    const u = diffText(a, b, { context: 1 }).unified;
    assert.equal(u, '--- a\n+++ b\n@@ -1,3 +1,3 @@\n L1\n-L2\n+X2\n L3\n@@ -17,3 +17,3 @@\n L17\n-L18\n+X18\n L19\n');
    // context 足够大时合并成一个 hunk
    assert.equal(diffText(a, b, { context: 10 }).unified.match(/^@@/gm).length, 1);
    assert.equal(diffText('', 'x\n').unified, '--- a\n+++ b\n@@ -0,0 +1 @@\n+x\n');
    assert.equal(diffText('x\n', '').unified, '--- a\n+++ b\n@@ -1 +0,0 @@\n-x\n');
    assert.equal(diffText('same\n', 'same\n').unified, '');
  });

  test('末尾缺换行时标注 \\ No newline at end of file', () => {
    const u = diffText('a\nb', 'a\nb\n').unified;
    assert.equal(u, '--- a\n+++ b\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n');
    assert.equal(diffText('a\nb', 'a\nc').unified, '--- a\n+++ b\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n');
    assert.deepEqual(splitLines('a\r\nb\n'), { tokens: ['a', 'b'], eol: true });
  });

  test('按词 / 按字符对比，偏移为 UTF-16 下标', () => {
    const w = diffText('hello world', 'hello there world', { mode: 'word' });
    assert.equal(w.unified, null);
    assert.deepEqual(w.ops.map((o) => [o.type, o.value, o.oldStart, o.newStart]), [
      ['equal', 'hello ', 0, 0], ['insert', 'there ', 6, 6], ['equal', 'world', 6, 12],
    ]);
    assert.ok(!('lines' in w.ops[0]));
    assert.deepEqual(splitWords('我爱JS代码 ok!'), ['我', '爱', 'JS', '代', '码', ' ', 'ok', '!']);
    const c = diffText('😀a', '😀b', { mode: 'char' });
    assert.deepEqual(c.ops.map((o) => [o.type, o.value, o.oldStart]), [['equal', '😀', 0], ['delete', 'a', 2], ['insert', 'b', 3]]);
    assert.equal(c.stats.similarity, 50);
  });

  test('忽略大小写 / 空白', () => {
    assert.equal(diffText('Hello World', 'hello   world', { mode: 'word', ignoreCase: true, ignoreWhitespace: true }).identical, true);
    assert.equal(diffText(' a b\nC', 'ab \nc', { ignoreCase: true, ignoreWhitespace: true }).identical, true);
    assert.equal(diffText('A', 'a').identical, false);
    const r = diffText('', '');
    assert.equal(r.identical, true);
    assert.equal(r.stats.similarity, 100);
  });

  test('大输入：差异少时很快；完全不同时直接得出；差异爆炸时 400', () => {
    const a = Array.from({ length: 15000 }, (_, i) => `line ${i}`).join('\n');
    const b = Array.from({ length: 15000 }, (_, i) => `line ${i % 50 ? i : `x${i}`}`).join('\n');
    const { out, ms } = timed(() => diffText(a, b));
    assert.equal(out.stats.added, 300);
    assert.equal(out.stats.removed, 300);
    assert.ok(ms < 2000, `${ms}ms`);
    const other = Array.from({ length: 15000 }, (_, i) => `other ${i}`).join('\n');
    const d = timed(() => diffText(a, other));
    assert.equal(d.out.stats.unchanged, 0);
    assert.ok(d.ms < 1000, `${d.ms}ms`);
    // 两个随机字母串：编辑距离很大，超出计算量上限
    let x = 123456789;
    const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
    const r1 = Array.from({ length: 20000 }, () => 'abcd'[Math.floor(rnd() * 4)]).join('');
    const r2 = Array.from({ length: 20000 }, () => 'abcd'[Math.floor(rnd() * 4)]).join('');
    const t = performance.now();
    assert.throws(() => diffText(r1, r2, { mode: 'char' }), { status: 400, message: /差异过大/ });
    assert.ok(performance.now() - t < 3000);
  });

  test('大小与行数限制', () => {
    assert.throws(() => diffText('x'.repeat(MAX_BYTES + 1), ''), { status: 400, message: /a 过大/ });
    assert.throws(() => diffText('', '\n'.repeat(MAX_TOKENS.line + 1)), { status: 400, message: /b 超过 20000 行/ });
    assert.throws(() => diffText('x'.repeat(MAX_TOKENS.char + 1), '', { mode: 'char' }), { status: 400 });
    assert.throws(() => diffText('a', 'b', { mode: 'xx' }), { status: 400 });
  });

  test('接口：GET / POST，参数校验与字段说明', async () => {
    const get = route(diffModule, 'GET', '/api/tools/diff');
    const post = route(diffModule, 'POST', '/api/tools/diff');
    const r1 = await get.handler({ query: q({ a: 'x\ny\n', b: 'x\nz\n' }) });
    assert.equal(r1.data.stats.added, 1);
    const r2 = await post.handler({ query: q(), body: { a: 'hello world', b: 'hello there', mode: 'word', ignoreCase: true, context: 0 } });
    assert.equal(r2.data.mode, 'word');
    checkFields(post, r1.data, r2.data);
    // 空字符串是合法输入，缺参数才报错
    assert.equal((await post.handler({ query: q(), body: { a: '', b: '' } })).data.identical, true);
    await assert.rejects(post.handler({ query: q(), body: { a: 'x' } }), { status: 400, message: /缺少参数 b/ });
    await assert.rejects(get.handler({ query: q({ b: 'x' }) }), { status: 400, message: /缺少参数 a/ });
    await assert.rejects(post.handler({ query: q(), body: { a: 'x', b: 'y', mode: 'bad' } }), { status: 400 });
    await assert.rejects(post.handler({ query: q(), body: { a: 'x', b: 'y', context: 101 } }), { status: 400 });
    await assert.rejects(post.handler({ query: q(), body: { a: 'x', b: 'y', ignoreCase: 'yes' } }), { status: 400 });
    await assert.rejects(async () => post.handler({ query: q(), body: { a: ['x'], b: 'y' } }), { status: 400 });
  });
});

// ---------------- 格式转换 ----------------

describe('YAML 解析', () => {
  test('常用语法', () => {
    const doc = [
      '# 注释',
      'name: 张三   # 行尾注释',
      'age: 18',
      'pi: 3.14',
      'ok: true',
      'off: false',
      'nothing: ~',
      'empty:',
      'hex: 0x1F',
      'oct: 0o17',
      'exp: 1e3',
      'inf: -.inf',
      'ver: 1.2.3',
      'yes: yes',
      'quoted: "a\\tb \\u4e2d \\"q\\""',
      "single: 'it''s # not comment'",
      'url: http://x.com/a#b',
      'list:',
      '  - a',
      '  - b: 1',
      '    c: 2',
      '  - - x',
      '    - y',
      '  -',
      '    k: v',
      'compact:',
      '- 1',
      '- 2',
      'flow: [1, "two", {a: 1, b: [x, y]}, ]',
      "fobj: {a: 1, 'b c': null, d}",
      'multiFlow: [',
      '  1,  # 注释',
      '  2',
      ']',
      'plain: this is',
      '  continued',
      '',
      '  after blank',
      '"quoted key": 1',
      'dq: "multi',
      '  line"',
    ].join('\n');
    assert.deepEqual(parseYaml(doc), {
      name: '张三', age: 18, pi: 3.14, ok: true, off: false, nothing: null, empty: null, hex: 31, oct: 15, exp: 1000,
      inf: -Infinity, ver: '1.2.3', yes: 'yes', quoted: 'a\tb 中 "q"', single: "it's # not comment", url: 'http://x.com/a#b',
      list: ['a', { b: 1, c: 2 }, ['x', 'y'], { k: 'v' }],
      compact: [1, 2],
      flow: [1, 'two', { a: 1, b: ['x', 'y'] }],
      fobj: { a: 1, 'b c': null, d: null },
      multiFlow: [1, 2],
      plain: 'this is continued\nafter blank',
      'quoted key': 1,
      dq: 'multi line',
    });
  });

  test('多行文本 | 与 >，以及 - / + 结尾处理', () => {
    const doc = 'lit: |\n  line1\n    indented\n  line3\n\nstrip: |-\n  a\n  b\n\nkeep: |+\n  k\n\nfold: >\n  folded\n  text\n\n  para\n    more\n  end\nind: |2\n    two\nlast: x\n';
    assert.deepEqual(parseYaml(doc), {
      lit: 'line1\n  indented\nline3\n',
      strip: 'a\nb',
      keep: 'k\n\n',
      fold: 'folded text\npara\n  more\nend\n',
      ind: '  two\n',
      last: 'x',
    });
    assert.equal(parseYaml('- |\n  a\n  b\n- c')[0], 'a\nb\n');
  });

  test('文档标记、空文档、顶层标量与序列', () => {
    assert.equal(parseYaml(''), null);
    assert.equal(parseYaml('# 只有注释\n'), null);
    assert.equal(parseYaml('hello'), 'hello');
    assert.equal(parseYaml('42'), 42);
    assert.deepEqual(parseYaml('- a\n- b'), ['a', 'b']);
    assert.deepEqual(parseYaml('---\nfoo: bar\n...\n'), { foo: 'bar' });
    assert.deepEqual(parseYaml('\uFEFFa: 1\r\nb: 2\r\n'), { a: 1, b: 2 });
  });

  test('不支持的语法和错误给出中文 400', () => {
    const cases = [
      ['a: &x 1', /锚点/], ['a: *x', /别名/], ['a: !!str 1', /标签/], ['? a\n: b', /复杂键/], ['%YAML 1.2\n---\na: 1', /指令/],
      ['a: 1\na: 2', /重复的键/], ['a:\n\t- b', /Tab/], ['---\na: 1\n---\nb: 2', /多文档/],
      ['a: [1, 2', /括号没有闭合/], ['a: "x', /引号没有闭合/], ['a: b: c', /冒号/], ['a: 1\n  b: 2', /缩进/],
      ['a:\n  - x\n y: 1', /缩进|格式/], ['a: "\\q"', /转义/], ['a: - b', /序列项/],
    ];
    for (const [src, re] of cases) assert.throws(() => parseYaml(src), { status: 400, message: re }, src);
  });

  test('别名炸弹被直接拒绝', () => {
    const bomb = 'a: &a ["lol","lol"]\nb: &b [*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b]\nd: [*c,*c,*c,*c]';
    assert.throws(() => parseYaml(bomb), { status: 400, message: /锚点/ });
  });

  test('__proto__ 键不会污染原型', () => {
    const v = parseYaml('__proto__:\n  polluted: 1\n');
    assert.deepEqual(Object.keys(v), ['__proto__']);
    assert.equal(({}).polluted, undefined);
    assert.equal(Object.getPrototypeOf(v), Object.prototype);
    const f = parseYaml('x: {__proto__: 1}');
    assert.ok(Object.hasOwn(f.x, '__proto__'));
  });

  test('嵌套深度上限 100', () => {
    assert.throws(() => parseYaml('['.repeat(101) + ']'.repeat(101)), { status: 400, message: /嵌套层级/ });
    assert.throws(() => parseYaml('- '.repeat(150) + 'x'), { status: 400, message: /嵌套层级/ });
    const ok = Array.from({ length: 50 }, (_, i) => `${'  '.repeat(i)}k${i}:`).join('\n') + ' 1';
    assert.equal(convertFormat(ok, { from: 'yaml', to: 'json' }).rootType, 'object');
  });

  test('类型识别（YAML 1.2 核心模式）', () => {
    assert.equal(resolvePlain('True'), true);
    assert.equal(resolvePlain('NULL'), null);
    assert.equal(resolvePlain('-12'), -12);
    assert.equal(resolvePlain('12345678901234567890'), '12345678901234567890');
    assert.ok(Number.isNaN(resolvePlain('.nan')));
    assert.equal(resolvePlain('on'), 'on');
    assert.equal(resolvePlain('010'), 10);
  });
});

describe('YAML 输出与往返', () => {
  test('输出格式', () => {
    assert.equal(toYaml({ a: 1, b: [1, { c: 'x' }], d: {}, e: [], s: 'true', m: 'l1\nl2\n' }),
      'a: 1\nb:\n  - 1\n  - c: x\nd: {}\ne: []\ns: "true"\nm: |\n  l1\n  l2\n');
    assert.equal(toYaml([[1, 2], []]), '- - 1\n  - 2\n- []\n');
    assert.equal(toYaml('x'), 'x\n');
    assert.equal(toYaml(null), 'null\n');
  });

  test('需要引号的字符串都能原样读回', () => {
    const tricky = ['', ' lead', 'trail ', 'a: b', 'a #b', '#x', '-x', '- x', '[x]', '{x}', '&a', '*a', '!t', '|', '>', '%', '@', '`',
      'yes', 'No', 'on', 'null', '~', '1.5', '0x10', '.inf', '---', '...', 'x\n', 'x\n\n', '\n', 'a\nb', ' a\nb', 'a \nb', 'tab\there',
      'é\u2028', '"q"', "'s'", 'back\\slash', 'x:', 'ok:x', '中文: 值', '\u0000'];
    const obj = Object.fromEntries(tricky.map((s, i) => [s || `k${i}`, s]));
    obj.list = tricky;
    obj.nested = [{ deep: [[{ x: tricky.slice(0, 10) }]] }];
    assert.deepEqual(parseYaml(toYaml(obj)), obj);
  });

  test('随机数据往返（JSON → YAML → JSON）', () => {
    let seed = 1;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const chars = ['a', 'b', ' ', '\n', ':', '#', '-', '"', "'", '\\', '[', ']', '{', '}', ',', '&', '*', '!', '|', '>', '1', '.', '中', '\t', '%', '@', '?', '~'];
    const rs = () => Array.from({ length: Math.floor(rnd() * 8) }, () => chars[Math.floor(rnd() * chars.length)]).join('');
    const rv = (d) => {
      const r = rnd();
      if (d > 3 || r < 0.4) {
        const t = rnd();
        return t < 0.6 ? rs() : t < 0.7 ? Math.round(rnd() * 1000) / 10 : t < 0.8 ? null : t < 0.9 ? true : -5;
      }
      if (r < 0.7) return Array.from({ length: Math.floor(rnd() * 4) }, () => rv(d + 1));
      const o = {};
      for (let i = 0; i < Math.floor(rnd() * 4); i++) o[rs()] = rv(d + 1);
      return o;
    };
    for (let i = 0; i < 3000; i++) {
      const v = rv(0);
      assert.deepEqual(parseYaml(toYaml(v)), v, JSON.stringify(v));
    }
  });
});

describe('CSV', () => {
  test('引号、转义引号、字段内换行和分隔符', () => {
    assert.deepEqual(parseCsv('a,b\n"x, y","he said ""hi"""\n"multi\nline",2\r\n\n3,4\n'), [
      ['a', 'b'], ['x, y', 'he said "hi"'], ['multi\nline', '2'], ['3', '4'],
    ]);
    assert.deepEqual(parseCsv('a;b\n1;"2;3"', ';'), [['a', 'b'], ['1', '2;3']]);
    assert.deepEqual(parseCsv('a\tb\n1\t2', '\t'), [['a', 'b'], ['1', '2']]);
    assert.deepEqual(parseCsv('x,\n,'), [['x', ''], ['', '']]);
    assert.deepEqual(parseCsv('""\n'), [['']]);
    assert.throws(() => parseCsv('"abc'), { status: 400, message: /引号没有闭合/ });
    assert.throws(() => parseCsv('"a"b,c'), { status: 400, message: /多余字符/ });
  });

  test('表头：重名、空名、多出的列', () => {
    assert.deepEqual(csvToValue('name,name,\n1,2,3,4\n5'), [
      { name: '1', name_2: '2', column3: '3', column4: '4' },
      { name: '5', name_2: '', column3: '' },
    ]);
    assert.deepEqual(csvToValue('a,b\n1,2', { header: false }), [['a', 'b'], ['1', '2']]);
    assert.deepEqual(csvToValue(''), []);
  });

  test('输出：对象数组取键的并集，二维数组，简单值数组', () => {
    assert.equal(valueToCsv([{ a: 1, b: 'x,y' }, { c: 'q"q', a: { n: 1 } }]), 'a,b,c\n1,"x,y",\n"{""n"":1}",,"q""q"\n');
    assert.equal(valueToCsv([{ a: 1 }], { header: false }), '1\n');
    assert.equal(valueToCsv([[1, 2], [3, 'a\nb']]), '1,2\n3,"a\nb"\n');
    assert.equal(valueToCsv([1, null, ' s']), 'value\n1\n""\n" s"\n');
    assert.equal(valueToCsv({ a: 1 }), 'a\n1\n');
    assert.equal(valueToCsv([{ a: 1 }], { delimiter: '\t' }), 'a\n1\n');
    assert.throws(() => valueToCsv('x'), { status: 400 });
    assert.throws(() => valueToCsv([{ a: 1 }, [1]]), { status: 400, message: /混用/ });
  });

  test('随机数据往返（对象数组 → CSV → 对象数组）', () => {
    let seed = 3;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const chars = ['a', ' ', ',', '"', '\n', '\r', ';', '中', ''];
    const rs = () => Array.from({ length: Math.floor(rnd() * 6) }, () => chars[Math.floor(rnd() * chars.length)]).join('');
    for (let i = 0; i < 2000; i++) {
      const keys = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, k) => `k${k}`);
      const rows = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => Object.fromEntries(keys.map((k) => [k, rs()])));
      assert.deepEqual(csvToValue(valueToCsv(rows)), rows, JSON.stringify(rows));
    }
  });
});

describe('格式转换接口', () => {
  const r = route(convertModule, 'POST', '/api/tools/convert');
  const call = (body) => r.handler({ query: q(), body });

  test('各方向转换', async () => {
    const y2j = await call({ input: 'name: 张三\ntags:\n  - a\n', from: 'yaml', to: 'json' });
    assert.equal(y2j.data.output, '{\n  "name": "张三",\n  "tags": [\n    "a"\n  ]\n}');
    assert.equal(y2j.data.rootType, 'object');
    const j2y = await call({ input: '[{"a":1,"b":"x"},{"a":2}]', from: 'json', to: 'yaml' });
    assert.equal(j2y.data.output, '- a: 1\n  b: x\n- a: 2\n');
    const j2c = await call({ input: '[{"a":1,"b":"x"},{"a":2}]', from: 'json', to: 'csv' });
    assert.equal(j2c.data.output, 'a,b\n1,x\n2,\n');
    const c2j = await call({ input: 'a;b\n1;2\n', from: 'csv', to: 'json', delimiter: ';', indent: 0 });
    assert.equal(c2j.data.output, '[{"a":"1","b":"2"}]');
    const c2y = await call({ input: 'a,b\n1,2\n', from: 'csv', to: 'yaml', header: false });
    assert.equal(c2y.data.output, '- - a\n  - b\n- - "1"\n  - "2"\n');
    const j2j = await call({ input: '{"a":[1]}', from: 'json', to: 'json', indent: 4 });
    assert.equal(j2j.data.output, '{\n    "a": [\n        1\n    ]\n}');
    checkFields(r, y2j.data, c2y.data);
    assert.equal(y2j.data.inputBytes, Buffer.byteLength('name: 张三\ntags:\n  - a\n'));
  });

  test('校验与限制', async () => {
    await assert.rejects(call({ from: 'json', to: 'yaml' }), { status: 400, message: /缺少参数 input/ });
    await assert.rejects(call({ input: '{}', from: 'xml', to: 'json' }), { status: 400 });
    await assert.rejects(call({ input: '{}', from: 'json' }), { status: 400, message: /缺少参数 to/ });
    await assert.rejects(call({ input: '{bad', from: 'json', to: 'yaml' }), { status: 400, message: /JSON 格式错误/ });
    await assert.rejects(call({ input: 'a', from: 'csv', to: 'json', delimiter: 'x' }), { status: 400, message: /delimiter/ });
    await assert.rejects(call({ input: '1', from: 'json', to: 'csv' }), { status: 400 });
    await assert.rejects(call({ input: '{}', from: 'json', to: 'yaml', indent: 3 }), { status: 400 });
    const deep = '['.repeat(101) + ']'.repeat(101);
    await assert.rejects(call({ input: deep, from: 'json', to: 'yaml' }), { status: 400, message: /嵌套层级/ });
    assert.throws(() => convertFormat('"' + 'x'.repeat(CONVERT_MAX) + '"', { from: 'json', to: 'yaml' }), { status: 400, message: /过大/ });
    // YAML 的 .inf 转 JSON 时变成 null（JSON 无法表示）
    assert.equal(convertFormat('a: .inf', { from: 'yaml', to: 'json', indent: 0 }).output, '{"a":null}');
  });

  test('接近 1 MB 的病态输入也能很快处理', () => {
    const M = 1000 * 1000;
    const cases = [
      ['yaml', 'a: "' + 'x \n'.repeat(M / 3 - 10)],
      ['yaml', 'a: "' + 'x   \n'.repeat(M / 5 - 10) + '"'],
      ['yaml', 'a' + ' '.repeat(M - 10) + 'b'],
      ['yaml', 'a' + ':x'.repeat(M / 2 - 10)],
      ['yaml', '['.repeat(M / 2)],
      ['yaml', '- '.repeat(M / 2)],
      ['yaml', "'".repeat(M - 10)],
      ['yaml', Array.from({ length: 60000 }, (_, i) => `k${i}: v${i}`).join('\n')],
      ['yaml', 'a: |\n' + '  line\n'.repeat(M / 7 - 10)],
      ['csv', '"' + 'a""'.repeat(M / 3 - 10) + '"'],
      ['csv', 'a,b\n'.repeat(M / 4 - 10)],
    ];
    for (const [from, input] of cases) {
      const t = performance.now();
      try { convertFormat(input, { from, to: 'json' }); } catch (err) { assert.equal(err.status, 400); }
      const ms = performance.now() - t;
      assert.ok(ms < 1500, `${from} ${input.slice(0, 20)} ${ms}ms`);
    }
  });
});

// ---------------- Markdown ----------------

describe('Markdown 渲染', () => {
  const html = (md, opts) => markdownToHtml(md, opts).html;

  test('标题、段落、强调、删除线、行内代码、硬换行', () => {
    assert.equal(html('# 标题 *一*\n\n## Two ##\n\nSetext\n===\n\nH2\n---'),
      '<h1 id="标题-一">标题 <em>一</em></h1>\n<h2 id="two">Two</h2>\n<h1 id="setext">Setext</h1>\n<h2 id="h2">H2</h2>\n');
    assert.equal(renderInline('**b** *i* _i_ ***bi*** ~~d~~ `a<b`'), '<strong>b</strong> <em>i</em> <em>i</em> <em><strong>bi</strong></em> <del>d</del> <code>a&lt;b</code>');
    assert.equal(renderInline('*a **b** c*'), '<em>a <strong>b</strong> c</em>');
    assert.equal(renderInline('foo_bar_baz'), 'foo_bar_baz');
    assert.equal(renderInline('*a*b*'), '<em>a</em>b*');
    assert.equal(renderInline('`` a ` b ``'), '<code>a ` b</code>');
    assert.equal(renderInline('\\*not\\* &copy; & <'), '*not* &copy; &amp; &lt;');
    assert.equal(html('a  \nb\\\nc\nd'), '<p>a<br />\nb<br />\nc\nd</p>\n');
  });

  test('代码块', () => {
    assert.equal(html('```js\nconst x = "<y>";\n```'), '<pre><code class="language-js">const x = &quot;&lt;y&gt;&quot;;\n</code></pre>\n');
    assert.equal(html('~~~\n```\n~~~'), '<pre><code>```\n</code></pre>\n');
    assert.equal(html('    indented\n    code'), '<pre><code>indented\ncode\n</code></pre>\n');
    assert.equal(html('```"><script>\nx\n```'), '<pre><code class="language-script">x\n</code></pre>\n');
    assert.equal(html('```\nunclosed'), '<pre><code>unclosed\n</code></pre>\n');
  });

  test('引用、列表、任务列表、分隔线', () => {
    assert.equal(html('> quote **q**\nlazy\n> > nested'),
      '<blockquote>\n<p>quote <strong>q</strong>\nlazy</p>\n<blockquote>\n<p>nested</p>\n</blockquote>\n</blockquote>\n');
    assert.equal(html('- a\n- b\n  - c\n  - d\n- [x] done\n- [ ] todo'),
      '<ul>\n<li>a</li>\n<li>b\n<ul>\n<li>c</li>\n<li>d</li>\n</ul>\n</li>\n<li class="task-list-item"><input type="checkbox" disabled checked /> done</li>\n<li class="task-list-item"><input type="checkbox" disabled /> todo</li>\n</ul>\n');
    assert.equal(html('1. one\n2. two\n\n3) three'), '<ol>\n<li>one</li>\n<li>two</li>\n</ol>\n<ol start="3">\n<li>three</li>\n</ol>\n');
    assert.equal(html('* a\n\n* b'), '<ul>\n<li>\n<p>a</p>\n</li>\n<li>\n<p>b</p>\n</li>\n</ul>\n');
    assert.equal(html('- a\n\n  b\n- c'), '<ul>\n<li>\n<p>a</p>\n<p>b</p>\n</li>\n<li>\n<p>c</p>\n</li>\n</ul>\n');
    assert.equal(html('***\n- - -\n___'), '<hr />\n<hr />\n<hr />\n');
    // 非 1 开头的有序列表不能打断段落
    assert.equal(html('text\n2. no'), '<p>text\n2. no</p>\n');
  });

  test('链接、图片、自动链接', () => {
    assert.equal(renderInline('[a](https://x.com "T")'), '<a href="https://x.com" title="T" rel="noopener noreferrer">a</a>');
    assert.equal(renderInline('![p](/i.png)'), '<img src="/i.png" alt="p" />');
    assert.equal(renderInline('[![i](a.png)](b)'), '<a href="b" rel="noopener noreferrer"><img src="a.png" alt="i" /></a>');
    assert.equal(renderInline('![a *b* [c](d)](e.png)'), '<img src="e.png" alt="a b c" />');
    assert.equal(renderInline('[a](<b c>) [x](y(z))'), '<a href="b%20c" rel="noopener noreferrer">a</a> <a href="y(z)" rel="noopener noreferrer">x</a>');
    assert.equal(renderInline('[a [b](c) d](e)'), '[a <a href="c" rel="noopener noreferrer">b</a> d](e)');
    assert.equal(renderInline('[x [a](b)] [c](d)'), '[x <a href="b" rel="noopener noreferrer">a</a>] <a href="d" rel="noopener noreferrer">c</a>');
    assert.equal(renderInline('[a] (b) [c]'), '[a] (b) [c]');
    assert.equal(renderInline('<https://x.y/?a=1&b=2> <me@x.com>'), '<a href="https://x.y/?a=1&amp;b=2" rel="noopener noreferrer">https://x.y/?a=1&amp;b=2</a> <a href="mailto:me@x.com" rel="noopener noreferrer">me@x.com</a>');
    assert.equal(renderInline('see https://example.com/a_(b). and www.foo.com, ok'),
      'see <a href="https://example.com/a_(b)" rel="noopener noreferrer">https://example.com/a_(b)</a>. and <a href="http://www.foo.com" rel="noopener noreferrer">www.foo.com</a>, ok');
    assert.equal(renderInline('[see https://x.com](/y)'), '<a href="/y" rel="noopener noreferrer">see https://x.com</a>');
  });

  test('GFM 表格', () => {
    assert.equal(html('| a | b | c |\n|:-:|--:|:--|\n| 1 | 2 \\| 3 |\n| x |'),
      '<table>\n<thead>\n<tr><th style="text-align:center">a</th><th style="text-align:right">b</th><th style="text-align:left">c</th></tr>\n</thead>\n<tbody>\n<tr><td style="text-align:center">1</td><td style="text-align:right">2 | 3</td><td style="text-align:left"></td></tr>\n<tr><td style="text-align:center">x</td><td style="text-align:right"></td><td style="text-align:left"></td></tr>\n</tbody>\n</table>\n');
    // 列数不一致不是表格
    assert.equal(html('a | b\n---'), '<h2 id="a--b">a | b</h2>\n');
  });

  test('目录与字数', () => {
    const r = markdownToHtml('# Hello World\n\n## Hello World\n\n## 你好，世界！\n\n### `code` & <b>\n\n正文 3 个 words.');
    assert.deepEqual(r.toc, [
      { level: 1, text: 'Hello World', id: 'hello-world' },
      { level: 2, text: 'Hello World', id: 'hello-world-1' },
      { level: 2, text: '你好，世界！', id: '你好世界' },
      { level: 3, text: 'code & <b>', id: 'code--b' },
    ]);
    assert.ok(r.html.includes('<h3 id="code--b"><code>code</code> &amp; &lt;b&gt;</h3>'));
    // Hello World ×2、你好世界、code、b、正文、3、个、words
    assert.equal(r.words, 2 + 2 + 4 + 2 + 2 + 1 + 1 + 1);
    assert.equal(markdownToHtml('').html, '');
    assert.equal(markdownToHtml('# #').toc[0].id, 'section');
  });
});

// 按顺序取出标签的属性名（属性值里的文字不算）
function attrNames(tag) {
  const rest = tag.slice(/^<[a-z0-9]+/i.exec(tag)[0].length);
  const re = /\s+([a-z-]+)(?:="[^"]*")?/iy;
  const names = [];
  let m;
  while ((m = re.exec(rest))) names.push(m[1].toLowerCase());
  return names;
}

describe('Markdown 安全', () => {
  const html = (md, opts) => markdownToHtml(md, opts).html;
  const XSS = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](  javascript:alert(1)  )',
    '[x](<javascript:alert(1)>)',
    '[x](java\\script:alert(1))',
    '[x](&#106;avascript:alert(1))',
    '[x](vbscript:msgbox(1))',
    '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '![x](javascript:alert(1))',
    '![x](data:image/svg+xml,<svg onload=alert(1)>)',
    '<javascript:alert(1)>',
    '[x](https://ok.com "a\\" onmouseover=\\"alert(1)")',
    '[x](https://ok.com" onmouseover="alert(1))',
    '![x" onerror="alert(1)](/a.png)',
    '```"><img src=x onerror=alert(1)>\ncode\n```',
    '# <img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">x</a>',
    '<!-- --><svg/onload=alert(1)>',
    '| <script> |\n|---|\n| <img onerror=x> |',
  ];

  test('默认 sanitize：原始 HTML 全部转义，危险链接被丢弃', () => {
    for (const md of XSS) {
      const out = html(md);
      assert.doesNotMatch(out, /<(?!\/?(?:p|a|img|h1|pre|code|table|thead|tbody|tr|th|td|br)\b)[a-z!]/i, `${md} → ${out}`);
      assert.doesNotMatch(out, /href="\s*(?:javascript|vbscript|data):/i, md);
      assert.doesNotMatch(out, /src="\s*(?:javascript|data):/i, md);
      // 所有属性都是 name="value" 形式，值里不含未转义的引号，事件属性不会出现在标签里
      for (const tag of out.match(/<[a-z][^>]*>/gi) ?? []) {
        assert.match(tag, /^<[a-z0-9]+(?:\s+[a-z-]+(?:="[^"]*")?)*\s*\/?>$/i, `${md} → ${tag}`);
        assert.ok(attrNames(tag).every((n) => ['href', 'src', 'alt', 'title', 'rel', 'id', 'class', 'style', 'type', 'disabled', 'checked', 'start'].includes(n)), `${md} → ${tag}`);
      }
    }
    assert.equal(html('[x](javascript:alert(1))'), '<p>x</p>\n');
    assert.equal(html('![x](javascript:alert(1))'), '<p>x</p>\n');
    assert.equal(html('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>\n');
    assert.equal(html('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>\n');
  });

  test('sanitize=false 保留原始 HTML，但链接过滤仍然生效', () => {
    assert.equal(html('<div>raw</div>\n\ntext <b>x</b>', { sanitize: false }), '<div>raw</div>\n<p>text <b>x</b></p>\n');
    assert.equal(html('[x](javascript:alert(1))', { sanitize: false }), '<p>x</p>\n');
  });

  test('safeUrl', () => {
    for (const ok of ['https://a.com', 'http://a.com', 'mailto:a@b.c', '/p', 'p/q', '?x=1', '#top', '../a', 'a.html?x=a:b']) assert.ok(safeUrl(ok), ok);
    for (const bad of ['javascript:x', ' JAVASCRIPT:x', 'java\tscript:x', 'java\nscript:x', '\u0001javascript:x', 'data:image/png;base64,AA', 'vbscript:x', 'file:///etc/passwd', 'ftp://x', 'x:y']) {
      assert.equal(safeUrl(bad), null, JSON.stringify(bad));
    }
    assert.equal(safeUrl('a b"<>'), 'a%20b%22%3C%3E');
  });

  test('病态输入（ReDoS 式）都在 1 秒内完成', () => {
    const N = 50000;
    const cases = {
      stars: '*'.repeat(N) + 'a',
      unders: 'a' + '_'.repeat(N) + 'a',
      brackets: '['.repeat(N),
      closeBrackets: ']'.repeat(N),
      imgOpen: '!['.repeat(N / 2),
      alternating: '*a'.repeat(N),
      underWords: '_a_ '.repeat(N / 2),
      bracketParens: '[]('.repeat(N / 2),
      nestedLinks: '['.repeat(N / 2) + '](x)'.repeat(N / 2),
      ticks: '` ``'.repeat(N / 2),
      angles: '<a:b'.repeat(N / 2),
      quotes: '>'.repeat(N),
      listMarkers: '- '.repeat(N) + 'x',
      nestedQuotes: Array.from({ length: 5000 }, (_, i) => `${'>'.repeat(i % 40)} x`).join('\n'),
      deepLists: Array.from({ length: 2000 }, (_, i) => `${' '.repeat((i % 200) * 2)}- x`).join('\n'),
      urlPunct: 'http://a.b' + '.'.repeat(N) + ')'.repeat(N),
      links: '[a](b) '.repeat(N / 2),
      mixed: '*_~[`<&!\\'.repeat(N / 4),
      emphasis: '**a '.repeat(N / 2) + ' b**'.repeat(N / 2),
      lazyParagraph: '- a\n' + 'lazy\n'.repeat(N),
      table: '|a|\n|-|\n' + '|x|\n'.repeat(N),
      titles: '[a](b "'.repeat(N / 4),
      emails: '<a@'.repeat(N / 2),
    };
    for (const [name, md] of Object.entries(cases)) {
      const { ms } = timed(() => markdownToHtml(md));
      assert.ok(ms < 1000, `${name}: ${ms}ms`);
    }
    const { ms } = timed(() => markdownToHtml('<!--'.repeat(N), { sanitize: false }));
    assert.ok(ms < 1000, `comments: ${ms}ms`);
  });

  test('大小限制与接口校验', async () => {
    assert.throws(() => markdownToHtml('x'.repeat(MD_MAX + 1)), { status: 400, message: /过大/ });
    const r = route(markdownModule, 'POST', '/api/tools/markdown');
    const res = await r.handler({ query: q(), body: { text: '# 标题\n\n[a](https://x.com)\n\n- [x] ok', sanitize: true } });
    checkFields(r, res.data);
    assert.equal((await r.handler({ query: q(), body: { text: '' } })).data.html, '');
    await assert.rejects(r.handler({ query: q(), body: {} }), { status: 400, message: /缺少参数 text/ });
    await assert.rejects(r.handler({ query: q(), body: { text: 'x', sanitize: 'no' } }), { status: 400 });
    await assert.rejects(r.handler({ query: q(), body: { text: ['x'] } }), { status: 400 });
    const raw = await r.handler({ query: q(), body: { text: '<b>x</b>', sanitize: false } });
    assert.equal(raw.data.html, '<p><b>x</b></p>\n');
  });
});

// ---------------- 开发速查 ----------------

describe('开发速查', () => {
  test('HTTP 状态码', async () => {
    const r = route(devrefModule, 'GET', '/api/devref/http-status');
    const all = await r.handler({ query: q() });
    assert.equal(all.data.total, DATA.STATUS.length);
    assert.ok(all.data.total >= 60);
    const codes = all.data.items.map((s) => s.code);
    assert.deepEqual(codes, [...codes].sort((a, b) => a - b));
    for (const c of [100, 200, 204, 206, 301, 302, 304, 307, 308, 400, 401, 403, 404, 405, 409, 413, 418, 422, 429, 451, 500, 502, 503, 504]) assert.ok(codes.includes(c), c);
    const one = await r.handler({ query: q({ code: '404' }) });
    assert.deepEqual(one.data.items[0], {
      code: 404, name: 'Not Found', nameZh: '未找到', description: '服务器找不到请求的资源', category: '4xx',
      categoryDesc: '客户端错误：请求有误或无法被满足', spec: 'RFC 9110',
    });
    assert.ok((await r.handler({ query: q({ code: '5XX' }) })).data.items.every((s) => s.category === '5xx'));
    assert.deepEqual(lookupStatus({ q: 'teapot' }).items.map((s) => s.code), [418]);
    assert.ok(lookupStatus({ q: '重定向' }).items.some((s) => s.code === 301));
    assert.equal(lookupStatus({ code: '4xx', q: '限流' }).items[0].code, 429);
    await assert.rejects(r.handler({ query: q({ code: '299' }) }), { status: 404, message: /未收录状态码 299/ });
    await assert.rejects(r.handler({ query: q({ code: 'abc' }) }), { status: 400 });
    assert.equal(lookupStatus({ q: '不存在的词' }).total, 0);
    checkFields(r, all.data);
  });

  test('MIME 类型', async () => {
    const r = route(devrefModule, 'GET', '/api/devref/mime');
    const all = await r.handler({ query: q() });
    assert.ok(all.data.total >= 150);
    const exts = DATA.MIME.map((m) => m.ext);
    assert.equal(new Set(exts).size, exts.length);
    for (const m of DATA.MIME) assert.match(m.type, /^[a-z]+\/[a-zA-Z0-9.+-]+$/, m.ext);
    const pick = (ext) => lookupMime({ ext }).items[0].type;
    assert.equal(pick('png'), 'image/png');
    assert.equal(pick('.JSON'), 'application/json');
    assert.equal(pick('report.pdf'), 'application/pdf');
    assert.equal(pick('docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(pick('woff2'), 'font/woff2');
    assert.equal(pick('mp4'), 'video/mp4');
    assert.equal(pick('svg'), 'image/svg+xml');
    assert.deepEqual(lookupMime({ type: 'Text/HTML; charset=utf-8' }).items.map((m) => m.ext), ['html', 'htm']);
    assert.ok(lookupMime({ q: 'word' }).items.some((m) => m.ext === 'docx'));
    await assert.rejects(r.handler({ query: q({ ext: 'zzzz' }) }), { status: 404, message: /未收录扩展名 \.zzzz/ });
    await assert.rejects(r.handler({ query: q({ type: 'x/y' }) }), { status: 404 });
    checkFields(r, all.data);
  });

  test('常用端口', async () => {
    const r = route(devrefModule, 'GET', '/api/devref/port');
    const all = await r.handler({ query: q() });
    assert.ok(all.data.total >= 80);
    const ports = DATA.PORTS.map((p) => p.port);
    assert.equal(new Set(ports).size, ports.length);
    assert.deepEqual(ports, [...ports].sort((a, b) => a - b));
    const one = (await r.handler({ query: q({ port: '3306' }) })).data.items[0];
    assert.deepEqual(one, { port: 3306, protocol: 'tcp', service: 'mysql', description: 'MySQL / MariaDB 数据库', range: 'registered' });
    assert.equal(lookupPort({ port: 22 }).items[0].service, 'ssh');
    assert.equal(lookupPort({ port: 443 }).items[0].range, 'well-known');
    assert.equal(lookupPort({ port: 51820 }).items[0].range, 'dynamic');
    assert.ok(lookupPort({ protocol: 'udp' }).items.every((p) => p.protocol.includes('udp')));
    assert.ok(lookupPort({ protocol: 'udp' }).items.some((p) => p.port === 53));
    assert.ok(lookupPort({ q: 'redis' }).items.some((p) => p.port === 6379));
    assert.ok(lookupPort({ q: '数据库' }).total >= 5);
    await assert.rejects(r.handler({ query: q({ port: '4' }) }), { status: 404, message: /未收录端口 4/ });
    await assert.rejects(r.handler({ query: q({ port: '70000' }) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ protocol: 'sctp' }) }), { status: 400 });
    checkFields(r, all.data);
  });
});

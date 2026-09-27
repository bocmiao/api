import { HttpError, param } from '../../lib/http.js';
import { getAndPost, truthy } from './inputs.js';

// 文本对比：Myers 差分算法（O(ND)，线性空间的“中间蛇”二分版本，与 diff-match-patch 的 bisect 同思路）。
// 支持按行 / 按词 / 按字符对比，可忽略空白和大小写，并输出统一格式（unified）差异文本。
// 防滥用：限制输入大小、行数（词数 / 字符数），并给算法设计算量预算，差异过大时返回 400 而不是长时间占用 CPU。

export const MAX_BYTES = 200 * 1024;
export const MAX_TOKENS = { line: 20_000, word: 50_000, char: 20_000 };
export const MAX_WORK = 20_000_000;
export const MAX_OPS = 5000;
const MODES = ['line', 'word', 'char'];

// ---------------- 切分 ----------------

// 按行切分：\n 和 \r\n 都算换行；末尾的换行不产生多余的空行，另用 eol 记录有没有
export function splitLines(text) {
  if (text === '') return { tokens: [], eol: true };
  const tokens = text.split(/\r?\n/);
  const eol = tokens[tokens.length - 1] === '';
  if (eol) tokens.pop();
  return { tokens, eol };
}

// 按词切分：连续空白、单个汉字、连续的字母数字下划线、其他单个字符各算一个词
const WORD_RE = /\s+|\p{Script=Han}|[[\p{L}\p{N}_]--\p{Script=Han}]+|[^]/gv;
export const splitWords = (text) => text.match(WORD_RE) ?? [];

// 按字符切分：按 Unicode 码点，emoji 等代理对算 1 个字符
export const splitChars = (text) => [...text];

function tokenize(text, mode) {
  if (mode === 'line') return splitLines(text);
  return { tokens: mode === 'word' ? splitWords(text) : splitChars(text), eol: true };
}

// ---------------- Myers 差分 ----------------

// 对两个整数数组求最短编辑脚本，返回 [[type, count], ...]，type：0 相同 / 1 插入 / -1 删除
export function myersDiff(A, B, budget = { left: MAX_WORK }) {
  const runs = [];
  const push = (type, n) => {
    if (n <= 0) return;
    const last = runs[runs.length - 1];
    if (last && last[0] === type) last[1] += n;
    else runs.push([type, n]);
  };
  const spend = (n) => {
    budget.left -= n;
    if (budget.left < 0) throw new HttpError(400, '两段文本差异过大，超出计算量上限，请缩小对比范围或改用按行对比');
  };

  // 在 A[a0,a1) 与 B[b0,b1) 上递归求差分
  const walk = (a0, a1, b0, b1) => {
    // 去掉公共前缀、公共后缀
    let pre = 0;
    while (a0 + pre < a1 && b0 + pre < b1 && A[a0 + pre] === B[b0 + pre]) pre++;
    let suf = 0;
    while (a1 - suf > a0 + pre && b1 - suf > b0 + pre && A[a1 - suf - 1] === B[b1 - suf - 1]) suf++;
    spend(pre + suf + 1);
    push(0, pre);
    a0 += pre; b0 += pre; a1 -= suf; b1 -= suf;
    if (a0 === a1) push(1, b1 - b0);
    else if (b0 === b1) push(-1, a1 - a0);
    else {
      const split = bisect(a0, a1, b0, b1);
      if (split) {
        walk(a0, split[0], b0, split[1]);
        walk(split[0], a1, split[1], b1);
      } else {
        push(-1, a1 - a0);
        push(1, b1 - b0);
      }
    }
    push(0, suf);
  };

  // 同时从两端搜索，找到中间蛇（前后两条路径重叠）处的切分点
  const bisect = (a0, a1, b0, b1) => {
    const N = a1 - a0;
    const M = b1 - b0;
    const maxD = Math.ceil((N + M) / 2);
    const off = maxD;
    const len = 2 * maxD + 2;
    const v1 = new Int32Array(len).fill(-1);
    const v2 = new Int32Array(len).fill(-1);
    v1[off + 1] = 0;
    v2[off + 1] = 0;
    const delta = N - M;
    const front = delta % 2 !== 0;
    let k1start = 0; let k1end = 0; let k2start = 0; let k2end = 0;
    for (let d = 0; d < maxD; d++) {
      spend(2 * d + 2);
      for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
        const i1 = off + k1;
        let x1 = (k1 === -d || (k1 !== d && v1[i1 - 1] < v1[i1 + 1])) ? v1[i1 + 1] : v1[i1 - 1] + 1;
        let y1 = x1 - k1;
        const sx = x1;
        while (x1 < N && y1 < M && A[a0 + x1] === B[b0 + y1]) { x1++; y1++; }
        if (x1 > sx) spend(x1 - sx);
        v1[i1] = x1;
        if (x1 > N) k1end += 2;
        else if (y1 > M) k1start += 2;
        else if (front) {
          const i2 = off + delta - k1;
          if (i2 >= 0 && i2 < len && v2[i2] !== -1 && x1 >= N - v2[i2]) return [a0 + x1, b0 + y1];
        }
      }
      for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
        const i2 = off + k2;
        let x2 = (k2 === -d || (k2 !== d && v2[i2 - 1] < v2[i2 + 1])) ? v2[i2 + 1] : v2[i2 - 1] + 1;
        let y2 = x2 - k2;
        const sx = x2;
        while (x2 < N && y2 < M && A[a1 - x2 - 1] === B[b1 - y2 - 1]) { x2++; y2++; }
        if (x2 > sx) spend(x2 - sx);
        v2[i2] = x2;
        if (x2 > N) k2end += 2;
        else if (y2 > M) k2start += 2;
        else if (!front) {
          const i1 = off + delta - k2;
          if (i1 >= 0 && i1 < len && v1[i1] !== -1) {
            const x1 = v1[i1];
            const y1 = off + x1 - i1;
            if (x1 >= N - x2) return [a0 + x1, b0 + y1];
          }
        }
      }
    }
    return null;
  };

  // 两边没有任何相同的元素时直接得出结果（全部删除再全部插入），不必搜索
  const seen = new Set(A);
  if (!B.some((x) => seen.has(x))) {
    push(-1, A.length);
    push(1, B.length);
    return runs;
  }
  walk(0, A.length, 0, B.length);
  return runs;
}

// ---------------- 对外的对比函数 ----------------

// 比较用的键：忽略空白（去掉所有空白字符，与 diff -w 一致）/ 忽略大小写
function keyOf(token, { ignoreWhitespace, ignoreCase, mode }) {
  let k = token;
  if (ignoreWhitespace) k = mode === 'line' ? k.replace(/\s+/g, '') : (/^\s+$/.test(k) ? ' ' : k);
  if (ignoreCase) k = k.toLowerCase();
  return k;
}

function checkInput(name, text, mode, count) {
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new HttpError(400, `${name} 过大（最多 ${MAX_BYTES / 1024} KB）`);
  const limit = MAX_TOKENS[mode];
  const unit = { line: '行', word: '个词', char: '个字符' }[mode];
  if (count > limit) throw new HttpError(400, `${name} 超过 ${limit} ${unit}，无法按 ${mode} 模式对比`);
}

const round2 = (n) => Math.round(n * 100) / 100;

export function diffText(a, b, { mode = 'line', ignoreWhitespace = false, ignoreCase = false, context = 3 } = {}) {
  if (!MODES.includes(mode)) throw new HttpError(400, `mode 只能是 ${MODES.join(' / ')}`);
  const ta = tokenize(a, mode);
  const tb = tokenize(b, mode);
  checkInput('a', a, mode, ta.tokens.length);
  checkInput('b', b, mode, tb.tokens.length);

  // 把每个词映射成整数，比较更快；行模式下末尾没有换行的最后一行加标记，只和同样没有换行的行相等
  const ids = new Map();
  const opts = { ignoreWhitespace, ignoreCase, mode };
  const toIds = ({ tokens, eol }) => Int32Array.from(tokens, (t, i) => {
    let k = keyOf(t, opts);
    if (mode === 'line' && !eol && i === tokens.length - 1) k += '\u0000noeol';
    let id = ids.get(k);
    if (id === undefined) { id = ids.size; ids.set(k, id); }
    return id;
  });
  const runs = myersDiff(toIds(ta), toIds(tb));

  // 组装 ops
  const join = (arr) => arr.join(mode === 'line' ? '\n' : '');
  const TYPE = { 0: 'equal', 1: 'insert', '-1': 'delete' };
  const ops = [];
  let ia = 0; let ib = 0; let posA = 0; let posB = 0;
  let added = 0; let removed = 0; let unchanged = 0;
  for (const [t, n] of runs) {
    const src = t === 1 ? tb.tokens.slice(ib, ib + n) : ta.tokens.slice(ia, ia + n);
    const value = join(src);
    if (ops.length < MAX_OPS) {
      const op = {
        type: TYPE[t],
        count: n,
        oldStart: mode === 'line' ? ia + 1 : posA,
        newStart: mode === 'line' ? ib + 1 : posB,
        value,
      };
      if (mode === 'line') op.lines = src;
      ops.push(op);
    }
    const chars = value.length + (mode === 'line' ? n : 0);
    if (t === 0) { unchanged += n; ia += n; ib += n; posA += chars; posB += join(tb.tokens.slice(ib - n, ib)).length + (mode === 'line' ? n : 0); }
    else if (t === 1) { added += n; ib += n; posB += chars; }
    else { removed += n; ia += n; posA += chars; }
  }

  const total = ta.tokens.length + tb.tokens.length;
  return {
    mode,
    identical: added === 0 && removed === 0,
    stats: {
      added,
      removed,
      unchanged,
      oldCount: ta.tokens.length,
      newCount: tb.tokens.length,
      similarity: total === 0 ? 100 : round2((200 * unchanged) / total),
    },
    ops,
    opsTruncated: runs.length > MAX_OPS,
    unified: mode === 'line' ? unifiedDiff(runs, ta, tb, context) : null,
  };
}

// 统一格式（与 diff -u / git diff 相同）：--- a / +++ b / @@ -起始,行数 +起始,行数 @@
export function unifiedDiff(runs, ta, tb, context = 3) {
  // 展开成逐行的编辑序列，再按上下文行数分组成 hunk
  const lines = [];
  let ia = 0; let ib = 0;
  for (const [t, n] of runs) {
    for (let k = 0; k < n; k++) {
      if (t === 0) lines.push([' ', ia++, ib++]);
      else if (t === -1) lines.push(['-', ia++, ib]);
      else lines.push(['+', ia, ib++]);
    }
  }
  const changed = [];
  lines.forEach((l, i) => { if (l[0] !== ' ') changed.push(i); });
  if (!changed.length) return '';

  const out = ['--- a', '+++ b'];
  const lastA = ta.tokens.length - 1;
  const lastB = tb.tokens.length - 1;
  let h = 0;
  while (h < changed.length) {
    const from = Math.max(0, changed[h] - context);
    let end = changed[h];
    while (h + 1 < changed.length && changed[h + 1] - end <= 2 * context + 1) end = changed[++h];
    h++;
    const to = Math.min(lines.length - 1, end + context);
    const seg = lines.slice(from, to + 1);
    const oldN = seg.filter((l) => l[0] !== '+').length;
    const newN = seg.filter((l) => l[0] !== '-').length;
    const oldStart = seg[0][1] + 1;
    const newStart = seg[0][2] + 1;
    const fmt = (s, n) => (n === 0 ? `${s - 1},0` : n === 1 ? `${s}` : `${s},${n}`);
    out.push(`@@ -${fmt(oldStart, oldN)} +${fmt(newStart, newN)} @@`);
    for (const [t, x, y] of seg) {
      out.push(t + (t === '+' ? tb.tokens[y] : ta.tokens[x]));
      const noEol = (t !== '+' && x === lastA && !ta.eol) || (t === '+' && y === lastB && !tb.eol);
      if (noEol) out.push('\\ No newline at end of file');
    }
  }
  return `${out.join('\n')}\n`;
}

// ---------------- 路由 ----------------

const EXAMPLE_A = '第一行\n第二行\n第三行\n';
const EXAMPLE_B = '第一行\n第 2 行\n第三行\n第四行\n';

export default {
  name: 'diff',
  category: 'tools',
  title: '文本对比',
  description: '按行 / 词 / 字符对比两段文本（Myers 算法），给出增删统计、相似度和 unified 格式差异',
  source: '本地计算',
  routes: getAndPost({
    path: '/api/tools/diff',
    summary: '文本对比：按行 / 词 / 字符找出差异，返回编辑操作列表和 unified diff（长文本请用 POST）',
    params: [
      { name: 'a', required: true, desc: `原文本（旧版本），最多 ${MAX_BYTES / 1024} KB；按行对比最多 ${MAX_TOKENS.line} 行，按词 ${MAX_TOKENS.word} 个词，按字符 ${MAX_TOKENS.char} 个字符。受请求体 100KB 上限影响，经 HTTP 调用时两段合计不超过约 100KB`, example: EXAMPLE_A },
      { name: 'b', required: true, desc: '新文本（新版本），限制同 a', example: EXAMPLE_B },
      { name: 'mode', default: 'line', desc: 'line 按行 / word 按词（连续字母数字算一个词，每个汉字单独算）/ char 按字符', example: 'line' },
      { name: 'ignoreWhitespace', default: 'false', desc: '是否忽略空白：按行对比时去掉所有空白再比较（同 diff -w）；按词 / 字符对比时任意空白视为相同。true / false', example: 'false' },
      { name: 'ignoreCase', default: 'false', desc: '是否忽略大小写，true / false', example: 'false' },
      { name: 'context', default: '3', desc: 'unified 差异中每处改动前后保留的上下文行数，0~100', example: '3' },
    ],
    fields: [
      { name: 'mode', type: 'string', desc: '对比粒度：line / word / char' },
      { name: 'identical', type: 'boolean', desc: '两段文本在当前比较规则下是否完全相同' },
      { name: 'stats', type: 'object', desc: '统计信息（单位随 mode：行 / 词 / 字符）' },
      { name: 'stats.added', type: 'number', desc: '新增数量（b 中新增的行 / 词 / 字符数）' },
      { name: 'stats.removed', type: 'number', desc: '删除数量（a 中被删除的行 / 词 / 字符数）' },
      { name: 'stats.unchanged', type: 'number', desc: '未变化的数量' },
      { name: 'stats.oldCount', type: 'number', desc: 'a 的总行数 / 词数 / 字符数（末尾换行不产生额外的空行）' },
      { name: 'stats.newCount', type: 'number', desc: 'b 的总行数 / 词数 / 字符数' },
      { name: 'stats.similarity', type: 'number', desc: '相似度百分比 = 2 × 未变化数 ÷ (a 总数 + b 总数) × 100，保留 2 位小数；两段都为空时为 100' },
      { name: 'ops', type: 'array', desc: `按顺序排列的编辑操作（相邻同类合并），依次应用可由 a 得到 b；最多 ${MAX_OPS} 条` },
      { name: 'ops[].type', type: 'string', desc: 'equal 相同 / insert 插入（来自 b）/ delete 删除（来自 a）' },
      { name: 'ops[].count', type: 'number', desc: '这一段包含的行 / 词 / 字符数' },
      { name: 'ops[].oldStart', type: 'number', desc: '在 a 中的起始位置：按行时为行号（从 1 开始），按词 / 字符时为字符偏移（UTF-16 下标，从 0 开始）；insert 时表示插入点' },
      { name: 'ops[].newStart', type: 'number', desc: '在 b 中的起始位置，规则同 oldStart；delete 时表示删除点' },
      { name: 'ops[].value', type: 'string', desc: '这一段的原文（equal、delete 取自 a，insert 取自 b）；按行时各行用 \\n 连接' },
      { name: 'ops[].lines', type: 'array', desc: '仅按行对比：这一段的各行文本（不含换行符）' },
      { name: 'ops[].lines[]', type: 'string', desc: '一行文本' },
      { name: 'opsTruncated', type: 'boolean', desc: `ops 是否因超过 ${MAX_OPS} 条被截断（统计和 unified 不受影响）` },
      { name: 'unified', type: 'string|null', desc: '仅按行对比：unified 格式差异（--- a / +++ b / @@ -起始,行数 +起始,行数 @@，行数为 1 时省略；末尾缺换行时标注 \\ No newline at end of file）；没有差异时为空字符串；按词 / 字符对比时为 null' },
    ],
  }, async (input) => {
    const a = param(input, 'a', { default: '' });
    const b = param(input, 'b', { default: '' });
    if (input.get('a') == null) throw new HttpError(400, '缺少参数 a');
    if (input.get('b') == null) throw new HttpError(400, '缺少参数 b');
    const mode = param(input, 'mode', { default: 'line', oneOf: MODES });
    const bool = (name) => truthy(param(input, name, { default: 'false', oneOf: ['0', '1', 'true', 'false'] }));
    const context = param(input, 'context', { default: 3, int: true, min: 0, max: 100 });
    return { data: diffText(a, b, { mode, ignoreWhitespace: bool('ignoreWhitespace'), ignoreCase: bool('ignoreCase'), context }) };
  }),
};

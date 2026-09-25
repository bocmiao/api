import { HttpError, param } from '../../lib/http.js';
import { getAndPost, bodyParams, truthy } from './inputs.js';

// ---------------- 文本统计 ----------------

const count = (text, re) => (text.match(re) ?? []).length;

export function textStat(text) {
  const lines = text === '' ? [] : text.split(/\r\n|\r|\n/);
  const chinese = count(text, /\p{Script=Han}/gu);
  const englishWords = count(text, /[A-Za-z]+(?:['’-][A-Za-z]+)*/g);
  const numbers = count(text, /\d+(?:\.\d+)?/g);
  return {
    characters: [...text].length,
    charactersNoSpaces: [...text.replace(/\s/g, '')].length,
    chinese,
    letters: count(text, /[A-Za-z]/g),
    digits: count(text, /[0-9]/g),
    spaces: count(text, /[^\S\r\n]/g),
    punctuation: count(text, /\p{P}/gu),
    chinesePunctuation: count(text, /(?=\p{P})[\u3000-\u303f\uff00-\uffef\u2010-\u201f\u2026\u00b7]/gu),
    englishWords,
    numbers,
    words: chinese + englishWords + numbers,
    lines: lines.length,
    nonEmptyLines: lines.filter((l) => l.trim()).length,
    paragraphs: text.split(/(?:\r?\n|\r)\s*(?:\r?\n|\r)/).filter((p) => p.trim()).length,
    bytes: Buffer.byteLength(text, 'utf8'),
    readingMinutes: Math.round(((chinese / 400) + (englishWords / 200)) * 10) / 10,
  };
}

// ---------------- 人民币大写 ----------------

const NUMS = '零壹贰叁肆伍陆柒捌玖';
const UNITS = ['', '拾', '佰', '仟'];

// 0~9999 的一节，如 1001 → 壹仟零壹
function section(g) {
  let out = '';
  let zero = false;
  for (let i = 3; i >= 0; i--) {
    const d = Math.floor(g / 10 ** i) % 10;
    if (d === 0) {
      if (out) zero = true;
    } else {
      if (zero) out += '零';
      zero = false;
      out += NUMS[d] + UNITS[i];
    }
  }
  return out;
}

// 不超过 8 位的整数（无前导零）
function below1e8(s) {
  const n = Number(s);
  const hi = Math.floor(n / 10_000);
  const lo = n % 10_000;
  if (!hi) return section(lo);
  let out = `${section(hi)}万`;
  if (lo) out += (lo < 1000 ? '零' : '') + section(lo);
  return out;
}

// 不超过 16 位的整数（无前导零）；亿以上按“万亿”读，如 1 0001 0000 0000 → 壹万零壹亿
function integerCapital(s) {
  if (s.length <= 8) return below1e8(s);
  const hi = s.slice(0, -8);
  const lo = Number(s.slice(-8));
  let out = `${below1e8(hi)}亿`;
  if (lo) out += (lo < 10_000_000 ? '零' : '') + below1e8(String(lo));
  return out;
}

export function rmbCapital(input) {
  const m = /^([+-])?(\d{1,16})(?:\.(\d{0,2}))?$/.exec(String(input ?? '').trim().replace(/[,，\s¥￥]/g, ''));
  if (!m) throw new HttpError(400, 'amount 须为最多 16 位整数、最多 2 位小数的金额，如 1234.56');
  const [, sign, rawInt, dec = ''] = m;
  const intPart = rawInt.replace(/^0+(?=\d)/, '');
  const jiao = Number(dec[0] ?? 0);
  const fen = Number(dec[1] ?? 0);
  const isZero = intPart === '0' && !jiao && !fen;
  let capital = '';
  if (intPart !== '0') capital += `${integerCapital(intPart)}元`;
  if (!jiao && !fen) {
    capital += intPart === '0' ? '零元整' : '整';
  } else {
    if (jiao) capital += `${NUMS[jiao]}角`;
    else if (intPart !== '0') capital += '零';
    if (fen) capital += `${NUMS[fen]}分`;
  }
  const negative = sign === '-' && !isZero;
  const cents = `${jiao}${fen}`;
  return {
    amount: `${negative ? '-' : ''}${intPart}.${cents}`,
    capital: (negative ? '负' : '') + capital,
    formatted: `${negative ? '-' : ''}¥${intPart.replace(/\B(?=(\d{3})+$)/g, ',')}.${cents}`,
  };
}

// ---------------- JSON ----------------

const MAX_DEPTH = 500;

function locate(text, message) {
  const m = /position (\d+)/.exec(message);
  const position = m ? Number(m[1]) : text.length;
  const before = text.slice(0, position);
  const line = before.split('\n').length;
  return {
    message: message.replace(/\s*\(line \d+ column \d+\)$/, ''),
    position,
    line,
    column: position - before.lastIndexOf('\n'),
  };
}

// 非递归地统计节点数、键数、最大深度，避免深层嵌套把栈撑爆
function measure(value) {
  let nodes = 0;
  let keys = 0;
  let depth = 0;
  const stack = [[value, 1]];
  while (stack.length) {
    const [v, d] = stack.pop();
    nodes++;
    if (v === null || typeof v !== 'object') continue;
    depth = Math.max(depth, d);
    if (depth > MAX_DEPTH) throw new HttpError(400, `JSON 嵌套超过 ${MAX_DEPTH} 层，无法处理`);
    const children = Array.isArray(v) ? v : Object.values(v);
    if (!Array.isArray(v)) keys += Object.keys(v).length;
    for (const c of children) stack.push([c, d + 1]);
  }
  return { nodes, keys, depth };
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v === null || typeof v !== 'object') return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
}

export function jsonTool(text, { action = 'format', indent = '2', sortKeys: sort = false } = {}) {
  const inputBytes = Buffer.byteLength(text, 'utf8');
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { action, valid: false, result: null, error: locate(text, err.message), stats: { inputBytes, outputBytes: 0, nodes: 0, keys: 0, depth: 0 } };
  }
  const stats = measure(value);
  if (sort) value = sortKeys(value);
  const space = indent === 'tab' ? '\t' : Number(indent);
  let result = null;
  if (action === 'format') result = JSON.stringify(value, null, space);
  else if (action === 'minify') result = JSON.stringify(value);
  return {
    action,
    valid: true,
    result,
    error: null,
    stats: { inputBytes, outputBytes: result === null ? 0 : Buffer.byteLength(result, 'utf8'), ...stats },
  };
}

const TEXT_STAT_FIELDS = [
  { name: 'characters', type: 'number', desc: '字符总数（按 Unicode 字符计，emoji 算 1 个，含空白和换行）' },
  { name: 'charactersNoSpaces', type: 'number', desc: '不含空白（空格、制表符、换行等）的字符数' },
  { name: 'chinese', type: 'number', desc: '汉字数（Unicode Han 字符，含繁体和扩展区，不含中文标点）' },
  { name: 'letters', type: 'number', desc: '英文字母数（A-Z、a-z）' },
  { name: 'digits', type: 'number', desc: '阿拉伯数字个数（0-9，每位算 1 个）' },
  { name: 'spaces', type: 'number', desc: '空白字符数（空格、制表符、全角空格等，不含换行）' },
  { name: 'punctuation', type: 'number', desc: '标点符号总数（Unicode 标点类，中英文都算；不含 + = $ 等符号类字符）' },
  { name: 'chinesePunctuation', type: 'number', desc: '中文（全角）标点数，如 ，。！？；：“”‘’（）《》、…—' },
  { name: 'englishWords', type: 'number', desc: '英文单词数（连续字母，允许中间带 \' 或 -，如 don\'t、e-mail 各算 1 个）' },
  { name: 'numbers', type: 'number', desc: '数字串个数（连续数字算 1 个，可带小数点，如 3.14）' },
  { name: 'words', type: 'number', desc: '字数（汉字数 + 英文单词数 + 数字串数），接近 Word 的中英混排统计口径' },
  { name: 'lines', type: 'number', desc: '行数（\\n、\\r\\n、\\r 都算换行；空文本为 0，末尾换行后的空行也算 1 行）' },
  { name: 'nonEmptyLines', type: 'number', desc: '非空行数（去掉只含空白的行）' },
  { name: 'paragraphs', type: 'number', desc: '段落数（以空行分隔、且含非空白内容的块）' },
  { name: 'bytes', type: 'number', desc: 'UTF-8 编码后的字节数（汉字一般 3 字节，emoji 4 字节）' },
  { name: 'readingMinutes', type: 'number', desc: '估算阅读时长（分钟，保留 1 位小数），按中文每分钟 400 字、英文每分钟 200 词' },
];

export default {
  name: 'text-tools',
  category: 'tools',
  title: '文本统计 / 人民币大写 / JSON',
  description: '文本字数统计、金额转人民币大写、JSON 格式化压缩与校验',
  source: '本地计算',
  routes: [
    ...getAndPost({
      path: '/api/tools/text-stat',
      summary: '文本统计：字符数、汉字、英文单词、数字、标点、行数、段落、字节数、阅读时长（长文本请用 POST）',
      params: [{ name: 'text', required: true, desc: '要统计的文本，最多 100000 个字符', example: 'Hello 世界！\n这是第二行，共 3 个 words。' }],
      fields: TEXT_STAT_FIELDS,
    }, async (input) => ({ data: textStat(param(input, 'text', { required: true, max: 100_000 })) })),
    {
      method: 'GET',
      path: '/api/tools/rmb',
      summary: '金额转人民币大写，如 1234.56 → 壹仟贰佰叁拾肆元伍角陆分',
      params: [{ name: 'amount', required: true, desc: '金额：最多 16 位整数、2 位小数，可带负号；千分位逗号、空格和 ¥ 会被忽略', example: '1234.56' }],
      fields: [
        { name: 'amount', type: 'string', desc: '规范化后的金额，固定两位小数，如 1234.56、-0.05' },
        { name: 'capital', type: 'string', desc: '中文大写金额。按财务写法：整数部分带“元”，没有角分时以“整”结尾；有角无分时不加“整”；元与分之间缺角时写“零”（如 壹元零伍分）；负数前加“负”；0 为 零元整；亿以上按“万亿”读（如 壹万零壹亿元整）' },
        { name: 'formatted', type: 'string', desc: '带千分位的小写金额，如 ¥1,234.56' },
      ],
      async handler({ query }) {
        return { data: rmbCapital(param(query, 'amount', { required: true, max: 40 })) };
      },
    },
    {
      method: 'POST',
      path: '/api/tools/json',
      summary: 'JSON 格式化 / 压缩 / 校验，出错时给出行号和列号',
      params: [
        { name: 'text', in: 'body', required: true, desc: 'JSON 文本，最多 100000 个字符（受请求体 100KB 限制）', example: '{"id":1,"name":"张三","tags":["a","b"]}' },
        { name: 'action', in: 'body', default: 'format', desc: 'format 格式化；minify 压缩；validate 只校验（result 为 null）', example: 'format' },
        { name: 'indent', in: 'body', default: '2', desc: '格式化缩进：2 / 4（空格）或 tab', example: '4' },
        { name: 'sortKeys', in: 'body', default: 'false', desc: '是否按键名排序（递归），true / false', example: 'true' },
      ],
      fields: [
        { name: 'action', type: 'string', desc: '执行的操作：format / minify / validate' },
        { name: 'valid', type: 'boolean', desc: '输入是否为合法 JSON（按 JSON 标准，不接受注释、尾逗号、单引号）' },
        { name: 'result', type: 'string|null', desc: 'format / minify 的结果；validate 或 JSON 不合法时为 null' },
        { name: 'error', type: 'object|null', desc: 'JSON 不合法时的错误位置；合法时为 null' },
        { name: 'error.message', type: 'string', desc: '解析器的错误信息（英文，来自 V8），如 Unexpected token } in JSON at position 10' },
        { name: 'error.position', type: 'number', desc: '出错位置（从 0 开始的字符下标）' },
        { name: 'error.line', type: 'number', desc: '出错的行号（从 1 开始）' },
        { name: 'error.column', type: 'number', desc: '出错的列号（从 1 开始）' },
        { name: 'stats', type: 'object', desc: '统计信息；JSON 不合法时除 inputBytes 外都为 0' },
        { name: 'stats.inputBytes', type: 'number', desc: '输入的 UTF-8 字节数' },
        { name: 'stats.outputBytes', type: 'number', desc: '输出结果的 UTF-8 字节数；没有结果时为 0' },
        { name: 'stats.nodes', type: 'number', desc: '节点总数（每个对象、数组、字符串、数字、布尔、null 各算 1 个）' },
        { name: 'stats.keys', type: 'number', desc: '所有对象的键总数' },
        { name: 'stats.depth', type: 'number', desc: '最大嵌套深度（顶层对象或数组为 1，顶层是标量时为 0）；超过 500 层返回 400' },
      ],
      async handler({ body }) {
        const input = bodyParams(body);
        const text = param(input, 'text', { required: true, max: 100_000 });
        const action = param(input, 'action', { default: 'format', oneOf: ['format', 'minify', 'validate'] });
        const indent = param(input, 'indent', { default: '2', oneOf: ['2', '4', 'tab'] });
        const sort = truthy(param(input, 'sortKeys', { default: 'false', oneOf: ['0', '1', 'true', 'false'] }));
        return { data: jsonTool(text, { action, indent, sortKeys: sort }) };
      },
    },
  ],
};

import { createHash, randomInt, randomUUID } from 'node:crypto';
import { HttpError, param } from '../../lib/http.js';

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const pad = (n, w = 2) => String(n).padStart(w, '0');

function beijing(ms) {
  const d = new Date(ms + 8 * 3600_000);
  return {
    text: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
    weekday: WEEKDAYS[d.getUTCDay()],
  };
}

// 自动识别：纯数字按位数区分秒/毫秒（≥ 12 位视为毫秒），否则按日期字符串解析；无时区的日期视为北京时间
export function parseTimestamp(value, now = Date.now()) {
  let ms;
  let detected;
  const v = (value ?? '').trim();
  if (!v) {
    ms = now;
    detected = 'now';
  } else if (/^-?\d+(\.\d+)?$/.test(v)) {
    const intDigits = v.replace(/^-/, '').split('.')[0].length;
    if (intDigits >= 12) {
      ms = Math.trunc(Number(v));
      detected = 'milliseconds';
    } else {
      ms = Math.round(Number(v) * 1000);
      detected = 'seconds';
    }
  } else {
    let s = v;
    const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?)?$/.exec(s);
    if (m) {
      // Date.parse 会把 2025-02-30、2025-04-31 这类不存在的日期顺延到下个月，这里直接拒绝
      const [y, mon, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
      const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mon - 1];
      if (!days || day < 1 || day > days) throw new HttpError(400, 'value 不是有效的日期');
      s = `${m[1]}-${pad(m[2])}-${pad(m[3])}T${pad(m[4] ?? 0)}:${m[5] ?? '00'}:${m[6] ?? '00'}${m[7] ?? ''}+08:00`;
    }
    ms = Date.parse(s);
    detected = 'date';
  }
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) throw new HttpError(400, 'value 无法识别为时间戳或日期');
  const bj = beijing(ms);
  return {
    input: v || null,
    detected,
    seconds: Math.floor(ms / 1000),
    milliseconds: ms,
    iso: new Date(ms).toISOString(),
    beijing: bj.text,
    weekday: bj.weekday,
  };
}

const HASH_ALGOS = ['md5', 'sha1', 'sha256', 'sha512'];

export function hashText(text, algo) {
  const h = createHash(algo).update(text, 'utf8');
  const buf = h.digest();
  return { algo, hex: buf.toString('hex'), base64: buf.toString('base64') };
}

export function base64Convert(text, action) {
  if (action === 'encode') return Buffer.from(text, 'utf8').toString('base64');
  const s = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.replace(/=+$/, '').length % 4 === 1) {
    throw new HttpError(400, '不是合法的 Base64 字符串');
  }
  const bytes = Buffer.from(s, 'base64');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, '解码结果不是有效的 UTF-8 文本');
  }
}

export function urlConvert(text, action) {
  if (action === 'encode') return encodeURIComponent(text);
  try {
    return decodeURIComponent(text);
  } catch {
    throw new HttpError(400, '不是合法的 URL 编码字符串');
  }
}

const SETS = {
  lower: 'abcdefghijkmnpqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digits: '23456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?',
};

// 每类字符至少出现一次；去掉了易混淆的 0 O o 1 l I
export function generatePassword(length, symbols) {
  const groups = [SETS.lower, SETS.upper, SETS.digits, ...(symbols ? [SETS.symbols] : [])];
  const all = groups.join('');
  const chars = groups.map((g) => g[randomInt(g.length)]);
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export default {
  name: 'devtools',
  category: 'tools',
  title: '开发小工具',
  description: '时间戳转换、UUID、哈希、Base64、URL 编解码、随机密码',
  source: '本地计算',
  routes: [
    {
      method: 'GET',
      path: '/api/tools/timestamp',
      summary: '时间戳与日期互转（自动识别秒/毫秒/日期字符串）',
      params: [{ name: 'value', required: false, desc: '时间戳（秒或毫秒）或日期字符串，留空为当前时间；无时区的日期按北京时间解析', example: '1758700800' }],
      fields: [
        { name: 'input', type: 'string|null', desc: '请求参数 value 去掉首尾空白后的原文；没传 value 或为空时为 null（此时取服务器当前时间）' },
        {
          name: 'detected',
          type: 'string',
          desc: '输入的识别方式：now（没传 value，取当前时间）；seconds（按秒级时间戳解析：纯数字且整数部分不超过 11 位，可带小数）；'
            + 'milliseconds（按毫秒级时间戳解析：整数部分 12 位及以上，小数部分舍去）；date（按日期字符串解析：YYYY-MM-DD、YYYY/MM/DD、YYYY.MM.DD，'
            + '可带 HH:mm[:ss[.SSS]]，不带时区时按北京时间；其他写法（如带 Z 或 +08:00 的 ISO 8601）交给 JavaScript Date.parse 解析，这类写法不带时区时按服务器所在时区解析）',
        },
        { name: 'seconds', type: 'number', desc: 'Unix 时间戳（秒，整数），即距 1970-01-01T00:00:00Z 的秒数，与时区无关；不足 1 秒的部分向下取整（负数也向下，如 -1.5 秒记为 -2）' },
        { name: 'milliseconds', type: 'number', desc: 'Unix 时间戳（毫秒，整数），与时区无关' },
        { name: 'iso', type: 'string', desc: 'ISO 8601 格式的 UTC 时间，带 3 位毫秒，如 2025-09-24T08:00:00.000Z' },
        { name: 'beijing', type: 'string', desc: '北京时间（UTC+8），格式 YYYY-MM-DD HH:mm:ss（24 小时制，不含毫秒），如 2025-09-24 16:00:00' },
        { name: 'weekday', type: 'string', desc: '北京时间当天是星期几，取值 星期日、星期一 … 星期六' },
      ],
      async handler({ query }) {
        return { data: parseTimestamp(param(query, 'value', { default: '', max: 64 })) };
      },
    },
    {
      method: 'GET',
      path: '/api/tools/uuid',
      summary: '批量生成 UUID v4',
      params: [{ name: 'count', default: '1', desc: '数量（1~100）', example: '5' }],
      fields: [
        { name: '[]', type: 'string', desc: 'data 是字符串数组，长度等于 count；每项是一个随机生成的 UUID v4（小写，36 个字符，含 4 个连字符，如 3b241101-e2bb-4255-8caf-4136c566a962）' },
      ],
      async handler({ query }) {
        const count = param(query, 'count', { default: 1, int: true, min: 1, max: 100 });
        return { data: Array.from({ length: count }, () => randomUUID()) };
      },
    },
    {
      method: 'GET',
      path: '/api/tools/hash',
      summary: '计算文本的 MD5 / SHA1 / SHA256 / SHA512 摘要',
      params: [
        { name: 'text', required: true, desc: '文本（UTF-8），最多 10000 个字符', example: 'hello' },
        { name: 'algo', default: 'sha256', desc: '算法 md5 / sha1 / sha256 / sha512', example: 'md5' },
      ],
      fields: [
        { name: 'algo', type: 'string', desc: '使用的算法：md5 / sha1 / sha256 / sha512，与请求参数 algo 相同' },
        { name: 'hex', type: 'string', desc: '摘要的十六进制编码（小写），长度 md5 为 32、sha1 为 40、sha256 为 64、sha512 为 128 个字符；计算前文本按 UTF-8 转成字节' },
        { name: 'base64', type: 'string', desc: '同一摘要的标准 Base64 编码（RFC 4648，使用 + 和 /，带 = 填充，不是 URL 安全变体），长度 md5 为 24、sha1 为 28、sha256 为 44、sha512 为 88 个字符' },
      ],
      async handler({ query }) {
        const text = param(query, 'text', { required: true, max: 10_000 });
        const algo = param(query, 'algo', { default: 'sha256', oneOf: HASH_ALGOS });
        return { data: hashText(text, algo) };
      },
    },
    {
      method: 'GET',
      path: '/api/tools/base64',
      summary: 'Base64 编码 / 解码（UTF-8）',
      params: [
        { name: 'text', required: true, desc: '文本，最多 10000 个字符', example: '你好，世界' },
        { name: 'action', default: 'encode', desc: 'encode 编码 / decode 解码', example: 'encode' },
      ],
      fields: [
        { name: 'action', type: 'string', desc: '执行的操作：encode（编码）或 decode（解码），与请求参数 action 相同' },
        { name: 'result', type: 'string', desc: 'encode 时为文本按 UTF-8 转成字节后的标准 Base64（使用 + 和 /，带 = 填充，不换行）；decode 时为解码得到的文本（输入也可以是 URL 安全变体 - _，可省略 = 填充，空白会被忽略；解码出的字节不是有效 UTF-8 时返回 400 错误）' },
      ],
      async handler({ query }) {
        const text = param(query, 'text', { required: true, max: 10_000 });
        const action = param(query, 'action', { default: 'encode', oneOf: ['encode', 'decode'] });
        return { data: { action, result: base64Convert(text, action) } };
      },
    },
    {
      method: 'GET',
      path: '/api/tools/urlencode',
      summary: 'URL 编码 / 解码（encodeURIComponent）',
      params: [
        { name: 'text', required: true, desc: '文本，最多 10000 个字符', example: 'a=1&b=中文' },
        { name: 'action', default: 'encode', desc: 'encode 编码 / decode 解码', example: 'encode' },
      ],
      fields: [
        { name: 'action', type: 'string', desc: '执行的操作：encode（编码）或 decode（解码），与请求参数 action 相同' },
        { name: 'result', type: 'string', desc: "encode 时为 encodeURIComponent 的结果：按 UTF-8 百分号编码，除字母、数字和 - _ . ! ~ * ' ( ) 外都会编码，空格编码为 %20（不是 +）；decode 时为 decodeURIComponent 的结果（+ 不会还原成空格）" },
      ],
      async handler({ query }) {
        const text = param(query, 'text', { required: true, max: 10_000 });
        const action = param(query, 'action', { default: 'encode', oneOf: ['encode', 'decode'] });
        return { data: { action, result: urlConvert(text, action) } };
      },
    },
    {
      method: 'GET',
      path: '/api/tools/password',
      summary: '生成加密安全的随机密码',
      params: [
        { name: 'length', default: '16', desc: '长度（8~128）', example: '20' },
        { name: 'symbols', default: '0', desc: '是否包含符号，1 为包含', example: '1' },
        { name: 'count', default: '1', desc: '数量（1~20）', example: '3' },
      ],
      fields: [
        {
          name: '[]',
          type: 'string',
          desc: `data 是字符串数组，长度等于 count；每项是一个用加密安全随机数生成的密码，长度等于 length。至少包含小写字母、大写字母、数字各 1 个（symbols 为 1 时还至少含 1 个符号）。`
            + `字符范围：小写 ${SETS.lower}、大写 ${SETS.upper}、数字 ${SETS.digits}、符号 ${SETS.symbols}（去掉了易混淆的 l、o、I、O、0、1）`,
        },
      ],
      async handler({ query }) {
        const length = param(query, 'length', { default: 16, int: true, min: 8, max: 128 });
        const symbols = param(query, 'symbols', { default: '0', oneOf: ['0', '1', 'true', 'false'] });
        const count = param(query, 'count', { default: 1, int: true, min: 1, max: 20 });
        const withSymbols = symbols === '1' || symbols === 'true';
        return { data: Array.from({ length: count }, () => generatePassword(length, withSymbols)) };
      },
    },
  ],
};

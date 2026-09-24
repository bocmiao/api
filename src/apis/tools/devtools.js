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
  lower: 'abcdefghijkmnopqrstuvwxyz',
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
      async handler({ query }) {
        return { data: parseTimestamp(param(query, 'value', { default: '', max: 64 })) };
      },
    },
    {
      method: 'GET',
      path: '/api/tools/uuid',
      summary: '批量生成 UUID v4',
      params: [{ name: 'count', default: '1', desc: '数量（1~100）', example: '5' }],
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

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError, param } from '../../lib/http.js';
import { getAndPost, bodyParams } from './inputs.js';

// 本模块的参数（token、secret、password）都比较敏感：
// - 都提供 POST（参数放在 JSON 请求体里，不进网址），密码强度只提供 POST；
// - 本站的调用日志（request_log）只记录路径，不记录查询参数和请求体；
// - 报错信息不回显 token / secret / password 的内容。

// ---------------- JWT ----------------

const HS = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' };

function decodeSegment(seg, label) {
  if (!/^[A-Za-z0-9_-]*$/.test(seg)) throw new HttpError(400, `JWT 的${label}不是合法的 Base64URL`);
  let value;
  try {
    value = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(400, `JWT 的${label}不是合法的 JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `JWT 的${label}须为 JSON 对象`);
  return value;
}

const isoOf = (sec) => (typeof sec === 'number' && Number.isFinite(sec) && Math.abs(sec) < 8.64e12 ? new Date(sec * 1000).toISOString() : null);

export function verifyHs(alg, signingInput, signature, secret) {
  const expected = createHmac(HS[alg], secret).update(signingInput).digest();
  const actual = Buffer.from(signature, 'base64url');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function decodeJwt(token, { secret, encoding = 'utf8', now = Date.now() } = {}) {
  const parts = String(token ?? '').trim().replace(/^Bearer\s+/i, '').split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1]) throw new HttpError(400, 'JWT 应由三段 Base64URL 组成，用 . 分隔（头部.载荷.签名）');
  const header = decodeSegment(parts[0], '头部');
  const payload = decodeSegment(parts[1], '载荷');
  if (!/^[A-Za-z0-9_-]*$/.test(parts[2])) throw new HttpError(400, 'JWT 的签名不是合法的 Base64URL');
  const algorithm = typeof header.alg === 'string' ? header.alg : '';

  let verification;
  let verified = false;
  if (algorithm.toLowerCase() === 'none') {
    verification = 'none';
  } else if (!HS[algorithm]) {
    verification = 'unsupported';
  } else if (secret == null || secret === '') {
    verification = 'skipped';
  } else {
    let key;
    try {
      key = encoding === 'utf8' ? Buffer.from(secret, 'utf8') : Buffer.from(secret, 'base64');
    } catch {
      throw new HttpError(400, 'secret 不是合法的 Base64');
    }
    verified = verifyHs(algorithm, `${parts[0]}.${parts[1]}`, parts[2], key);
    verification = verified ? 'valid' : 'invalid';
  }
  const MESSAGES = {
    valid: '签名正确',
    invalid: '签名不匹配：密钥错误，或令牌被篡改',
    skipped: '未提供 secret，只解码、没有验证签名，内容不可信',
    unsupported: `暂不支持验证 ${algorithm || '（空）'} 算法的签名（只支持 HS256 / HS384 / HS512），只解码、内容不可信`,
    none: '算法为 none（无签名），任何人都能伪造，内容不可信',
  };

  const nowSec = Math.floor(now / 1000);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const exp = num(payload.exp);
  const nbf = num(payload.nbf);
  return {
    header,
    payload,
    algorithm,
    signature: parts[2],
    verified,
    verification,
    verifyMessage: MESSAGES[verification],
    times: { issuedAt: isoOf(payload.iat), notBefore: isoOf(nbf), expiresAt: isoOf(exp) },
    expired: exp === null ? null : exp <= nowSec,
    expiresIn: exp === null ? null : exp - nowSec,
    notYetValid: nbf === null ? null : nbf > nowSec,
  };
}

// ---------------- TOTP ----------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input) {
  const s = String(input).toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!/^[A-Z2-7]+$/.test(s)) throw new HttpError(400, 'secret 不是合法的 Base32（只能包含 A-Z、2-7，可带 = 填充）');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of s) {
    value = ((value << 5) | B32.indexOf(ch)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

// RFC 4226 / 6238
export function hotp(key, counter, algorithm = 'sha1', digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac(algorithm, key).update(msg).digest();
  const offset = h[h.length - 1] & 0x0f;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}

export function totp({ secret, digits = 6, period = 30, algorithm = 'sha1', time = Date.now() / 1000, issuer = 'Miao API', account = 'test' }) {
  const generated = !secret;
  const b32 = generated ? base32Encode(randomBytes(20)) : null;
  const key = base32Decode(b32 ?? secret);
  if (key.length < 10) throw new HttpError(400, 'secret 太短（解码后至少 10 字节，即 16 个 Base32 字符）');
  const t = Math.floor(time);
  const counter = Math.floor(t / period);
  const out = {
    code: hotp(key, counter, algorithm, digits),
    previousCode: hotp(key, counter - 1, algorithm, digits),
    nextCode: hotp(key, counter + 1, algorithm, digits),
    remaining: period - (t % period),
    period,
    digits,
    algorithm,
    counter,
    generated,
  };
  if (generated) {
    const label = encodeURIComponent(`${issuer}:${account}`);
    out.secret = b32;
    out.otpauthUrl = `otpauth://totp/${label}?secret=${b32}&issuer=${encodeURIComponent(issuer)}&algorithm=${algorithm.toUpperCase()}&digits=${digits}&period=${period}`;
  }
  return out;
}

// ---------------- 密码强度 ----------------

const COMMON = new Set([
  '123456', '123456789', '12345678', '1234567', '12345', '1234567890', '111111', '000000', '123123', '654321', '666666', '888888', '121212', '112233',
  'password', 'passw0rd', 'p@ssw0rd', 'qwerty', 'qwertyuiop', 'qwerty123', 'abc123', 'a123456', '123456a', '1q2w3e4r', '1qaz2wsx', 'zxcvbnm', 'asdfghjkl',
  'iloveyou', 'woaini', 'woaini1314', '5201314', '1314520', 'admin', 'admin123', 'root', 'test', 'guest', 'welcome', 'letmein', 'monkey', 'dragon',
  'football', 'baseball', 'master', 'superman', 'sunshine', 'princess', 'login', 'hello', 'freedom', 'whatever', 'trustno1', 'abcd1234', 'aa123456',
]);
const WORDS = ['password', 'qwerty', 'admin', 'login', 'welcome', 'iloveyou', 'woaini', 'love', 'hello', 'test', 'user', 'root', 'master', 'dragon', 'monkey'];
const KEYBOARD = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1qaz2wsx3edc', 'qazwsxedc'];
const LEET = { '@': 'a', 4: 'a', 3: 'e', 1: 'i', '!': 'i', 0: 'o', $: 's', 5: 's', 7: 't' };
const LEVELS = [
  ['非常弱', '几乎可以被瞬间破解，请立即更换'],
  ['弱', '容易被破解，不要用在任何重要账号上'],
  ['一般', '能抵挡在线猜测，但数据库泄露后很快会被破解'],
  ['强', '安全性较好，适合大多数账号'],
  ['非常强', '安全性很高；建议配合密码管理器，每个网站使用不同的密码'],
];

// 把可预测的片段折算成更短的“有效长度”
function effectiveLength(pw) {
  const lower = pw.toLowerCase();
  const chars = [...pw];
  let length = chars.length;
  const issues = new Set();
  for (const m of pw.matchAll(/(.)\1{2,}/gu)) {
    length -= [...m[0]].length - 1.5;
    issues.add('包含连续重复的字符，如 aaa、111');
  }
  let run = 1;
  let step = 0;
  for (let i = 1; i <= chars.length; i++) {
    const diff = i < chars.length ? chars[i].codePointAt(0) - chars[i - 1].codePointAt(0) : NaN;
    if (Math.abs(diff) === 1 && (run === 1 || diff === step)) {
      run++;
      step = diff;
      continue;
    }
    if (run >= 3) {
      length -= run - 2;
      issues.add('包含顺序字符，如 abc、123');
    }
    run = Math.abs(diff) === 1 ? 2 : 1;
    step = Math.abs(diff) === 1 ? diff : 0;
  }
  outer: for (const row of KEYBOARD) {
    for (const seq of [row, [...row].reverse().join('')]) {
      for (let size = Math.min(seq.length, lower.length); size >= 4; size--) {
        for (let i = 0; i + size <= seq.length; i++) {
          if (lower.includes(seq.slice(i, i + size))) {
            length -= size - 2;
            issues.add('包含键盘上相邻的按键，如 qwerty、asdf');
            continue outer;
          }
        }
      }
    }
  }
  const plain = lower.replace(/[@431!0$57]/g, (c) => LEET[c] ?? c);
  const word = WORDS.find((w) => lower.includes(w) || plain.includes(w));
  if (word) {
    length -= word.length - 1.5;
    issues.add('包含常见单词，如 password、admin、love');
  }
  if (/(19[5-9]\d|20[0-4]\d)/.test(pw)) {
    length -= 2.5;
    issues.add('包含年份或生日，容易被猜到');
  }
  return { length: Math.max(1, length), issues: [...issues] };
}

function humanTime(seconds) {
  if (seconds < 1) return '不到 1 秒';
  if (seconds >= 31557600 * 1e9) return '超过 10 亿年';
  if (seconds >= 31557600 * 1e4) return `约 ${Math.round(seconds / 31557600 / 1e4).toLocaleString('zh-CN')} 万年`;
  const [name, size] = [['年', 31557600], ['天', 86400], ['小时', 3600], ['分钟', 60], ['秒', 1]].find(([, s]) => seconds >= s);
  return `约 ${Math.round(seconds / size).toLocaleString('zh-CN')} ${name}`;
}

export function passwordStrength(pw) {
  const chars = [...pw];
  const has = {
    lowercase: /[a-z]/.test(pw),
    uppercase: /[A-Z]/.test(pw),
    digits: /\d/.test(pw),
    symbols: /[!-/:-@[-`{-~ ]/.test(pw),
    other: /[^\x20-\x7e]/.test(pw),
  };
  const poolSize = (has.lowercase ? 26 : 0) + (has.uppercase ? 26 : 0) + (has.digits ? 10 : 0) + (has.symbols ? 33 : 0) + (has.other ? 100 : 0) || 1;
  const isCommon = COMMON.has(pw.toLowerCase());
  const { length: effective, issues } = effectiveLength(pw);
  let entropy = isCommon ? Math.log2(COMMON.size) : effective * Math.log2(poolSize);
  if (!isCommon && /^\d+$/.test(pw) && chars.length <= 8) entropy = Math.min(entropy, 20);
  if (isCommon) issues.unshift('这是最常见的弱密码之一，会被最先尝试');
  const guesses = 2 ** entropy / 2;
  const score = entropy < 28 ? 0 : entropy < 36 ? 1 : entropy < 60 ? 2 : entropy < 80 ? 3 : 4;
  const suggestions = [];
  if (chars.length < 12) suggestions.push('把长度增加到 12 位以上，长度比复杂度更重要');
  if (Object.values(has).filter(Boolean).length < 3) suggestions.push('混合使用大小写字母、数字和符号');
  if (issues.length) suggestions.push('避开常见单词、键盘顺序、重复字符和生日年份');
  if (score < 3) suggestions.push('可以用几个不相关的词组成一句话，如 correct-horse-battery-staple，好记又安全');
  return {
    score,
    level: LEVELS[score][0],
    summary: LEVELS[score][1],
    entropyBits: Math.round(entropy * 10) / 10,
    length: chars.length,
    charset: { ...has, poolSize },
    isCommon,
    crackTime: { online: humanTime(guesses / 100), offline: humanTime(guesses / 1e10) },
    issues,
    suggestions,
  };
}

// ---------------- 路由 ----------------

const EXAMPLE_SECRET = 'your-256-bit-secret';
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const EXAMPLE_TOKEN = (() => {
  const input = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub: '1234567890', name: '张三', admin: true, iat: 1767225600, exp: 4102444800 })}`;
  return `${input}.${createHmac('sha256', EXAMPLE_SECRET).update(input).digest('base64url')}`;
})();

const jwtRoute = {
  path: '/api/tools/jwt',
  summary: 'JWT 解码，提供 secret 时验证 HS256 / HS384 / HS512 签名',
  params: [
    { name: 'token', required: true, desc: 'JWT 令牌，可带 Bearer 前缀，最多 8192 个字符。令牌和密钥比较敏感，建议用 POST', example: EXAMPLE_TOKEN },
    { name: 'secret', required: false, desc: 'HS256 / HS384 / HS512 的签名密钥，最多 1024 个字符；不传时只解码，verified 为 false。请勿提交生产环境的真实密钥', example: EXAMPLE_SECRET },
    { name: 'encoding', default: 'utf8', desc: 'secret 的编码：utf8（原样作为密钥）/ base64（先 Base64 解码，也接受 Base64URL）', example: 'utf8' },
  ],
  fields: [
    { name: 'header', type: 'object', desc: '头部（JOSE Header），键名不固定，常见 alg 算法、typ 类型、kid 密钥 ID' },
    { name: 'header.*', type: 'string|number|boolean|object|array|null', desc: '头部中的一个字段，原样返回' },
    { name: 'payload', type: 'object', desc: '载荷（声明），键名不固定；JWT 载荷只是 Base64URL 编码，并未加密' },
    { name: 'payload.*', type: 'string|number|boolean|object|array|null', desc: '载荷中的一个声明，原样返回，如 sub 主体、iat 签发时间、exp 过期时间（Unix 秒）' },
    { name: 'algorithm', type: 'string', desc: '头部 alg 字段的值；没有或不是字符串时为空字符串' },
    { name: 'signature', type: 'string', desc: '签名段原文（Base64URL）' },
    { name: 'verified', type: 'boolean', desc: '签名是否已验证且正确。只有提供了 secret 且签名匹配时为 true；没提供 secret、算法不支持、算法为 none、签名不匹配时都为 false，此时内容不可信' },
    { name: 'verification', type: 'string', desc: '验证结果：valid 签名正确；invalid 签名不匹配；skipped 未提供 secret，只解码；unsupported 算法不是 HS256/384/512（如 RS256、ES256），无法验证；none 算法为 none（无签名）' },
    { name: 'verifyMessage', type: 'string', desc: '验证结果的中文说明' },
    { name: 'times', type: 'object', desc: '载荷中时间声明换算成的时间' },
    { name: 'times.issuedAt', type: 'string|null', desc: 'iat 签发时间，ISO 8601 UTC；没有该声明或不是数字时为 null' },
    { name: 'times.notBefore', type: 'string|null', desc: 'nbf 生效时间，ISO 8601 UTC；没有时为 null' },
    { name: 'times.expiresAt', type: 'string|null', desc: 'exp 过期时间，ISO 8601 UTC；没有时为 null' },
    { name: 'expired', type: 'boolean|null', desc: '按服务器当前时间是否已过期（exp ≤ 当前时间）；没有 exp 时为 null' },
    { name: 'expiresIn', type: 'number|null', desc: '距离过期的秒数，已过期为负数；没有 exp 时为 null' },
    { name: 'notYetValid', type: 'boolean|null', desc: '是否还没到生效时间（nbf > 当前时间）；没有 nbf 时为 null' },
  ],
};

const totpRoute = {
  path: '/api/tools/totp',
  summary: 'TOTP 两步验证码（兼容 Google / 微软 Authenticator）：根据 Base32 密钥计算当前验证码和剩余秒数；不传密钥时随机生成一个',
  params: [
    { name: 'secret', required: false, desc: 'Base32 密钥（验证器二维码里的 secret，空格和 - 会被忽略），至少 16 个字符；不传则随机生成新密钥。请勿提交正在使用的真实密钥，建议用 POST', example: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' },
    { name: 'digits', default: '6', desc: '验证码位数（6~8）', example: '6' },
    { name: 'period', default: '30', desc: '时间步长（秒，15~300）', example: '30' },
    { name: 'algorithm', default: 'sha1', desc: '哈希算法 sha1 / sha256 / sha512，绝大多数验证器用 sha1', example: 'sha1' },
    { name: 'time', required: false, desc: '按指定的 Unix 时间（秒）计算，用于调试；不传为服务器当前时间', example: '59' },
  ],
  fields: [
    { name: 'code', type: 'string', desc: '当前时间步的验证码（位数等于 digits，不足补前导 0）' },
    { name: 'previousCode', type: 'string', desc: '上一个时间步的验证码（很多服务端允许 ±1 个时间步的时钟误差）' },
    { name: 'nextCode', type: 'string', desc: '下一个时间步的验证码' },
    { name: 'remaining', type: 'number', desc: '当前验证码剩余有效秒数（1~period）' },
    { name: 'period', type: 'number', desc: '时间步长（秒）' },
    { name: 'digits', type: 'number', desc: '验证码位数' },
    { name: 'algorithm', type: 'string', desc: '哈希算法：sha1 / sha256 / sha512' },
    { name: 'counter', type: 'number', desc: '时间步计数，即 floor(Unix 秒 / period)' },
    { name: 'generated', type: 'boolean', desc: '密钥是否由本接口随机生成（没传 secret 时为 true）' },
    { name: 'secret', type: 'string', desc: '仅 generated 为 true 时返回：随机生成的 Base32 密钥（20 字节，32 个字符）' },
    { name: 'otpauthUrl', type: 'string', desc: '仅 generated 为 true 时返回：otpauth:// 格式的密钥 URI，可用二维码接口生成二维码后用验证器扫描添加' },
  ],
};

async function jwtHandler(input) {
  const token = param(input, 'token', { required: true, max: 8192 });
  const secret = param(input, 'secret', { max: 1024 });
  const encoding = param(input, 'encoding', { default: 'utf8', oneOf: ['utf8', 'base64'] });
  return { data: decodeJwt(token, { secret, encoding }) };
}

async function totpHandler(input) {
  const secret = param(input, 'secret', { max: 128 });
  const digits = param(input, 'digits', { default: 6, int: true, min: 6, max: 8 });
  const period = param(input, 'period', { default: 30, int: true, min: 15, max: 300 });
  const algorithm = param(input, 'algorithm', { default: 'sha1', oneOf: ['sha1', 'sha256', 'sha512'] });
  const time = param(input, 'time', { int: true, min: 0, max: 253402300799 });
  return { data: totp({ secret, digits, period, algorithm, time: time ?? Date.now() / 1000 }) };
}

export default {
  name: 'security-tools',
  category: 'tools',
  title: 'JWT / TOTP / 密码强度',
  description: 'JWT 解码与 HS 签名验证、TOTP 两步验证码、密码强度检测',
  source: '本地计算',
  routes: [
    ...getAndPost(jwtRoute, jwtHandler),
    ...getAndPost(totpRoute, totpHandler),
    {
      method: 'POST',
      path: '/api/tools/password-strength',
      summary: '密码强度检测：信息熵、常见弱密码、键盘顺序、重复字符、年份等模式，估算破解时间（只支持 POST，密码不进网址）',
      params: [
        { name: 'password', in: 'body', required: true, desc: '要检测的密码，最多 128 个字符。请勿提交正在使用的真实密码', example: 'Tr0ub4dor&3' },
      ],
      fields: [
        { name: 'score', type: 'number', desc: '强度评分 0~4：0 非常弱、1 弱、2 一般、3 强、4 非常强（按有效信息熵 <28、<36、<60、<80、≥80 比特划分）' },
        { name: 'level', type: 'string', desc: '强度等级：非常弱 / 弱 / 一般 / 强 / 非常强' },
        { name: 'summary', type: 'string', desc: '对该等级的一句话说明' },
        { name: 'entropyBits', type: 'number', desc: '有效信息熵（比特，保留 1 位小数），已扣除重复、顺序、键盘相邻、常见单词、年份等可预测片段' },
        { name: 'length', type: 'number', desc: '密码长度（按 Unicode 字符计）' },
        { name: 'charset', type: 'object', desc: '包含的字符类型' },
        { name: 'charset.lowercase', type: 'boolean', desc: '是否含小写字母 a-z' },
        { name: 'charset.uppercase', type: 'boolean', desc: '是否含大写字母 A-Z' },
        { name: 'charset.digits', type: 'boolean', desc: '是否含数字 0-9' },
        { name: 'charset.symbols', type: 'boolean', desc: '是否含 ASCII 符号或空格' },
        { name: 'charset.other', type: 'boolean', desc: '是否含非 ASCII 字符（如中文、emoji）' },
        { name: 'charset.poolSize', type: 'number', desc: '按包含的字符类型估算的字符集大小（小写 26、大写 26、数字 10、符号 33、其他 100 相加）' },
        { name: 'isCommon', type: 'boolean', desc: '是否在内置的常见弱密码表中（不区分大小写）' },
        { name: 'crackTime', type: 'object', desc: '估算的平均破解时间（中文描述）' },
        { name: 'crackTime.online', type: 'string', desc: '在线猜测（每秒 100 次）所需时间，如 约 3 天' },
        { name: 'crackTime.offline', type: 'string', desc: '离线暴力破解（每秒 100 亿次）所需时间' },
        { name: 'issues', type: 'array', desc: '发现的问题，可能为空数组' },
        { name: 'issues[]', type: 'string', desc: '一条问题说明' },
        { name: 'suggestions', type: 'array', desc: '改进建议，可能为空数组' },
        { name: 'suggestions[]', type: 'string', desc: '一条建议' },
      ],
      async handler({ body }) {
        const password = param(bodyParams(body), 'password', { required: true, max: 128 });
        return { data: passwordStrength(password) };
      },
    },
  ],
};

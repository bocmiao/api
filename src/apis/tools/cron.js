import { HttpError, param } from '../../lib/http.js';

// 零依赖的 Cron 解析器：5 段（分 时 日 月 周）或 6 段（秒 分 时 日 月 周），固定按北京时间（UTC+8，无夏令时）计算

const OFFSET = 8 * 3600_000;
const DAY = 86400_000;
const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];
const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DOW_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const ALIASES = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
};
const SPECS = {
  second: { min: 0, max: 59, label: '秒' },
  minute: { min: 0, max: 59, label: '分' },
  hour: { min: 0, max: 23, label: '时' },
  dayOfMonth: { min: 1, max: 31, label: '日' },
  month: { min: 1, max: 12, label: '月', names: MONTH_NAMES, base: 1 },
  dayOfWeek: { min: 0, max: 7, label: '周', names: DOW_NAMES, base: 0 },
};

function parseValue(tok, spec, field) {
  const up = tok.toUpperCase();
  if (spec.names) {
    const i = spec.names.indexOf(up);
    if (i >= 0) return i + spec.base;
  }
  if (!/^\d{1,2}$/.test(tok)) throw new HttpError(400, `${field} 字段含无法识别的值：${tok}`);
  const n = Number(tok);
  if (n < spec.min || n > spec.max) throw new HttpError(400, `${field} 字段的值须在 ${spec.min}~${spec.max} 之间：${tok}`);
  return n;
}

// 返回允许值的有序数组；wildcard 表示该段是否为 * / ?（日与周的“或”规则要用）
export function parseField(text, key) {
  const spec = SPECS[key];
  const values = new Set();
  const wildcard = text === '*' || text === '?';
  for (const part of text.split(',')) {
    const m = /^(\*|\?|[A-Za-z0-9]+)(?:-([A-Za-z0-9]+))?(?:\/(\d{1,2}))?$/.exec(part);
    if (!m) throw new HttpError(400, `${key} 字段格式不正确：${part}（支持 * , - / 和数字${spec.names ? '、英文缩写' : ''}，不支持 L W # 等扩展写法）`);
    const [, a, b, stepText] = m;
    const step = stepText ? Number(stepText) : 1;
    if (step < 1) throw new HttpError(400, `${key} 字段的步长须大于 0`);
    let lo;
    let hi;
    if (a === '*' || a === '?') {
      if (b !== undefined) throw new HttpError(400, `${key} 字段格式不正确：${part}`);
      [lo, hi] = [spec.min, key === 'dayOfWeek' ? 6 : spec.max];
    } else {
      lo = parseValue(a, spec, key);
      hi = b !== undefined ? parseValue(b, spec, key) : stepText ? (key === 'dayOfWeek' ? 6 : spec.max) : lo;
    }
    if (lo > hi) throw new HttpError(400, `${key} 字段的范围起点大于终点：${part}`);
    for (let v = lo; v <= hi; v += step) values.add(key === 'dayOfWeek' && v === 7 ? 0 : v);
  }
  return { values: [...values].sort((x, y) => x - y), wildcard, text };
}

export function parseCron(expression) {
  const raw = String(expression ?? '').trim().replace(/\s+/g, ' ');
  const alias = ALIASES[raw.toLowerCase()];
  const expr = alias ?? raw;
  const tokens = expr.split(' ');
  if (tokens.length !== 5 && tokens.length !== 6) throw new HttpError(400, 'Cron 表达式须为 5 段（分 时 日 月 周）或 6 段（秒 分 时 日 月 周），用空格分隔');
  const hasSeconds = tokens.length === 6;
  const [second, minute, hour, dayOfMonth, month, dayOfWeek] = hasSeconds ? tokens : ['0', ...tokens];
  const texts = { second, minute, hour, dayOfMonth, month, dayOfWeek };
  const parsed = Object.fromEntries(Object.entries(texts).map(([k, t]) => [k, parseField(t, k)]));
  return { expression: raw, normalized: expr, hasSeconds, alias: Boolean(alias), fields: texts, parsed };
}

function dayMatches(p, month, dom, dow) {
  if (!p.month.values.includes(month)) return false;
  const domOk = p.dayOfMonth.values.includes(dom);
  const dowOk = p.dayOfWeek.values.includes(dow);
  // 与 Vixie cron 一致：日、周都做了限制时满足其一即可；只限制其一时按那一个
  if (!p.dayOfMonth.wildcard && !p.dayOfWeek.wildcard) return domOk || dowOk;
  if (!p.dayOfMonth.wildcard) return domOk;
  if (!p.dayOfWeek.wildcard) return dowOk;
  return true;
}

// 严格大于 afterMs 的下一个执行时间（UTC 毫秒）；maxDays 天内找不到返回 null
export function nextRun(parsed, afterMs, maxDays = 366 * 8) {
  const cursor = Math.floor(afterMs / 1000) * 1000 + OFFSET; // 北京时间的“墙上时间”毫秒
  let dayStart = Math.floor(cursor / DAY) * DAY;
  for (let i = 0; i < maxDays; i++, dayStart += DAY) {
    const d = new Date(dayStart);
    if (!dayMatches(parsed, d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCDay())) continue;
    for (const h of parsed.hour.values) {
      if (dayStart + (h + 1) * 3600_000 <= cursor) continue;
      for (const m of parsed.minute.values) {
        if (dayStart + h * 3600_000 + (m + 1) * 60_000 <= cursor) continue;
        for (const s of parsed.second.values) {
          const t = dayStart + h * 3600_000 + m * 60_000 + s * 1000;
          if (t > cursor) return t - OFFSET;
        }
      }
    }
  }
  return null;
}

const pad = (n) => String(n).padStart(2, '0');

export function beijingParts(ms) {
  const d = new Date(ms + OFFSET);
  return {
    time: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
    weekday: `星期${WEEK_CN[d.getUTCDay()]}`,
  };
}

// ---------------- 中文描述 ----------------

const unitName = { second: '秒', minute: '分钟', hour: '小时', dayOfMonth: '天', month: '个月' };
const valueName = {
  second: (v) => `${v} 秒`, minute: (v) => `${v} 分`, hour: (v) => `${v} 点`,
  dayOfMonth: (v) => `${v} 号`, month: (v) => `${v} 月`, dayOfWeek: (v) => `周${WEEK_CN[v % 7]}`,
};

function describePart(key, text) {
  const spec = SPECS[key];
  const name = valueName[key];
  const val = (t) => {
    const up = t.toUpperCase();
    if (spec.names && spec.names.includes(up)) return spec.names.indexOf(up) + spec.base;
    return Number(t);
  };
  return text.split(',').map((part) => {
    const [range, step] = part.split('/');
    const [a, b] = range.split('-');
    if (range === '*' || range === '?') return step ? `每 ${step} ${unitName[key] ?? '天'}` : null;
    if (b !== undefined) {
      const r = key === 'dayOfWeek' ? `${name(val(a))}至${name(val(b))}` : `${name(val(a))}到 ${name(val(b))}`;
      return step ? `${r}之间每 ${step} ${unitName[key] ?? '天'}` : r;
    }
    return step ? `从${name(val(a))}起每 ${step} ${unitName[key] ?? '天'}` : name(val(a));
  }).filter(Boolean).join('、') || null;
}

export function describeCron({ fields, parsed, hasSeconds }) {
  const single = (k) => /^\d+$/.test(fields[k]);
  const month = describePart('month', fields.month);
  const dom = describePart('dayOfMonth', fields.dayOfMonth);
  // 周带步长（如 */2）时直接列出是周几，比“每 2 天”准确
  const dow = fields.dayOfWeek.includes('/')
    ? parsed.dayOfWeek.values.map((v) => `周${WEEK_CN[v]}`).join('、')
    : describePart('dayOfWeek', fields.dayOfWeek);
  const every = (d) => (d.startsWith('每') ? d : `每${d}`);
  let date;
  if (dom && dow) date = `${month ? `${month}的` : '每月 '}${dom}或${every(dow)}`;
  else if (dom?.startsWith('每')) date = `${month ? `${month}的` : ''}${dom}（每月从 1 号起算）`;
  else if (dom) date = month ? `${month} ${dom}` : `每月 ${dom}`;
  else if (dow) date = `${month ? `${month}的` : ''}${every(dow)}`;
  else date = month ? `${month}每天` : '每天';

  let time;
  if (single('hour') && single('minute') && (!hasSeconds || single('second'))) {
    const sec = hasSeconds && parsed.second.values[0] ? `:${pad(parsed.second.values[0])}` : '';
    time = `${pad(parsed.hour.values[0])}:${pad(parsed.minute.values[0])}${sec}`;
  } else {
    const h = describePart('hour', fields.hour);
    const m = describePart('minute', fields.minute);
    if (!h && !m) time = '每分钟';
    else if (!h) time = m.startsWith('每') ? m : `每小时的 ${m}`;
    else time = `${h}的 ${m ?? '每分钟'}`;
    if (hasSeconds) {
      const sd = describePart('second', fields.second);
      if (!sd) time += '的每秒';
      else if (sd.startsWith('每') && time === '每分钟') time = sd;
      else if (!(single('second') && parsed.second.values[0] === 0)) time += `的 ${sd}`;
    }
    // 只有时间在变化、日期不限时，“每天”可以省略，如 每 15 分钟
    if (date === '每天' && (time.startsWith('每') || !h)) date = '';
  }
  return `${date} ${time} 执行（北京时间）`.replace(/\s+/g, ' ').trim();
}

export function cronSchedule(expression, { count = 5, from = Date.now() } = {}) {
  const c = parseCron(expression);
  const next = [];
  let t = from;
  while (next.length < count) {
    const n = nextRun(c.parsed, t);
    if (n === null) break;
    next.push({ ...beijingParts(n), iso: new Date(n).toISOString(), timestamp: Math.floor(n / 1000) });
    t = n;
  }
  if (!next.length) throw new HttpError(400, 'Cron 表达式在未来 8 年内没有任何执行时间（例如 2 月 30 日），请检查日期');
  return {
    expression: c.expression,
    normalized: c.normalized,
    hasSeconds: c.hasSeconds,
    description: describeCron(c),
    fields: c.fields,
    timezone: 'Asia/Shanghai',
    next,
  };
}

// from：Unix 秒 / 毫秒，或北京时间 YYYY-MM-DD[ HH:mm[:ss]]
export function parseFrom(v) {
  if (v == null || v === '') return Date.now();
  if (/^\d{9,10}$/.test(v)) return Number(v) * 1000;
  if (/^\d{12,13}$/.test(v)) return Number(v);
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (!m) throw new HttpError(400, 'from 须为 Unix 时间戳或 YYYY-MM-DD HH:mm:ss（北京时间）');
  const [y, mo, d, h = 0, mi = 0, s = 0] = m.slice(1).map((x) => (x === undefined ? undefined : Number(x)));
  const ms = Date.UTC(y, mo - 1, d, h, mi, s) - OFFSET;
  const back = new Date(ms + OFFSET);
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) throw new HttpError(400, 'from 不是有效的时间');
  return ms;
}

export default {
  name: 'cron',
  category: 'tools',
  title: 'Cron 表达式解析',
  description: '解析 5 段 / 6 段 Cron 表达式，给出中文说明和接下来的执行时间（北京时间）',
  source: '本地计算',
  routes: [
    {
      method: 'GET',
      path: '/api/tools/cron',
      summary: 'Cron 表达式解析：中文说明 + 未来 N 次执行时间（北京时间）',
      params: [
        { name: 'expression', required: true, desc: 'Cron 表达式：5 段（分 时 日 月 周）或 6 段（秒 分 时 日 月 周）；支持 * ? , - /、月份和星期英文缩写（JAN、MON）、周日写 0 或 7，以及 @yearly @monthly @weekly @daily @hourly；不支持 L W # 扩展', example: '0 9 * * 1-5' },
        { name: 'count', default: '5', desc: '返回接下来几次执行时间（1~20）', example: '3' },
        { name: 'from', required: false, desc: '从哪个时间之后开始算：Unix 时间戳（秒或毫秒），或北京时间 YYYY-MM-DD HH:mm:ss；不传为当前时间', example: '2026-01-01 00:00:00' },
      ],
      fields: [
        { name: 'expression', type: 'string', desc: '输入的表达式（多余空白合并为一个空格）' },
        { name: 'normalized', type: 'string', desc: '实际计算用的表达式；@daily 等简写会展开成 5 段，如 0 0 * * *' },
        { name: 'hasSeconds', type: 'boolean', desc: '是否为带秒的 6 段表达式' },
        { name: 'description', type: 'string', desc: '自动生成的中文说明，如 每周一至周五 09:00 执行（北京时间）' },
        { name: 'fields', type: 'object', desc: '各段原文' },
        { name: 'fields.second', type: 'string', desc: '秒（0~59）；5 段表达式固定为 0' },
        { name: 'fields.minute', type: 'string', desc: '分（0~59）' },
        { name: 'fields.hour', type: 'string', desc: '时（0~23）' },
        { name: 'fields.dayOfMonth', type: 'string', desc: '日（1~31）。与“周”都不是 * 时，两者满足其一即执行（与 Linux crontab 一致）' },
        { name: 'fields.month', type: 'string', desc: '月（1~12 或 JAN~DEC）' },
        { name: 'fields.dayOfWeek', type: 'string', desc: '周（0~7 或 SUN~SAT，0 和 7 都是周日）' },
        { name: 'timezone', type: 'string', desc: '计算使用的时区，固定为 Asia/Shanghai（北京时间，UTC+8）' },
        { name: 'next', type: 'array', desc: '接下来的执行时间，按时间先后排列，长度一般等于 count；8 年内执行次数不足时会更少' },
        { name: 'next[].time', type: 'string', desc: '北京时间，YYYY-MM-DD HH:mm:ss' },
        { name: 'next[].weekday', type: 'string', desc: '北京时间当天是星期几，如 星期一' },
        { name: 'next[].iso', type: 'string', desc: 'ISO 8601 UTC 时间' },
        { name: 'next[].timestamp', type: 'number', desc: 'Unix 时间戳（秒）' },
      ],
      async handler({ query }) {
        const expression = param(query, 'expression', { required: true, max: 200 });
        const count = param(query, 'count', { default: 5, int: true, min: 1, max: 20 });
        const from = parseFrom(param(query, 'from', { max: 32 }));
        return { data: cronSchedule(expression, { count, from }) };
      },
    },
  ],
};

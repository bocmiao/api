import { randomInt } from 'node:crypto';
import { HttpError, param } from '../../lib/http.js';

// 随机数全部用 crypto.randomInt（密码学安全、无取模偏差），适合抽签、抽奖等需要公平的场景。

export const MAX_COUNT = 1000;
export const MAX_ITEMS = 1000;
const LIMIT = 1e12; // crypto.randomInt 要求 max - min < 2^48，这里取整数范围 ±1 万亿
const MAX_STRING_LENGTH = 1024;
const MAX_STRING_COUNT = 100;

export const CHARSETS = {
  alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  letters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  hex: '0123456789abcdef',
  lower: 'abcdefghijklmnopqrstuvwxyz0123456789',
  readable: 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789', // 去掉易混淆的 0O1lIiLo
};

// Fisher–Yates 洗牌，返回新数组
export function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// [min, max] 闭区间内的随机整数；unique 时互不重复
export function randomNumbers({ min = 1, max = 100, count = 1, unique = false } = {}) {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || Math.abs(min) > LIMIT || Math.abs(max) > LIMIT) {
    throw new HttpError(400, `min、max 须为 -${LIMIT} ~ ${LIMIT} 之间的整数`);
  }
  if (min > max) throw new HttpError(400, 'min 不能大于 max');
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) throw new HttpError(400, `count 须为 1~${MAX_COUNT} 之间的整数`);
  const size = max - min + 1;
  if (unique && count > size) throw new HttpError(400, `不重复时 count 不能超过范围内的整数个数（${size} 个）`);
  const draw = () => min + randomInt(size);
  if (!unique) return Array.from({ length: count }, draw);
  // 要取的数接近范围大小时直接洗牌截取，否则拒绝采样去重
  if (count * 2 > size) return shuffle(Array.from({ length: size }, (_, i) => min + i)).slice(0, count);
  const seen = new Set();
  while (seen.size < count) seen.add(draw());
  return [...seen];
}

// 选项：有换行时按行分隔，否则按中英文逗号分隔；去掉首尾空白和空项，不去重（重复写几次就是加权）
export function parseItems(raw) {
  const text = String(raw ?? '');
  const items = text.split(/[\r\n]/.test(text) ? /\r?\n|\r/ : /[,，]/).map((s) => s.trim()).filter(Boolean);
  if (!items.length) throw new HttpError(400, 'items 不能为空');
  if (items.length > MAX_ITEMS) throw new HttpError(400, `items 最多 ${MAX_ITEMS} 项`);
  return items;
}

// 不放回抽取 count 项（同一项不会被抽中两次）
export function pickItems(items, count = 1) {
  if (!Number.isInteger(count) || count < 1) throw new HttpError(400, 'count 须为正整数');
  if (count > items.length) throw new HttpError(400, `count 不能超过选项个数（${items.length} 项）`);
  const idx = randomNumbers({ min: 0, max: items.length - 1, count, unique: true });
  return idx.map((i) => ({ index: i, item: items[i] }));
}

export function randomStrings({ length = 16, charset = 'alnum', count = 1 } = {}) {
  const chars = CHARSETS[charset];
  if (!chars) throw new HttpError(400, `charset 只能是 ${Object.keys(CHARSETS).join(' / ')}`);
  return Array.from({ length: count }, () => Array.from({ length }, () => chars[randomInt(chars.length)]).join(''));
}

const bool = (query, name) => ['true', '1'].includes(param(query, name, { default: 'false', oneOf: ['true', 'false', '1', '0'] }));

const itemsParam = { name: 'items', required: true, desc: `选项列表，最多 ${MAX_ITEMS} 项：有换行时按行分隔，否则按逗号（中英文均可）分隔；首尾空白和空项会被去掉，重复项保留（可用来加权）`, example: '张三,李四,王五,赵六' };

export default {
  name: 'random',
  category: 'tools',
  title: '随机工具',
  description: '随机整数、抽签抽奖、列表乱序、随机字符串，使用密码学安全随机数，结果不缓存',
  source: '本地生成（Node.js crypto.randomInt）',
  routes: [
    {
      method: 'GET',
      path: '/api/random/number',
      summary: '生成指定范围内的随机整数，可一次多个、可不重复',
      params: [
        { name: 'min', default: '1', desc: `最小值（含），-${LIMIT}~${LIMIT} 之间的整数`, example: '1' },
        { name: 'max', default: '100', desc: `最大值（含），-${LIMIT}~${LIMIT} 之间的整数，不能小于 min`, example: '100' },
        { name: 'count', default: '1', desc: `生成个数，1~${MAX_COUNT}`, example: '5' },
        { name: 'unique', default: 'false', desc: '是否互不重复：true / false；为 true 时 count 不能超过范围内的整数个数', example: 'true' },
      ],
      fields: [
        { name: 'min', type: 'number', desc: '最小值（含）' },
        { name: 'max', type: 'number', desc: '最大值（含）' },
        { name: 'count', type: 'number', desc: '生成个数' },
        { name: 'unique', type: 'boolean', desc: '是否互不重复' },
        { name: 'numbers', type: 'array', desc: '随机整数列表（按生成顺序，未排序）' },
      ],
      async handler({ query }) {
        const min = param(query, 'min', { default: 1, int: true, min: -LIMIT, max: LIMIT });
        const max = param(query, 'max', { default: 100, int: true, min: -LIMIT, max: LIMIT });
        const count = param(query, 'count', { default: 1, int: true, min: 1, max: MAX_COUNT });
        const unique = bool(query, 'unique');
        return { data: { min, max, count, unique, numbers: randomNumbers({ min, max, count, unique }) } };
      },
    },
    {
      method: 'GET',
      path: '/api/random/pick',
      summary: '抽签 / 抽奖：从选项中随机抽取若干项（不放回）',
      params: [
        itemsParam,
        { name: 'count', default: '1', desc: '抽取个数，不能超过选项个数；同一项不会被重复抽中', example: '1' },
      ],
      fields: [
        { name: 'total', type: 'number', desc: '有效选项个数' },
        { name: 'count', type: 'number', desc: '抽取个数' },
        { name: 'picked', type: 'array', desc: '抽中的项（按抽中顺序）' },
        { name: 'picked[].index', type: 'number', desc: '该项在选项列表中的位置（从 0 开始）' },
        { name: 'picked[].item', type: 'string', desc: '选项内容' },
      ],
      async handler({ query }) {
        const items = parseItems(param(query, 'items', { required: true, max: 20_000 }));
        const count = param(query, 'count', { default: 1, int: true, min: 1, max: MAX_ITEMS });
        return { data: { total: items.length, count, picked: pickItems(items, count) } };
      },
    },
    {
      method: 'GET',
      path: '/api/random/shuffle',
      summary: '把列表随机打乱顺序（如随机分组、排序号）',
      params: [itemsParam],
      fields: [
        { name: 'total', type: 'number', desc: '有效选项个数' },
        { name: 'items', type: 'array', desc: '打乱后的列表（字符串）' },
      ],
      async handler({ query }) {
        const items = parseItems(param(query, 'items', { required: true, max: 20_000 }));
        return { data: { total: items.length, items: shuffle(items) } };
      },
    },
    {
      method: 'GET',
      path: '/api/random/string',
      summary: '生成随机字符串（邀请码、随机 ID 等）',
      params: [
        { name: 'length', default: '16', desc: `长度，1~${MAX_STRING_LENGTH}`, example: '16' },
        { name: 'charset', default: 'alnum', desc: '字符集：alnum 大小写字母+数字 / letters 大小写字母 / digits 数字 / hex 十六进制小写 / lower 小写字母+数字 / readable 去掉易混淆字符（0O1lIiLo）', example: 'alnum' },
        { name: 'count', default: '1', desc: `生成个数，1~${MAX_STRING_COUNT}`, example: '1' },
      ],
      fields: [
        { name: 'length', type: 'number', desc: '每个字符串的长度' },
        { name: 'charset', type: 'string', desc: '使用的字符集名称' },
        { name: 'count', type: 'number', desc: '生成个数' },
        { name: 'strings', type: 'array', desc: '随机字符串列表' },
      ],
      async handler({ query }) {
        const length = param(query, 'length', { default: 16, int: true, min: 1, max: MAX_STRING_LENGTH });
        const charset = param(query, 'charset', { default: 'alnum', oneOf: Object.keys(CHARSETS) });
        const count = param(query, 'count', { default: 1, int: true, min: 1, max: MAX_STRING_COUNT });
        return { data: { length, charset, count, strings: randomStrings({ length, charset, count }) } };
      },
    },
  ],
};

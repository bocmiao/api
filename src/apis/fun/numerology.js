import { HttpError, param } from '../../lib/http.js';
import { NUMEROLOGY } from './data/numerology.js';

export const NUMEROLOGY_NOTICE = '81 数理属于民间说法，号码吉凶仅供娱乐，请勿当真，也不必因此更换号码';

const TYPES = {
  phone: { name: '手机号', re: /^1\d{10}$/, error: '手机号须为 1 开头的 11 位数字' },
  qq: { name: 'QQ 号', re: /^[1-9]\d{4,10}$/, error: 'QQ 号须为 5~11 位数字，且首位不能为 0' },
};

const trimZeros = (s) => s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

// 81 数理算法：取后四位 ÷ 80，小数部分 × 80 后四舍五入，结果为 0 时按 80 计。
// 后四位是整数，“小数部分 × 80”恰好等于除以 80 的余数，这里用整数运算避免浮点误差。
export function shuliOf(digits) {
  const n = Number(digits);
  if (!/^\d{1,4}$/.test(String(digits)) || !Number.isInteger(n)) throw new HttpError(400, '用于计算的后四位必须是数字');
  const rem = n % 80;
  const value = rem === 0 ? 80 : rem;
  const quotient = trimZeros((n / 80).toFixed(4));
  const frac = trimZeros((rem / 80).toFixed(4));
  const formula = rem === 0
    ? `${digits} ÷ 80 = ${quotient}，小数部分为 0，按 80 计`
    : `${digits} ÷ 80 = ${quotient}，小数部分 ${frac} × 80 = ${rem}`;
  return { value, formula };
}

export function numerologyOf(type, number) {
  const t = TYPES[type];
  if (!t) throw new HttpError(400, 'type 只能是 phone / qq');
  if (!t.re.test(number)) throw new HttpError(400, t.error);
  const digits = number.slice(-4);
  const { value, formula } = shuliOf(digits);
  const entry = NUMEROLOGY[value];
  return {
    type,
    typeName: t.name,
    number,
    digits,
    value,
    formula,
    level: entry.level,
    sign: entry.sign,
    detail: entry.detail,
    notice: NUMEROLOGY_NOTICE,
  };
}

export default {
  name: 'numerology',
  category: 'fun',
  title: '号码吉凶',
  description: '按 81 数理测算手机号 / QQ 号吉凶：取号码后四位除以 80，小数部分乘 80 后四舍五入（为 0 时按 80 计）得到数理数，查 81 数理表。仅供娱乐',
  source: '本地计算（81 数理，民间说法）',
  routes: [
    {
      method: 'GET',
      path: '/api/numerology',
      summary: '手机号 / QQ 号 81 数理吉凶（仅供娱乐）',
      params: [
        { name: 'type', required: false, default: 'phone', desc: '号码类型：phone（手机号）/ qq（QQ 号）', example: 'phone' },
        {
          name: 'number',
          required: true,
          desc: '号码，只能是纯数字，不能带空格、横线或 +86。手机号须为 1 开头的 11 位；QQ 号须为 5~11 位且首位不为 0',
          example: '13800138000',
        },
      ],
      fields: [
        { name: 'type', type: 'string', desc: '号码类型：phone 或 qq' },
        { name: 'typeName', type: 'string', desc: '号码类型中文名：手机号 或 QQ 号' },
        { name: 'number', type: 'string', desc: '查询的号码（原样返回）' },
        { name: 'digits', type: 'string', desc: '参与计算的号码后四位（保留前导 0，如 "0080"）' },
        {
          name: 'value',
          type: 'number',
          desc: '数理数，1~80 的整数。算法：后四位 ÷ 80，取小数部分 × 80 后四舍五入，结果为 0 时按 80 计。'
            + 'QQ 号用同样的规则；因为 10000 是 80 的整数倍，用整个号码计算与只用后四位结果相同。81 数理表中的 81 按此算法不会出现',
        },
        { name: 'formula', type: 'string', desc: '计算过程说明，如 "8000 ÷ 80 = 100，小数部分为 0，按 80 计" 或 "1234 ÷ 80 = 15.425，小数部分 0.425 × 80 = 34"' },
        { name: 'level', type: 'string', desc: '吉凶：吉、半吉（民间表中的“吉带凶”“凶带吉”）、凶' },
        { name: 'sign', type: 'string', desc: '签语，四字一句的 81 数理口诀，参照民间通行表整理' },
        { name: 'detail', type: 'string', desc: '详细解释：本项目撰写的白话说明' },
        { name: 'notice', type: 'string', desc: '固定提示语：结果仅供娱乐，请勿当真' },
      ],
      async handler({ query }) {
        const type = param(query, 'type', { default: 'phone', oneOf: Object.keys(TYPES) });
        // 具体格式在 numerologyOf 里按类型校验，给出更明确的错误提示
        const number = param(query, 'number', { required: true, max: 20 });
        return { data: numerologyOf(type, number) };
      },
    },
  ],
};

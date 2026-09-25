import { HttpError, param } from '../../lib/http.js';
import { num, round } from './calc-util.js';

// 个人所得税（综合所得·工资薪金）
// 依据：《个人所得税法》（2018 年修正）综合所得税率表；国家税务总局公告 2018 年第 61 号（累计预扣法）；
// 财政部 税务总局公告 2023 年第 30 号（全年一次性奖金单独计税政策延续至 2027-12-31）。

export const MONTHLY_THRESHOLD = 5000; // 基本减除费用（起征点），元/月
export const ANNUAL_THRESHOLD = 60000; // 元/年

// 综合所得年度税率表（按年度应纳税所得额）：[上限（含）, 税率 %, 速算扣除数]
export const ANNUAL_BRACKETS = [
  [36000, 3, 0],
  [144000, 10, 2520],
  [300000, 20, 16920],
  [420000, 25, 31920],
  [660000, 30, 52920],
  [960000, 35, 85920],
  [Infinity, 45, 181920],
];

// 按月换算后的综合所得税率表：用于全年一次性奖金单独计税（奖金 ÷ 12 找税率）
export const MONTHLY_BRACKETS = [
  [3000, 3, 0],
  [12000, 10, 210],
  [25000, 20, 1410],
  [35000, 25, 2660],
  [55000, 30, 4410],
  [80000, 35, 7160],
  [Infinity, 45, 15160],
];

const cents = (yuan) => Math.round(yuan * 100);
const yuan = (c) => c / 100;

// 按税率表计算：taxable 为应纳税所得额（元）；lookup 为查档用的金额（默认同 taxable）
export function taxBy(table, taxable, lookup = taxable) {
  const [, rate, quick] = table.find(([limit]) => lookup <= limit);
  if (taxable <= 0) return { rate: table[0][1], quickDeduction: 0, tax: 0 };
  // 以分为单位计算，避免浮点误差：税额 = 应纳税所得额 × 税率 − 速算扣除数，四舍五入到分
  const tax = Math.max(0, Math.round((cents(taxable) * rate) / 100) - quick * 100);
  return { rate, quickDeduction: quick, tax: yuan(tax) };
}

// 工资薪金累计预扣法：逐月计算（第 m 月累计应纳税所得额 = (月收入 − 5000 − 五险一金 − 专项附加 − 其他) × m）
export function monthlyWithholding({ income, insurance = 0, special = 0, other = 0, months = 12 }) {
  const perMonth = income - MONTHLY_THRESHOLD - insurance - special - other;
  const list = [];
  let paidCents = 0;
  for (let m = 1; m <= months; m++) {
    const cumulativeTaxable = Math.max(0, round(perMonth * m));
    const { rate, quickDeduction, tax: cumulativeTax } = taxBy(ANNUAL_BRACKETS, cumulativeTaxable);
    // 本月应预扣 = 累计应纳税额 − 已预扣；为负时本月不扣（多扣的年度汇算时退）
    const taxCents = Math.max(0, cents(cumulativeTax) - paidCents);
    paidCents += taxCents;
    list.push({
      month: m,
      cumulativeIncome: round(income * m),
      cumulativeTaxable,
      rate,
      quickDeduction,
      cumulativeTax: yuan(paidCents),
      tax: yuan(taxCents),
      afterTax: round(income - insurance - yuan(taxCents)),
    });
  }
  const totalIncome = round(income * months);
  const totalInsurance = round(insurance * months);
  const totalTax = yuan(paidCents);
  const totalAfterTax = round(totalIncome - totalInsurance - totalTax);
  return {
    months: list,
    total: {
      income: totalIncome,
      insurance: totalInsurance,
      tax: totalTax,
      afterTax: totalAfterTax,
      averageAfterTax: round(totalAfterTax / months),
      effectiveRate: totalIncome > 0 ? round((totalTax / totalIncome) * 100) : 0,
    },
  };
}

// 年度汇算：全年综合所得收入 − 60000 − 全年五险一金 − 全年专项附加 − 全年其他扣除
export function annualTax({ income, insurance = 0, special = 0, other = 0 }) {
  const taxable = Math.max(0, round(income - ANNUAL_THRESHOLD - insurance - special - other));
  const { rate, quickDeduction, tax } = taxBy(ANNUAL_BRACKETS, taxable);
  return {
    taxable,
    rate,
    quickDeduction,
    tax,
    afterTax: round(income - insurance - tax),
    effectiveRate: income > 0 ? round((tax / income) * 100) : 0,
  };
}

// 全年一次性奖金单独计税：奖金 ÷ 12 查月度税率表，税额 = 奖金 × 税率 − 速算扣除数（只减一次）
export function bonusTax(bonus) {
  const { rate, quickDeduction, tax } = taxBy(MONTHLY_BRACKETS, bonus, bonus / 12);
  return { amount: bonus, monthlyAverage: round(bonus / 12), rate, quickDeduction, tax, afterTax: round(bonus - tax) };
}

const NOTE = '按现行综合所得税率表（3%~45% 七级超额累进，起征点每月 5000 元）计算，仅供参考，实际以个人所得税 App 和单位申报为准。';

export default {
  name: 'tax',
  category: 'life',
  title: '个人所得税计算',
  description: '按现行综合所得税率表计算工资薪金个税：月度累计预扣逐月明细、年度汇算，支持五险一金、专项附加扣除和年终奖单独计税',
  source: '本地计算（个人所得税法综合所得税率表、国家税务总局公告 2018 年第 61 号）',
  routes: [
    {
      method: 'GET',
      path: '/api/tax/income',
      summary: '个人所得税计算（月度累计预扣 / 年度汇算）',
      params: [
        { name: 'income', required: true, desc: '税前收入（元）：mode=monthly 时为每月工资，mode=annual 时为全年工资薪金合计（0~100000000，最多 2 位小数）', example: '20000' },
        { name: 'mode', default: 'monthly', desc: '计算方式：monthly 按月累计预扣法逐月计算（金额均按月填写）；annual 年度汇算（金额均按全年合计填写）', example: 'monthly' },
        { name: 'insurance', default: '0', desc: '个人缴纳的五险一金（元），monthly 填每月、annual 填全年', example: '3000' },
        { name: 'special', default: '0', desc: '专项附加扣除合计（元）：子女教育、赡养老人、住房贷款利息或住房租金、3 岁以下婴幼儿照护、继续教育等，monthly 填每月、annual 填全年', example: '2000' },
        { name: 'other', default: '0', desc: '其他依法扣除（元），如个人养老金、企业年金、商业健康险，monthly 填每月、annual 填全年', example: '0' },
        { name: 'months', default: '12', desc: 'mode=monthly 时计算几个月（从 1 月起，1~12）', example: '12' },
        { name: 'bonus', desc: '全年一次性奖金（年终奖，元），传入后按单独计税方式另行计算', example: '36000' },
      ],
      fields: [
        { name: 'mode', type: 'string', desc: '计算方式：monthly（月度累计预扣）或 annual（年度汇算）' },
        { name: 'income', type: 'number', desc: '税前收入（元），即请求参数 income；monthly 为每月、annual 为全年' },
        { name: 'insurance', type: 'number', desc: '五险一金（元），口径同 income' },
        { name: 'special', type: 'number', desc: '专项附加扣除（元），口径同 income' },
        { name: 'other', type: 'number', desc: '其他扣除（元），口径同 income' },
        { name: 'threshold', type: 'number', desc: '基本减除费用（元）：monthly 为每月 5000，annual 为全年 60000' },
        { name: 'taxable', type: 'number', desc: '应纳税所得额（元）：monthly 为单月（收入 − 5000 − 五险一金 − 专项附加 − 其他，不低于 0），annual 为全年' },
        { name: 'rate', type: 'number', desc: '适用税率（百分数，如 10 表示 10%）：monthly 为第 1 个月的适用税率，annual 为全年适用税率' },
        { name: 'quickDeduction', type: 'number', desc: '速算扣除数（元），与 rate 对应（年度税率表）' },
        { name: 'tax', type: 'number', desc: '个税（元）：monthly 为第 1 个月预扣的个税，annual 为全年应纳个税' },
        { name: 'afterTax', type: 'number', desc: '税后收入（元）= 收入 − 五险一金 − 个税：monthly 为第 1 个月到手，annual 为全年到手（不含年终奖）' },
        { name: 'effectiveRate', type: 'number', desc: '实际税负（百分数，保留 2 位小数）= 个税 ÷ 税前收入 × 100；monthly 按 total 合计计算' },
        { name: 'months', type: 'array|null', desc: 'monthly：逐月预扣明细；annual 为 null' },
        { name: 'months[].month', type: 'number', desc: '第几个月（1~12）' },
        { name: 'months[].cumulativeIncome', type: 'number', desc: '截至本月累计收入（元）' },
        { name: 'months[].cumulativeTaxable', type: 'number', desc: '截至本月累计应纳税所得额（元）' },
        { name: 'months[].rate', type: 'number', desc: '按累计应纳税所得额查年度税率表得到的税率（百分数）' },
        { name: 'months[].quickDeduction', type: 'number', desc: '对应的速算扣除数（元）' },
        { name: 'months[].cumulativeTax', type: 'number', desc: '截至本月累计已预扣个税（元）' },
        { name: 'months[].tax', type: 'number', desc: '本月预扣个税（元）= 累计应纳税额 − 此前已预扣，不低于 0。随累计收入跨档，下半年通常比上半年多' },
        { name: 'months[].afterTax', type: 'number', desc: '本月到手（元）= 月收入 − 五险一金 − 本月个税' },
        { name: 'total', type: 'object|null', desc: 'monthly：所计算月份的合计；annual 为 null' },
        { name: 'total.income', type: 'number', desc: '合计税前收入（元）' },
        { name: 'total.insurance', type: 'number', desc: '合计五险一金（元）' },
        { name: 'total.tax', type: 'number', desc: '合计预扣个税（元）；按满 12 个月计算时等于年度汇算应纳税额' },
        { name: 'total.afterTax', type: 'number', desc: '合计到手（元）' },
        { name: 'total.averageAfterTax', type: 'number', desc: '月均到手（元）' },
        { name: 'total.effectiveRate', type: 'number', desc: '合计实际税负（百分数）' },
        { name: 'bonus', type: 'object|null', desc: '年终奖单独计税结果；未传 bonus 时为 null' },
        { name: 'bonus.amount', type: 'number', desc: '年终奖金额（元）' },
        { name: 'bonus.monthlyAverage', type: 'number', desc: '奖金 ÷ 12（元），用来查月度税率表' },
        { name: 'bonus.rate', type: 'number', desc: '适用税率（百分数）' },
        { name: 'bonus.quickDeduction', type: 'number', desc: '月度税率表的速算扣除数（元），只减一次' },
        { name: 'bonus.tax', type: 'number', desc: '年终奖个税（元）= 奖金 × 税率 − 速算扣除数' },
        { name: 'bonus.afterTax', type: 'number', desc: '年终奖税后（元）' },
        { name: 'brackets', type: 'array', desc: '本次使用的综合所得年度税率表（7 级）' },
        { name: 'brackets[].level', type: 'number', desc: '级数 1~7' },
        { name: 'brackets[].min', type: 'number', desc: '全年应纳税所得额下限（元，不含）' },
        { name: 'brackets[].max', type: 'number|null', desc: '全年应纳税所得额上限（元，含），最高一档为 null' },
        { name: 'brackets[].rate', type: 'number', desc: '税率（百分数）' },
        { name: 'brackets[].quickDeduction', type: 'number', desc: '速算扣除数（元）' },
        { name: 'note', type: 'string', desc: '计算依据与免责说明（仅供参考）' },
      ],
      async handler({ query }) {
        const mode = param(query, 'mode', { default: 'monthly', oneOf: ['monthly', 'annual'] });
        const money = (name, required = false) => num(query, name, { required, default: 0, min: 0, max: 1e8, unit: '元', decimals: 2 });
        const input = { income: money('income', true), insurance: money('insurance'), special: money('special'), other: money('other') };
        const bonusRaw = query.get('bonus');
        const bonus = bonusRaw == null || bonusRaw === '' ? null : bonusTax(num(query, 'bonus', { min: 0, max: 1e9, unit: '元', decimals: 2 }));
        if (input.insurance > input.income) throw new HttpError(400, 'insurance 不能大于 income');
        const brackets = ANNUAL_BRACKETS.map(([max, rate, quickDeduction], i) => ({
          level: i + 1, min: i ? ANNUAL_BRACKETS[i - 1][0] : 0, max: Number.isFinite(max) ? max : null, rate, quickDeduction,
        }));

        if (mode === 'annual') {
          const a = annualTax(input);
          return { data: { mode, ...input, threshold: ANNUAL_THRESHOLD, ...a, months: null, total: null, bonus, brackets, note: NOTE } };
        }
        const months = param(query, 'months', { default: 12, int: true, min: 1, max: 12 });
        const r = monthlyWithholding({ ...input, months });
        const first = r.months[0];
        return {
          data: {
            mode,
            ...input,
            threshold: MONTHLY_THRESHOLD,
            taxable: first.cumulativeTaxable,
            rate: first.rate,
            quickDeduction: first.quickDeduction,
            tax: first.tax,
            afterTax: first.afterTax,
            effectiveRate: r.total.effectiveRate,
            months: r.months,
            total: r.total,
            bonus,
            brackets,
            note: NOTE,
          },
        };
      },
    },
  ],
};

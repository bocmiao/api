import { HttpError, param } from '../../lib/http.js';

const round1 = (n) => Math.round(n * 10) / 10;

// 中国成人标准（《中国成人超重和肥胖症预防控制指南》）
const CHINA = [
  { max: 18.5, code: 'underweight', level: '偏瘦', range: '< 18.5' },
  { max: 24, code: 'normal', level: '正常', range: '18.5 ~ 23.9' },
  { max: 28, code: 'overweight', level: '超重', range: '24.0 ~ 27.9' },
  { max: Infinity, code: 'obese', level: '肥胖', range: '≥ 28.0' },
];

// WHO 成人标准
const WHO = [
  { max: 18.5, code: 'underweight', level: '偏瘦', range: '< 18.5' },
  { max: 25, code: 'normal', level: '正常', range: '18.5 ~ 24.9' },
  { max: 30, code: 'overweight', level: '超重', range: '25.0 ~ 29.9' },
  { max: 35, code: 'obese_1', level: 'I 度肥胖', range: '30.0 ~ 34.9' },
  { max: 40, code: 'obese_2', level: 'II 度肥胖', range: '35.0 ~ 39.9' },
  { max: Infinity, code: 'obese_3', level: 'III 度肥胖', range: '≥ 40.0' },
];

const ADVICE = {
  underweight: '体重偏轻，建议保证每日能量和优质蛋白摄入，规律三餐，配合力量训练增加肌肉量；如体重持续下降请就医排查原因。',
  normal: '体重在健康范围内，继续保持均衡饮食和每周至少 150 分钟的中等强度运动。',
  overweight: '体重超重，建议控制总热量、少吃高油高糖食物，每周进行 150~300 分钟中等强度运动，循序渐进减重。',
  obese: '已达到肥胖标准，肥胖会增加高血压、糖尿病等风险，建议在医生或营养师指导下制定减重计划。',
};

// 分级按保留 1 位小数后的 BMI 判断，与返回的 bmi 值一致（避免 23.95 这类介于两档之间的值）
const classify = (table, bmi) => table.find((c) => bmi < c.max);

export function calcBMI(height, weight) {
  // 用 厘米² / 10000 而不是 (厘米/100)²，减少浮点误差（如 160cm、80kg 应为 31.25 → 31.3，而不是 31.2499… → 31.2）
  const h2 = height * height;
  const bmi = round1((weight * 10000) / h2);
  const cn = classify(CHINA, bmi);
  const who = classify(WHO, bmi);
  const min = round1((18.5 * h2) / 10000);
  const max = round1((23.9 * h2) / 10000);
  const toNormal = weight < min ? round1(min - weight) : weight > max ? round1(max - weight) : 0;
  return {
    height,
    weight,
    bmi,
    china: { level: cn.level, code: cn.code, range: cn.range },
    who: { level: who.level, code: who.code, range: who.range },
    normalWeight: { min, max },
    toNormal,
    advice: ADVICE[cn.code],
  };
}

function number(query, name, min, max, unit) {
  const raw = param(query, name, { required: true, max: 10 });
  const n = Number(raw);
  if (!/^\d+(\.\d+)?$/.test(raw) || !(n >= min && n <= max)) throw new HttpError(400, `${name} 须为 ${min}~${max} 之间的数字（${unit}）`);
  return n;
}

export default {
  name: 'bmi',
  category: 'life',
  title: 'BMI 计算',
  description: '根据身高体重计算 BMI，给出中国标准与 WHO 标准分级、健康体重范围和建议',
  source: '本地计算（中国成人超重和肥胖症预防控制指南、WHO 标准）',
  routes: [
    {
      method: 'GET',
      path: '/api/bmi',
      summary: '计算身体质量指数（BMI）',
      params: [
        { name: 'height', required: true, desc: '身高，单位厘米（50~250，可带小数）', example: '175' },
        { name: 'weight', required: true, desc: '体重，单位公斤（10~300，可带小数）', example: '68.5' },
      ],
      fields: [
        { name: 'height', type: 'number', desc: '身高（厘米），即请求参数 height' },
        { name: 'weight', type: 'number', desc: '体重（公斤），即请求参数 weight' },
        { name: 'bmi', type: 'number', desc: 'BMI = 体重(kg) ÷ 身高(m)²，四舍五入保留 1 位小数；分级按这个保留后的值判断' },
        { name: 'china', type: 'object', desc: '中国成人标准分级（适用于 18 岁以上成人，不适用于儿童、孕妇和肌肉发达的运动员）' },
        { name: 'china.level', type: 'string', desc: '分级名称：偏瘦（< 18.5）、正常（18.5~23.9）、超重（24.0~27.9）、肥胖（≥ 28.0）' },
        { name: 'china.code', type: 'string', desc: '分级代码：underweight、normal、overweight、obese，与 level 一一对应' },
        { name: 'china.range', type: 'string', desc: '该分级的 BMI 区间文字，如 "18.5 ~ 23.9"' },
        { name: 'who', type: 'object', desc: '世界卫生组织（WHO）成人标准分级' },
        { name: 'who.level', type: 'string', desc: '分级名称：偏瘦（< 18.5）、正常（18.5~24.9）、超重（25.0~29.9）、I 度肥胖（30.0~34.9）、II 度肥胖（35.0~39.9）、III 度肥胖（≥ 40.0）' },
        { name: 'who.code', type: 'string', desc: '分级代码：underweight、normal、overweight、obese_1、obese_2、obese_3，与 level 一一对应' },
        { name: 'who.range', type: 'string', desc: '该分级的 BMI 区间文字，如 "25.0 ~ 29.9"' },
        { name: 'normalWeight', type: 'object', desc: '按中国标准（BMI 18.5~23.9）换算的该身高正常体重范围' },
        { name: 'normalWeight.min', type: 'number', desc: '正常体重下限（公斤，保留 1 位小数）= 18.5 × 身高(m)²' },
        { name: 'normalWeight.max', type: 'number', desc: '正常体重上限（公斤，保留 1 位小数）= 23.9 × 身高(m)²' },
        { name: 'toNormal', type: 'number', desc: '距离正常体重范围还差多少公斤（保留 1 位小数）：正数表示需要增重到下限，负数表示需要减重到上限，已在范围内为 0' },
        { name: 'advice', type: 'string', desc: '按中国标准分级给出的一句健康建议（仅供参考，不能替代医生诊断）' },
      ],
      async handler({ query }) {
        const height = number(query, 'height', 50, 250, '厘米');
        const weight = number(query, 'weight', 10, 300, '公斤');
        return { data: calcBMI(height, weight) };
      },
    },
  ],
};

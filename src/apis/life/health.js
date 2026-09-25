import { HttpError, param } from '../../lib/http.js';
import { calcBMI } from './bmi.js';
import { num, round } from './calc-util.js';

// 活动水平系数（常用的 TDEE 系数）
export const ACTIVITY = {
  sedentary: { factor: 1.2, name: '久坐（几乎不运动）' },
  light: { factor: 1.375, name: '轻度活动（每周运动 1~3 天）' },
  moderate: { factor: 1.55, name: '中度活动（每周运动 3~5 天）' },
  active: { factor: 1.725, name: '高度活动（每周运动 6~7 天）' },
  very: { factor: 1.9, name: '极高活动（体力劳动或每天高强度训练）' },
};

const GENDERS = { male: 'male', female: 'female', m: 'male', f: 'female', 男: 'male', 女: 'female' };
const round1 = (n) => round(n, 1);

// Mifflin-St Jeor（1990）：男 10W + 6.25H − 5A + 5，女 10W + 6.25H − 5A − 161
export const mifflin = ({ gender, weight, height, age }) => 10 * weight + 6.25 * height - 5 * age + (gender === 'male' ? 5 : -161);

// Deurenberg（1991）BMI 法体脂率：1.2 × BMI + 0.23 × 年龄 − 10.8 × 性别（男 1 女 0）− 5.4
export const deurenberg = ({ gender, bmi, age }) => 1.2 * bmi + 0.23 * age - 10.8 * (gender === 'male' ? 1 : 0) - 5.4;

// 美国海军围度法（公制，厘米）：男用腰围、颈围；女另需臀围
export function navyBodyFat({ gender, height, waist, neck, hip }) {
  if (gender === 'male') {
    if (waist - neck <= 0) return null;
    return 495 / (1.0324 - 0.19077 * Math.log10(waist - neck) + 0.15456 * Math.log10(height)) - 450;
  }
  if (hip == null || waist + hip - neck <= 0) return null;
  return 495 / (1.29579 - 0.35004 * Math.log10(waist + hip - neck) + 0.221 * Math.log10(height)) - 450;
}

// 美国运动委员会（ACE）体脂分级
export function bodyFatLevel(gender, pct) {
  const t = gender === 'male' ? [[6, '必需脂肪'], [14, '运动员'], [18, '健康'], [25, '一般'], [Infinity, '偏高']] : [[14, '必需脂肪'], [21, '运动员'], [25, '健康'], [32, '一般'], [Infinity, '偏高']];
  return t.find(([max]) => pct < max)[1];
}

export function healthCalc({ gender, age, height, weight, activity = 'light', waist = null, neck = null, hip = null }) {
  const act = ACTIVITY[activity];
  const bmi = calcBMI(height, weight);
  const bmr = mifflin({ gender, weight, height, age });
  const tdee = bmr * act.factor;
  const inches = height / 2.54;
  // Devine（1974）：男 50 + 2.3 ×（身高英寸 − 60），女 45.5 + 2.3 ×（身高英寸 − 60）
  const devine = (gender === 'male' ? 50 : 45.5) + 2.3 * (inches - 60);
  // 国内常用：男（身高 − 100）× 0.9，女（身高 − 100）× 0.9 − 2.5
  const broca = (height - 100) * 0.9 - (gender === 'male' ? 0 : 2.5);
  const bfBmi = deurenberg({ gender, bmi: bmi.bmi, age });
  const navy = waist != null && neck != null ? navyBodyFat({ gender, height, waist, neck, hip }) : null;
  const navyOk = navy != null && Number.isFinite(navy) && navy > 0 && navy < 75 ? navy : null;
  const maxHr = 208 - 0.7 * age; // Tanaka（2001）
  const zone = (lo, hi) => ({ min: Math.round(maxHr * lo), max: Math.round(maxHr * hi) });

  return {
    gender,
    age,
    height,
    weight,
    activity: { level: activity, factor: act.factor, name: act.name },
    bmi: { value: bmi.bmi, level: bmi.china.level, see: '/api/bmi' },
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    calories: {
      maintain: Math.round(tdee),
      mildLoss: Math.round(tdee - 250),
      loss: Math.round(tdee - 500),
      gain: Math.round(tdee + 300),
      minimum: gender === 'male' ? 1500 : 1200,
    },
    idealWeight: {
      devine: round1(devine),
      broca: round1(broca),
      bmiMin: bmi.normalWeight.min,
      bmiMax: bmi.normalWeight.max,
    },
    bodyFat: {
      bmiMethod: round1(bfBmi),
      bmiMethodLevel: bodyFatLevel(gender, bfBmi),
      navy: navyOk == null ? null : round1(navyOk),
      navyLevel: navyOk == null ? null : bodyFatLevel(gender, navyOk),
    },
    heartRate: {
      max: Math.round(maxHr),
      fatBurn: zone(0.6, 0.7),
      aerobic: zone(0.7, 0.8),
    },
    water: { min: Math.round(weight * 30), max: Math.round(weight * 40) },
    disclaimer: '以上均为公式估算，仅供参考，不能替代医生、营养师的诊断和建议；孕妇、未成年人、运动员及患病人群不适用。',
  };
}

export default {
  name: 'health',
  category: 'life',
  title: '健康指标计算',
  description: '根据性别、年龄、身高、体重估算基础代谢（BMR）、每日总消耗（TDEE）、理想体重、体脂率与心率区间（仅供参考）',
  source: '本地计算（Mifflin-St Jeor、Deurenberg、美国海军围度法、Devine、Tanaka 公式）',
  routes: [
    {
      method: 'GET',
      path: '/api/health/calc',
      summary: '基础代谢、每日热量、理想体重、体脂率估算',
      params: [
        { name: 'gender', required: true, desc: '性别：male / female（也可用 男 / 女）', example: 'male' },
        { name: 'age', required: true, desc: '年龄（周岁，18~100，公式适用于成人）', example: '30' },
        { name: 'height', required: true, desc: '身高（厘米，100~250）', example: '175' },
        { name: 'weight', required: true, desc: '体重（公斤，30~300）', example: '70' },
        { name: 'activity', default: 'light', desc: '活动水平：sedentary 久坐 1.2、light 轻度 1.375、moderate 中度 1.55、active 高度 1.725、very 极高 1.9', example: 'moderate' },
        { name: 'waist', desc: '腰围（厘米，肚脐水平），与 neck 一起传入时用海军围度法估算体脂', example: '82' },
        { name: 'neck', desc: '颈围（厘米，喉结下方）', example: '38' },
        { name: 'hip', desc: '臀围（厘米，最宽处），女性用海军法时必填', example: '95' },
      ],
      fields: [
        { name: 'gender', type: 'string', desc: '性别：male 或 female' },
        { name: 'age', type: 'number', desc: '年龄（周岁）' },
        { name: 'height', type: 'number', desc: '身高（厘米）' },
        { name: 'weight', type: 'number', desc: '体重（公斤）' },
        { name: 'activity', type: 'object', desc: '活动水平' },
        { name: 'activity.level', type: 'string', desc: '活动水平代号：sedentary、light、moderate、active、very' },
        { name: 'activity.factor', type: 'number', desc: 'TDEE 活动系数' },
        { name: 'activity.name', type: 'string', desc: '活动水平中文说明' },
        { name: 'bmi', type: 'object', desc: 'BMI 摘要（详细分级与建议请用 /api/bmi）' },
        { name: 'bmi.value', type: 'number', desc: 'BMI，保留 1 位小数' },
        { name: 'bmi.level', type: 'string', desc: '中国成人标准分级：偏瘦、正常、超重、肥胖' },
        { name: 'bmi.see', type: 'string', desc: '详细 BMI 接口路径（/api/bmi）' },
        { name: 'bmr', type: 'number', desc: '基础代谢率（千卡/天，Mifflin-St Jeor 公式）：静卧不动一天消耗的热量' },
        { name: 'tdee', type: 'number', desc: '每日总能量消耗（千卡/天）= BMR × 活动系数' },
        { name: 'calories', type: 'object', desc: '每日摄入热量参考（千卡/天）' },
        { name: 'calories.maintain', type: 'number', desc: '维持体重 ≈ TDEE' },
        { name: 'calories.mildLoss', type: 'number', desc: '温和减重（约每周 0.25 公斤）= TDEE − 250' },
        { name: 'calories.loss', type: 'number', desc: '减重（约每周 0.5 公斤）= TDEE − 500' },
        { name: 'calories.gain', type: 'number', desc: '增重/增肌 = TDEE + 300' },
        { name: 'calories.minimum', type: 'number', desc: '无医生指导时不建议低于的每日摄入（男 1500、女 1200）' },
        { name: 'idealWeight', type: 'object', desc: '理想体重（公斤，不同公式结果不同，仅作参考区间）' },
        { name: 'idealWeight.devine', type: 'number', desc: 'Devine 公式：男 50 + 2.3 ×（身高英寸 − 60），女 45.5 + 2.3 ×（身高英寸 − 60）；身高低于 152cm 时偏低' },
        { name: 'idealWeight.broca', type: 'number', desc: '国内常用标准体重：男（身高 − 100）× 0.9，女再减 2.5' },
        { name: 'idealWeight.bmiMin', type: 'number', desc: '按中国标准 BMI 18.5 换算的健康体重下限' },
        { name: 'idealWeight.bmiMax', type: 'number', desc: '按中国标准 BMI 23.9 换算的健康体重上限' },
        { name: 'bodyFat', type: 'object', desc: '体脂率估算（百分数，误差可达 ±4% 以上）' },
        { name: 'bodyFat.bmiMethod', type: 'number', desc: 'Deurenberg BMI 法：1.2 × BMI + 0.23 × 年龄 − 10.8 × 性别（男 1 女 0）− 5.4；肌肉量大的人会高估' },
        { name: 'bodyFat.bmiMethodLevel', type: 'string', desc: 'bmiMethod 的分级（ACE 标准）：必需脂肪、运动员、健康、一般、偏高' },
        { name: 'bodyFat.navy', type: 'number|null', desc: '美国海军围度法体脂率；未传 waist、neck（女性还需 hip）或围度不合理时为 null' },
        { name: 'bodyFat.navyLevel', type: 'string|null', desc: 'navy 的分级（ACE 标准）；navy 为 null 时为 null' },
        { name: 'heartRate', type: 'object', desc: '心率参考（次/分钟）' },
        { name: 'heartRate.max', type: 'number', desc: '估算最大心率（Tanaka：208 − 0.7 × 年龄）' },
        { name: 'heartRate.fatBurn', type: 'object', desc: '燃脂区间（最大心率的 60%~70%）' },
        { name: 'heartRate.fatBurn.min', type: 'number', desc: '区间下限' },
        { name: 'heartRate.fatBurn.max', type: 'number', desc: '区间上限' },
        { name: 'heartRate.aerobic', type: 'object', desc: '有氧耐力区间（最大心率的 70%~80%）' },
        { name: 'heartRate.aerobic.min', type: 'number', desc: '区间下限' },
        { name: 'heartRate.aerobic.max', type: 'number', desc: '区间上限' },
        { name: 'water', type: 'object', desc: '每日饮水参考（毫升，按每公斤体重 30~40 毫升，高温和大量运动时需增加）' },
        { name: 'water.min', type: 'number', desc: '下限（毫升）' },
        { name: 'water.max', type: 'number', desc: '上限（毫升）' },
        { name: 'disclaimer', type: 'string', desc: '免责声明：公式估算仅供参考' },
      ],
      async handler({ query }) {
        const g = param(query, 'gender', { required: true, max: 10 });
        const gender = GENDERS[g.toLowerCase()];
        if (!gender) throw new HttpError(400, 'gender 只能是 male / female');
        const activity = param(query, 'activity', { default: 'light', oneOf: Object.keys(ACTIVITY) });
        const opt = (name, min, max) => num(query, name, { default: null, min, max, unit: '厘米' });
        const input = {
          gender,
          activity,
          age: param(query, 'age', { required: true, int: true, min: 18, max: 100 }),
          height: num(query, 'height', { required: true, min: 100, max: 250, unit: '厘米' }),
          weight: num(query, 'weight', { required: true, min: 30, max: 300, unit: '公斤' }),
          waist: opt('waist', 40, 250),
          neck: opt('neck', 20, 80),
          hip: opt('hip', 50, 250),
        };
        return { data: healthCalc(input) };
      },
    },
  ],
};

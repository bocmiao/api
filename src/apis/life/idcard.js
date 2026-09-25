import { param } from '../../lib/http.js';
import { parseDate, todayBeijing } from './lunar.js';

// 身份证号前两位对应的省级行政区（GB/T 2260），共 34 个
export const PROVINCES = {
  11: '北京市', 12: '天津市', 13: '河北省', 14: '山西省', 15: '内蒙古自治区',
  21: '辽宁省', 22: '吉林省', 23: '黑龙江省',
  31: '上海市', 32: '江苏省', 33: '浙江省', 34: '安徽省', 35: '福建省', 36: '江西省', 37: '山东省',
  41: '河南省', 42: '湖北省', 43: '湖南省', 44: '广东省', 45: '广西壮族自治区', 46: '海南省',
  50: '重庆市', 51: '四川省', 52: '贵州省', 53: '云南省', 54: '西藏自治区',
  61: '陕西省', 62: '甘肃省', 63: '青海省', 64: '宁夏回族自治区', 65: '新疆维吾尔自治区',
  71: '台湾省', 81: '香港特别行政区', 82: '澳门特别行政区',
};

// GB 11643-1999：ISO 7064 MOD 11-2
const WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CODES = '10X98765432';
export const checkDigitOf = (first17) => CODES[[...first17].reduce((s, d, i) => s + Number(d) * WEIGHTS[i], 0) % 11];

// 年龄（周岁）：today、birthday 均为 YYYY-MM-DD
export function ageOn(birthday, today) {
  const [by, bm, bd] = birthday.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

// 只打码展示，不回显完整号码：保留前 6 位与后 4 位
const mask = (id) => (id.length >= 10 ? `${id.slice(0, 6)}${'*'.repeat(id.length - 10)}${id.slice(-4)}` : '*'.repeat(id.length));

export function checkIdCard(input, today = todayBeijing()) {
  const id = String(input ?? '').trim().replace(/\s+/g, '').toUpperCase();
  const out = {
    valid: false,
    reason: null,
    masked: mask(id),
    length: id.length,
    checks: { format: false, province: null, birthday: null, checkDigit: null },
    province: null,
    provinceCode: null,
    birthday: null,
    age: null,
    gender: null,
  };
  const fail = (reason) => {
    out.reason ??= reason;
    return out;
  };

  if (!/^(\d{15}|\d{17}[\dX])$/.test(id)) return fail('格式不正确：应为 18 位（末位可为 X）或 15 位数字');
  out.checks.format = true;

  const code = id.slice(0, 2);
  const province = PROVINCES[code] ?? null;
  out.checks.province = !!province;
  out.provinceCode = code;
  out.province = province;

  // 15 位老号码：出生年份只有两位，按 19xx 处理；没有校验位
  const birthRaw = id.length === 15 ? `19${id.slice(6, 12)}` : id.slice(6, 14);
  const birthday = `${birthRaw.slice(0, 4)}-${birthRaw.slice(4, 6)}-${birthRaw.slice(6, 8)}`;
  const t = parseDate(birthday);
  const birthOk = t != null && Number(birthRaw.slice(0, 4)) >= 1900 && t <= parseDate(today);
  out.checks.birthday = birthOk;
  if (birthOk) {
    out.birthday = birthday;
    out.age = ageOn(birthday, today);
  }

  // 顺序码最后一位（18 位第 17 位 / 15 位第 15 位）奇数为男、偶数为女
  const seqLast = Number(id.length === 15 ? id[14] : id[16]);
  out.gender = seqLast % 2 === 1 ? '男' : '女';

  if (id.length === 18) out.checks.checkDigit = checkDigitOf(id.slice(0, 17)) === id[17];

  if (!province) fail('前两位不是有效的省级行政区代码');
  if (!birthOk) fail('出生日期不合法（不存在、早于 1900 年或晚于今天）');
  if (out.checks.checkDigit === false) fail('校验位错误');
  out.valid = out.reason == null;
  return out;
}

export default {
  name: 'idcard',
  category: 'life',
  title: '身份证号校验',
  description: '校验中国居民身份证号码的格式、省级代码、出生日期和校验位，解析性别与年龄；只做数学校验，不查询任何实名信息',
  source: '本地计算（GB 11643-1999 公民身份号码、GB/T 2260 行政区划代码）',
  routes: [
    {
      method: 'GET',
      path: '/api/idcard/check',
      summary: '身份证号码校验（校验位、出生日期、性别、年龄、省份）',
      params: [
        { name: 'id', required: true, desc: '18 位身份证号（末位可为 X，不区分大小写）或 15 位老号码', example: '11010519491231002X' },
      ],
      fields: [
        { name: 'valid', type: 'boolean', desc: '号码是否通过全部校验（格式、省级代码、出生日期、校验位）。只代表号码本身合法，不代表真实存在或属于某人' },
        { name: 'reason', type: 'string|null', desc: '不合法时的原因（取第一个未通过的检查）；合法时为 null' },
        { name: 'masked', type: 'string', desc: '打码后的号码（保留前 6 位和后 4 位），不回显完整号码' },
        { name: 'length', type: 'number', desc: '去掉空格后的号码长度' },
        { name: 'checks', type: 'object', desc: '各项检查结果；格式不对时后面几项为 null（未检查）' },
        { name: 'checks.format', type: 'boolean', desc: '长度与字符是否正确（18 位末位可为 X，或 15 位纯数字）' },
        { name: 'checks.province', type: 'boolean|null', desc: '前两位是否为有效的省级行政区代码' },
        { name: 'checks.birthday', type: 'boolean|null', desc: '出生日期是否存在且在 1900 年至今天（北京时间）之间' },
        { name: 'checks.checkDigit', type: 'boolean|null', desc: '第 18 位校验位是否正确（ISO 7064 MOD 11-2）；15 位老号码没有校验位，为 null' },
        { name: 'province', type: 'string|null', desc: '省级行政区名称，如 北京市；代码无效时为 null。只解析到省级' },
        { name: 'provinceCode', type: 'string|null', desc: '省级代码（号码前两位）；格式不对时为 null' },
        { name: 'birthday', type: 'string|null', desc: '出生日期 YYYY-MM-DD（15 位号码按 19xx 年）；日期不合法时为 null' },
        { name: 'age', type: 'number|null', desc: '按北京时间今天计算的周岁；日期不合法时为 null' },
        { name: 'gender', type: 'string|null', desc: '性别：男 / 女（顺序码末位奇数为男、偶数为女）；格式不对时为 null' },
      ],
      async handler({ query }) {
        const id = param(query, 'id', { required: true, max: 24 });
        return { data: checkIdCard(id) };
      },
    },
  ],
};

import { HttpError, param } from '../../lib/http.js';
import { num } from './calc-util.js';

// 每个单位：[代号, 中文名, 相对基准单位的系数, 别名...]；温度单独处理
// 市制依据 1959 年国务院《关于统一计量制度的命令》：1 市斤 = 500 克（十两制），1 市尺 = 1/3 米，1 亩 = 666.67 平方米
const U = (id, name, f, ...aliases) => ({ id, name, f, aliases });
export const CATEGORIES = {
  length: {
    name: '长度', base: 'm', units: [
      U('km', '千米', 1000, '公里', '千米'), U('m', '米', 1, '米'), U('dm', '分米', 0.1, '分米'), U('cm', '厘米', 0.01, '厘米'),
      U('mm', '毫米', 0.001, '毫米'), U('um', '微米', 1e-6, 'μm', '微米'), U('nm', '纳米', 1e-9, '纳米'),
      U('mi', '英里', 1609.344, '英里'), U('yd', '码', 0.9144, '码'), U('ft', '英尺', 0.3048, '英尺'), U('in', '英寸', 0.0254, '英寸'),
      U('nmi', '海里', 1852, '海里'),
      U('li', '里（市里）', 500, '里', '市里'), U('zhang', '丈', 10 / 3, '丈'), U('chi', '尺（市尺）', 1 / 3, '尺', '市尺'),
      U('cun', '寸（市寸）', 1 / 30, '寸', '市寸'), U('fen_len', '分（市分）', 1 / 300, '市分'),
      U('ly', '光年', 9.4607304725808e15, '光年'), U('au', '天文单位', 149597870700, '天文单位'),
    ],
  },
  mass: {
    name: '重量', base: 'kg', units: [
      U('t', '吨', 1000, '吨'), U('kg', '千克', 1, '公斤', '千克'), U('g', '克', 0.001, '克'), U('mg', '毫克', 1e-6, '毫克'),
      U('ug', '微克', 1e-9, 'μg', '微克'),
      U('lb', '磅', 0.45359237, '磅'), U('oz', '盎司', 0.028349523125, '盎司'), U('ozt', '金衡盎司', 0.0311034768, '金衡盎司'),
      U('ct', '克拉', 0.0002, '克拉'),
      U('dan', '担（市担）', 50, '担', '市担'), U('jin', '斤（市斤）', 0.5, '斤', '市斤'), U('liang', '两（市两）', 0.05, '两', '市两'),
      U('qian', '钱（市钱）', 0.005, '钱', '市钱'),
    ],
  },
  area: {
    name: '面积', base: 'm2', units: [
      U('km2', '平方千米', 1e6, '平方千米', '平方公里'), U('ha', '公顷', 1e4, '公顷'), U('m2', '平方米', 1, '平方米', '平米', '㎡'),
      U('dm2', '平方分米', 0.01, '平方分米'), U('cm2', '平方厘米', 1e-4, '平方厘米'), U('mm2', '平方毫米', 1e-6, '平方毫米'),
      U('qing', '顷', 200000 / 3, '顷'), U('mu', '亩', 2000 / 3, '亩', '市亩'), U('fen_area', '分（地）', 200 / 3, '分地'),
      U('acre', '英亩', 4046.8564224, '英亩'), U('ft2', '平方英尺', 0.09290304, '平方英尺'), U('in2', '平方英寸', 0.00064516, '平方英寸'),
      U('mi2', '平方英里', 2589988.110336, '平方英里'),
    ],
  },
  volume: {
    name: '体积/容积', base: 'l', units: [
      U('m3', '立方米', 1000, '立方米', '方'), U('l', '升', 1, 'L', '升', '公升'), U('dl', '分升', 0.1, 'dL', '分升'),
      U('ml', '毫升', 0.001, 'mL', '毫升'), U('cm3', '立方厘米', 0.001, 'cc', '立方厘米'), U('dm3', '立方分米', 1, '立方分米'),
      U('gal', '加仑（美）', 3.785411784, '美制加仑'), U('gal_uk', '加仑（英）', 4.54609, '英制加仑'),
      U('qt', '夸脱（美）', 0.946352946), U('pt', '品脱（美）', 0.473176473), U('cup', '杯（美）', 0.2365882365),
      U('floz', '液量盎司（美）', 0.0295735295625), U('ft3', '立方英尺', 28.316846592, '立方英尺'),
    ],
  },
  temperature: {
    name: '温度', base: 'C', units: [
      U('C', '摄氏度', null, '℃', '摄氏度', 'c'), U('F', '华氏度', null, '℉', '华氏度', 'f'), U('K', '开尔文', null, '开尔文', 'k'),
      U('R', '兰氏度', null, '兰氏度'),
    ],
  },
  speed: {
    name: '速度', base: 'mps', units: [
      U('mps', '米/秒', 1, 'm/s'), U('kmph', '千米/时', 1 / 3.6, 'km/h', 'kph'), U('mph', '英里/时', 0.44704),
      U('knot', '节', 1852 / 3600, 'kn', '节'), U('fps', '英尺/秒', 0.3048, 'ft/s'), U('mach', '马赫（15℃ 海平面）', 340.29, '马赫'),
      U('c0', '光速', 299792458, '光速'),
    ],
  },
  data: {
    name: '数据存储', base: 'B', units: [
      U('bit', '比特', 0.125, 'b'), U('B', '字节', 1, 'Byte', '字节'),
      U('KB', '千字节（1000）', 1e3, 'kB'), U('MB', '兆字节（1000²）', 1e6), U('GB', '吉字节（1000³）', 1e9),
      U('TB', '太字节（1000⁴）', 1e12), U('PB', '拍字节（1000⁵）', 1e15),
      U('KiB', 'KiB（1024）', 1024), U('MiB', 'MiB（1024²）', 1024 ** 2), U('GiB', 'GiB（1024³）', 1024 ** 3),
      U('TiB', 'TiB（1024⁴）', 1024 ** 4), U('PiB', 'PiB（1024⁵）', 1024 ** 5),
      U('Kb', '千比特', 125, 'kbit'), U('Mb', '兆比特', 125000, 'Mbit'), U('Gb', '吉比特', 125000000, 'Gbit'),
    ],
  },
  time: {
    name: '时间', base: 's', units: [
      U('ns', '纳秒', 1e-9, '纳秒'), U('us', '微秒', 1e-6, 'μs', '微秒'), U('ms', '毫秒', 0.001, '毫秒'), U('s', '秒', 1, '秒', 'sec'),
      U('min', '分钟', 60, '分钟', '分'), U('h', '小时', 3600, '小时', '时', 'hour'), U('d', '天', 86400, '天', '日', 'day'),
      U('week', '周', 604800, '周', '星期'), U('month', '月（按 30 天）', 2592000, '月'), U('year', '年（按 365 天）', 31536000, '年'),
      U('shichen', '时辰', 7200, '时辰'), U('ke', '刻（15 分钟）', 900, '刻'),
    ],
  },
  pressure: {
    name: '压强', base: 'Pa', units: [
      U('Pa', '帕', 1, '帕'), U('hPa', '百帕', 100, '百帕'), U('kPa', '千帕', 1e3, '千帕'), U('MPa', '兆帕', 1e6, '兆帕'),
      U('bar', '巴', 1e5, '巴'), U('atm', '标准大气压', 101325, '大气压'), U('mmHg', '毫米汞柱', 133.322387415, '毫米汞柱'),
      U('psi', '磅/平方英寸', 6894.757293168),
    ],
  },
  energy: {
    name: '能量', base: 'J', units: [
      U('J', '焦耳', 1, '焦', '焦耳'), U('kJ', '千焦', 1e3, '千焦'), U('cal', '卡', 4.184, '卡'), U('kcal', '千卡（大卡）', 4184, '千卡', '大卡'),
      U('Wh', '瓦时', 3600, '瓦时'), U('kWh', '千瓦时（度）', 3.6e6, '度', '千瓦时'), U('eV', '电子伏特', 1.602176634e-19, '电子伏'),
    ],
  },
  angle: {
    name: '角度', base: 'deg', units: [
      U('deg', '度', 1, '°', '角度'), U('rad', '弧度', 180 / Math.PI, '弧度'), U('grad', '百分度', 0.9),
      U('arcmin', '角分', 1 / 60, '′'), U('arcsec', '角秒', 1 / 3600, '″'), U('turn', '圈', 360, '圈', '周角'),
    ],
  },
};

// 索引：代号精确匹配 > 别名精确匹配 > 忽略大小写后唯一匹配（数据单位 MB 与 Mb 大小写含义不同，忽略大小写有歧义时报错）
const EXACT = new Map();
const LOWER = new Map();
for (const [cat, def] of Object.entries(CATEGORIES)) {
  for (const u of def.units) {
    const entry = { cat, unit: u };
    EXACT.set(u.id, entry);
  }
}
for (const [cat, def] of Object.entries(CATEGORIES)) {
  for (const u of def.units) {
    for (const a of u.aliases) if (!EXACT.has(a)) EXACT.set(a, { cat, unit: u });
    for (const k of [u.id, ...u.aliases]) {
      const lk = k.toLowerCase();
      const list = LOWER.get(lk) ?? [];
      if (!list.some((e) => e.unit === u)) list.push({ cat, unit: u });
      LOWER.set(lk, list);
    }
  }
}

export function findUnit(name) {
  const key = String(name ?? '').trim();
  const hit = EXACT.get(key);
  if (hit) return hit;
  const list = LOWER.get(key.toLowerCase()) ?? [];
  if (list.length === 1) return list[0];
  if (list.length > 1) throw new HttpError(400, `单位 ${key} 有歧义（区分大小写），可选：${list.map((e) => e.unit.id).join('、')}`);
  throw new HttpError(400, `未知单位：${key}，可调用 /api/unit/list 查看全部单位`);
}

const TO_C = { C: (v) => v, F: (v) => ((v - 32) * 5) / 9, K: (v) => v - 273.15, R: (v) => ((v - 491.67) * 5) / 9 };
const FROM_C = { C: (v) => v, F: (v) => (v * 9) / 5 + 32, K: (v) => v + 273.15, R: (v) => ((v + 273.15) * 9) / 5 };

// 保留 12 位有效数字，去掉 0.1+0.2 这类浮点尾巴
const tidy = (n) => (n === 0 || !Number.isFinite(n) ? n : Number(n.toPrecision(12)));

function convertRaw(cat, value, from, to) {
  if (cat === 'temperature') return FROM_C[to.id](TO_C[from.id](value));
  return (value * from.f) / to.f;
}

export function convertUnit(value, fromName, toName) {
  const from = findUnit(fromName);
  const to = toName == null || toName === '' ? null : findUnit(toName);
  if (to && to.cat !== from.cat) {
    throw new HttpError(400, `${from.unit.name}（${CATEGORIES[from.cat].name}）与 ${to.unit.name}（${CATEGORIES[to.cat].name}）不是同一类单位，无法换算`);
  }
  if (from.cat === 'temperature' && TO_C[from.unit.id](value) < -273.15 - 1e-9) throw new HttpError(400, '温度不能低于绝对零度（-273.15℃）');
  const def = CATEGORIES[from.cat];
  const result = to ? tidy(convertRaw(from.cat, value, from.unit, to.unit)) : null;
  return {
    category: from.cat,
    categoryName: def.name,
    value,
    from: { unit: from.unit.id, name: from.unit.name },
    to: to ? { unit: to.unit.id, name: to.unit.name } : null,
    result,
    text: to ? `${value} ${from.unit.name} = ${result} ${to.unit.name}` : null,
    all: def.units.map((u) => ({ unit: u.id, name: u.name, value: tidy(convertRaw(from.cat, value, from.unit, u)) })),
  };
}

export function listUnits() {
  return Object.entries(CATEGORIES).map(([id, def]) => ({
    category: id,
    name: def.name,
    units: def.units.map((u) => ({ unit: u.id, name: u.name, aliases: u.aliases.filter((a) => a !== u.id) })),
  }));
}

export default {
  name: 'unit',
  category: 'life',
  title: '单位换算',
  description: '长度、重量、面积、体积、温度、速度、数据存储、时间、压强、能量、角度单位互相换算，含斤、两、里、亩等中国市制单位',
  source: '本地计算（国际单位制、1959 年国务院统一计量制度命令中的市制换算）',
  routes: [
    {
      method: 'GET',
      path: '/api/unit',
      summary: '单位换算（不传 to 时换算为同类全部单位）',
      params: [
        { name: 'value', required: true, desc: '要换算的数值', example: '3' },
        { name: 'from', required: true, desc: '原单位：代号（如 km、jin、mu、C、MB）或中文（如 公里、斤、亩、摄氏度）；区分大小写，完整列表见 /api/unit/list', example: '斤' },
        { name: 'to', desc: '目标单位，须与原单位同类；不传时只返回 all（换算到同类所有单位）', example: 'kg' },
      ],
      fields: [
        { name: 'category', type: 'string', desc: '单位类别代号：length、mass、area、volume、temperature、speed、data、time、pressure、energy、angle' },
        { name: 'categoryName', type: 'string', desc: '单位类别中文名，如 重量' },
        { name: 'value', type: 'number', desc: '原数值' },
        { name: 'from', type: 'object', desc: '识别出的原单位' },
        { name: 'from.unit', type: 'string', desc: '单位代号，如 jin' },
        { name: 'from.name', type: 'string', desc: '单位中文名，如 斤（市斤）' },
        { name: 'to', type: 'object|null', desc: '识别出的目标单位；未传 to 时为 null' },
        { name: 'to.unit', type: 'string', desc: '单位代号' },
        { name: 'to.name', type: 'string', desc: '单位中文名' },
        { name: 'result', type: 'number|null', desc: '换算结果（保留 12 位有效数字）；未传 to 时为 null' },
        { name: 'text', type: 'string|null', desc: '换算结果的中文表述，如 "3 斤（市斤） = 1.5 千克"；未传 to 时为 null' },
        { name: 'all', type: 'array', desc: '原数值换算到同类每个单位的结果' },
        { name: 'all[].unit', type: 'string', desc: '单位代号' },
        { name: 'all[].name', type: 'string', desc: '单位中文名' },
        { name: 'all[].value', type: 'number', desc: '换算结果（保留 12 位有效数字）' },
      ],
      async handler({ query }) {
        const value = num(query, 'value', { required: true, min: -1e300, max: 1e300 });
        const from = param(query, 'from', { required: true, max: 20 });
        const to = param(query, 'to', { max: 20 });
        return { data: convertUnit(value, from, to) };
      },
    },
    {
      method: 'GET',
      path: '/api/unit/list',
      summary: '全部可换算的单位',
      params: [],
      fields: [
        { name: '[].category', type: 'string', desc: '类别代号，如 length' },
        { name: '[].name', type: 'string', desc: '类别中文名，如 长度' },
        { name: '[].units', type: 'array', desc: '该类别下的单位' },
        { name: '[].units[].unit', type: 'string', desc: '单位代号（from/to 参数可直接使用，区分大小写）' },
        { name: '[].units[].name', type: 'string', desc: '单位中文名' },
        { name: '[].units[].aliases', type: 'array', desc: '也可使用的别名（字符串数组，如 公里、斤），可能为空数组' },
      ],
      async handler() {
        return { data: listUnits() };
      },
    },
  ],
};

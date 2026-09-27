import { HttpError, param } from '../../lib/http.js';
import { SOLAR_TERMS, solarTermTime, solarTermDay, parseDate, fmtDate, todayBeijing } from './lunar.js';

const DAY_MS = 86_400_000;
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;
const SEASONS = ['冬', '冬', '春', '春', '春', '春', '春', '春', '夏', '夏', '夏', '夏', '夏', '夏', '秋', '秋', '秋', '秋', '秋', '秋', '冬', '冬', '冬', '冬'];

// 节气简介（顺序同 SOLAR_TERMS，从小寒开始）
export const TERM_DESC = [
  '天气渐寒，尚未大冷，进入一年中最冷的时段',
  '一年中最冷的时候，寒潮频繁，冰天雪地',
  '二十四节气之首，春季开始，万物萌生',
  '降水增多，雨量渐增，气温回升',
  '春雷始鸣，惊醒蛰伏于地下越冬的昆虫',
  '昼夜平分，此后北半球白天渐长于黑夜',
  '气清景明，万物皆显，也是扫墓祭祖的时节',
  '雨生百谷，降雨增多，利于谷类作物生长',
  '夏季开始，气温明显升高，雷雨增多',
  '夏熟作物籽粒开始饱满，但还未成熟',
  '有芒的麦子快收，有芒的稻子可种，农事繁忙',
  '白天最长、黑夜最短的一天，炎热将至',
  '天气开始炎热，但还没到最热的时候',
  '一年中最热的时期，高温酷暑',
  '秋季开始，暑去凉来，但仍有"秋老虎"',
  '"处"为终止，炎热的暑天即将结束',
  '天气转凉，清晨草木上出现白色露珠',
  '昼夜平分，此后北半球黑夜渐长于白天',
  '露水更凉，将要凝结成霜，深秋来临',
  '天气渐冷，开始出现霜冻，秋季最后一个节气',
  '冬季开始，万物收藏，规避寒冷',
  '气温下降，开始降雪，但雪量不大',
  '降雪增多，地面可能积雪，天气更冷',
  '白天最短、黑夜最长的一天，民间有"冬至大如年"之说',
];

const fmtTime = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

function termInfo(year, k) {
  return {
    index: k + 1,
    name: SOLAR_TERMS[k],
    date: fmtDate(solarTermDay(year, k)),
    time: fmtTime(solarTermTime(year, k)),
    longitude: (285 + 15 * k) % 360,
    season: SEASONS[k],
    desc: TERM_DESC[k],
  };
}

// 某年的 24 个节气（按日期顺序，从小寒到冬至）
export function yearTerms(year) {
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) throw new HttpError(400, `year 须为 ${MIN_YEAR}~${MAX_YEAR} 之间的整数`);
  return { year, count: 24, terms: SOLAR_TERMS.map((_, k) => termInfo(year, k)) };
}

// 某天（YYYY-MM-DD，北京时间日历日）所处的节气与下一个节气
export function nextTerm(dateStr) {
  const t = parseDate(dateStr);
  if (t == null) throw new HttpError(400, 'date 不是有效日期（格式 YYYY-MM-DD）');
  const year = new Date(t).getUTCFullYear();
  if (year < MIN_YEAR || year >= MAX_YEAR) throw new HttpError(400, `date 超出范围（${MIN_YEAR}–${MAX_YEAR - 1} 年）`);
  const list = [];
  for (const y of [year - 1, year, year + 1]) {
    if (y < MIN_YEAR - 1 || y > MAX_YEAR) continue;
    for (let k = 0; k < 24; k++) list.push({ y, k, day: solarTermDay(y, k) });
  }
  const today = list.find((x) => x.day === t);
  const cur = list.filter((x) => x.day <= t).at(-1);
  const nxt = list.find((x) => x.day > t);
  const next = { ...termInfo(nxt.y, nxt.k), days: Math.round((nxt.day - t) / DAY_MS) };
  const current = { ...termInfo(cur.y, cur.k), daysSince: Math.round((t - cur.day) / DAY_MS) };
  const text = today
    ? `今天是${current.name}（${current.time} 交节），下一个节气${next.name}还有 ${next.days} 天（${next.date}）`
    : `当前节气：${current.name}（第 ${current.daysSince + 1} 天），距离${next.name}还有 ${next.days} 天（${next.date}）`;
  return {
    date: fmtDate(t),
    today: today ? SOLAR_TERMS[today.k] : null,
    current,
    next,
    text,
  };
}

const TERM_FIELDS = (prefix) => [
  { name: `${prefix}.index`, type: 'number', desc: '在一年中的序号 1–24（1=小寒，24=冬至）' },
  { name: `${prefix}.name`, type: 'string', desc: '节气名称，如 立春' },
  { name: `${prefix}.date`, type: 'string', desc: '交节日期 YYYY-MM-DD（北京时间）' },
  { name: `${prefix}.time`, type: 'string', desc: '交节时刻 YYYY-MM-DD HH:mm（北京时间 UTC+8，天文算法计算，误差约 1 分钟）' },
  { name: `${prefix}.longitude`, type: 'number', desc: '交节时的太阳视黄经（度），如 立春 315、春分 0、夏至 90' },
  { name: `${prefix}.season`, type: 'string', desc: '所属季节：春/夏/秋/冬（按四立划分）' },
  { name: `${prefix}.desc`, type: 'string', desc: '节气简介' },
];

export default {
  name: 'jieqi',
  category: 'life',
  title: '二十四节气',
  description: '查询某年二十四节气的交节日期与精确时刻，以及当前节气和距下一个节气的天数（天文算法本地计算）',
  source: '本地计算（太阳视黄经天文算法，北京时间）',
  routes: [
    {
      method: 'GET',
      path: '/api/jieqi',
      summary: '某年的二十四节气日期与交节时刻',
      params: [
        { name: 'year', required: false, desc: `年份 ${MIN_YEAR}–${MAX_YEAR}，默认今年（北京时间）`, example: '2026' },
      ],
      fields: [
        { name: 'year', type: 'number', desc: '年份' },
        { name: 'count', type: 'number', desc: '节气个数，固定为 24' },
        { name: 'terms', type: 'array', desc: '全年 24 个节气，按日期先后排列（小寒在 1 月初，冬至在 12 月下旬）' },
        ...TERM_FIELDS('terms[]'),
      ],
      async handler({ query }) {
        const year = param(query, 'year', { default: Number(todayBeijing().slice(0, 4)), int: true, min: MIN_YEAR, max: MAX_YEAR });
        return { data: yearTerms(year) };
      },
    },
    {
      method: 'GET',
      path: '/api/jieqi/next',
      summary: '当前节气与距下一个节气的天数',
      params: [
        { name: 'date', required: false, desc: '日期 YYYY-MM-DD，默认今天（北京时间）', example: '2026-09-27' },
      ],
      fields: [
        { name: 'date', type: 'string', desc: '查询日期 YYYY-MM-DD（北京时间）' },
        { name: 'today', type: 'string|null', desc: '当天交节的节气名称；当天不是节气时为 null' },
        { name: 'current', type: 'object', desc: '当前所处的节气（当天或之前最近一次交节的节气）' },
        ...TERM_FIELDS('current'),
        { name: 'current.daysSince', type: 'number', desc: '距该节气交节日已过去的天数（交节当天为 0）' },
        { name: 'next', type: 'object', desc: '下一个节气（交节日期晚于查询日期）' },
        ...TERM_FIELDS('next'),
        { name: 'next.days', type: 'number', desc: '距下一个节气还有几天' },
        { name: 'text', type: 'string', desc: '一句话中文描述，适合机器人直接回复，如 当前节气：秋分（第 5 天），距离寒露还有 11 天（2026-10-08）' },
      ],
      async handler({ query }) {
        const date = param(query, 'date', { default: todayBeijing(), pattern: /^\d{4}-\d{1,2}-\d{1,2}$/ });
        return { data: nextTerm(date) };
      },
    },
  ],
};

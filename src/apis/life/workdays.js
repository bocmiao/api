import { HttpError, param } from '../../lib/http.js';
import { parseDate, fmtDate, todayBeijing } from './lunar.js';
import { loadHolidayYear, holidayInfoFrom } from './holiday.js';

const DAY_MS = 86_400_000;
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const DATE_RE = /^\d{4}-\d{1,2}-\d{1,2}$/;
export const MAX_RANGE_DAYS = 1100;
export const MAX_ADD_DAYS = 500;
const MIN_YEAR = 2007;
const MAX_YEAR = 2100;

// 按年加载放假安排（复用 /api/holiday 的数据源与缓存：holiday-cn → 内置安排 → 未公布）。
// 上游失败又没有内置数据时降级为只按周末计算，并在 years[].source 标注 unavailable
export function makeYearLoader(load = loadHolidayYear) {
  const years = new Map();
  const get = async (year) => {
    if (!years.has(year)) {
      let data;
      try {
        data = await load(year);
      } catch {
        data = { year, papers: [], days: [], source: 'unavailable' };
      }
      years.set(year, data);
    }
    return years.get(year);
  };
  const summary = () => [...years.values()]
    .sort((a, b) => a.year - b.year)
    .map((d) => ({ year: d.year, source: d.source ?? 'unknown', published: d.days.length > 0 }));
  return { get, summary };
}

async function dayInfo(loader, t) {
  const year = new Date(t).getUTCFullYear();
  if (year < MIN_YEAR || year > MAX_YEAR) throw new HttpError(400, `日期超出范围（${MIN_YEAR}–${MAX_YEAR} 年）`);
  return holidayInfoFrom(await loader.get(year), fmtDate(t));
}

const meta = (loader) => {
  const years = loader.summary();
  return { years, complete: years.every((y) => y.published), degraded: years.some((y) => y.source === 'unavailable') };
};

// 统计 start~end（含首尾）之间的工作日
export async function countWorkdays(start, end, loader = makeYearLoader()) {
  const s = parseDate(start);
  const e = parseDate(end);
  if (e < s) throw new HttpError(400, 'end 不能早于 start');
  const total = Math.round((e - s) / DAY_MS) + 1;
  if (total > MAX_RANGE_DAYS) throw new HttpError(400, `日期范围不能超过 ${MAX_RANGE_DAYS} 天`);
  const count = { normal: 0, workday: 0, weekend: 0, holiday: 0 };
  const byName = new Map();
  for (let t = s; t <= e; t += DAY_MS) {
    const info = await dayInfo(loader, t);
    count[info.type]++;
    if (info.type === 'holiday') byName.set(info.name, (byName.get(info.name) ?? 0) + 1);
  }
  return {
    mode: 'between',
    start: fmtDate(s),
    end: fmtDate(e),
    days: null,
    totalDays: total,
    workdays: count.normal + count.workday,
    offDays: count.weekend + count.holiday,
    weekends: count.weekend,
    holidays: count.holiday,
    adjustedWorkdays: count.workday,
    holidayDetail: [...byName].map(([name, days]) => ({ name, days })),
    result: null,
    weekday: null,
    calendarDays: null,
    ...meta(loader),
  };
}

// 从 start 起往后（days>0）或往前（days<0）数 N 个工作日；start 当天不计入。days=0 时返回 start 本身
export async function addWorkdays(start, days, loader = makeYearLoader()) {
  const s = parseDate(start);
  const step = days >= 0 ? 1 : -1;
  let t = s;
  let left = Math.abs(days);
  let guard = 0;
  while (left > 0) {
    if (++guard > MAX_RANGE_DAYS * 2) throw new HttpError(400, '计算范围过大');
    t += step * DAY_MS;
    if ((await dayInfo(loader, t)).isWorkday) left--;
  }
  const info = await dayInfo(loader, t);
  return {
    mode: 'add',
    start: fmtDate(s),
    end: null,
    days,
    totalDays: null,
    workdays: null,
    offDays: null,
    weekends: null,
    holidays: null,
    adjustedWorkdays: null,
    holidayDetail: null,
    result: info.date,
    weekday: WEEKDAYS[new Date(t).getUTCDay()],
    calendarDays: Math.round(Math.abs(t - s) / DAY_MS),
    ...meta(loader),
  };
}

export default {
  name: 'workdays',
  category: 'life',
  title: '工作日计算',
  description: '按中国法定节假日与调休安排统计两个日期之间的工作日，或推算 N 个工作日之后（之前）的日期',
  source: 'NateScarlet/holiday-cn（与 /api/holiday 同源，含内置兜底）',
  routes: [
    {
      method: 'GET',
      path: '/api/workdays',
      summary: '工作日统计 / 推算 N 个工作日后的日期',
      params: [
        { name: 'start', desc: '开始日期 YYYY-MM-DD，默认今天（北京时间）', example: '2026-09-28' },
        { name: 'end', desc: '结束日期 YYYY-MM-DD（含当天）。传 end 统计 start~end 的工作日（最多 1100 天），与 days 二选一', example: '2026-10-11' },
        { name: 'days', desc: '工作日数（-500~500）：推算 start 之后第 N 个工作日（start 当天不算），负数往前推；与 end 二选一', example: '10' },
      ],
      fields: [
        { name: 'mode', type: 'string', desc: '计算方式：between（统计区间，传了 end）或 add（推算日期，传了 days）' },
        { name: 'start', type: 'string', desc: '开始日期 YYYY-MM-DD' },
        { name: 'end', type: 'string|null', desc: 'between：结束日期；add 为 null' },
        { name: 'days', type: 'number|null', desc: 'add：请求的工作日数；between 为 null' },
        { name: 'totalDays', type: 'number|null', desc: 'between：区间总天数（含首尾）；add 为 null' },
        { name: 'workdays', type: 'number|null', desc: 'between：需要上班的天数（普通工作日 + 调休上班日）；add 为 null' },
        { name: 'offDays', type: 'number|null', desc: 'between：休息天数 = weekends + holidays；add 为 null' },
        { name: 'weekends', type: 'number|null', desc: 'between：普通周末休息天数（不含法定假期中的周末）；add 为 null' },
        { name: 'holidays', type: 'number|null', desc: 'between：法定节假日放假天数（含假期中的周末）；add 为 null' },
        { name: 'adjustedWorkdays', type: 'number|null', desc: 'between：其中调休上班（周末补班）的天数；add 为 null' },
        { name: 'holidayDetail', type: 'array|null', desc: 'between：区间内各假期占用的放假天数；add 为 null' },
        { name: 'holidayDetail[].name', type: 'string', desc: '假期名称，如 国庆节' },
        { name: 'holidayDetail[].days', type: 'number', desc: '该假期落在区间内的放假天数' },
        { name: 'result', type: 'string|null', desc: 'add：推算出的日期 YYYY-MM-DD（days=0 时为 start 本身）；between 为 null' },
        { name: 'weekday', type: 'string|null', desc: 'add：result 是星期几；between 为 null' },
        { name: 'calendarDays', type: 'number|null', desc: 'add：从 start 到 result 跨越的自然日天数；between 为 null' },
        { name: 'years', type: 'array', desc: '计算用到的各年份放假安排及其来源' },
        { name: 'years[].year', type: 'number', desc: '年份' },
        { name: 'years[].source', type: 'string', desc: '数据来源：holiday-cn（上游）、builtin（上游不可用，用内置国务院安排）、none（该年安排尚未公布）、unavailable（上游失败且无内置数据，已降级为只按周末计算）' },
        { name: 'years[].published', type: 'boolean', desc: '该年是否有放假安排数据；为 false 时该年只按周六日休息计算，结果可能与实际不符' },
        { name: 'complete', type: 'boolean', desc: '用到的所有年份是否都有放假安排数据' },
        { name: 'degraded', type: 'boolean', desc: '是否有年份因上游失败降级为只按周末计算（years[].source 为 unavailable）' },
      ],
      async handler({ query }) {
        const start = param(query, 'start', { default: todayBeijing(), pattern: DATE_RE });
        const end = param(query, 'end', { pattern: DATE_RE });
        const days = param(query, 'days', { int: true, min: -MAX_ADD_DAYS, max: MAX_ADD_DAYS });
        const s = parseDate(start);
        if (s == null) throw new HttpError(400, 'start 不是有效日期');
        const y = new Date(s).getUTCFullYear();
        if (y < MIN_YEAR || y > MAX_YEAR) throw new HttpError(400, `日期超出范围（${MIN_YEAR}–${MAX_YEAR} 年）`);
        if (end != null && days != null) throw new HttpError(400, 'end 与 days 只能传一个');
        if (end != null) {
          if (parseDate(end) == null) throw new HttpError(400, 'end 不是有效日期');
          return { data: await countWorkdays(start, end) };
        }
        if (days == null) throw new HttpError(400, '请传 end（统计区间工作日）或 days（推算 N 个工作日后的日期）');
        return { data: await addWorkdays(start, days) };
      },
    },
  ],
};

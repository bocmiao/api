import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError, param } from '../../lib/http.js';
import { parseDate, fmtDate, todayBeijing } from './lunar.js';

const DAY_MS = 86_400_000;
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const upstreamUrl = (year) => `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`;

// 内置国务院办公厅放假安排（与 holiday-cn 同名），上游不可用时兜底
// [名称, 放假起, 放假止, 调休上班日...]
const FALLBACK = {
  2025: [
    ['元旦', '2025-01-01', '2025-01-01'],
    ['春节', '2025-01-28', '2025-02-04', '2025-01-26', '2025-02-08'],
    ['清明节', '2025-04-04', '2025-04-06'],
    ['劳动节', '2025-05-01', '2025-05-05', '2025-04-27'],
    ['端午节', '2025-05-31', '2025-06-02'],
    ['国庆节、中秋节', '2025-10-01', '2025-10-08', '2025-09-28', '2025-10-11'],
  ],
  2026: [
    ['元旦', '2026-01-01', '2026-01-03', '2026-01-04'],
    ['春节', '2026-02-15', '2026-02-23', '2026-02-14', '2026-02-28'],
    ['清明节', '2026-04-04', '2026-04-06'],
    ['劳动节', '2026-05-01', '2026-05-05', '2026-05-09'],
    ['端午节', '2026-06-19', '2026-06-21'],
    ['中秋节', '2026-09-25', '2026-09-27'],
    ['国庆节', '2026-10-01', '2026-10-07', '2026-09-20', '2026-10-10'],
  ],
};

export function fallbackYear(year) {
  const spec = FALLBACK[year];
  if (!spec) return null;
  const days = [];
  for (const [name, from, to, ...work] of spec) {
    for (let t = parseDate(from); t <= parseDate(to); t += DAY_MS) days.push({ name, date: fmtDate(t), isOffDay: true });
    for (const w of work) days.push({ name, date: w, isOffDay: false });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  return { year, papers: [], days };
}

// 校验并规整 holiday-cn 的 {year, papers, days:[{name,date,isOffDay}]}
export function parseHolidayCn(raw, year) {
  if (!raw || !Array.isArray(raw.days)) throw new HttpError(502, '节假日数据格式无法识别');
  const days = raw.days
    .filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d.date) && typeof d.isOffDay === 'boolean')
    .map((d) => ({ name: String(d.name ?? ''), date: d.date, isOffDay: d.isOffDay }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { year: raw.year ?? year, papers: Array.isArray(raw.papers) ? raw.papers : [], days };
}

// 加载某年安排：优先上游，失败用内置；都没有则返回空列表（尚未公布）
export async function loadHolidayYear(year) {
  const res = await cache.wrap(`holiday:${year}`, DAY_MS, async () => {
    try {
      return { ...parseHolidayCn(await fetchJSON(upstreamUrl(year)), year), source: 'holiday-cn' };
    } catch (err) {
      const fb = fallbackYear(year);
      if (fb) return { ...fb, source: 'builtin' };
      // 上游 404 通常表示当年安排尚未公布
      if (err instanceof HttpError && /HTTP 404/.test(err.message)) return { year, papers: [], days: [], source: 'none' };
      throw err;
    }
  });
  return res.data;
}

// 纯函数：根据某年的安排判断某天
export function holidayInfoFrom(yearData, dateStr) {
  const t = parseDate(dateStr);
  if (t == null) throw new HttpError(400, 'date 格式应为 YYYY-MM-DD');
  const date = fmtDate(t);
  const wd = new Date(t).getUTCDay();
  const weekend = wd === 0 || wd === 6;
  const hit = yearData.days.find((d) => d.date === date);
  let type;
  let note;
  if (hit?.isOffDay) { type = 'holiday'; note = `${hit.name}假期`; }
  else if (hit) { type = 'workday'; note = `${hit.name}调休上班`; }
  else if (weekend) { type = 'weekend'; note = '周末'; }
  else { type = 'normal'; note = '工作日'; }
  const isOffDay = type === 'holiday' || type === 'weekend';
  return {
    date,
    weekday: WEEKDAYS[wd],
    isOffDay,
    isWorkday: !isOffDay,
    type,
    name: hit?.name ?? null,
    note,
    published: yearData.days.length > 0,
  };
}

// 把放假日合并成假期段
export function holidayPeriods(yearData) {
  const periods = [];
  for (const d of yearData.days) {
    if (!d.isOffDay) continue;
    const last = periods.at(-1);
    if (last && last.name === d.name && parseDate(d.date) - parseDate(last.end) === DAY_MS) {
      last.end = d.date;
      last.days += 1;
    } else periods.push({ name: d.name, start: d.date, end: d.date, days: 1 });
  }
  for (const p of periods) p.workdays = yearData.days.filter((d) => !d.isOffDay && d.name === p.name).map((d) => d.date);
  return periods;
}

// 纯函数：从若干年的数据里找出进行中的假期与下一个假期
export function nextHolidayFrom(years, today) {
  const t = parseDate(today);
  const periods = years.flatMap(holidayPeriods);
  const current = periods.find((p) => parseDate(p.start) <= t && t <= parseDate(p.end)) ?? null;
  const next = periods.find((p) => parseDate(p.start) > t) ?? null;
  const withCountdown = (p) => p && { ...p, daysUntil: Math.round((parseDate(p.start) - t) / DAY_MS) };
  return { today, current: current && { ...current, dayIndex: Math.round((t - parseDate(current.start)) / DAY_MS) + 1 }, next: withCountdown(next) };
}

export async function getHolidayInfo(dateStr = todayBeijing()) {
  const year = Number(dateStr.slice(0, 4));
  return holidayInfoFrom(await loadHolidayYear(year), dateStr);
}

export async function getNextHoliday(today = todayBeijing()) {
  const year = Number(today.slice(0, 4));
  const years = [await loadHolidayYear(year)];
  try {
    years.push(await loadHolidayYear(year + 1));
  } catch {
    // 明年数据取不到时只看今年
  }
  return nextHolidayFrom(years, today);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const checkYear = (y) => {
  if (y < 2007 || y > 2100) throw new HttpError(400, '年份超出范围（2007–2100）');
  return y;
};

export default {
  name: 'holiday',
  category: 'life',
  title: '节假日与调休',
  description: '中国法定节假日、调休上班日查询，含下一个假期倒计时',
  source: 'NateScarlet/holiday-cn（国务院办公厅通知）',
  routes: [
    {
      method: 'GET',
      path: '/api/holiday',
      summary: '查询某天是否放假/上班及节日名',
      params: [{ name: 'date', desc: '日期 YYYY-MM-DD，默认今天（北京时间）', example: '2026-10-01' }],
      fields: [
        { name: 'date', type: 'string', desc: '查询的日期，YYYY-MM-DD（北京时间的日历日）' },
        { name: 'weekday', type: 'string', desc: '星期几，如 星期四' },
        { name: 'isOffDay', type: 'boolean', desc: '当天是否休息：type 为 holiday 或 weekend 时为 true' },
        { name: 'isWorkday', type: 'boolean', desc: '当天是否要上班（与 isOffDay 相反）：type 为 workday 或 normal 时为 true' },
        { name: 'type', type: 'string', desc: '日期类型，取值：holiday（法定节假日放假，含假期中的周末）、workday（调休上班日，通常是被调成上班的周末）、weekend（普通周末，休息）、normal（普通工作日，上班）' },
        { name: 'name', type: 'string|null', desc: '所属节假日名称（如 春节、国庆节；两节连休时可能是 "国庆节、中秋节"）。仅 type 为 holiday 或 workday 时有值，weekend、normal 为 null' },
        { name: 'note', type: 'string', desc: '中文说明：holiday 为 "<节日>假期"，workday 为 "<节日>调休上班"，weekend 为 "周末"，normal 为 "工作日"' },
        { name: 'published', type: 'boolean', desc: '该年放假安排是否已有数据。为 false 时表示国务院尚未公布（或数据源暂无），type 只按周末/工作日推断，不包含法定假日与调休' },
      ],
      async handler({ query }) {
        const date = param(query, 'date', { default: todayBeijing(), pattern: DATE_RE });
        if (parseDate(date) == null) throw new HttpError(400, 'date 不是有效日期');
        checkYear(Number(date.slice(0, 4)));
        return { data: await getHolidayInfo(date) };
      },
    },
    {
      method: 'GET',
      path: '/api/holiday/next',
      summary: '下一个法定假期及倒计时天数',
      params: [{ name: 'date', desc: '从哪天开始算，默认今天（北京时间）', example: '2026-09-24' }],
      fields: [
        { name: 'today', type: 'string', desc: '计算基准日期，YYYY-MM-DD（默认北京时间今天）' },
        { name: 'current', type: 'object|null', desc: '基准日期正处于的假期；不在假期中时为 null' },
        { name: 'current.name', type: 'string', desc: '假期名称，如 国庆节' },
        { name: 'current.start', type: 'string', desc: '放假第一天，YYYY-MM-DD' },
        { name: 'current.end', type: 'string', desc: '放假最后一天，YYYY-MM-DD' },
        { name: 'current.days', type: 'number', desc: '连续放假天数（含假期中的周末）' },
        { name: 'current.workdays', type: 'array', desc: '该节日对应的调休上班日（YYYY-MM-DD 字符串数组），没有调休时为空数组' },
        { name: 'current.dayIndex', type: 'number', desc: '基准日期是本次假期的第几天（从 1 开始）' },
        { name: 'next', type: 'object|null', desc: '基准日期之后最近开始的一个假期（开始日期晚于基准日期）。只在今年和明年的放假安排中查找，明年安排尚未公布且今年已没有假期时为 null' },
        { name: 'next.name', type: 'string', desc: '假期名称，如 国庆节' },
        { name: 'next.start', type: 'string', desc: '放假第一天，YYYY-MM-DD' },
        { name: 'next.end', type: 'string', desc: '放假最后一天，YYYY-MM-DD' },
        { name: 'next.days', type: 'number', desc: '连续放假天数（含假期中的周末）' },
        { name: 'next.workdays', type: 'array', desc: '该节日对应的调休上班日（YYYY-MM-DD 字符串数组），没有调休时为空数组' },
        { name: 'next.daysUntil', type: 'number', desc: '距离假期开始还有几天（放假第一天减基准日期）' },
      ],
      async handler({ query }) {
        const date = param(query, 'date', { default: todayBeijing(), pattern: DATE_RE });
        if (parseDate(date) == null) throw new HttpError(400, 'date 不是有效日期');
        checkYear(Number(date.slice(0, 4)));
        return { data: await getNextHoliday(date) };
      },
    },
    {
      method: 'GET',
      path: '/api/holiday/year',
      summary: '某年全部放假安排与调休日',
      params: [{ name: 'year', desc: '年份，默认今年', example: '2026' }],
      fields: [
        { name: 'year', type: 'number', desc: '年份' },
        { name: 'papers', type: 'array', desc: '国务院办公厅放假通知原文链接（字符串数组），来自 holiday-cn；使用内置数据或尚未公布时为空数组' },
        { name: 'days', type: 'array', desc: '当年所有放假日与调休上班日，按日期升序；不含普通周末。尚未公布时为空数组' },
        { name: 'days[].name', type: 'string', desc: '所属节假日名称，如 春节' },
        { name: 'days[].date', type: 'string', desc: '日期，YYYY-MM-DD' },
        { name: 'days[].isOffDay', type: 'boolean', desc: 'true 为放假，false 为调休上班' },
        { name: 'source', type: 'string', desc: '数据来源：holiday-cn（从 NateScarlet/holiday-cn 获取）、builtin（上游不可用，使用内置的国务院安排）、none（该年安排尚未公布，days 与 periods 为空）' },
        { name: 'periods', type: 'array', desc: '按连续日期合并后的假期段，按时间先后排列' },
        { name: 'periods[].name', type: 'string', desc: '假期名称，如 国庆节' },
        { name: 'periods[].start', type: 'string', desc: '放假第一天，YYYY-MM-DD' },
        { name: 'periods[].end', type: 'string', desc: '放假最后一天，YYYY-MM-DD' },
        { name: 'periods[].days', type: 'number', desc: '连续放假天数（含假期中的周末）' },
        { name: 'periods[].workdays', type: 'array', desc: '该节日对应的调休上班日（YYYY-MM-DD 字符串数组），没有调休时为空数组' },
      ],
      async handler({ query }) {
        const year = checkYear(param(query, 'year', { default: Number(todayBeijing().slice(0, 4)), int: true, min: 2007, max: 2100 }));
        const data = await loadHolidayYear(year);
        return { data: { ...data, periods: holidayPeriods(data) } };
      },
    },
  ],
};

import { randomInt } from 'node:crypto';
import { param } from '../../lib/http.js';
import { getLunarInfo, parseDate, fmtDate, todayBeijing } from './lunar.js';
import { loadHolidayYear, holidayInfoFrom, holidayPeriods } from './holiday.js';

const DAY_MS = 86_400_000;
const HOLIDAY_LIMIT = 5;

// 原创摸鱼语录
export const QUOTES = [
  '工作是老板的，身体是自己的，喝口水再说。',
  '键盘敲得响，不如茶泡得香。',
  '今天的事今天做不完，说明明天还需要我。',
  '上班要有上班的样子，摸鱼要有摸鱼的格局。',
  '只要我不看群消息，需求就追不上我。',
  '努力不一定成功，但不摸鱼一定很累。',
  '工位是我的船，摸鱼是我的桨。',
  '深呼吸，带薪思考也是一种生产力。',
  '把复杂的事情简单做，把简单的事情留给明天。',
  '人生苦短，先去接杯热水。',
  '会议很长，但我的发呆更长。',
  '进度条走得慢没关系，我陪它一起慢。',
  '今天也是为工资而不是为 KPI 活着的一天。',
  '摸鱼一时爽，一直摸鱼一直爽，但记得按时交差。',
  '周末还没来，但我已经在心里放假了。',
  '起身走两步，颈椎会感谢你的。',
  '领导在的时候认真工作，领导不在的时候认真休息。',
  '先别急着回消息，让子弹飞一会儿。',
  '工作做得好是本分，摸鱼摸得巧是本事。',
  '离下班又近了一分钟，这就是进步。',
  '今天的我，也是一条努力游向周末的鱼。',
  '效率的秘诀：先休息，再高效。',
  '饮水机和厕所，是打工人的两大避风港。',
  '别卷了，卷到最后都是别人的年终奖。',
  '人在工位，心在远方，钱在路上。',
  '今天的烦恼今天放下，明天的烦恼明天再说。',
  '只要思想不滑坡，办法总比需求多。',
  '看一眼窗外，世界比屏幕大得多。',
  '上班如上坟，摸鱼如摸金——小心点，别被发现。',
  '工资到账的那一刻，所有的委屈都有了价格。',
  '合理分配体力，才能撑到下班打卡。',
  '伸个懒腰吧，今天的你已经很努力了。',
  '需求可以改，但我的午休不能改。',
  '一杯咖啡续命，一段摸鱼回血。',
  '离放假越近，时间走得越慢，这是打工人的相对论。',
  '慢慢来，比较快；摸摸鱼，更长久。',
];

// 距离周末：按日历周六、周日计算，不考虑调休
export function weekendCountdown(today) {
  const wd = new Date(parseDate(today)).getUTCDay();
  const isWeekend = wd === 0 || wd === 6;
  return { isWeekend, daysUntil: isWeekend ? 0 : 6 - wd };
}

// 距离发薪日：payday 为每月几号（1–31），本月没有这一天时按月末算；今天已过本月发薪日时算下个月的
export function paydayCountdown(today, payday) {
  const t = parseDate(today);
  const d = new Date(t);
  const target = (y, m) => {
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const day = Math.min(payday, last);
    return { t: Date.UTC(y, m, day), monthEnd: day < payday };
  };
  let hit = target(d.getUTCFullYear(), d.getUTCMonth());
  if (hit.t < t) hit = target(d.getUTCFullYear(), d.getUTCMonth() + 1);
  const daysUntil = Math.round((hit.t - t) / DAY_MS);
  return { day: payday, date: fmtDate(hit.t), daysUntil, isToday: daysUntil === 0, monthEnd: hit.monthEnd };
}

// 今天之后开始的假期，按开始日期排序，最多 limit 个
export function upcomingHolidays(years, today, limit = HOLIDAY_LIMIT) {
  const t = parseDate(today);
  const seen = new Set();
  return years
    .flatMap(holidayPeriods)
    .filter((p) => parseDate(p.start) > t && !seen.has(`${p.name}|${p.start}`) && seen.add(`${p.name}|${p.start}`))
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, limit)
    .map((p) => ({ name: p.name, start: p.start, end: p.end, days: p.days, daysUntil: Math.round((parseDate(p.start) - t) / DAY_MS) }));
}

export async function loadMoyu({ payday = 10, now = Date.now(), pick = (n) => randomInt(n) } = {}) {
  const date = todayBeijing(now);
  const year = Number(date.slice(0, 4));
  const info = getLunarInfo(date);
  // 今年和明年并行加载；今年的取不到就降级，明年的取不到只影响倒计时列表
  const [cur, next] = await Promise.allSettled([loadHolidayYear(year), loadHolidayYear(year + 1)]);

  let today;
  let holidays = null;
  let source = null;
  let notice = null;
  const degraded = cur.status === 'rejected';
  if (degraded) {
    today = { isOffDay: null, type: null, name: null, note: '节假日数据暂缺，无法判断今天是否放假' };
    notice = '节假日数据获取失败，暂时只提供周末和发薪日倒计时';
  } else {
    const h = holidayInfoFrom(cur.value, date);
    today = { isOffDay: h.isOffDay, type: h.type, name: h.name, note: h.note };
    source = cur.value.source ?? null;
    holidays = upcomingHolidays([cur.value, ...(next.status === 'fulfilled' ? [next.value] : [])], date);
    if (!h.published) notice = `${year} 年放假安排尚未公布，今天是否放假只按周末判断`;
  }

  return {
    date,
    weekday: info.weekday,
    lunar: {
      text: info.lunar.text,
      monthDay: `${info.lunar.monthName}${info.lunar.dayName}`,
      yearName: info.yearName,
    },
    festivals: info.festivals,
    today,
    weekend: weekendCountdown(date),
    payday: paydayCountdown(date, payday),
    holidays,
    holidaySource: source,
    degraded,
    notice,
    quote: QUOTES[pick(QUOTES.length)],
  };
}

export default {
  name: 'moyu',
  category: 'life',
  title: '摸鱼日历',
  description: '今天放不放假、距周末/发薪日/法定节假日还有几天，外加一句摸鱼语',
  source: '本地计算 + NateScarlet/holiday-cn（节假日安排）',
  routes: [
    {
      method: 'GET',
      path: '/api/moyu',
      summary: '摸鱼日历：周末、发薪日与节假日倒计时',
      params: [
        { name: 'payday', required: false, default: '10', desc: '每月发薪日（1~31），本月没有这一天时按月末计算', example: '15' },
      ],
      fields: [
        { name: 'date', type: 'string', desc: '今天的日期（北京时间），YYYY-MM-DD' },
        { name: 'weekday', type: 'string', desc: '今天星期几，取值 星期日、星期一 … 星期六' },
        { name: 'lunar', type: 'object', desc: '今天的农历（本地计算，不依赖节假日数据）' },
        { name: 'lunar.text', type: 'string', desc: '完整农历日期，如 二〇二六年八月十四' },
        { name: 'lunar.monthDay', type: 'string', desc: '农历月日，如 八月十四、闰六月初一、腊月三十' },
        { name: 'lunar.yearName', type: 'string', desc: '干支生肖年名，如 丙午马年（以正月初一换年）' },
        { name: 'festivals', type: 'array', desc: '今天的节日名称（字符串数组，公历节日与农历节日，如 中秋节、教师节），与 /api/lunar 的 festivals 相同；没有节日时为空数组' },
        { name: 'today', type: 'object', desc: '今天是否放假（依赖节假日数据）' },
        { name: 'today.isOffDay', type: 'boolean|null', desc: '今天是否休息：法定假日（含假期中的周末）或普通周末为 true，调休上班日和普通工作日为 false；节假日数据获取失败（degraded 为 true）时为 null' },
        { name: 'today.type', type: 'string|null', desc: '日期类型：holiday（法定节假日放假）、workday（调休上班）、weekend（普通周末）、normal（普通工作日）；degraded 为 true 时为 null' },
        { name: 'today.name', type: 'string|null', desc: '所属节假日名称，如 国庆节；仅 type 为 holiday 或 workday 时有值，其余情况（含 degraded）为 null' },
        { name: 'today.note', type: 'string', desc: '中文说明：如 "国庆节假期"、"国庆节调休上班"、"周末"、"工作日"；degraded 为 true 时为 "节假日数据暂缺，无法判断今天是否放假"' },
        { name: 'weekend', type: 'object', desc: '周末倒计时（按日历周六、周日计算，不考虑调休；不依赖节假日数据）' },
        { name: 'weekend.isWeekend', type: 'boolean', desc: '今天是否是周六或周日' },
        { name: 'weekend.daysUntil', type: 'number', desc: '距离周六还有几天（整数，周一为 5、周五为 1）；今天是周六或周日时为 0' },
        { name: 'payday', type: 'object', desc: '发薪日倒计时（不依赖节假日数据，不考虑发薪日遇节假日提前）' },
        { name: 'payday.day', type: 'number', desc: '请求的每月发薪日（1~31），即参数 payday，默认 10' },
        { name: 'payday.date', type: 'string', desc: '下一个发薪日的实际日期，YYYY-MM-DD：今天没过本月发薪日时为本月，已过则为下个月；该月没有这一天（如 31 号遇到小月、2 月）时取该月最后一天' },
        { name: 'payday.daysUntil', type: 'number', desc: '距离发薪日还有几天（整数），今天发薪时为 0' },
        { name: 'payday.isToday', type: 'boolean', desc: '今天是否就是发薪日（daysUntil 为 0）' },
        { name: 'payday.monthEnd', type: 'boolean', desc: '是否因为该月没有 payday 这一天而改用月末（如 payday=31 遇到 9 月时取 9 月 30 日）' },
        { name: 'holidays', type: 'array|null', desc: `接下来的法定节假日（放假开始日期晚于今天），按开始日期升序，最多 ${HOLIDAY_LIMIT} 个；只在今年和明年已公布的安排中查找，都没有时为空数组；节假日数据获取失败（degraded 为 true）时为 null` },
        { name: 'holidays[].name', type: 'string', desc: '假期名称，如 国庆节、春节；两节连休时可能是 "国庆节、中秋节"' },
        { name: 'holidays[].start', type: 'string', desc: '放假第一天，YYYY-MM-DD' },
        { name: 'holidays[].end', type: 'string', desc: '放假最后一天，YYYY-MM-DD' },
        { name: 'holidays[].days', type: 'number', desc: '连续放假天数（含假期中的周末）' },
        { name: 'holidays[].daysUntil', type: 'number', desc: '距离放假第一天还有几天（整数，至少为 1）' },
        { name: 'holidaySource', type: 'string|null', desc: '今年节假日数据的来源：holiday-cn（从 NateScarlet/holiday-cn 获取）、builtin（上游不可用，使用内置的国务院安排）、none（今年安排尚未公布）；degraded 为 true 时为 null' },
        { name: 'degraded', type: 'boolean', desc: '是否降级：今年的节假日数据获取失败（上游不可用且没有内置数据）时为 true，此时 today 的放假判断、holidays 与 holidaySource 为 null，只保证周末和发薪日倒计时' },
        { name: 'notice', type: 'string|null', desc: '数据缺失提示：degraded 时为 "节假日数据获取失败，暂时只提供周末和发薪日倒计时"；今年安排尚未公布时说明只按周末判断；数据完整时为 null' },
        { name: 'quote', type: 'string', desc: `随机一句摸鱼语（从内置的 ${QUOTES.length} 条原创语录中随机选取，每次请求都可能不同）` },
      ],
      async handler({ query }) {
        const payday = param(query, 'payday', { default: 10, int: true, min: 1, max: 31 });
        return { data: await loadMoyu({ payday }) };
      },
    },
  ],
};

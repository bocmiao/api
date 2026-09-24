import { getHolidayInfo } from '../life/holiday.js';
import { GREETING_PERIODS, HOLIDAY_TIPS, WORKDAY_TIPS } from './data/greeting.js';
import { beijingClock, pick } from './seeded.js';

// 节假日数据最多等这么久；超时则按普通周末/工作日处理（后台请求完成后会进缓存，下次就能用上）
export const HOLIDAY_TIMEOUT_MS = 3000;

export const periodOf = (hour) => GREETING_PERIODS.find((p) => hour >= p.from && hour < p.to);

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

// 纯函数：now 为时间戳，holiday 为 getHolidayInfo 的结果（取不到时传 null）
export function buildGreeting(now, holiday, rand = Math.random) {
  const clock = beijingClock(now);
  const period = periodOf(clock.hour);
  const weekend = clock.weekdayIndex === 0 || clock.weekdayIndex === 6;
  // 节假日数据只在日期与今天一致、且当年安排已公布时采用
  const info = holiday && holiday.date === clock.date && holiday.published !== false ? holiday : null;
  const dayType = info ? info.type : weekend ? 'weekend' : 'normal';
  const isOffDay = info ? info.isOffDay : weekend;
  const holidayName = info && (dayType === 'holiday' || dayType === 'workday') ? info.name : null;

  let tip;
  if (dayType === 'holiday') {
    tip = `${fill(pick(HOLIDAY_TIPS, rand), { name: holidayName })}${pick(period.off, rand)}`;
  } else if (dayType === 'workday') {
    const evening = clock.hour >= 17;
    const reminder = fill(pick(evening ? WORKDAY_TIPS.evening : WORKDAY_TIPS.day, rand), { name: holidayName, weekday: clock.weekday });
    // 白天（5~17 点）再补一句上班日的时段提示；凌晨和傍晚以后只给调休提醒
    tip = clock.hour >= 5 && !evening ? `${reminder}${pick(period.work, rand)}` : reminder;
  } else {
    tip = pick(isOffDay ? period.off : period.work, rand);
  }

  return {
    period: period.key,
    periodName: period.name,
    greeting: pick(period.greetings, rand),
    tip,
    date: clock.date,
    time: clock.time,
    weekday: clock.weekday,
    isOffDay,
    dayType,
    holidayName,
    holidayData: Boolean(info),
  };
}

// 取今天的节假日信息；失败或超时返回 null，不向外抛错
export async function holidayOrNull(date, timeoutMs = HOLIDAY_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      getHolidayInfo(date),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function loadGreeting(now = Date.now(), { timeoutMs = HOLIDAY_TIMEOUT_MS, rand = Math.random } = {}) {
  return buildGreeting(now, await holidayOrNull(beijingClock(now).date, timeoutMs), rand);
}

const periodDesc = GREETING_PERIODS.map((p) => `${p.key}=${p.name}（${p.from}:00~${p.to === 24 ? '24:00' : `${p.to}:00`}）`).join('，');

export default {
  name: 'greeting',
  category: 'fun',
  title: '温馨提示',
  description: '按北京时间时段返回问候语与贴心提示，结合法定节假日与调休安排',
  source: '本地内置文案 + 节假日数据（NateScarlet/holiday-cn，取不到时按周末/工作日处理）',
  routes: [
    {
      method: 'GET',
      path: '/api/greeting',
      summary: '当前时段的问候语和提示语（北京时间）',
      params: [],
      fields: [
        { name: 'period', type: 'string', desc: `时段标识（北京时间，左闭右开）：${periodDesc}` },
        { name: 'periodName', type: 'string', desc: '时段中文名：凌晨、早上、上午、中午、下午、傍晚、晚上、深夜' },
        { name: 'greeting', type: 'string', desc: '问候语，如“早上好！”，从该时段的问候语中随机挑选' },
        {
          name: 'tip',
          type: 'string',
          desc: '提示语。法定节假日放假：假期风格的提示（含节日名）；调休上班日：以“【调休提醒】”开头，特别提醒今天要上班；'
            + '普通周末：休息日风格；普通工作日：上班日风格。每次请求随机挑选',
        },
        { name: 'date', type: 'string', desc: '当前北京时间日期，YYYY-MM-DD' },
        { name: 'time', type: 'string', desc: '当前北京时间，HH:mm（24 小时制）' },
        { name: 'weekday', type: 'string', desc: '星期几，如 星期四' },
        { name: 'isOffDay', type: 'boolean', desc: '今天是否放假：法定节假日与普通周末为 true，调休上班日与普通工作日为 false；节假日数据取不到时只按周末判断' },
        {
          name: 'dayType',
          type: 'string',
          desc: '日期类型：holiday（法定节假日放假）、workday（调休上班日）、weekend（普通周末）、normal（普通工作日）。节假日数据取不到时只会是 weekend 或 normal',
        },
        { name: 'holidayName', type: 'string|null', desc: '节假日名称（如 国庆节）；仅 dayType 为 holiday 或 workday 时有值，其余为 null' },
        {
          name: 'holidayData',
          type: 'boolean',
          desc: `是否取到了今天可用的节假日数据。false 表示节假日数据源不可用、超过 ${HOLIDAY_TIMEOUT_MS / 1000} 秒未响应，`
            + '或当年放假安排尚未公布，此时按普通周末/工作日处理，不会报错',
        },
      ],
      async handler() {
        return { data: await loadGreeting() };
      },
    },
  ],
};

import { HttpError, param } from '../../lib/http.js';
import { solarToLunar, parseDate, fmtDate, todayBeijing, GAN, ZHI, ANIMALS, lunarMonthName, lunarDayName } from './lunar.js';
import { ageOn } from './idcard.js';

const DAY_MS = 86_400_000;
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const DATE_RE = /^\d{4}-\d{1,2}-\d{1,2}$/;

// 星座（常用中文划分，[名称, 起始月, 起始日, 英文]），按起始日期升序
const SIGNS = [
  ['摩羯座', 1, 1, 'Capricorn'], ['水瓶座', 1, 20, 'Aquarius'], ['双鱼座', 2, 19, 'Pisces'], ['白羊座', 3, 21, 'Aries'],
  ['金牛座', 4, 20, 'Taurus'], ['双子座', 5, 21, 'Gemini'], ['巨蟹座', 6, 22, 'Cancer'], ['狮子座', 7, 23, 'Leo'],
  ['处女座', 8, 23, 'Virgo'], ['天秤座', 9, 23, 'Libra'], ['天蝎座', 10, 24, 'Scorpio'], ['射手座', 11, 23, 'Sagittarius'],
  ['摩羯座', 12, 22, 'Capricorn'],
];
const SIGN_RANGE = {
  摩羯座: '12-22 ~ 01-19', 水瓶座: '01-20 ~ 02-18', 双鱼座: '02-19 ~ 03-20', 白羊座: '03-21 ~ 04-19', 金牛座: '04-20 ~ 05-20',
  双子座: '05-21 ~ 06-21', 巨蟹座: '06-22 ~ 07-22', 狮子座: '07-23 ~ 08-22', 处女座: '08-23 ~ 09-22', 天秤座: '09-23 ~ 10-23',
  天蝎座: '10-24 ~ 11-22', 射手座: '11-23 ~ 12-21',
};

export function constellationOf(month, day) {
  let hit = SIGNS[0];
  for (const s of SIGNS) if (month > s[1] || (month === s[1] && day >= s[2])) hit = s;
  return { name: hit[0], en: hit[3], range: SIGN_RANGE[hit[0]] };
}

const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const dateOf = (y, m, d) => Date.UTC(y, m - 1, m === 2 && d === 29 && !isLeapYear(y) ? 28 : d);
const days = (a, b) => Math.round((b - a) / DAY_MS);
const yearGanzhi = (y) => GAN[(((y - 4) % 10) + 10) % 10] + ZHI[(((y - 4) % 12) + 12) % 12];

// 下一个农历生日：从 today 起往后找农历月、日相同的那天（闰月出生按同名的非闰月过；该月没有三十时按廿九过）
export function nextLunarBirthday(birthLunar, t) {
  for (let i = 0, cur = t; i <= 400; i++, cur += DAY_MS) {
    let l;
    try {
      l = solarToLunar(cur);
    } catch {
      return null; // 超出农历表范围（2100 年以后）
    }
    if (!l.isLeap && l.month === birthLunar.month && l.day === Math.min(birthLunar.day, l.monthDays)) {
      return { date: fmtDate(cur), daysUntil: i, lunarYear: l.year };
    }
  }
  return null;
}

export function ageInfo(birthday, today = todayBeijing()) {
  const b = parseDate(birthday);
  const t = parseDate(today);
  if (b == null) throw new HttpError(400, 'birthday 不是有效日期（YYYY-MM-DD）');
  if (t == null) throw new HttpError(400, 'date 不是有效日期（YYYY-MM-DD）');
  if (b > t) throw new HttpError(400, '出生日期不能晚于计算日期');
  const bd = new Date(b);
  const [by, bm, bdd] = [bd.getUTCFullYear(), bd.getUTCMonth() + 1, bd.getUTCDate()];
  const ty = new Date(t).getUTCFullYear();

  const birthLunar = solarToLunar(b);
  const todayLunar = solarToLunar(t);

  // 2 月 29 日出生：非闰年按 2 月 28 日过生日
  let next = dateOf(ty, bm, bdd);
  if (next < t) next = dateOf(ty + 1, bm, bdd);
  const nextYear = new Date(next).getUTCFullYear();
  const age = ageOn(fmtDate(b), fmtDate(t)) + (bm === 2 && bdd === 29 && !isLeapYear(ty) && days(dateOf(ty, 2, 29), t) === 0 ? 1 : 0);
  const lunarNext = nextLunarBirthday(birthLunar, t);

  return {
    birthday: fmtDate(b),
    date: fmtDate(t),
    weekday: WEEKDAYS[bd.getUTCDay()],
    age,
    nominalAge: todayLunar.year - birthLunar.year + 1,
    daysLived: days(b, t),
    zodiac: ANIMALS[(((birthLunar.year - 4) % 12) + 12) % 12],
    ganzhiYear: yearGanzhi(birthLunar.year),
    constellation: constellationOf(bm, bdd),
    lunar: {
      year: birthLunar.year,
      month: birthLunar.month,
      day: birthLunar.day,
      isLeap: birthLunar.isLeap,
      text: `${yearGanzhi(birthLunar.year)}年${lunarMonthName(birthLunar.month, birthLunar.isLeap)}${lunarDayName(birthLunar.day)}`,
    },
    nextBirthday: {
      date: fmtDate(next),
      weekday: WEEKDAYS[new Date(next).getUTCDay()],
      daysUntil: days(t, next),
      turning: nextYear - by,
      isToday: next === t,
    },
    nextLunarBirthday: lunarNext && {
      date: lunarNext.date,
      daysUntil: lunarNext.daysUntil,
      text: `${lunarMonthName(birthLunar.month)}${lunarDayName(Math.min(birthLunar.day, solarToLunar(parseDate(lunarNext.date)).monthDays))}`,
    },
  };
}

export default {
  name: 'age',
  category: 'life',
  title: '年龄 / 生肖 / 星座',
  description: '根据公历生日计算周岁、虚岁、已活天数、生肖、星座、农历生日，以及下一个公历/农历生日倒计时',
  source: '本地计算（农历数据复用 /api/lunar）',
  routes: [
    {
      method: 'GET',
      path: '/api/age',
      summary: '周岁、虚岁、生肖、星座与生日倒计时',
      params: [
        { name: 'birthday', required: true, desc: '公历出生日期 YYYY-MM-DD（1900-01-31 起）', example: '1995-08-20' },
        { name: 'date', desc: '按哪天计算，YYYY-MM-DD，默认今天（北京时间）', example: '2026-09-25' },
      ],
      fields: [
        { name: 'birthday', type: 'string', desc: '出生日期 YYYY-MM-DD' },
        { name: 'date', type: 'string', desc: '计算基准日期 YYYY-MM-DD（默认北京时间今天）' },
        { name: 'weekday', type: 'string', desc: '出生那天是星期几' },
        { name: 'age', type: 'number', desc: '周岁：过了今年生日才加 1（2 月 29 日出生的，非闰年在 2 月 28 日算过生日）' },
        { name: 'nominalAge', type: 'number', desc: '虚岁：出生即 1 岁，每过一个农历新年（正月初一）加 1 岁' },
        { name: 'daysLived', type: 'number', desc: '从出生到基准日期经过的天数' },
        { name: 'zodiac', type: 'string', desc: '生肖（按农历正月初一换年，春节前出生属上一年的生肖）' },
        { name: 'ganzhiYear', type: 'string', desc: '出生农历年的干支纪年，如 乙亥' },
        { name: 'constellation', type: 'object', desc: '星座（按常用的公历日期划分，交界日期各资料可能差一天）' },
        { name: 'constellation.name', type: 'string', desc: '星座中文名，如 狮子座' },
        { name: 'constellation.en', type: 'string', desc: '星座英文名，如 Leo' },
        { name: 'constellation.range', type: 'string', desc: '该星座的公历日期范围，如 "07-23 ~ 08-22"' },
        { name: 'lunar', type: 'object', desc: '农历生日' },
        { name: 'lunar.year', type: 'number', desc: '农历年（数字）' },
        { name: 'lunar.month', type: 'number', desc: '农历月（1~12）' },
        { name: 'lunar.day', type: 'number', desc: '农历日（1~30）' },
        { name: 'lunar.isLeap', type: 'boolean', desc: '是否闰月出生' },
        { name: 'lunar.text', type: 'string', desc: '农历生日中文，如 乙亥年七月廿五' },
        { name: 'nextBirthday', type: 'object', desc: '下一个公历生日（基准日期当天就是生日时即为当天）' },
        { name: 'nextBirthday.date', type: 'string', desc: '日期 YYYY-MM-DD' },
        { name: 'nextBirthday.weekday', type: 'string', desc: '星期几' },
        { name: 'nextBirthday.daysUntil', type: 'number', desc: '距离下一个生日还有几天，当天为 0' },
        { name: 'nextBirthday.turning', type: 'number', desc: '到时满几周岁' },
        { name: 'nextBirthday.isToday', type: 'boolean', desc: '基准日期是否正好是生日' },
        { name: 'nextLunarBirthday', type: 'object|null', desc: '下一个农历生日（闰月出生的按同名普通月过，该月没有三十的按廿九过）；超出农历表范围时为 null' },
        { name: 'nextLunarBirthday.date', type: 'string', desc: '对应的公历日期 YYYY-MM-DD' },
        { name: 'nextLunarBirthday.daysUntil', type: 'number', desc: '距离还有几天，当天为 0' },
        { name: 'nextLunarBirthday.text', type: 'string', desc: '当年过生日的农历月日，如 七月廿五' },
      ],
      async handler({ query }) {
        const birthday = param(query, 'birthday', { required: true, pattern: DATE_RE });
        const date = param(query, 'date', { default: todayBeijing(), pattern: DATE_RE });
        const b = parseDate(birthday);
        if (b != null && b < Date.UTC(1900, 0, 31)) throw new HttpError(400, 'birthday 不能早于 1900-01-31');
        const t = parseDate(date);
        if (t != null && t > Date.UTC(2100, 11, 31)) throw new HttpError(400, 'date 不能晚于 2100-12-31');
        return { data: ageInfo(birthday, date) };
      },
    },
  ],
};

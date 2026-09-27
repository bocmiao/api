import { HttpError, param } from '../../lib/http.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const BJ = 8 * HOUR_MS; // 北京时间 UTC+8，无夏令时
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const QUARTER_NAMES = ['一', '二', '三', '四'];
export const PERIODS = ['year', 'quarter', 'month', 'week', 'day'];

const pad = (n) => String(n).padStart(2, '0');
const ymd = (t) => new Date(t).toISOString().slice(0, 10);
const round2 = (n) => Math.round(n * 100) / 100;

// ASCII 进度条：▓ 已过去，░ 剩余
export function progressBar(percent, width = 20) {
  const filled = Math.min(width, Math.max(0, Math.round((percent / 100) * width)));
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

// ISO 周数（周一为一周开始，含 1 月 4 日的周为第 1 周）
export function isoWeek(dayUtc) {
  const d = new Date(dayUtc);
  const wd = (d.getUTCDay() + 6) % 7;
  const thursday = dayUtc + (3 - wd) * DAY_MS;
  const y = new Date(thursday).getUTCFullYear();
  return { year: y, week: Math.floor((thursday - Date.UTC(y, 0, 1)) / DAY_MS / 7) + 1 };
}

// 计算一个区间的进度。wall 为"北京墙上时间"毫秒（按 UTC 读数），start/end 同样按北京墙上时间
function period(key, label, name, start, end, wall, width) {
  const total = end - start;
  const passed = Math.min(Math.max(wall - start, 0), total);
  const percent = round2((passed / total) * 100);
  const byHour = key === 'day';
  const unitMs = byHour ? HOUR_MS : DAY_MS;
  const totalUnits = Math.round(total / unitMs);
  const elapsed = Math.floor(passed / unitMs + 1e-9);
  const remaining = totalUnits - Math.ceil(passed / unitMs - 1e-9);
  const unit = byHour ? '小时' : '天';
  return {
    key,
    label,
    name,
    start: ymd(start),
    end: ymd(end - DAY_MS),
    percent,
    total: totalUnits,
    elapsed,
    remaining,
    unit,
    bar: progressBar(percent, width),
    text: `${name}已过去 ${percent.toFixed(2)}%，还剩 ${remaining} ${unit}`,
  };
}

// 计算某一时刻（UTC 毫秒）在北京时间下的年/季/月/周/日进度
// endOfDay=true 时按该日 24:00（当天已结束）计算
export function timeProgress(now = Date.now(), width = 20, endOfDay = false) {
  const d = new Date(now + BJ);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = Date.UTC(y, m, d.getUTCDate());
  const q = Math.floor(m / 3);
  const wd = (d.getUTCDay() + 6) % 7; // 0=周一
  const weekStart = day - wd * DAY_MS;
  const { week } = isoWeek(day);
  const wall = endOfDay ? day + DAY_MS : now + BJ;
  const items = {
    year: period('year', '年', `${y} 年`, Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1), wall, width),
    quarter: period('quarter', '季度', `第${QUARTER_NAMES[q]}季度`, Date.UTC(y, q * 3, 1), Date.UTC(y, q * 3 + 3, 1), wall, width),
    month: period('month', '月', `${m + 1} 月`, Date.UTC(y, m, 1), Date.UTC(y, m + 1, 1), wall, width),
    week: period('week', '周', `本周（第 ${week} 周）`, weekStart, weekStart + 7 * DAY_MS, wall, width),
    day: period('day', '日', '今天', day, day + DAY_MS, wall, width),
  };
  items.day.start = items.day.end = ymd(day);
  const lines = PERIODS.map((k) => `${items[k].label.padEnd(2, '　')} ${items[k].bar} ${items[k].percent.toFixed(2)}%`);
  return {
    now: endOfDay ? `${ymd(day)} 24:00` : `${ymd(day)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    weekday: WEEKDAYS[d.getUTCDay()],
    weekNumber: week,
    ...items,
    text: `${items.year.text}\n${lines.join('\n')}`,
  };
}

// 解析 date 参数：YYYY-MM-DD 视为当天结束（24:00），也可带 HH:mm。返回 { at: UTC 毫秒, endOfDay }
export function parseProgressDate(s) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(String(s ?? '').trim());
  if (!m) throw new HttpError(400, 'date 格式应为 YYYY-MM-DD 或 YYYY-MM-DD HH:mm');
  const [y, mo, dd] = [+m[1], +m[2], +m[3]];
  const t = Date.UTC(y, mo - 1, dd);
  const back = new Date(t);
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== dd) throw new HttpError(400, 'date 不是有效日期');
  if (y < 1900 || y > 2100) throw new HttpError(400, 'date 年份须在 1900–2100 之间');
  if (m[4] == null) return { at: t + 12 * HOUR_MS - BJ, endOfDay: true };
  if (+m[4] > 23 || +m[5] > 59) throw new HttpError(400, 'date 中的时间不合法');
  return { at: t + (+m[4]) * HOUR_MS + (+m[5]) * 60_000 - BJ, endOfDay: false };
}

const PERIOD_DESC = {
  year: '今年', quarter: '本季度', month: '本月', week: '本周（周一至周日）', day: '今天（按小时计）',
};

const periodFields = () => PERIODS.flatMap((k) => {
  const unit = k === 'day' ? '小时' : '天';
  return [
    { name: k, type: 'object', desc: `${PERIOD_DESC[k]}的进度` },
    { name: `${k}.key`, type: 'string', desc: `周期键名，固定为 ${k}` },
    { name: `${k}.label`, type: 'string', desc: '周期中文简称：年 / 季度 / 月 / 周 / 日' },
    { name: `${k}.name`, type: 'string', desc: '周期名称，如 2026 年、第三季度、9 月、本周（第 39 周）、今天' },
    { name: `${k}.start`, type: 'string', desc: '周期开始日期 YYYY-MM-DD' },
    { name: `${k}.end`, type: 'string', desc: '周期最后一天 YYYY-MM-DD（含）' },
    { name: `${k}.percent`, type: 'number', desc: '已过去的百分比（0–100，保留 2 位小数，精确到当前时刻）' },
    { name: `${k}.total`, type: 'number', desc: `周期总长度（${unit}）` },
    { name: `${k}.elapsed`, type: 'number', desc: `已完整过去的${unit}数` },
    { name: `${k}.remaining`, type: 'number', desc: `剩余的完整${unit}数（不含正在进行的这一${k === 'day' ? '小时' : '天'}）` },
    { name: `${k}.unit`, type: 'string', desc: `elapsed / remaining / total 的单位：${unit}` },
    { name: `${k}.bar`, type: 'string', desc: 'ASCII 进度条，▓ 为已过去、░ 为剩余，长度由 width 参数决定' },
    { name: `${k}.text`, type: 'string', desc: '一句话中文，如 2026 年已过去 74.52%，还剩 93 天' },
  ];
});

export default {
  name: 'progress',
  category: 'life',
  title: '时间进度',
  description: '今年、本季度、本月、本周、今天分别过去了百分之多少，附进度条和可直接发送的中文文案（北京时间），适合聊天机器人',
  source: '本地计算（北京时间）',
  routes: [
    {
      method: 'GET',
      path: '/api/progress',
      summary: '年 / 季度 / 月 / 周 / 日时间进度',
      params: [
        { name: 'date', required: false, desc: '按指定时间计算：YYYY-MM-DD（按当天结束 24:00 计算）或 YYYY-MM-DD HH:mm（北京时间）；默认当前时刻', example: '2026-09-29' },
        { name: 'width', required: false, default: '20', desc: '进度条长度（字符数）5–50', example: '10' },
      ],
      fields: [
        { name: 'now', type: 'string', desc: '计算所用的北京时间 YYYY-MM-DD HH:mm（只传日期时为 YYYY-MM-DD 24:00）' },
        { name: 'weekday', type: 'string', desc: '星期几，如 星期一' },
        { name: 'weekNumber', type: 'number', desc: 'ISO 周数（周一为一周开始，1–53）' },
        ...periodFields(),
        { name: 'text', type: 'string', desc: '可直接发送的多行文案：首行为年度进度，其后每行为 周期 + 进度条 + 百分比' },
      ],
      async handler({ query }) {
        const date = param(query, 'date', { max: 20 });
        const width = param(query, 'width', { default: 20, int: true, min: 5, max: 50 });
        const { at, endOfDay } = date ? parseProgressDate(date) : { at: Date.now(), endOfDay: false };
        return { data: timeProgress(at, width, endOfDay) };
      },
    },
  ],
};

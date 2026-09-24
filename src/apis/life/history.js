import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError, param, stripTags } from '../../lib/http.js';
import { todayBeijing } from './lunar.js';

// 年份排序用："前221" "公元前221年" 视为 -221，无法解析的排在最后
function yearNum(y) {
  const m = String(y ?? '').match(/(前)?\s*(\d+)/);
  if (!m) return Infinity;
  return m[1] ? -Number(m[2]) : Number(m[2]);
}

const TYPE_TEXT = { event: '事件', birth: '出生', death: '逝世' };

// 百度百科：{ "09": { "0924": [ { year, title(HTML), festival, link, type, desc, cover, pic_share, ... } ] } }
export function parseBaiduHistory(raw, mm, dd) {
  const list = raw?.[mm]?.[`${mm}${dd}`];
  if (!Array.isArray(list)) throw new HttpError(502, '百度百科返回的数据格式无法识别');
  return list
    .map((x) => ({
      year: String(x.year ?? '').trim(),
      title: stripTags(x.title ?? ''),
      desc: stripTags(x.desc ?? ''),
      type: x.type ?? 'event',
      typeText: TYPE_TEXT[x.type] ?? '事件',
      festival: stripTags(x.festival ?? '') || null,
      link: typeof x.link === 'string' && x.link ? x.link.replace(/^http:/, 'https:') : null,
      image: typeof x.pic_share === 'string' && x.pic_share ? x.pic_share : null,
    }))
    .filter((x) => x.title)
    .sort((a, b) => yearNum(a.year) - yearNum(b.year));
}

export async function loadHistoryToday(mmdd = todayBeijing().slice(5)) {
  const [mm, dd] = mmdd.split('-');
  // 同一个月的数据在一个文件里，按月缓存原始数据
  const res = await cache.wrap(`history:${mm}`, 12 * 3600_000, () =>
    fetchJSON(`https://baike.baidu.com/cms/home/eventsOnHistory/${mm}.json`, { headers: { referer: 'https://baike.baidu.com/calendar/' } }));
  return { ...res, data: { date: `${mm}-${dd}`, events: parseBaiduHistory(res.data, mm, dd) } };
}

export default {
  name: 'history-today',
  category: 'life',
  title: '历史上的今天',
  description: '历史上的今天发生的大事、出生与逝世人物',
  source: '百度百科（非官方接口）',
  unofficial: true,
  routes: [
    {
      method: 'GET',
      path: '/api/history/today',
      summary: '历史上的今天大事记',
      params: [{ name: 'date', desc: '月-日 MM-DD，默认今天（北京时间）', example: '10-01' }],
      fields: [
        { name: 'date', type: 'string', desc: '查询的月-日，MM-DD（默认北京时间今天）' },
        { name: 'events', type: 'array', desc: '历史上这一天的条目，按年份从早到晚排序；已过滤掉没有标题的条目' },
        { name: 'events[].year', type: 'string', desc: '发生年份（字符串，如 "1949"）；上游缺失时为空字符串' },
        { name: 'events[].title', type: 'string', desc: '标题（已去除 HTML 标签）' },
        { name: 'events[].desc', type: 'string', desc: '简介（已去除 HTML 标签）；上游没有简介时为空字符串' },
        { name: 'events[].type', type: 'string', desc: '条目类型：event（事件）、birth（出生）、death（逝世）；上游缺省时为 event，其他取值原样返回' },
        { name: 'events[].typeText', type: 'string', desc: '类型中文名：事件、出生、逝世；无法识别的类型为"事件"' },
        { name: 'events[].festival', type: 'string|null', desc: '相关节日名称；上游没有时为 null' },
        { name: 'events[].link', type: 'string|null', desc: '百度百科词条链接（已统一为 https）；上游没有时为 null' },
        { name: 'events[].image', type: 'string|null', desc: '配图链接；上游没有时为 null' },
      ],
      async handler({ query }) {
        const date = param(query, 'date', { default: todayBeijing().slice(5), pattern: /^\d{2}-\d{2}$/ });
        const [m, d] = date.split('-').map(Number);
        const t = new Date(Date.UTC(2024, m - 1, d)); // 闰年，允许 02-29
        if (m < 1 || m > 12 || t.getUTCMonth() !== m - 1) throw new HttpError(400, 'date 不是有效的月-日');
        return loadHistoryToday(date);
      },
    },
  ],
};

import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError, param, stripTags } from '../../lib/http.js';
import { todayBeijing } from './lunar.js';

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
    .sort((a, b) => parseInt(a.year, 10) - parseInt(b.year, 10));
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

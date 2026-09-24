import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError, param } from '../../lib/http.js';

const UPSTREAM = 'https://api.bgm.tv/calendar';
const TTL_MS = 60 * 60_000;
// Bangumi API 要求自定义 UA：开发者/应用名 (联系方式)
const BGM_UA = 'api-hub/0.1 (https://github.com/api-hub/api-hub)';
const WEEKDAY_CN = ['', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];

const https = (u) => (typeof u === 'string' ? u.replace(/^http:\/\//, 'https://') : null);

// /calendar 响应：[{ weekday: { en, cn, ja, id }, items: [{ id, url, name, name_cn, air_date, air_weekday, rating, rank, images, collection }] }]
export function parseCalendar(raw) {
  if (!Array.isArray(raw)) throw new HttpError(502, 'Bangumi 返回的数据格式无法识别');
  return raw
    .map((day) => {
      const id = day.weekday?.id;
      return {
        weekday: id,
        weekdayName: WEEKDAY_CN[id] ?? day.weekday?.cn ?? null,
        items: (day.items ?? [])
          .map((it) => ({
            id: it.id,
            title: it.name_cn || it.name,
            name: it.name,
            nameCn: it.name_cn || null,
            airDate: it.air_date || null,
            score: it.rating?.score || null,
            votes: it.rating?.total ?? 0,
            rank: it.rank || null,
            watching: it.collection?.doing ?? 0,
            cover: https(it.images?.large || it.images?.common || null),
            thumb: https(it.images?.medium || it.images?.small || null),
            url: `https://bgm.tv/subject/${it.id}`,
          }))
          .sort((a, b) => b.watching - a.watching),
      };
    })
    .filter((d) => d.weekday >= 1 && d.weekday <= 7)
    .sort((a, b) => a.weekday - b.weekday);
}

// 以东八区为准
export function todayWeekday(now = new Date()) {
  const d = new Date(now.getTime() + 8 * 3600_000).getUTCDay();
  return d === 0 ? 7 : d;
}

export async function loadAnimeCalendar() {
  return parseCalendar(await fetchJSON(UPSTREAM, { headers: { 'user-agent': BGM_UA } }));
}

export default {
  name: 'anime-calendar',
  category: 'fun',
  title: '番剧放送表',
  description: '本季每日新番放送时间表，按关注人数排序',
  source: 'Bangumi 番组计划',
  routes: [
    {
      method: 'GET',
      path: '/api/anime/calendar',
      summary: '获取每周番剧放送表，可按星期筛选',
      params: [
        { name: 'weekday', desc: '星期 1~7（7=周日），或 today；留空返回整周', example: 'today' },
      ],
      async handler({ query }) {
        let wd = param(query, 'weekday', { pattern: /^([1-7]|today)$/ });
        const res = await cache.wrap('bgm:calendar', TTL_MS, loadAnimeCalendar);
        if (!wd) return res;
        wd = wd === 'today' ? todayWeekday() : Number(wd);
        return { ...res, data: res.data.find((d) => d.weekday === wd) ?? { weekday: wd, weekdayName: WEEKDAY_CN[wd], items: [] } };
      },
    },
  ],
};

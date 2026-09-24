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
      fields: [
        {
          name: '[].weekday',
          type: 'number',
          desc: '未传 weekday 时 data 为数组，每项是一天的放送表，按星期一到星期日排序（上游某天没有番剧时可能缺少该天）。本字段为星期几：1=星期一 … 7=星期日',
        },
        { name: '[].weekdayName', type: 'string', desc: '星期中文名，如 "星期一"' },
        { name: '[].items', type: 'array', desc: '当天放送的番剧，按在看人数从多到少排序，每项字段同 items[]' },
        { name: '[].items[].*', type: 'number|string|null', desc: '同 items[] 中的同名字段' },
        {
          name: 'weekday',
          type: 'number',
          desc: '传了 weekday 参数时 data 为单日对象。本字段为星期几：1=星期一 … 7=星期日（weekday=today 时按北京时间取当天）',
        },
        { name: 'weekdayName', type: 'string', desc: '星期中文名，如 "星期日"' },
        { name: 'items', type: 'array', desc: '当天放送的番剧，按在看人数从多到少排序；上游当天没有数据时为空数组' },
        { name: 'items[].id', type: 'number', desc: 'Bangumi 条目 ID' },
        { name: 'items[].title', type: 'string', desc: '显示用标题：有中文名时为中文名，否则为原名' },
        { name: 'items[].name', type: 'string', desc: '原名（通常为日文），如 "葬送のフリーレン"' },
        { name: 'items[].nameCn', type: 'string|null', desc: '中文名，如 "葬送的芙莉莲"；Bangumi 未登记中文名时为 null' },
        { name: 'items[].airDate', type: 'string|null', desc: '开播日期（YYYY-MM-DD，Bangumi 登记的首播日期）；未登记时为 null' },
        { name: 'items[].score', type: 'number|null', desc: 'Bangumi 评分，满分 10；暂无评分时为 null' },
        { name: 'items[].votes', type: 'number', desc: '评分人数；暂无评分时为 0' },
        { name: 'items[].rank', type: 'number|null', desc: 'Bangumi 动画排名（数字越小越靠前）；未进入排名时为 null' },
        { name: 'items[].watching', type: 'number', desc: 'Bangumi 上标记"在看"的人数；列表按此从多到少排序' },
        {
          name: 'items[].cover',
          type: 'string|null',
          desc: '封面大图链接（Bangumi large 规格，没有时用 common 规格），已转为 https；条目没有封面时为 null',
        },
        {
          name: 'items[].thumb',
          type: 'string|null',
          desc: '封面小图链接（Bangumi medium 规格，没有时用 small 规格），已转为 https；条目没有封面时为 null',
        },
        { name: 'items[].url', type: 'string', desc: 'Bangumi 条目页面链接（https://bgm.tv/subject/{id}）' },
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

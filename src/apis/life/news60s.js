import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError, param, stripTags } from '../../lib/http.js';
import { todayBeijing } from './lunar.js';

// 主源：vikiboss/60s 开源项目的公共实例（数据整理自"每天60秒读懂世界"公众号/知乎专栏）
const VIKI_URL = 'https://60s.viki.moe/v2/60s';
// 备用：知乎专栏"每天60秒读懂世界"
const ZHIHU_URL = 'https://www.zhihu.com/api/v4/columns/c_1715391799055720448/items?limit=1';

const cleanItem = (s) => stripTags(s).replace(/^\d+[、.．]\s*/, '').replace(/[；;]$/, '').trim();

export function parseViki60s(raw) {
  const d = raw?.data;
  if (!d || !Array.isArray(d.news) || !d.news.length) throw new HttpError(502, '60s 数据格式无法识别');
  return {
    date: d.date ?? null,
    weekday: d.day_of_week ?? null,
    lunarDate: d.lunar_date ?? null,
    news: d.news.map(cleanItem).filter(Boolean),
    tip: d.tip ? stripTags(d.tip) : null,
    image: d.image ?? null,
    cover: d.cover ?? null,
    link: d.link ?? null,
    source: '60s.viki.moe',
  };
}

// 知乎专栏文章正文：<p>1、xxx；</p>... <p>【微语】xxx</p>
export function parseZhihu60s(raw) {
  const item = raw?.data?.[0];
  if (!item?.content) throw new HttpError(502, '知乎专栏数据格式无法识别');
  const paras = [...item.content.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => stripTags(m[1])).filter(Boolean);
  const news = paras.filter((p) => /^\d+[、.．]/.test(p)).map(cleanItem);
  const tipPara = paras.find((p) => p.includes('【微语】'));
  if (!news.length) throw new HttpError(502, '知乎专栏数据格式无法识别');
  const created = item.created ?? item.updated;
  return {
    date: created ? todayBeijing(created * 1000) : null,
    weekday: null,
    lunarDate: null,
    news,
    tip: tipPara ? tipPara.replace(/^.*?【微语】\s*/, '') : null,
    image: item.image_url || null,
    cover: item.image_url || null,
    link: item.url ?? null,
    source: 'zhihu.com',
  };
}

// 供推送复用
export async function loadDaily60s(date) {
  const key = `news60s:${date ?? 'latest'}`;
  return cache.wrap(key, 30 * 60_000, async () => {
    try {
      return parseViki60s(await fetchJSON(date ? `${VIKI_URL}?date=${encodeURIComponent(date)}` : VIKI_URL));
    } catch (err) {
      if (date) throw err;
      return parseZhihu60s(await fetchJSON(ZHIHU_URL));
    }
  });
}

export default {
  name: 'news-60s',
  category: 'life',
  title: '60 秒读懂世界',
  description: '每日 15 条新闻简报 + 微语',
  source: '60s.viki.moe（vikiboss/60s，备用知乎专栏"每天60秒读懂世界"）',
  unofficial: true,
  routes: [
    {
      method: 'GET',
      path: '/api/news/60s',
      summary: '获取每日 60 秒新闻简报',
      params: [{ name: 'date', desc: '日期 YYYY-MM-DD，留空取最新一期', example: '2026-09-24' }],
      fields: [
        { name: 'date', type: 'string|null', desc: '简报日期，YYYY-MM-DD。备用源 zhihu.com 按文章发布时间换算为北京时间日期；取不到时为 null' },
        { name: 'weekday', type: 'string|null', desc: '星期几，如 星期四。仅主源 60s.viki.moe 提供，备用源 zhihu.com 为 null' },
        { name: 'lunarDate', type: 'string|null', desc: '农历日期，如 八月十四（不含年份）。仅主源 60s.viki.moe 提供，备用源 zhihu.com 为 null' },
        { name: 'news', type: 'array', desc: '新闻条目（字符串数组，通常 15 条），已去掉序号、HTML 标签和末尾分号' },
        { name: 'tip', type: 'string|null', desc: '微语（每日一句）；上游没有时为 null' },
        { name: 'image', type: 'string|null', desc: '图片链接：主源为整期简报的图片版；备用源为知乎文章题图。没有时为 null' },
        { name: 'cover', type: 'string|null', desc: '封面图链接：主源为封面图；备用源与 image 相同。没有时为 null' },
        { name: 'link', type: 'string|null', desc: '原文链接：主源为公众号文章，备用源为知乎专栏文章。没有时为 null' },
        { name: 'source', type: 'string', desc: '本次数据实际来自哪个源：60s.viki.moe（主源）或 zhihu.com（未指定 date 且主源失败时的备用源）' },
      ],
      async handler({ query }) {
        const date = param(query, 'date', { pattern: /^\d{4}-\d{2}-\d{2}$/ });
        return loadDaily60s(date);
      },
    },
  ],
};

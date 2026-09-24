import { cache } from '../../lib/cache.js';
import { fetchText, HttpError, param, stripTags, decodeEntities } from '../../lib/http.js';

const TOP250 = 'https://movie.douban.com/top250';
const NOWPLAYING = 'https://movie.douban.com/cinema/nowplaying';
const HEADERS = { referer: 'https://movie.douban.com/', 'accept-language': 'zh-CN,zh;q=0.9' };

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decodeEntities(m[1]).trim() : null;
};
const num = (s) => (s == null || s === '' || Number.isNaN(Number(s)) ? null : Number(s));
const clean = (s) => s.replace(/^[\s/]+/, '').trim();

// top250?start=N 的 HTML：<ol class="grid_view"><li><div class="item">...</div></li>
export function parseTop250(html) {
  const items = html.split(/<div class="item">/).slice(1);
  if (!items.length) throw new HttpError(502, '豆瓣 Top250 页面结构无法识别（可能触发了反爬）');
  return items.map((block) => {
    const rank = num(/<em[^>]*>(\d+)<\/em>/.exec(block)?.[1]);
    const url = /<a href="(https:\/\/movie\.douban\.com\/subject\/\d+\/)"/.exec(block)?.[1] ?? null;
    const img = /<img[^>]*>/.exec(block)?.[0] ?? '';
    const titles = [...block.matchAll(/<span class="title">([\s\S]*?)<\/span>/g)].map((m) => clean(stripTags(m[1])));
    const other = /<span class="other">([\s\S]*?)<\/span>/.exec(block)?.[1];
    const bd = /<div class="bd">\s*<p[^>]*>([\s\S]*?)<\/p>/.exec(block)?.[1] ?? '';
    const [crewLine = '', metaLine = ''] = bd.split(/<br\s*\/?>/).map((s) => stripTags(s));
    const meta = metaLine.split('/').map((s) => s.trim()).filter(Boolean);
    const votes = /<span>(\d+)人评价<\/span>/.exec(block)?.[1];
    const quoteHtml = /<p class="quote">([\s\S]*?)<\/p>/.exec(block)?.[1];
    return {
      rank,
      id: url ? url.match(/subject\/(\d+)/)[1] : null,
      title: titles[0] ?? attr(img, 'alt'),
      originalTitle: titles[1] ?? null,
      otherTitles: other ? clean(stripTags(other)) : null,
      rating: num(/<span class="rating_num"[^>]*>([\d.]+)<\/span>/.exec(block)?.[1]),
      votes: num(votes),
      year: num(/(\d{4})/.exec(meta[0] ?? '')?.[1]),
      region: meta[1] ?? null,
      genres: meta[2] ? meta[2].split(/\s+/) : [],
      crew: crewLine || null,
      poster: attr(img, 'src'),
      url,
      quote: quoteHtml ? stripTags(quoteHtml) || null : null,
    };
  });
}

// cinema/nowplaying/{city}/ 的 HTML：<div id="nowplaying"> 下 <li class="list-item" data-title data-score ...>
export function parseNowPlaying(html) {
  const start = html.indexOf('id="nowplaying"');
  if (start < 0) throw new HttpError(502, '豆瓣正在热映页面结构无法识别（可能触发了反爬）');
  const end = html.indexOf('id="upcoming"', start);
  const section = html.slice(start, end > 0 ? end : undefined);
  const parts = section.split(/(?=<li[^>]*class="list-item")/).slice(1);
  return parts.map((part) => {
    const tag = /^<li[^>]*>/.exec(part)[0];
    const id = attr(tag, 'id') || attr(tag, 'data-subject');
    const img = /<li class="poster">[\s\S]*?(<img[^>]*>)/.exec(part)?.[1] ?? '';
    const score = num(attr(tag, 'data-score'));
    return {
      id,
      title: attr(tag, 'data-title'),
      rating: score || null, // 0 表示暂无评分
      votes: num(attr(tag, 'data-votecount')),
      year: num(attr(tag, 'data-release')),
      duration: attr(tag, 'data-duration') || null,
      region: attr(tag, 'data-region') || null,
      director: attr(tag, 'data-director') || null,
      actors: (attr(tag, 'data-actors') || '').split('/').map((s) => s.trim()).filter(Boolean),
      poster: attr(img, 'src'),
      url: id ? `https://movie.douban.com/subject/${id}/` : null,
    };
  });
}

export async function loadDoubanTop250(page = 1) {
  const html = await fetchText(`${TOP250}?start=${(page - 1) * 25}&filter=`, { headers: HEADERS });
  return { page, pageSize: 25, totalPages: 10, list: parseTop250(html) };
}

export async function loadDoubanNowPlaying(city = 'beijing') {
  const html = await fetchText(`${NOWPLAYING}/${encodeURIComponent(city)}/`, { headers: HEADERS });
  return { city, list: parseNowPlaying(html) };
}

export default {
  name: 'douban',
  category: 'fun',
  title: '豆瓣电影',
  description: '豆瓣电影 Top250 与各城市正在热映',
  source: '豆瓣电影（网页抓取）',
  unofficial: true,
  routes: [
    {
      method: 'GET',
      path: '/api/douban/top250',
      summary: '豆瓣电影 Top250，每页 25 部',
      params: [{ name: 'page', default: 1, desc: '页码 1~10', example: '1' }],
      async handler({ query }) {
        const page = param(query, 'page', { default: 1, int: true, min: 1, max: 10 });
        return cache.wrap(`douban:top250:${page}`, 24 * 3600_000, () => loadDoubanTop250(page));
      },
    },
    {
      method: 'GET',
      path: '/api/douban/nowplaying',
      summary: '指定城市正在热映的电影',
      params: [{ name: 'city', default: 'beijing', desc: '城市拼音，例如 beijing、shanghai、guangzhou', example: 'shanghai' }],
      async handler({ query }) {
        const city = param(query, 'city', { default: 'beijing', pattern: /^[a-z]{2,20}$/ });
        return cache.wrap(`douban:nowplaying:${city}`, 60 * 60_000, () => loadDoubanNowPlaying(city));
      },
    },
  ],
};

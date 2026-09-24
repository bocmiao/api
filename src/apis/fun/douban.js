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
      // 形如 "1994 / 美国 / 犯罪 剧情"；多个上映年份时年份段会有多段，地区和类型总在最后两段
      region: (meta.length >= 3 ? meta.at(-2) : meta[1]) ?? null,
      genres: meta.length >= 3 ? meta.at(-1).split(/\s+/) : [],
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
      fields: [
        { name: 'page', type: 'number', desc: '当前页码（1~10）' },
        { name: 'pageSize', type: 'number', desc: '每页条数，固定为 25' },
        { name: 'totalPages', type: 'number', desc: '总页数，固定为 10（共 250 部）' },
        { name: 'list', type: 'array', desc: '本页的电影，按排名从前到后' },
        { name: 'list[].rank', type: 'number|null', desc: 'Top250 排名（1~250）；页面解析不到时为 null' },
        { name: 'list[].id', type: 'string|null', desc: '豆瓣电影条目 ID（数字字符串，如 "1292052"）；解析不到条目链接时为 null' },
        { name: 'list[].title', type: 'string|null', desc: '中文片名；解析不到时取海报的 alt 文本，仍没有时为 null' },
        { name: 'list[].originalTitle', type: 'string|null', desc: '外文原名，如 "The Shawshank Redemption"；只有一个片名（如华语片）时为 null' },
        { name: 'list[].otherTitles', type: 'string|null', desc: '其他译名/又名，多个用 " / " 分隔，如 "月黑高飞(港) / 刺激1995(台)"；没有时为 null' },
        { name: 'list[].rating', type: 'number|null', desc: '豆瓣评分，满分 10（一位小数，如 9.7）；解析不到时为 null' },
        { name: 'list[].votes', type: 'number|null', desc: '评价人数；解析不到时为 null' },
        { name: 'list[].year', type: 'number|null', desc: '上映年份（4 位数字，如 1994）；解析不到时为 null' },
        { name: 'list[].region', type: 'string|null', desc: '制片国家/地区，多个用空格分隔，如 "中国大陆 中国香港"；解析不到时为 null' },
        { name: 'list[].genres', type: 'array', desc: '类型，字符串数组，如 ["犯罪", "剧情"]；解析不到时为空数组' },
        {
          name: 'list[].crew',
          type: 'string|null',
          desc: '导演与主演（列表页原文，过长时被豆瓣截断为 "..."），如 "导演: 弗兰克·德拉邦特 Frank Darabont 主演: 蒂姆·罗宾斯 Tim Robbins /..."；没有时为 null',
        },
        {
          name: 'list[].poster',
          type: 'string|null',
          desc: '海报链接（豆瓣列表页的小尺寸竖版海报，路径含 s_ratio_poster，格式为 jpg 或 webp）。豆瓣图片有防盗链，网页中引用需加 referrerpolicy="no-referrer"',
        },
        { name: 'list[].url', type: 'string|null', desc: '豆瓣电影条目页面（https://movie.douban.com/subject/{id}/）；解析不到时为 null' },
        { name: 'list[].quote', type: 'string|null', desc: '一句话短评/经典台词，如 "希望让人自由。"；部分电影没有，此时为 null' },
      ],
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
      fields: [
        { name: 'city', type: 'string', desc: '城市拼音，即请求的 city 参数' },
        { name: 'list', type: 'array', desc: '该城市正在上映的电影（不含"即将上映"），按豆瓣页面顺序' },
        { name: 'list[].id', type: 'string|null', desc: '豆瓣电影条目 ID（数字字符串）；页面缺失时为 null' },
        { name: 'list[].title', type: 'string|null', desc: '片名；页面缺失时为 null' },
        { name: 'list[].rating', type: 'number|null', desc: '豆瓣评分，满分 10（一位小数）；暂无评分（刚上映、评价人数不足）时为 null' },
        { name: 'list[].votes', type: 'number|null', desc: '评价人数；页面未提供时为 null' },
        { name: 'list[].year', type: 'number|null', desc: '上映年份（如 2026）；页面未提供时为 null' },
        { name: 'list[].duration', type: 'string|null', desc: '片长文本，如 "128分钟"；页面未提供时为 null' },
        { name: 'list[].region', type: 'string|null', desc: '制片国家/地区，如 "中国大陆"；页面未提供时为 null' },
        { name: 'list[].director', type: 'string|null', desc: '导演（页面原文）；页面未提供时为 null' },
        { name: 'list[].actors', type: 'array', desc: '主演，字符串数组，如 ["李四", "王五"]；页面未提供时为空数组' },
        {
          name: 'list[].poster',
          type: 'string|null',
          desc: '海报链接（豆瓣小尺寸竖版海报，路径含 s_ratio_poster）；豆瓣图片有防盗链，网页中引用需加 referrerpolicy="no-referrer"；页面缺失时为 null',
        },
        { name: 'list[].url', type: 'string|null', desc: '豆瓣电影条目页面（https://movie.douban.com/subject/{id}/）；没有 id 时为 null' },
      ],
      async handler({ query }) {
        const city = param(query, 'city', { default: 'beijing', pattern: /^[a-z]{2,20}$/ });
        return cache.wrap(`douban:nowplaying:${city}`, 60 * 60_000, () => loadDoubanNowPlaying(city));
      },
    },
  ],
};

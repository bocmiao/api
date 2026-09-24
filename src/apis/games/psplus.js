import { cache } from '../../lib/cache.js';
import { fetchText, HttpError, stripTags, decodeEntities } from '../../lib/http.js';

// PlayStation Blog（英文）没有官方 API，读 RSS 找每月会免公告
const FEEDS = [
  'https://blog.playstation.com/tag/playstation-plus/feed/',
  'https://blog.playstation.com/feed/',
];
const TTL_MS = 60 * 60 * 1000;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const TITLE_RE = /PlayStation Plus Monthly Games\b/i;

const cdata = (s = '') => s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? cdata(m[1]).trim() : '';
};

export function parseRssItems(xml) {
  if (typeof xml !== 'string' || !/<rss|<feed|<channel/.test(xml)) throw new HttpError(502, 'PlayStation Blog 返回的不是 RSS');
  return [...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const content = tag(it, 'content:encoded') || tag(it, 'description');
    const image = it.match(/<media:(?:content|thumbnail)[^>]*url="([^"]+)"/)?.[1]
      ?? it.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="image/)?.[1]
      ?? content.match(/<img[^>]*src="([^"]+)"/)?.[1]
      ?? null;
    return {
      title: decodeEntities(stripTags(tag(it, 'title'))),
      link: tag(it, 'link'),
      pubDate: tag(it, 'pubDate'),
      summary: stripTags(tag(it, 'description')).slice(0, 300),
      image: image && decodeEntities(image),
    };
  });
}

// "A, B, and C" / "A, B and C" / "A and B" → [A, B, C]；只在最后一段拆 and，避免误拆 "Rock and Roll" 这类中间项
export function splitGames(list) {
  const parts = list.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
  let last = parts.pop() ?? '';
  if (/^and\s/i.test(last)) parts.push(last.slice(4));
  else {
    const i = last.toLowerCase().lastIndexOf(' and ');
    parts.push(...(i > 0 ? [last.slice(0, i), last.slice(i + 5)] : [last]));
  }
  return parts.map((s) => s.trim().replace(/[.!]+$/, '')).filter(Boolean);
}

// 纯函数：从 RSS 中找出最近的每月会免公告
export function parsePsPlusMonthly(xml) {
  const posts = parseRssItems(xml).filter((i) => TITLE_RE.test(i.title));
  if (!posts.length) throw new HttpError(404, '最近的博客文章中没有找到 PS Plus 每月会免公告');

  return posts.map((p) => {
    const colon = p.title.indexOf(':');
    const games = colon >= 0 ? splitGames(p.title.slice(colon + 1)) : [];
    const monthName = p.title.match(/\bfor\s+([A-Za-z]+)/i)?.[1]?.toLowerCase();
    const mi = MONTHS.indexOf(monthName);
    const pub = p.pubDate ? new Date(p.pubDate) : null;
    let month = null;
    if (mi >= 0 && pub && !Number.isNaN(pub.getTime())) {
      // 公告一般在上月末发布：12 月发布的 1 月会免属于下一年
      const year = pub.getUTCFullYear() + (mi < pub.getUTCMonth() - 6 ? 1 : 0);
      month = `${year}-${String(mi + 1).padStart(2, '0')}`;
    }
    return {
      month,
      games,
      title: p.title,
      url: p.link,
      image: p.image,
      summary: p.summary,
      publishedAt: pub && !Number.isNaN(pub.getTime()) ? pub.toISOString() : null,
    };
  });
}

async function loadFeed() {
  let lastErr;
  for (const url of FEEDS) {
    try {
      return parsePsPlusMonthly(await fetchText(url, { headers: { accept: 'application/rss+xml, application/xml' } }));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export default {
  name: 'psplus',
  category: 'games',
  title: 'PS Plus 每月会免',
  description: 'PlayStation Plus 每月免费游戏（来自 PlayStation Blog 公告，英文游戏名）',
  source: 'PlayStation Blog RSS',
  unofficial: true,
  routes: [
    {
      method: 'GET',
      path: '/api/psplus/monthly',
      summary: '获取最新一期 PS Plus 每月会免游戏，history 为 RSS 中更早的几期',
      params: [],
      async handler() {
        const res = await cache.wrap('psplus:monthly', TTL_MS, loadFeed);
        const [latest, ...history] = res.data;
        return { ...res, data: { ...latest, history } };
      },
    },
  ],
};

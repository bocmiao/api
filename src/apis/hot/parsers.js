// 各热榜上游的纯解析函数：原始响应 -> 统一条目 { rank, title, url, hot, desc, extra? }
import { HttpError, decodeEntities, stripTags } from '../../lib/http.js';

// "1234 万热度" / "3.2亿" / "12,345" / 12345 -> number；无法识别返回 null
export function parseHotNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([万亿kKmMwW]?)/);
  if (!m) return null;
  const unit = { 万: 1e4, w: 1e4, W: 1e4, 亿: 1e8, k: 1e3, K: 1e3, m: 1e6, M: 1e6 }[m[2]] ?? 1;
  return Math.round(Number(m[1]) * unit);
}

export function truncate(s, n = 120) {
  if (!s) return null;
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// 统一条目：去掉空标题，重新编号
export function normalize(list) {
  return list
    .filter((it) => it && it.title)
    .map((it, i) => {
      const item = {
        rank: i + 1,
        title: String(it.title).trim(),
        url: it.url || null,
        hot: parseHotNumber(it.hot),
        desc: truncate(it.desc),
      };
      if (it.extra) {
        const extra = Object.fromEntries(Object.entries(it.extra).filter(([, v]) => v != null && v !== ''));
        if (Object.keys(extra).length) item.extra = extra;
      }
      return item;
    });
}

const bad = (name) => new HttpError(502, `${name}返回的数据格式无法识别`);

// ---------- 微博 ----------
export function parseWeibo(raw) {
  const list = raw?.data?.realtime;
  if (!Array.isArray(list)) throw bad('微博');
  return normalize(
    list
      .filter((v) => !v.is_ad && v.word)
      .map((v) => ({
        title: v.word,
        url: `https://s.weibo.com/weibo?q=${encodeURIComponent(`#${v.word}#`)}`,
        hot: v.num ?? v.raw_hot,
        desc: v.note && v.note !== v.word ? v.note : null,
        extra: { label: v.label_name || v.icon_desc || null, category: v.category || v.flag_desc || null },
      })),
  );
}

// ---------- 知乎 ----------
// 兼容 api.zhihu.com 移动端结构（target.title/excerpt）与 www 新版结构（target.title_area.text 等）
export function parseZhihu(raw) {
  const list = raw?.data;
  if (!Array.isArray(list)) throw bad('知乎');
  return normalize(
    list.map((v) => {
      const t = v.target ?? {};
      const title = t.title ?? t.title_area?.text;
      const link = t.link?.url ?? t.url ?? '';
      const qid = link.match(/questions?\/(\d+)/)?.[1] ?? (t.type === 'question' || !t.type ? t.id : null);
      return {
        title,
        url: qid ? `https://www.zhihu.com/question/${qid}` : link || null,
        hot: v.detail_text ?? t.metrics_area?.text,
        desc: t.excerpt ?? t.excerpt_area?.text ?? null,
        extra: {
          answers: t.answer_count ?? null,
          followers: t.follower_count ?? null,
          cover: v.children?.[0]?.thumbnail || t.image_area?.url || null,
        },
      };
    }),
  );
}

// ---------- B 站（popular 与 ranking/v2 的 list 结构一致） ----------
export function parseBilibili(raw) {
  if (raw?.code !== 0) throw new HttpError(502, `B 站接口返回错误：${raw?.message ?? raw?.code ?? '未知'}`);
  const list = raw?.data?.list;
  if (!Array.isArray(list)) throw bad('B 站');
  return normalize(
    list.map((v) => ({
      title: v.title,
      url: v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : v.short_link_v2 || null,
      hot: v.stat?.view,
      desc: v.rcmd_reason?.content || v.desc || null,
      extra: {
        bvid: v.bvid,
        author: v.owner?.name,
        cover: v.pic,
        like: v.stat?.like,
        danmaku: v.stat?.danmaku,
        score: v.score,
      },
    })),
  );
}

// ---------- 抖音 ----------
export function parseDouyin(raw) {
  const list = raw?.data?.word_list;
  if (!Array.isArray(list)) throw bad('抖音');
  return normalize(
    list.map((v) => ({
      title: v.word,
      url: v.sentence_id
        ? `https://www.douyin.com/hot/${v.sentence_id}`
        : `https://www.douyin.com/search/${encodeURIComponent(v.word ?? '')}`,
      hot: v.hot_value,
      desc: null,
      extra: {
        cover: v.word_cover?.url_list?.[0],
        videoCount: v.video_count,
        eventTime: v.event_time ? new Date(v.event_time * 1000).toISOString() : null,
      },
    })),
  );
}

// ---------- 百度（HTML 中 <!--s-data:{...}--> 注释） ----------
export function parseBaidu(html) {
  const m = String(html).match(/<!--s-data:([\s\S]*?)-->/);
  if (!m) throw bad('百度');
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    throw bad('百度');
  }
  const cards = data?.data?.cards;
  if (!Array.isArray(cards) || !cards.length) throw bad('百度');
  const card = cards.find((c) => c.component === 'hotList') ?? cards[0];
  // content 可能直接是条目数组，也可能再嵌一层 content
  const flat = (arr = []) => arr.flatMap((x) => (Array.isArray(x?.content) ? x.content : [x]));
  const top = flat(card.topContent).map((x) => ({ ...x, isTop: true }));
  const list = [...top, ...flat(card.content)];
  return normalize(
    list.map((v) => ({
      title: v.word ?? v.query,
      url: v.rawUrl || v.url || `https://www.baidu.com/s?wd=${encodeURIComponent(v.query ?? v.word ?? '')}`,
      hot: v.hotScore,
      desc: v.desc || null,
      extra: { cover: v.img, top: v.isTop || null, tag: { 1: '新', 3: '热', 4: '沸' }[v.hotTag] ?? null },
    })),
  );
}

// ---------- 今日头条 ----------
export function parseToutiao(raw) {
  const list = raw?.data;
  if (!Array.isArray(list)) throw bad('今日头条');
  return normalize(
    list.map((v) => ({
      title: v.Title,
      url: v.ClusterIdStr ? `https://www.toutiao.com/trending/${v.ClusterIdStr}/` : v.Url,
      hot: v.HotValue,
      desc: null,
      extra: { label: v.LabelDesc || null, cover: v.Image?.url, category: v.InterestCategory?.join?.(',') },
    })),
  );
}

// ---------- GitHub Trending（HTML） ----------
export function parseGithubTrending(html) {
  const blocks = String(html).split(/<article\b[^>]*class="[^"]*\bBox-row\b[^"]*"[^>]*>/).slice(1);
  if (!blocks.length) {
    if (/It looks like we don.t have any trending repositories/i.test(html)) return [];
    throw bad('GitHub Trending');
  }
  return normalize(
    blocks.map((b) => {
      b = b.split('</article>')[0];
      const href = b.match(/<h[12][^>]*>[\s\S]*?<a\b[^>]*href="\/([^"/]+\/[^"/]+)"/)?.[1];
      if (!href) return null;
      const desc = b.match(/<p\b[^>]*>([\s\S]*?)<\/p>/)?.[1];
      const language = b.match(/itemprop="programmingLanguage"[^>]*>([^<]*)</)?.[1];
      const count = (suffix) => {
        const re = new RegExp(`href="/${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${suffix}"[^>]*>([\\s\\S]*?)</a>`);
        const v = b.match(re)?.[1];
        return v ? parseHotNumber(stripTags(v)) : null;
      };
      const period = stripTags(b).match(/([\d,]+)\s+stars?\s+(today|this week|this month)/i);
      const [owner, repo] = href.split('/');
      return {
        title: `${owner}/${repo}`,
        url: `https://github.com/${href}`,
        hot: period ? period[1] : null,
        desc: desc ? stripTags(desc) : null,
        extra: {
          owner,
          repo,
          language: language ? decodeEntities(language.trim()) : null,
          stars: count('stargazers'),
          forks: count('forks'),
          starsInPeriod: period ? parseHotNumber(period[1]) : null,
        },
      };
    }),
  );
}

// ---------- V2EX ----------
export function parseV2ex(raw) {
  if (!Array.isArray(raw)) throw bad('V2EX');
  return normalize(
    raw.map((v) => ({
      title: v.title,
      url: v.url || `https://www.v2ex.com/t/${v.id}`,
      hot: v.replies,
      desc: v.content ? stripTags(v.content) : null,
      extra: { node: v.node?.title, author: v.member?.username, replies: v.replies },
    })),
  );
}

// ---------- Hacker News ----------
export function parseHackerNewsItems(items) {
  if (!Array.isArray(items)) throw bad('Hacker News');
  return normalize(
    items
      .filter((v) => v && !v.deleted && !v.dead)
      .map((v) => {
        const discuss = `https://news.ycombinator.com/item?id=${v.id}`;
        return {
          title: v.title,
          url: v.url || discuss,
          hot: v.score,
          desc: v.text ? stripTags(v.text) : null,
          extra: {
            by: v.by,
            comments: v.descendants,
            discussUrl: discuss,
            time: v.time ? new Date(v.time * 1000).toISOString() : null,
          },
        };
      }),
  );
}

// hn.algolia.com search?tags=front_page 的 hits（兜底用）
export function parseHackerNewsAlgolia(raw) {
  const hits = raw?.hits;
  if (!Array.isArray(hits)) throw bad('Hacker News');
  return parseHackerNewsItems(
    hits.map((h) => ({
      id: h.objectID,
      title: h.title,
      url: h.url,
      score: h.points,
      by: h.author,
      descendants: h.num_comments,
      time: h.created_at_i,
    })),
  );
}

// ---------- RSS 2.0 / Atom ----------
function unwrap(s) {
  if (s == null) return null;
  const parts = [];
  let hadCdata = false;
  const rest = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => {
    hadCdata = true;
    parts.push(c);
    return `\u0000${parts.length - 1}\u0000`;
  });
  // CDATA 外的部分需要解实体；CDATA 内是原文
  const decoded = decodeEntities(rest);
  return hadCdata ? decoded.replace(/\u0000(\d+)\u0000/g, (_, i) => parts[i]) : decoded;
}

function tag(block, names) {
  for (const n of names) {
    const re = new RegExp(`<${n}(?:\\s[^>]*)?(?<!/)>([\\s\\S]*?)</${n}>`, 'i');
    const m = block.match(re);
    if (m) return m[1];
  }
  return null;
}

function atomLink(block) {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
  const pick = links.find((a) => /href=/.test(a) && (!/rel=/.test(a) || /rel=["']alternate["']/.test(a)));
  return pick?.match(/href=["']([^"']+)["']/)?.[1] ?? null;
}

// 标题是纯文本：只去掉真正的 HTML 标签（如 <b>），保留 "<新一代>" 这类文字
const cleanTitle = (s) =>
  decodeEntities(s.replace(/<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?\/?>/gi, '')).replace(/\s+/g, ' ').trim();

export function parseFeed(xml) {
  const s = String(xml);
  const isAtom = /<feed\b/i.test(s) && !/<rss\b/i.test(s);
  const blocks = [...s.matchAll(isAtom ? /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi : /<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(
    (m) => m[1],
  );
  if (!blocks.length && !/<(rss|feed|rdf:RDF)\b/i.test(s)) throw bad('RSS');
  return normalize(
    blocks.map((b) => {
      const title = unwrap(tag(b, ['title']));
      const textLink = tag(b, ['link']);
      const link = textLink && textLink.trim() ? unwrap(textLink).trim() : atomLink(b) ?? unwrap(tag(b, ['guid', 'id']))?.trim();
      const body = unwrap(tag(b, ['description', 'summary', 'content:encoded', 'content']));
      const date = unwrap(tag(b, ['pubDate', 'published', 'updated', 'dc:date']))?.trim();
      const author = unwrap(tag(b, ['dc:creator', 'author']));
      const time = date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null;
      return {
        title: title ? cleanTitle(title) : null,
        url: link || null,
        hot: null,
        desc: body ? stripTags(body) : null,
        extra: { author: author ? stripTags(author) : null, time },
      };
    }),
  );
}

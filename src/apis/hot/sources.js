// 各热榜的抓取逻辑与注册表；loadHot(source, opts) 供其他模块复用
import { randomUUID } from 'node:crypto';
import { cache } from '../../lib/cache.js';
import { fetchJSON, fetchText, HttpError } from '../../lib/http.js';
import * as P from './parsers.js';
import { keysFromNav, signWbi } from './wbi.js';

export const HOT_TTL = 5 * 60_000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// ---------- B 站 ----------
const BILI_HEADERS = () => ({
  referer: 'https://www.bilibili.com/',
  origin: 'https://www.bilibili.com',
  'user-agent': UA,
  cookie: `buvid3=${randomUUID().toUpperCase()}infoc`,
});

async function biliWbiKeys() {
  const { data } = await cache.wrap('hot:bili:wbi', 60 * 60_000, async () => {
    // 未登录时 code=-101，但仍返回 wbi_img
    const nav = await fetchJSON('https://api.bilibili.com/x/web-interface/nav', { headers: BILI_HEADERS() });
    const keys = keysFromNav(nav);
    if (!keys) throw new HttpError(502, 'B 站 WBI 密钥获取失败');
    return keys;
  });
  return data;
}

async function biliGet(path, params, { sign }) {
  const qs = sign ? signWbi(params, await biliWbiKeys()) : new URLSearchParams(params).toString();
  return fetchJSON(`https://api.bilibili.com${path}?${qs}`, { headers: BILI_HEADERS() });
}

// 先按 sign 首选方式请求；若返回风控/错误码，换另一种方式再试一次
async function biliFetch(path, params, preferSign) {
  let raw;
  try {
    raw = await biliGet(path, params, { sign: preferSign });
    if (raw?.code === 0) return raw;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
  }
  const retry = await biliGet(path, params, { sign: !preferSign });
  return retry?.code === 0 ? retry : (raw ?? retry);
}

async function loadBilibili({ type = 'popular' } = {}) {
  if (type === 'rank') {
    // ranking/v2 目前需要 WBI 签名，未签名常返回 -352
    const raw = await biliFetch('/x/web-interface/ranking/v2', { rid: 0, type: 'all', web_location: '333.934' }, true);
    return { title: 'B 站排行榜', items: P.parseBilibili(raw) };
  }
  const raw = await biliFetch('/x/web-interface/popular', { ps: 50, pn: 1 }, false);
  return { title: 'B 站综合热门', items: P.parseBilibili(raw) };
}

// ---------- 抖音 ----------
async function douyinCookie() {
  try {
    const res = await fetch('https://www.douyin.com/passport/general/login_guiding_strategy/?aid=6383', {
      headers: { 'user-agent': UA, referer: 'https://www.douyin.com/' },
      signal: AbortSignal.timeout(5000),
    });
    const token = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .find((c) => c.startsWith('passport_csrf_token='));
    return token ?? '';
  } catch {
    return '';
  }
}

async function loadDouyin() {
  const cookie = await douyinCookie();
  const url =
    'https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1';
  const raw = await fetchJSON(url, {
    headers: { 'user-agent': UA, referer: 'https://www.douyin.com/hot', ...(cookie ? { cookie } : {}) },
  });
  return { title: '抖音热点', items: P.parseDouyin(raw) };
}

// ---------- Hacker News ----------
async function loadHackerNews({ limit = 30 } = {}) {
  try {
    const ids = await fetchJSON('https://hacker-news.firebaseio.com/v0/topstories.json');
    if (!Array.isArray(ids)) throw new HttpError(502, 'Hacker News 返回的数据格式无法识别');
    const items = await Promise.all(
      ids.slice(0, limit).map((id) =>
        fetchJSON(`https://hacker-news.firebaseio.com/v0/item/${Number(id)}.json`, { timeoutMs: 8000 }).catch(() => null),
      ),
    );
    if (items.every((v) => v == null)) throw new HttpError(502, 'Hacker News 条目获取失败');
    return { title: 'Hacker News', items: P.parseHackerNewsItems(items) };
  } catch (err) {
    // 兜底：Algolia 首页（顺序不完全等同 HN 排名）
    const raw = await fetchJSON(`https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${limit}`).catch(() => {
      throw err;
    });
    return { title: 'Hacker News', items: P.parseHackerNewsAlgolia(raw) };
  }
}

// ---------- 科技资讯 RSS ----------
export const NEWS_FEEDS = {
  ithome: { title: 'IT之家', url: 'https://www.ithome.com/rss/' },
  '36kr': { title: '36氪', url: 'https://36kr.com/feed' },
  sspai: { title: '少数派', url: 'https://sspai.com/feed' },
};

async function loadNews({ source = 'ithome' } = {}) {
  const feed = NEWS_FEEDS[source];
  if (!feed) throw new HttpError(400, `source 只能是 ${Object.keys(NEWS_FEEDS).join(' / ')}`);
  const xml = await fetchText(feed.url, {
    headers: { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
  });
  return { title: feed.title, items: P.parseFeed(xml) };
}

export const GITHUB_SINCE = ['daily', 'weekly', 'monthly'];
export const GITHUB_LANG_RE = /^[A-Za-z0-9.+#_ -]{1,40}$/;

// ---------- 注册表 ----------
// key(opts) 用于缓存键；load(opts) 返回 { title, items }
export const SOURCES = {
  weibo: {
    title: '微博热搜',
    key: () => '',
    async load() {
      const raw = await fetchJSON('https://weibo.com/ajax/side/hotSearch', {
        headers: { 'user-agent': UA, referer: 'https://weibo.com/', 'x-requested-with': 'XMLHttpRequest' },
      });
      return { title: '微博热搜', items: P.parseWeibo(raw) };
    },
  },
  zhihu: {
    title: '知乎热榜',
    key: () => '',
    async load() {
      const raw = await fetchJSON('https://api.zhihu.com/topstory/hot-lists/total?limit=50', {
        headers: { 'user-agent': UA, referer: 'https://www.zhihu.com/hot' },
      });
      return { title: '知乎热榜', items: P.parseZhihu(raw) };
    },
  },
  bilibili: {
    title: 'B 站热门',
    key: ({ type = 'popular' } = {}) => type,
    load: loadBilibili,
  },
  douyin: { title: '抖音热点', key: () => '', load: loadDouyin },
  baidu: {
    title: '百度热搜',
    key: () => '',
    async load() {
      const html = await fetchText('https://top.baidu.com/board?tab=realtime', {
        headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
      });
      return { title: '百度热搜', items: P.parseBaidu(html) };
    },
  },
  toutiao: {
    title: '今日头条热榜',
    key: () => '',
    async load() {
      const raw = await fetchJSON('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', {
        headers: { 'user-agent': UA, referer: 'https://www.toutiao.com/' },
      });
      return { title: '今日头条热榜', items: P.parseToutiao(raw) };
    },
  },
  github: {
    title: 'GitHub Trending',
    key: ({ since = 'daily', language = '' } = {}) => `${since}:${language.toLowerCase()}`,
    async load({ since = 'daily', language = '' } = {}) {
      if (!GITHUB_SINCE.includes(since)) throw new HttpError(400, `since 只能是 ${GITHUB_SINCE.join(' / ')}`);
      if (language && !GITHUB_LANG_RE.test(language)) throw new HttpError(400, 'language 参数不合法');
      const lang = language ? `/${encodeURIComponent(language.toLowerCase().replace(/ /g, '-'))}` : '';
      const html = await fetchText(`https://github.com/trending${lang}?since=${since}`, {
        headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'en-US,en;q=0.9' },
        timeoutMs: 15_000,
      });
      return { title: `GitHub Trending${language ? ` · ${language}` : ''}`, items: P.parseGithubTrending(html) };
    },
  },
  v2ex: {
    title: 'V2EX 热门',
    key: () => '',
    async load() {
      const raw = await fetchJSON('https://www.v2ex.com/api/topics/hot.json', { headers: { 'user-agent': UA } });
      return { title: 'V2EX 热门', items: P.parseV2ex(raw) };
    },
  },
  ithome: { title: 'IT之家', key: () => '', load: () => loadNews({ source: 'ithome' }) },
  '36kr': { title: '36氪', key: () => '', load: () => loadNews({ source: '36kr' }) },
  sspai: { title: '少数派', key: () => '', load: () => loadNews({ source: 'sspai' }) },
  hackernews: {
    title: 'Hacker News',
    key: ({ limit = 30 } = {}) => String(limit),
    load: loadHackerNews,
  },
};

export const SOURCE_IDS = Object.keys(SOURCES);

// 返回 cache.wrap 结构 { data: { source, title, items }, cached, stale?, updatedAt }
export async function getHot(source, opts = {}) {
  const src = SOURCES[source];
  if (!src) throw new HttpError(400, `未知热榜来源：${source}`);
  return cache.wrap(`hot:${source}:${src.key(opts)}`, HOT_TTL, async () => {
    const { title, items } = await src.load(opts);
    return { source, title, items };
  });
}

// 只要归一化数据：{ source, title, items }
export async function loadHot(source, opts = {}) {
  return (await getHot(source, opts)).data;
}

// 按 limit 截断（不改动缓存中的对象）
export function limitItems(res, limit) {
  if (!limit) return res;
  return { ...res, data: { ...res.data, items: res.data.items.slice(0, limit) } };
}

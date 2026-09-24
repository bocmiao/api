import { HttpError, param } from '../../lib/http.js';
import { GITHUB_LANG_RE, GITHUB_SINCE, NEWS_FEEDS, SOURCES, SOURCE_IDS, getHot, limitItems } from './sources.js';
import { SOURCES_FIELDS, allFields, sourceFields } from './fields.js';

export { loadHot, getHot, SOURCES, SOURCE_IDS } from './sources.js';

const LIMIT_PARAM = { name: 'limit', required: false, desc: '返回条数上限（1~100，默认全部）', example: '10' };
const readLimit = (query) => param(query, 'limit', { int: true, min: 1, max: 100 });

// 生成单个热榜模块
function hotModule({ id, title, description, source, unofficial = true, extraParams = [], readOpts = () => ({}) }) {
  return {
    name: `hot-${id}`,
    category: 'hot',
    title,
    description,
    source,
    unofficial,
    routes: [
      {
        method: 'GET',
        path: `/api/hot/${id}`,
        summary: `获取${title}`,
        params: [...extraParams, LIMIT_PARAM],
        fields: sourceFields(id),
        async handler({ query }) {
          const opts = readOpts(query);
          const limit = readLimit(query);
          return limitItems(await getHot(id === 'news' ? opts.source : id, opts), limit);
        },
      },
    ],
  };
}

const modules = [
  hotModule({ id: 'weibo', title: '微博热搜', description: '微博实时热搜榜，已过滤广告', source: '微博' }),
  hotModule({ id: 'zhihu', title: '知乎热榜', description: '知乎全站热榜问题与热度', source: '知乎' }),
  hotModule({
    id: 'bilibili',
    title: 'B 站热门',
    description: 'B 站综合热门或全站排行榜（排行榜使用 WBI 签名）',
    source: '哔哩哔哩',
    extraParams: [
      { name: 'type', required: false, default: 'popular', desc: '榜单类型：popular 综合热门 / rank 全站排行', example: 'rank' },
    ],
    readOpts: (q) => ({ type: param(q, 'type', { default: 'popular', oneOf: ['popular', 'rank'] }) }),
  }),
  hotModule({ id: 'douyin', title: '抖音热点', description: '抖音热点榜', source: '抖音' }),
  hotModule({ id: 'baidu', title: '百度热搜', description: '百度实时热搜榜', source: '百度' }),
  hotModule({ id: 'toutiao', title: '今日头条热榜', description: '今日头条热榜事件', source: '今日头条' }),
  hotModule({
    id: 'github',
    title: 'GitHub Trending',
    description: 'GitHub 趋势仓库：描述、语言、总星数与周期内新增星数',
    source: 'GitHub',
    extraParams: [
      { name: 'since', required: false, default: 'daily', desc: '时间范围：daily / weekly / monthly', example: 'weekly' },
      { name: 'language', required: false, default: '', desc: '编程语言（留空为全部）', example: 'javascript' },
    ],
    readOpts: (q) => ({
      since: param(q, 'since', { default: 'daily', oneOf: GITHUB_SINCE }),
      language: param(q, 'language', { default: '', pattern: GITHUB_LANG_RE }),
    }),
  }),
  hotModule({ id: 'v2ex', title: 'V2EX 热门', description: 'V2EX 最热主题', source: 'V2EX', unofficial: false }),
  hotModule({
    id: 'news',
    title: '科技资讯',
    description: 'IT之家 / 36氪 / 少数派 最新文章（RSS）',
    source: 'IT之家 / 36氪 / 少数派 RSS',
    unofficial: false,
    extraParams: [
      { name: 'source', required: false, default: 'ithome', desc: '资讯来源：ithome / 36kr / sspai', example: 'sspai' },
    ],
    readOpts: (q) => ({ source: param(q, 'source', { default: 'ithome', oneOf: Object.keys(NEWS_FEEDS) }) }),
  }),
  hotModule({
    id: 'hackernews',
    title: 'Hacker News',
    description: 'Hacker News 首页热门（Firebase 官方 API，失败时回退 Algolia）',
    source: 'Hacker News API',
    unofficial: false,
  }),
];

const DEFAULT_ALL = ['weibo', 'zhihu', 'baidu', 'douyin', 'toutiao', 'bilibili'];

modules.push({
  name: 'hot-all',
  category: 'hot',
  title: '热榜合集',
  description: '一次获取多个平台热榜，单个来源失败不影响其他来源',
  source: '多平台聚合',
  unofficial: true,
  routes: [
    {
      method: 'GET',
      path: '/api/hot/all',
      summary: '聚合多个平台热榜，返回各来源结果与失败信息',
      params: [
        {
          name: 'sources',
          required: false,
          default: DEFAULT_ALL.join(','),
          desc: `来源 id，逗号分隔。可选：${SOURCE_IDS.join(', ')}`,
          example: 'weibo,zhihu,github',
        },
        { name: 'limit', required: false, default: '10', desc: '每个来源的条数（1~50）', example: '5' },
      ],
      fields: allFields(),
      async handler({ query }) {
        const raw = param(query, 'sources', { default: DEFAULT_ALL.join(','), max: 200 });
        const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
        const unknown = ids.filter((s) => !SOURCES[s]);
        if (unknown.length) throw new HttpError(400, `未知来源：${unknown.join(', ')}`);
        if (!ids.length) throw new HttpError(400, 'sources 不能为空');
        const limit = param(query, 'limit', { default: 10, int: true, min: 1, max: 50 });

        const settled = await Promise.allSettled(ids.map((id) => getHot(id)));
        const sources = [];
        const errors = [];
        let updatedAt = null;
        let cached = true;
        let stale = false;
        settled.forEach((r, i) => {
          if (r.status === 'fulfilled') {
            const v = limitItems(r.value, limit);
            sources.push({ ...v.data, cached: !!v.cached, stale: !!v.stale, updatedAt: v.updatedAt });
            cached &&= !!v.cached;
            stale ||= !!v.stale;
            if (!updatedAt || v.updatedAt < updatedAt) updatedAt = v.updatedAt;
          } else {
            errors.push({ source: ids[i], title: SOURCES[ids[i]].title, message: r.reason?.message || '获取失败' });
          }
        });
        if (!sources.length) throw new HttpError(502, `所有来源均获取失败：${errors.map((e) => e.title).join('、')}`);
        return { data: { sources, errors }, cached, stale, updatedAt };
      },
    },
    {
      method: 'GET',
      path: '/api/hot/sources',
      summary: '列出可用的热榜来源 id 与名称',
      params: [],
      fields: SOURCES_FIELDS,
      async handler() {
        return { data: SOURCE_IDS.map((id) => ({ id, title: SOURCES[id].title })) };
      },
    },
  ],
});

export default modules;

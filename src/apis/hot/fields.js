// 热榜接口的返回字段说明（路由的 fields）。
// 各来源的条目结构相同 { rank, title, url, hot, desc, extra? }，但 title/url/hot/desc 的含义和 extra 里的字段因来源而异：
// 共用部分由 itemFields() 生成，来源差异写在 DOCS 里，/api/hot/all 的说明由 DOCS 合并而来。
import { NEWS_FEEDS, SOURCES, SOURCE_IDS } from './sources.js';

const field = (name, type, desc) => ({ name, type, desc });

const TIME = 'ISO 8601 格式，UTC 时区，如 2026-09-24T05:00:00.000Z';
const RANK = '排名，从 1 开始连续编号（已去掉广告、无标题等条目后重新编号，可能与上游页面上的名次不同）';
const EXTRA = '该来源特有的附加信息，字段见下。值为空的字段直接省略（不会是 null）；全部为空时整个 extra 不返回';
const TRUNCATE = '；已去除 HTML 标签并合并空白，超过 120 字时截断为前 120 字加 …';

/*
 * 每个来源的说明，键为路由 id（/api/hot/news 的三个 RSS 来源共用 news）：
 *   label      来源简称，用于 /api/hot/all 的合并说明
 *   source     data.source 的说明（省略时为"固定为 <id>"）
 *   listTitle  data.title 的说明
 *   items      data.items 的说明
 *   title      条目 title 的说明
 *   url/hot/desc  条目字段的 [type, desc]
 *   hotAll     /api/hot/all 里对 hot 含义的简述（该接口使用各来源的默认参数）
 *   extra      条目 extra 中的字段 [key, type, desc, opts?]；opts.inAll === false 表示 /api/hot/all 中不会出现
 */
export const DOCS = {
  weibo: {
    label: '微博',
    listTitle: '榜单名称，固定为「微博热搜」',
    items: '热搜条目，按微博热搜榜顺序排列，已过滤广告（商业推广）条目',
    title: '热搜话题词（不带 # 号）',
    url: ['string', '该话题的微博搜索页链接，格式 https://s.weibo.com/weibo?q=%23话题词%23'],
    hot: ['number|null', '热搜热度值，即微博热搜榜上显示的搜索量（上游 num，缺失时用 raw_hot）；两者都缺失时为 null'],
    hotAll: '搜索量',
    desc: ['string|null', '话题导语（上游 note）；note 为空或与话题词相同时为 null，大多数条目为 null'],
    extra: [
      ['label', 'string', '热搜角标文字（上游 label_name，缺失时用 icon_desc），常见取值：新（新上榜）、热（热门）、沸（热度很高）、爆（热度极高），另有 暖（暖心话题）、荐（推荐）等；无角标时不返回'],
      ['category', 'string', '话题分类（上游 category，缺失时用 flag_desc），中文原文，如 社会、科技；无分类时不返回'],
    ],
  },
  zhihu: {
    label: '知乎',
    listTitle: '榜单名称，固定为「知乎热榜」',
    items: '热榜问题，按知乎热榜顺序排列，最多 50 条',
    title: '问题标题',
    url: ['string|null', '问题页面链接，格式 https://www.zhihu.com/question/问题ID；非问题类条目为上游给出的原始链接（可能是 api.zhihu.com 的接口地址）；都没有时为 null'],
    hot: ['number|null', '知乎热度（知乎按浏览、互动等综合计算），由热榜上显示的文字换算成数字，如「1520 万热度」→ 15200000；无法识别时为 null'],
    hotAll: '热度（「万热度」换算成的数字）',
    desc: ['string|null', '问题摘要；没有摘要时为 null'],
    extra: [
      ['answers', 'number', '回答数；上游未提供时不返回'],
      ['followers', 'number', '关注者数；上游未提供时不返回'],
      ['cover', 'string', '配图链接（热榜上首条回答的缩略图或问题配图）；没有配图时不返回'],
    ],
  },
  bilibili: {
    label: 'B 站',
    listTitle: '榜单名称：type=popular 时为「B 站综合热门」，type=rank 时为「B 站排行榜」',
    items: '视频列表，按榜单顺序排列；type=popular 取综合热门第一页（最多 50 条），type=rank 为全站排行榜（上游通常返回 100 条）',
    title: '视频标题',
    url: ['string|null', '视频页链接 https://www.bilibili.com/video/BV号；没有 BV 号时为 b23.tv 短链；都没有时为 null'],
    hot: ['number|null', '视频播放量（上游 stat.view）；缺失时为 null'],
    hotAll: '播放量',
    desc: ['string|null', '推荐理由（上游 rcmd_reason，如「百万播放」，一般只有 type=popular 有），没有推荐理由时为视频简介，都为空时为 null；B 站对没写简介的视频可能返回「-」'],
    extra: [
      ['bvid', 'string', '视频 BV 号，如 BV1xx411c7aa'],
      ['author', 'string', 'UP 主昵称'],
      ['cover', 'string', '视频封面图链接（上游多为 http:// 开头）'],
      ['like', 'number', '点赞数'],
      ['danmaku', 'number', '弹幕数'],
      ['score', 'number', '排行榜综合得分，仅 type=rank 且上游提供时返回', { inAll: false }],
    ],
  },
  douyin: {
    label: '抖音',
    listTitle: '榜单名称，固定为「抖音热点」',
    items: '热点条目，按抖音热点榜顺序排列',
    title: '热点词',
    url: ['string', '热点详情页链接 https://www.douyin.com/hot/热点ID；没有热点 ID 时为该词的抖音搜索页链接'],
    hot: ['number|null', '抖音热度值（上游 hot_value，即热点榜上显示的热度）；缺失时为 null'],
    hotAll: '热度值',
    desc: ['null', '抖音热点没有摘要，恒为 null'],
    extra: [
      ['cover', 'string', '热点封面图链接；上游没有封面时不返回'],
      ['videoCount', 'number', '该热点下的相关视频数（上游 video_count）'],
      ['eventTime', 'string', `热点事件时间（上游 event_time），${TIME}`],
    ],
  },
  baidu: {
    label: '百度',
    listTitle: '榜单名称，固定为「百度热搜」',
    items: '热搜条目：置顶条目在最前（也占用排名），其余按百度实时热搜榜顺序排列',
    title: '热搜词',
    url: ['string', '百度搜索结果页链接（上游 rawUrl，其次 url；都为空时按热搜词拼成 https://www.baidu.com/s?wd=热搜词）'],
    hot: ['number|null', '百度热搜指数（上游 hotScore）；缺失时为 null'],
    hotAll: '热搜指数',
    desc: ['string|null', '热搜事件摘要；没有摘要时为 null'],
    extra: [
      ['cover', 'string', '配图链接；没有配图时不返回'],
      ['top', 'boolean', '是否置顶：置顶条目恒为 true；非置顶条目不返回此字段'],
      ['tag', 'string', '热度标签（由上游 hotTag 1/3/4 转换），取值：新（新上榜）、热（热门）、沸（热度很高）；无标签或为其他值时不返回'],
    ],
  },
  toutiao: {
    label: '今日头条',
    listTitle: '榜单名称，固定为「今日头条热榜」',
    items: '热点事件，按今日头条热榜顺序排列（不含置顶新闻）',
    title: '热点事件标题',
    url: ['string|null', '头条热点聚合页链接 https://www.toutiao.com/trending/事件ID/；没有事件 ID 时为上游 Url；都没有时为 null'],
    hot: ['number|null', '今日头条热度值（上游 HotValue）；缺失时为 null'],
    hotAll: '热度值',
    desc: ['null', '今日头条热榜没有摘要，恒为 null'],
    extra: [
      ['label', 'string', '热点标签文字（上游 LabelDesc），如 热、新；无标签时不返回'],
      ['cover', 'string', '配图链接；没有配图时不返回'],
      ['category', 'string', '兴趣分类，上游 InterestCategory 的英文代码，多个用英文逗号连接，如 society、sports 或 society,entertainment；无分类时不返回'],
    ],
  },
  github: {
    label: 'GitHub',
    listTitle: '榜单名称：未传 language 时为「GitHub Trending」，传了时为「GitHub Trending · 语言」（语言为请求参数 language 的原文）',
    items: '趋势仓库，按 GitHub Trending 页面顺序排列；该周期没有趋势仓库时为空数组',
    title: '仓库全名，格式 owner/repo',
    url: ['string', '仓库链接 https://github.com/owner/repo'],
    hot: ['number|null', '所选周期内新增的星数：since=daily 为今日、weekly 为本周、monthly 为本月，与 extra.starsInPeriod 相同；页面上没有该数字时为 null'],
    hotAll: '今日新增星数',
    desc: ['string|null', '仓库描述；仓库没有描述时为 null'],
    extra: [
      ['owner', 'string', '仓库所有者（用户名或组织名）'],
      ['repo', 'string', '仓库名'],
      ['language', 'string', '主要编程语言，如 TypeScript、C++；GitHub 未标注语言时不返回'],
      ['stars', 'number', '仓库总星数'],
      ['forks', 'number', '仓库 fork 数'],
      ['starsInPeriod', 'number', '所选周期内新增的星数，同 hot；页面上没有时不返回'],
    ],
  },
  v2ex: {
    label: 'V2EX',
    listTitle: '榜单名称，固定为「V2EX 热门」',
    items: 'V2EX 最热主题（官方 API topics/hot.json），按上游顺序排列',
    title: '主题标题',
    url: ['string', '主题链接 https://www.v2ex.com/t/主题ID'],
    hot: ['number|null', '主题回复数（上游 replies），与 extra.replies 相同'],
    hotAll: '回复数',
    desc: ['string|null', '主题正文的纯文本；正文为空时为 null'],
    extra: [
      ['node', 'string', '所属节点的中文名，如 程序员、问与答'],
      ['author', 'string', '楼主用户名'],
      ['replies', 'number', '回复数，同 hot'],
    ],
  },
  news: {
    label: 'IT之家/36氪/少数派',
    source: `来源 id，与请求参数 source 相同，取值：${Object.entries(NEWS_FEEDS).map(([id, f]) => `${id}（${f.title}）`).join('、')}`,
    listTitle: `来源名称：${Object.values(NEWS_FEEDS).map((f) => f.title).join('、')} 之一`,
    items: '最新文章，按 RSS 中的顺序排列（通常最新的在前）',
    title: '文章标题（已去除 HTML 标签并解码实体）',
    url: ['string|null', '文章链接（RSS 的 link，没有时退回 guid / id）；都没有时为 null'],
    hot: ['null', 'RSS 没有热度数据，恒为 null'],
    hotAll: '恒为 null（RSS 没有热度数据）',
    desc: ['string|null', '文章摘要，取 RSS 的 description / summary / 正文；没有时为 null'],
    extra: [
      ['author', 'string', '作者（RSS 的 dc:creator 或 author）；RSS 未提供时不返回'],
      ['time', 'string', `发布时间，${TIME}；RSS 未提供或无法解析时不返回`],
    ],
  },
  hackernews: {
    label: 'Hacker News',
    listTitle: '榜单名称，固定为「Hacker News」',
    items: '首页热门帖子，按 HN 首页排名排列，最多 30 条（已去掉已删除、失效或获取失败的帖子；官方 API 失败改用 Algolia 时顺序可能与首页略有不同）',
    title: '帖子标题（英文原文）',
    url: ['string', '帖子指向的外部链接；Ask HN 等没有外链的帖子为 HN 讨论页链接'],
    hot: ['number|null', '帖子得分（points，即 HN 用户的投票数）'],
    hotAll: '得分（投票数）',
    desc: ['string|null', '帖子正文，仅 Ask HN 等文字帖有；普通链接帖为 null'],
    extra: [
      ['by', 'string', '发帖人用户名'],
      ['comments', 'number', '评论总数（含所有楼层的回复）；招聘帖等不能评论的条目不返回'],
      ['discussUrl', 'string', 'HN 讨论页链接 https://news.ycombinator.com/item?id=帖子ID'],
      ['time', 'string', `发帖时间，${TIME}`],
    ],
  },
};

// 热榜来源 id -> DOCS 的键
const docOf = (id) => DOCS[NEWS_FEEDS[id] ? 'news' : id];

const withTruncate = ([type, desc]) => [type, type.includes('string') ? desc + TRUNCATE : desc];

function itemFields(prefix, doc) {
  const p = `${prefix}[]`;
  return [
    field(prefix, 'array', doc.items),
    field(`${p}.rank`, 'number', RANK),
    field(`${p}.title`, 'string', doc.title),
    field(`${p}.url`, ...doc.url),
    field(`${p}.hot`, ...doc.hot),
    field(`${p}.desc`, ...withTruncate(doc.desc)),
    field(`${p}.extra`, 'object', EXTRA),
    ...doc.extra.map(([key, type, desc]) => field(`${p}.extra.${key}`, type, desc)),
  ];
}

// 单来源路由 /api/hot/<id> 的 fields，data 为 { source, title, items }
export function sourceFields(id) {
  const doc = DOCS[id];
  return [
    field('source', 'string', doc.source ?? `来源 id，固定为 ${id}`),
    field('title', 'string', doc.listTitle),
    ...itemFields('items', doc),
  ];
}

const SOURCE_LIST = SOURCE_IDS.map((id) => `${id}（${SOURCES[id].title}）`).join('、');

// /api/hot/all 的 fields：条目字段为各来源的合并说明
export function allFields() {
  const docs = [...new Set(SOURCE_IDS.map(docOf))];
  const extras = new Map();
  for (const d of docs) {
    for (const [key, type, desc, opts] of d.extra) {
      if (opts?.inAll === false) continue;
      const e = extras.get(key) ?? { types: new Set(), parts: [] };
      for (const t of type.split('|')) e.types.add(t);
      e.parts.push(`${d.label}：${desc}`);
      extras.set(key, e);
    }
  }
  const labels = (pred) => docs.filter(pred).map((d) => d.label).join('、');
  const p = 'sources[].items[]';
  return [
    field('sources', 'array', '获取成功的来源，按请求参数 sources 的顺序排列；失败的来源不在此列，见 errors。B 站固定取综合热门，GitHub 固定取今日全部语言'),
    field('sources[].source', 'string', `来源 id，取值：${SOURCE_LIST}`),
    field('sources[].title', 'string', '榜单名称，如 微博热搜、B 站综合热门、GitHub Trending、IT之家'),
    field('sources[].items', 'array', '该来源的热榜条目，最多 limit 条（默认 10）；条目结构与对应的单来源接口相同'),
    field(`${p}.rank`, 'number', RANK),
    field(`${p}.title`, 'string', `条目标题。${docs.map((d) => `${d.label}：${d.title}`).join('；')}`),
    field(`${p}.url`, 'string|null', `条目链接（话题搜索页、问题页、视频页、仓库页、文章页等，格式见对应单来源接口）；${labels((d) => d.url[0].includes('null'))}在上游没有给出链接时为 null`),
    field(`${p}.hot`, 'number|null', `热度值，含义因来源而异。${docs.map((d) => `${d.label}：${d.hotAll}`).join('；')}；上游缺失时为 null`),
    field(`${p}.desc`, 'string|null', `摘要或简介，没有时为 null（${labels((d) => d.desc[0] === 'null')}恒为 null）${TRUNCATE}`),
    field(`${p}.extra`, 'object', `${EXTRA}。不同来源的字段不同，下列字段说明中标注了所属来源`),
    ...[...extras].map(([key, e]) => field(`${p}.extra.${key}`, [...e.types].join('|'), e.parts.join('。'))),
    field('sources[].cached', 'boolean', '该来源是否取自服务端缓存（热榜缓存 5 分钟）'),
    field('sources[].stale', 'boolean', '是否为过期的旧数据：上游获取失败时返回最近一次成功获取的数据，此时为 true'),
    field('sources[].updatedAt', 'string', `该来源数据从上游获取的时间，${TIME}`),
    field('errors', 'array', '获取失败的来源，全部成功时为空数组（所有来源都失败时接口直接返回 502）'),
    field('errors[].source', 'string', '失败的来源 id'),
    field('errors[].title', 'string', '失败的来源名称，如 百度热搜'),
    field('errors[].message', 'string', '失败原因（中文），如「无法连接上游服务」「上游服务响应超时」「上游返回 HTTP 500」「微博返回的数据格式无法识别」'),
  ];
}

// /api/hot/sources 的 fields，data 为数组
export const SOURCES_FIELDS = [
  field('[].id', 'string', `来源 id，可用于 /api/hot/all 的 sources 参数（ithome、36kr、sspai 也是 /api/hot/news 的 source 参数）。取值：${SOURCE_LIST}`),
  field('[].title', 'string', '来源名称，如 微博热搜'),
];

import { HttpError, param } from '../../lib/http.js';
import { COUNT_PARAM, readCount, pickItems } from './pool.js';
import { lazy, readDataJSON } from './lazy-json.js';

// 《唐诗三百首》《宋词三百首》（chinese-poetry，MIT，见 data/poetry/LICENSE），共 600 首，约 240KB，第一次用到时读入。
// 标题只保留正题；句中“(xx 一作：yy)”这类异文注释已抽到 notes（见 data/dict/build.js）
export const localPoems = lazy(() => readDataJSON('poetry/poems.json').map((p) => ({ ...p, content: p.paragraphs.join('\n') })));

export const DYNASTIES = ['唐', '宋'];
export const POEM_TYPES = ['五言绝句', '七言绝句', '五言律诗', '七言律诗', '五言古诗', '七言古诗', '乐府', '词'];
export const MAX_PAGE_SIZE = 50;

const format = ({ id, title, author, dynasty, type, content, paragraphs, notes }) => ({
  id, title, author, dynasty, type, content, paragraphs: [...paragraphs], notes: [...notes],
});
const squeeze = (s) => (s == null ? null : s.replace(/\s+/g, '') || null);

// keyword 匹配标题、作者和正文；author 须与作者完全一致；dynasty、type 为精确筛选
export function filterPoems({ keyword = null, author = null, dynasty = null, type = null } = {}) {
  const kw = squeeze(keyword);
  const who = squeeze(author);
  if (dynasty && !DYNASTIES.includes(dynasty)) throw new HttpError(400, `dynasty 只能是 ${DYNASTIES.join(' / ')}`);
  if (type && !POEM_TYPES.includes(type)) throw new HttpError(400, `type 只能是 ${POEM_TYPES.join(' / ')}`);
  const list = localPoems().filter((p) => (!dynasty || p.dynasty === dynasty)
    && (!type || p.type === type)
    && (!who || p.author === who)
    && (!kw || p.title.includes(kw) || p.author.includes(kw) || p.paragraphs.some((line) => line.includes(kw))));
  return { filters: { keyword: kw, author: who, dynasty: dynasty || null, type: type || null }, list };
}

export function searchPoems({ page = 1, size = 10, ...filters } = {}) {
  const { filters: f, list } = filterPoems(filters);
  const items = list.slice((page - 1) * size, page * size).map(format);
  return { ...f, total: list.length, page, size, count: items.length, items };
}

export function randomPoems({ count = 1, rand = Math.random, ...filters } = {}) {
  const { filters: f, list } = filterPoems(filters);
  const items = pickItems(list, count, rand).map(format);
  return { ...f, matched: list.length, count: items.length, items };
}

const FILTER_PARAMS = [
  { name: 'author', required: false, desc: '作者，须完整匹配，如“李白”“苏轼”', example: '李白' },
  { name: 'dynasty', required: false, desc: `朝代：${DYNASTIES.join(' / ')}（唐=唐诗三百首，宋=宋词三百首）`, example: '唐' },
  { name: 'type', required: false, desc: `体裁：${POEM_TYPES.join(' / ')}`, example: '七言绝句' },
];
const readFilters = (query) => ({
  keyword: param(query, 'keyword', { max: 20 }) ?? null,
  author: param(query, 'author', { max: 20 }) ?? null,
  dynasty: param(query, 'dynasty', { oneOf: DYNASTIES }) ?? null,
  type: param(query, 'type', { oneOf: POEM_TYPES }) ?? null,
});

const POEM_FIELDS = [
  { name: 'items[].id', type: 'string', desc: '诗词编号，如“tang-11”“song-39”，固定不变' },
  { name: 'items[].title', type: 'string', desc: '标题；宋词为词牌名（部分带题目，如“水调歌头”）' },
  { name: 'items[].author', type: 'string', desc: '作者' },
  { name: 'items[].dynasty', type: 'string', desc: '朝代：唐 或 宋' },
  { name: 'items[].type', type: 'string', desc: `体裁：${POEM_TYPES.join(' / ')}` },
  { name: 'items[].content', type: 'string', desc: '全文，按句换行（\\n）' },
  { name: 'items[].paragraphs', type: 'array', desc: '按句拆分的正文，元素为字符串' },
  { name: 'items[].notes', type: 'array', desc: '异文与通假注释，如“明年 一作：年年”；没有时为空数组' },
];
const FILTER_FIELDS = [
  { name: 'keyword', type: 'string|null', desc: '实际使用的关键字（已去掉空白）；未传时为 null' },
  { name: 'author', type: 'string|null', desc: '作者筛选；未传时为 null' },
  { name: 'dynasty', type: 'string|null', desc: '朝代筛选；未传时为 null' },
  { name: 'type', type: 'string|null', desc: '体裁筛选；未传时为 null' },
];

export default {
  name: 'poetry',
  category: 'fun',
  title: '古诗词库',
  description: '《唐诗三百首》《宋词三百首》全文，共 600 首，可按关键词、作者、朝代、体裁检索或随机抽取；本地数据，不依赖上游',
  source: '开源数据 chinese-poetry（MIT），唐诗已转为简体',
  routes: [
    {
      method: 'GET',
      path: '/api/poem/search',
      summary: '检索诗词全文（按关键词、作者、朝代、体裁），分页返回',
      params: [
        { name: 'keyword', required: false, desc: '关键词，匹配标题、作者和诗句；都不传则按顺序列出全部', example: '明月' },
        ...FILTER_PARAMS,
        { name: 'page', required: false, default: '1', desc: '页码，从 1 开始', example: '1' },
        { name: 'size', required: false, default: '10', desc: `每页条数，1~${MAX_PAGE_SIZE}`, example: '5' },
      ],
      fields: [
        ...FILTER_FIELDS,
        { name: 'total', type: 'number', desc: '符合条件的诗词总数；为 0 时 items 为空' },
        { name: 'page', type: 'number', desc: '当前页码' },
        { name: 'size', type: 'number', desc: '每页条数' },
        { name: 'count', type: 'number', desc: '本页实际条数，等于 items 的长度' },
        { name: 'items', type: 'array', desc: '本页诗词，按唐诗在前、宋词在后的固定顺序' },
        ...POEM_FIELDS,
      ],
      async handler({ query }) {
        const page = param(query, 'page', { default: 1, int: true, min: 1, max: 1000 });
        const size = param(query, 'size', { default: 10, int: true, min: 1, max: MAX_PAGE_SIZE });
        return { data: searchPoems({ ...readFilters(query), page, size }) };
      },
    },
    {
      method: 'GET',
      path: '/api/poem/random',
      summary: '随机诗词全文，可按关键词、作者、朝代、体裁限定范围',
      params: [
        { name: 'keyword', required: false, desc: '关键词，匹配标题、作者和诗句；不传则不限', example: '月' },
        ...FILTER_PARAMS,
        COUNT_PARAM,
      ],
      fields: [
        ...FILTER_FIELDS,
        { name: 'matched', type: 'number', desc: '符合条件的诗词总数；为 0 时 items 为空' },
        { name: 'count', type: 'number', desc: '实际返回的首数，等于 items 的长度（可能少于请求的 count）' },
        { name: 'items', type: 'array', desc: '随机抽取的诗词，互不重复' },
        ...POEM_FIELDS,
      ],
      async handler({ query }) {
        return { data: randomPoems({ ...readFilters(query), count: readCount(query) }) };
      },
    },
  ],
};

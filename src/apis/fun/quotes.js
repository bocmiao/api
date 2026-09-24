import { HttpError, param } from '../../lib/http.js';
import { QUOTE_TYPES } from './data/quotes.js';
import { sample } from './seeded.js';

export const QUOTE_TYPE_IDS = QUOTE_TYPES.map((t) => t.id);

const ALL = QUOTE_TYPES.flatMap((t) => t.items.map((content) => ({ type: t.id, typeName: t.name, content })));

export function pickQuotes(type = null, count = 1, rand = Math.random) {
  let pool = ALL;
  if (type != null) {
    if (!QUOTE_TYPE_IDS.includes(type)) throw new HttpError(400, `type 只能是 ${QUOTE_TYPE_IDS.join(' / ')}`);
    pool = ALL.filter((q) => q.type === type);
  }
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new HttpError(400, 'count 须为 1~10 之间的整数');
  const items = sample(pool, count, rand).map((q) => ({ ...q }));
  return { type, count: items.length, items };
}

export const quoteTypes = () => QUOTE_TYPES.map((t) => ({ id: t.id, name: t.name, desc: t.desc, count: t.items.length }));

const typeList = QUOTE_TYPES.map((t) => `${t.id}=${t.name}`).join('，');

export default {
  name: 'quotes',
  category: 'fun',
  title: '语录合集',
  description: '毒鸡汤、舔狗日记、情话、KFC 疯狂星期四、丧系幽默、神回复、人生建议、励志、温柔文案、伤感等分类语录，全部原创',
  source: '本地内置（原创语录库）',
  routes: [
    {
      method: 'GET',
      path: '/api/quotes',
      summary: '按分类随机取语录，一次 1~10 条',
      params: [
        { name: 'type', required: false, desc: `分类 id，不传则从全部分类中随机：${typeList}`, example: 'dujitang' },
        { name: 'count', required: false, default: '1', desc: '条数，1~10 的整数；同一次返回的语录不重复', example: '3' },
      ],
      fields: [
        { name: 'type', type: 'string|null', desc: '请求的分类 id；未传 type（从全部分类中随机）时为 null' },
        { name: 'count', type: 'number', desc: '实际返回的条数，等于 items 的长度' },
        { name: 'items', type: 'array', desc: '语录列表，随机顺序，互不重复' },
        { name: 'items[].type', type: 'string', desc: `该条语录所属分类 id：${typeList}` },
        { name: 'items[].typeName', type: 'string', desc: '所属分类中文名，如 毒鸡汤' },
        { name: 'items[].content', type: 'string', desc: '语录正文（神回复为“问：……答：……”格式）' },
      ],
      async handler({ query }) {
        const type = param(query, 'type', { oneOf: QUOTE_TYPE_IDS }) ?? null;
        const count = param(query, 'count', { default: 1, int: true, min: 1, max: 10 });
        return { data: pickQuotes(type, count), updatedAt: new Date().toISOString() };
      },
    },
    {
      method: 'GET',
      path: '/api/quotes/types',
      summary: '列出语录分类及条数',
      params: [],
      fields: [
        { name: '[].id', type: 'string', desc: '分类 id，用作 /api/quotes 的 type 参数' },
        { name: '[].name', type: 'string', desc: '分类中文名，如 KFC 疯狂星期四' },
        { name: '[].desc', type: 'string', desc: '分类简介' },
        { name: '[].count', type: 'number', desc: '该分类内置语录条数' },
      ],
      async handler() {
        return { data: quoteTypes() };
      },
    },
  ],
};

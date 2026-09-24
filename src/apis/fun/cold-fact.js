import { param } from '../../lib/http.js';
import { COLD_FACTS, COLD_FACT_TAGS } from './data/cold-facts.js';
import { COUNT_PARAM, readCount, withIds, pickItems } from './pool.js';

export const COLD_FACT_ITEMS = withIds(COLD_FACTS, ([content, tag]) => ({ content, tag }));

export function pickColdFacts({ tag = null, count = 1, rand = Math.random } = {}) {
  const pool = tag ? COLD_FACT_ITEMS.filter((x) => x.tag === tag) : COLD_FACT_ITEMS;
  const items = pickItems(pool, count, rand);
  return { tag, total: pool.length, count: items.length, items };
}

const tagList = COLD_FACT_TAGS.join(' / ');

export default {
  name: 'cold-fact',
  category: 'fun',
  title: '冷知识',
  description: `随机一条冷知识（${tagList}），每条都经过核对，只收录有可靠依据的知识；内置 ${COLD_FACTS.length} 条`,
  source: '本地内置（本站整理并核对）',
  routes: [
    {
      method: 'GET',
      path: '/api/cold-fact',
      summary: '随机冷知识，可按分类筛选',
      params: [
        COUNT_PARAM,
        { name: 'tag', required: false, desc: `分类：${tagList}；不传则从全部分类中随机`, example: '宇宙' },
      ],
      fields: [
        { name: 'tag', type: 'string|null', desc: '请求的分类；未传时为 null' },
        { name: 'total', type: 'number', desc: '该分类（未传 tag 时为全部）的冷知识条数' },
        { name: 'count', type: 'number', desc: '实际返回的条数，等于 items 的长度' },
        { name: 'items', type: 'array', desc: '冷知识列表，随机顺序，互不重复' },
        { name: 'items[].id', type: 'number', desc: '编号（固定不变）' },
        { name: 'items[].content', type: 'string', desc: '冷知识正文' },
        { name: 'items[].tag', type: 'string', desc: `所属分类：${tagList}` },
      ],
      async handler({ query }) {
        const tag = param(query, 'tag', { oneOf: COLD_FACT_TAGS }) ?? null;
        const count = readCount(query);
        return { data: pickColdFacts({ tag, count }) };
      },
    },
  ],
};

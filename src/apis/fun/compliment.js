import { COMPLIMENTS } from './data/compliments.js';
import { COUNT_PARAM, readCount, withIds, pickItems } from './pool.js';

export const COMPLIMENT_ITEMS = withIds(COMPLIMENTS, (content) => ({ content }));

export function pickCompliments({ count = 1, rand = Math.random } = {}) {
  const items = pickItems(COMPLIMENT_ITEMS, count, rand);
  return { total: COMPLIMENT_ITEMS.length, count: items.length, items };
}

export default {
  name: 'compliment',
  category: 'fun',
  title: '彩虹屁',
  description: `随机一句夸人的话（彩虹屁），全部原创、健康向，只夸品格、能力和相处感受；内置 ${COMPLIMENTS.length} 条`,
  source: '本地内置（原创）',
  routes: [
    {
      method: 'GET',
      path: '/api/compliment',
      summary: '随机彩虹屁',
      params: [COUNT_PARAM],
      fields: [
        { name: 'total', type: 'number', desc: '库中总条数' },
        { name: 'count', type: 'number', desc: '实际返回的条数，等于 items 的长度' },
        { name: 'items', type: 'array', desc: '列表，随机顺序，互不重复' },
        { name: 'items[].id', type: 'number', desc: '编号（固定不变）' },
        { name: 'items[].content', type: 'string', desc: '夸人的话' },
      ],
      async handler({ query }) {
        return { data: pickCompliments({ count: readCount(query) }) };
      },
    },
  ],
};

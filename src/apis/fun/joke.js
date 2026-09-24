import { JOKES } from './data/jokes.js';
import { COUNT_PARAM, readCount, withIds, pickItems } from './pool.js';

export const JOKE_ITEMS = withIds(JOKES, (content) => ({ content }));

export function pickJokes({ count = 1, rand = Math.random } = {}) {
  const items = pickItems(JOKE_ITEMS, count, rand);
  return { total: JOKE_ITEMS.length, count: items.length, items };
}

export default {
  name: 'joke',
  category: 'fun',
  title: '笑话',
  description: `随机一条轻松的生活、职场、校园小笑话，全部原创、健康向，不涉及地域和人群歧视；内置 ${JOKES.length} 条`,
  source: '本地内置（原创）',
  routes: [
    {
      method: 'GET',
      path: '/api/joke',
      summary: '随机笑话',
      params: [COUNT_PARAM],
      fields: [
        { name: 'total', type: 'number', desc: '库中总条数' },
        { name: 'count', type: 'number', desc: '实际返回的条数，等于 items 的长度' },
        { name: 'items', type: 'array', desc: '列表，随机顺序，互不重复' },
        { name: 'items[].id', type: 'number', desc: '编号（固定不变）' },
        { name: 'items[].content', type: 'string', desc: '笑话正文' },
      ],
      async handler({ query }) {
        return { data: pickJokes({ count: readCount(query) }) };
      },
    },
  ],
};

import { HttpError, param } from '../../lib/http.js';
import { BRAIN_TEASERS } from './data/brain-teasers.js';
import { COUNT_PARAM, readCount, withIds, pickItems } from './pool.js';

export const TEASER_ITEMS = withIds(BRAIN_TEASERS, ([question, answer]) => ({ question, answer }));

export function pickTeasers({ count = 1, hide = false, rand = Math.random } = {}) {
  const items = pickItems(TEASER_ITEMS, count, rand).map((x) => (hide ? { id: x.id, question: x.question } : x));
  return { total: TEASER_ITEMS.length, hidden: hide, count: items.length, items };
}

export function teaserAnswer(id) {
  const item = TEASER_ITEMS[id - 1];
  if (!item) throw new HttpError(404, `没有编号为 ${id} 的脑筋急转弯（编号范围 1~${TEASER_ITEMS.length}）`);
  return { ...item };
}

export default {
  name: 'brain-teaser',
  category: 'fun',
  title: '脑筋急转弯',
  description: `随机出一道脑筋急转弯，可以先隐藏答案、再按编号揭晓；内置 ${BRAIN_TEASERS.length} 道`,
  source: '本地内置（经典脑筋急转弯 + 本站整理）',
  routes: [
    {
      method: 'GET',
      path: '/api/brain-teaser',
      summary: '随机脑筋急转弯（可隐藏答案）',
      params: [
        COUNT_PARAM,
        { name: 'hide', required: false, default: '0', desc: '传 1 时不返回答案，只返回编号和题目，之后用 /api/brain-teaser/answer?id= 查答案', example: '1' },
      ],
      fields: [
        { name: 'total', type: 'number', desc: '题库总题数' },
        { name: 'hidden', type: 'boolean', desc: '是否隐藏了答案（hide=1 时为 true）' },
        { name: 'count', type: 'number', desc: '实际返回的题数，等于 items 的长度' },
        { name: 'items', type: 'array', desc: '题目列表，随机顺序，互不重复' },
        { name: 'items[].id', type: 'number', desc: '题目编号（固定不变），用于查询答案' },
        { name: 'items[].question', type: 'string', desc: '题目' },
        { name: 'items[].answer', type: 'string', desc: '答案，谐音、双关在括号里说明；hide=1 时不返回此字段' },
      ],
      async handler({ query }) {
        const count = readCount(query);
        const hide = param(query, 'hide', { default: '0', oneOf: ['0', '1'] }) === '1';
        return { data: pickTeasers({ count, hide }) };
      },
    },
    {
      method: 'GET',
      path: '/api/brain-teaser/answer',
      summary: '按编号查脑筋急转弯的答案',
      params: [
        { name: 'id', required: true, desc: '题目编号，来自 /api/brain-teaser 返回的 items[].id', example: '7' },
      ],
      fields: [
        { name: 'id', type: 'number', desc: '题目编号' },
        { name: 'question', type: 'string', desc: '题目' },
        { name: 'answer', type: 'string', desc: '答案' },
      ],
      async handler({ query }) {
        const id = param(query, 'id', { required: true, int: true, min: 1, max: 100000 });
        return { data: teaserAnswer(id) };
      },
    },
  ],
};

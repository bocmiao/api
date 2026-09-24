import { param } from '../../lib/http.js';
import { XIEHOUYU } from './data/xiehouyu.js';
import { COUNT_PARAM, readCount, withIds, pickItems } from './pool.js';

export const XIEHOUYU_ITEMS = withIds(XIEHOUYU, ([riddle, answer]) => ({ riddle, answer, text: `${riddle}——${answer}` }));

// keyword 同时匹配谜面和谜底（忽略空白）；没有匹配时 items 为空数组
export function pickXiehouyu({ keyword = null, count = 1, rand = Math.random } = {}) {
  const kw = keyword?.replace(/\s+/g, '') || null;
  const pool = kw ? XIEHOUYU_ITEMS.filter((x) => x.riddle.includes(kw) || x.answer.includes(kw)) : XIEHOUYU_ITEMS;
  const items = pickItems(pool, count, rand);
  return { keyword: kw, matched: pool.length, count: items.length, items };
}

export default {
  name: 'xiehouyu',
  category: 'fun',
  title: '歇后语',
  description: `随机返回歇后语（谜面 + 谜底），可按关键字搜索；内置 ${XIEHOUYU.length} 条民间传统歇后语`,
  source: '本地内置（民间传统歇后语）',
  routes: [
    {
      method: 'GET',
      path: '/api/xiehouyu',
      summary: '随机歇后语，可按关键字搜索',
      params: [
        { name: 'keyword', required: false, desc: '关键字，同时匹配谜面和谜底；不传则从全部歇后语中随机', example: '猪八戒' },
        COUNT_PARAM,
      ],
      fields: [
        { name: 'keyword', type: 'string|null', desc: '实际使用的关键字（已去掉空白）；未传时为 null' },
        { name: 'matched', type: 'number', desc: '符合条件的歇后语总数（未传 keyword 时为全部条数）；为 0 时 items 为空' },
        { name: 'count', type: 'number', desc: '实际返回的条数，等于 items 的长度（可能少于请求的 count）' },
        { name: 'items', type: 'array', desc: '歇后语列表，随机顺序，互不重复' },
        { name: 'items[].id', type: 'number', desc: '歇后语编号（固定不变）' },
        { name: 'items[].riddle', type: 'string', desc: '谜面（前半句），如“外甥打灯笼”' },
        { name: 'items[].answer', type: 'string', desc: '谜底（后半句），谐音双关的在括号里注明本字，如“照舅（旧）”' },
        { name: 'items[].text', type: 'string', desc: '完整的一句，格式为“谜面——谜底”' },
      ],
      async handler({ query }) {
        const keyword = param(query, 'keyword', { max: 20 }) ?? null;
        const count = readCount(query);
        return { data: pickXiehouyu({ keyword, count }) };
      },
    },
  ],
};

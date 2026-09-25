import { param } from '../../lib/http.js';
import { XIEHOUYU } from './data/xiehouyu.js';
import { COUNT_PARAM, readCount, withIds, pickItems } from './pool.js';
import { lazy, readDataJSON } from './lazy-json.js';

const toItem = ([riddle, answer]) => ({ riddle, answer, text: `${riddle}——${answer}` });
export const XIEHOUYU_ITEMS = withIds(XIEHOUYU, toItem);

// 新华词典歇后语（chinese-xinhua，MIT，见 data/dict/LICENSE），已按 data/dict/blocklist.js 过滤掉歧视性条目、
// 去重并去掉与精校数据谜面相同的；第一次用 scope=all 时才读入。id 接在精校数据之后
export const xinhuaXiehouyu = lazy(() => readDataJSON('dict/xiehouyu.json').map((x, i) => ({ id: XIEHOUYU.length + i + 1, ...toItem(x) })));
const allItems = lazy(() => [...XIEHOUYU_ITEMS, ...xinhuaXiehouyu()]);

export const SCOPES = ['curated', 'all'];

// keyword 同时匹配谜面和谜底（忽略空白）；没有匹配时 items 为空数组
export function pickXiehouyu({ keyword = null, count = 1, scope = 'curated', rand = Math.random } = {}) {
  const kw = keyword?.replace(/\s+/g, '') || null;
  const base = scope === 'all' ? allItems() : XIEHOUYU_ITEMS;
  const pool = kw ? base.filter((x) => x.riddle.includes(kw) || x.answer.includes(kw)) : base;
  const items = pickItems(pool, count, rand);
  return { keyword: kw, scope, matched: pool.length, count: items.length, items };
}

export default {
  name: 'xiehouyu',
  category: 'fun',
  title: '歇后语',
  description: `随机返回歇后语（谜面 + 谜底），可按关键字搜索；内置 ${XIEHOUYU.length} 条人工筛选的民间传统歇后语，另可选用约 1.25 万条新华词典歇后语（已过滤歧视性内容）`,
  source: '本地内置（民间传统歇后语）+ 新华词典开源数据 chinese-xinhua（MIT）',
  routes: [
    {
      method: 'GET',
      path: '/api/xiehouyu',
      summary: '随机歇后语，可按关键字搜索',
      params: [
        { name: 'keyword', required: false, desc: '关键字，同时匹配谜面和谜底；不传则从全部歇后语中随机', example: '猪八戒' },
        {
          name: 'scope',
          required: false,
          default: 'curated',
          desc: `抽取范围：curated=人工筛选的 ${XIEHOUYU.length} 条；all=再加上新华词典歇后语（约 1.25 万条，已过滤拿残障、疾病、性别、地域、民族打趣的条目，未逐条人工校对）`,
          example: 'all',
        },
        COUNT_PARAM,
      ],
      fields: [
        { name: 'keyword', type: 'string|null', desc: '实际使用的关键字（已去掉空白）；未传时为 null' },
        { name: 'scope', type: 'string', desc: `实际使用的抽取范围：curated 或 all。编号 1~${XIEHOUYU.length} 为人工筛选数据，更大的编号来自新华词典` },
        { name: 'matched', type: 'number', desc: '符合条件的歇后语总数（未传 keyword 时为所选范围的全部条数）；为 0 时 items 为空' },
        { name: 'count', type: 'number', desc: '实际返回的条数，等于 items 的长度（可能少于请求的 count）' },
        { name: 'items', type: 'array', desc: '歇后语列表，随机顺序，互不重复' },
        { name: 'items[].id', type: 'number', desc: `歇后语编号（固定不变）；1~${XIEHOUYU.length} 为人工筛选数据，更大的来自新华词典` },
        { name: 'items[].riddle', type: 'string', desc: '谜面（前半句），如“外甥打灯笼”' },
        { name: 'items[].answer', type: 'string', desc: '谜底（后半句），谐音双关的在括号里注明本字，如“照舅（旧）”；新华词典数据有多种说法时用“；”分隔，括号里可能是谐音字（如“规定（龟腚）”）或释义' },
        { name: 'items[].text', type: 'string', desc: '完整的一句，格式为“谜面——谜底”' },
      ],
      async handler({ query }) {
        const keyword = param(query, 'keyword', { max: 20 }) ?? null;
        const scope = param(query, 'scope', { default: 'curated', oneOf: SCOPES });
        const count = readCount(query);
        return { data: pickXiehouyu({ keyword, count, scope }) };
      },
    },
  ],
};

import { HttpError, param } from '../../lib/http.js';
import { GARBAGE_CATEGORIES, GARBAGE_ITEMS, NOTES } from './data/garbage.js';

const CATEGORY = Object.fromEntries(GARBAGE_CATEGORIES.map((c) => [c.name, c]));

export const GARBAGE_INDEX = Object.entries(GARBAGE_ITEMS).flatMap(([category, names]) =>
  names.map((name) => ({ name, key: normalize(name), category })));

const MAX_MATCHES = 10;
const MAX_CANDIDATES = 5;
const RULE_TIP = '可以按规则判断：能回收再利用的→可回收物；对人体或环境有害的→有害垃圾；易腐烂的食物→厨余垃圾（湿垃圾）；其余→其他垃圾（干垃圾）';

// 去掉空白、统一大小写和全角字母数字，便于匹配“x光片”“Ｕ盘”这类写法
export function normalize(s) {
  return String(s ?? '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .toLowerCase();
}

function itemOf(entry) {
  const c = CATEGORY[entry.category];
  return { name: entry.name, category: c.name, alias: c.alias, color: c.color, note: NOTES[entry.name] ?? null };
}

// 模糊匹配：物品名包含查询词（查“电池”得到“干电池”“纽扣电池”），或查询词包含物品名（查“旧手机”得到“手机”）。
// 完全相同的排最前，其次按名称长度差从小到大。
export function matchGarbage(query) {
  const q = normalize(query);
  if (!q) return [];
  const scored = [];
  for (const e of GARBAGE_INDEX) {
    let score = null;
    if (e.key === q) score = 0;
    else if (e.key.includes(q)) score = 1 + (e.key.length - q.length);
    else if (e.key.length >= 2 && q.includes(e.key)) score = 1.5 + (q.length - e.key.length);
    if (score != null) scored.push([score, e]);
  }
  return scored.sort((a, b) => a[0] - b[0]).map(([, e]) => e);
}

// 查不到时的相近候选：与查询词共有的字越多越靠前
export function similarGarbage(query, limit = MAX_CANDIDATES) {
  const chars = [...new Set(normalize(query))];
  if (!chars.length) return [];
  return GARBAGE_INDEX
    .map((e) => [chars.filter((ch) => e.key.includes(ch)).length, e])
    .filter(([n]) => n > 0)
    .sort((a, b) => b[0] - a[0] || a[1].key.length - b[1].key.length)
    .slice(0, limit)
    .map(([, e]) => e.name);
}

export function lookupGarbage(query) {
  const matches = matchGarbage(query);
  if (!matches.length) {
    const candidates = similarGarbage(query);
    const err = new HttpError(404, candidates.length
      ? `没有找到「${query}」，相近的物品：${candidates.join('、')}`
      : `没有找到「${query}」，${RULE_TIP}`);
    err.candidates = candidates;
    throw err;
  }
  const items = matches.slice(0, MAX_MATCHES).map(itemOf);
  const best = items[0];
  const c = CATEGORY[best.category];
  return {
    query,
    exact: normalize(best.name) === normalize(query),
    name: best.name,
    category: c.name,
    alias: c.alias,
    color: c.color,
    guide: c.guide,
    note: best.note,
    ambiguous: new Set(items.map((i) => i.category)).size > 1,
    matches: items,
  };
}

const categoryList = GARBAGE_CATEGORIES.map((c) => `${c.name}（上海叫${c.alias}）`).join('、');

export default {
  name: 'garbage',
  category: 'life',
  title: '垃圾分类',
  description: `按物品名查询所属垃圾分类（${categoryList}），返回投放指南，支持模糊匹配；词库 ${GARBAGE_INDEX.length} 种常见物品`,
  source: '本地词库（按 GB/T 19095-2019 与上海市生活垃圾分类指引整理）',
  routes: [
    {
      method: 'GET',
      path: '/api/garbage',
      summary: '查询物品属于哪类垃圾及投放要求',
      params: [
        { name: 'name', required: true, desc: '物品名，支持模糊匹配：查“电池”会同时列出干电池、纽扣电池等；查不到返回 404 并在 message 中给出相近物品', example: '电池' },
      ],
      fields: [
        { name: 'query', type: 'string', desc: '查询的物品名（原样返回）' },
        { name: 'exact', type: 'boolean', desc: '最佳匹配是否与查询词完全相同；为 false 时是模糊匹配的结果，建议看 matches 确认' },
        { name: 'name', type: 'string', desc: '最佳匹配的物品名' },
        { name: 'category', type: 'string', desc: '最佳匹配所属分类（国家标准名称）：可回收物 / 有害垃圾 / 厨余垃圾 / 其他垃圾' },
        { name: 'alias', type: 'string', desc: '该分类在上海的叫法：可回收物 / 有害垃圾 / 湿垃圾 / 干垃圾' },
        { name: 'color', type: 'string', desc: '该分类的标志色（十六进制，如 #1E5AA8）' },
        { name: 'guide', type: 'string', desc: '该分类的投放指南' },
        { name: 'note', type: 'string|null', desc: '该物品的补充说明（地区差异、特殊投放要求）；没有时为 null' },
        { name: 'ambiguous', type: 'boolean', desc: '匹配到的物品是否分属不同分类（如查“电池”：干电池是其他垃圾，纽扣电池是有害垃圾），为 true 时请按具体物品判断' },
        { name: 'matches', type: 'array', desc: `全部匹配结果（最多 ${MAX_MATCHES} 条），完全相同的排最前，其次按名称接近程度排序；第一条即最佳匹配` },
        { name: 'matches[].name', type: 'string', desc: '物品名' },
        { name: 'matches[].category', type: 'string', desc: '所属分类（国家标准名称）' },
        { name: 'matches[].alias', type: 'string', desc: '所属分类在上海的叫法' },
        { name: 'matches[].color', type: 'string', desc: '所属分类的标志色' },
        { name: 'matches[].note', type: 'string|null', desc: '补充说明；没有时为 null' },
      ],
      async handler({ query }) {
        const name = param(query, 'name', { required: true, max: 30 }).trim();
        if (!name) throw new HttpError(400, '缺少参数 name');
        return { data: lookupGarbage(name) };
      },
    },
  ],
};

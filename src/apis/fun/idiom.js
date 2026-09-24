import { HttpError, param } from '../../lib/http.js';
import { IDIOMS } from './data/idioms.js';
import { pick } from './seeded.js';

export const IDIOM_ITEMS = IDIOMS.map(([word, pinyin, explanation, source, example], i) => ({
  id: i + 1, word, pinyin, explanation, source, example,
}));
const BY_WORD = new Map(IDIOM_ITEMS.map((x) => [x.word, x]));

const MAX_CANDIDATES = 5;
const HAN_RE = /^\p{Script=Han}{2,20}$/u;

// 去掉声调，ü 记作 v（避免“驴 lǘ”和“路 lù”混为一谈）
export const toneless = (s) => s.normalize('NFD').replace(/ü/g, 'v').replace(/[̀-ͯ]/g, '').toLowerCase();

const brief = (x) => ({ word: x.word, pinyin: x.pinyin, explanation: x.explanation });
const clean = (s) => String(s ?? '').replace(/\s+/g, '');

// 查不到时的候选：先是包含查询词的成语，再按与查询词共有的字数排序
export function similarIdioms(query, limit = MAX_CANDIDATES) {
  const q = clean(query);
  const chars = [...new Set(q)];
  return IDIOM_ITEMS
    .map((x) => [x.word.includes(q) ? 100 : chars.filter((ch) => x.word.includes(ch)).length, x])
    .filter(([n]) => n > 0)
    .sort((a, b) => b[0] - a[0] || a[1].id - b[1].id)
    .slice(0, limit)
    .map(([, x]) => x.word);
}

export function lookupIdiom(word = null, rand = Math.random) {
  if (word == null) return { ...pick(IDIOM_ITEMS, rand), random: true };
  const q = clean(word);
  const hit = BY_WORD.get(q);
  if (hit) return { ...hit, random: false };
  const candidates = similarIdioms(q);
  const err = new HttpError(404, candidates.length
    ? `词库里没有「${q}」，相近的成语：${candidates.join('、')}`
    : `词库里没有「${q}」`);
  err.candidates = candidates;
  throw err;
}

// 成语接龙：返回首字与 word 尾字相同的成语；word 在词库里时，另外给出首字与尾字同音（不计声调）的成语
export function idiomChain(word) {
  const q = clean(word);
  if (!HAN_RE.test(q)) throw new HttpError(400, 'word 须为 2~20 个汉字');
  const tail = q.at(-1);
  const known = BY_WORD.get(q) ?? null;
  const tailPinyin = known ? known.pinyin.split(' ').at(-1) : null;
  const items = IDIOM_ITEMS.filter((x) => x.word[0] === tail && x.word !== q).map(brief);
  const homophones = tailPinyin
    ? IDIOM_ITEMS
      .filter((x) => x.word[0] !== tail && x.word !== q && toneless(x.pinyin.split(' ')[0]) === toneless(tailPinyin))
      .map(brief)
    : [];
  return { word: q, known: Boolean(known), tail, tailPinyin, count: items.length, items, homophones };
}

export default {
  name: 'idiom',
  category: 'fun',
  title: '成语词典',
  description: `查询成语的拼音、释义、出处和例句，不传参数随机一条；支持成语接龙。内置 ${IDIOMS.length} 条常用成语`,
  source: '本地内置（常用成语词库，例句为本站原创）',
  routes: [
    {
      method: 'GET',
      path: '/api/idiom',
      summary: '查询成语（不传 word 时随机一条）',
      params: [
        { name: 'word', required: false, desc: '要查的成语（需完整匹配）；不传则随机返回一条。查不到返回 404，并在 message 中给出相近的成语', example: '画龙点睛' },
      ],
      fields: [
        { name: 'id', type: 'number', desc: '成语在词库中的编号' },
        { name: 'word', type: 'string', desc: '成语' },
        { name: 'pinyin', type: 'string', desc: '带声调的拼音，每字一个音节、空格分隔；按词典惯例标原调（“一”“不”不标变调）' },
        { name: 'explanation', type: 'string', desc: '释义' },
        { name: 'source', type: 'string|null', desc: '出处，如“《史记·项羽本纪》”；写“典出”的表示成语由该处文字或故事概括而来；出处无法确认时为 null' },
        { name: 'example', type: 'string', desc: '例句（本站原创）' },
        { name: 'random', type: 'boolean', desc: '是否为随机返回（未传 word 时为 true）' },
      ],
      async handler({ query }) {
        const word = param(query, 'word', { max: 20 }) ?? null;
        return { data: lookupIdiom(word && clean(word) ? word : null) };
      },
    },
    {
      method: 'GET',
      path: '/api/idiom/chain',
      summary: '成语接龙：找首字与给定成语尾字相同的成语',
      params: [
        { name: 'word', required: true, desc: '上一个成语（2~20 个汉字，不必在词库中），取它的最后一个字来接龙', example: '一鸣惊人' },
      ],
      fields: [
        { name: 'word', type: 'string', desc: '传入的成语（已去掉空白）' },
        { name: 'known', type: 'boolean', desc: '传入的成语是否在词库中；在词库中时才能给出尾字读音和同音接龙' },
        { name: 'tail', type: 'string', desc: '用来接龙的尾字' },
        { name: 'tailPinyin', type: 'string|null', desc: '尾字在该成语中的读音（带声调）；成语不在词库中时为 null' },
        { name: 'count', type: 'number', desc: '同字接龙的成语数，等于 items 的长度；为 0 表示词库里接不上' },
        { name: 'items', type: 'array', desc: '首字与尾字相同的成语（按词库顺序，不含传入的成语本身）' },
        { name: 'items[].word', type: 'string', desc: '成语' },
        { name: 'items[].pinyin', type: 'string', desc: '带声调的拼音' },
        { name: 'items[].explanation', type: 'string', desc: '释义' },
        { name: 'homophones', type: 'array', desc: '首字与尾字同音（不计声调）但不同字的成语，作为同音接龙的备选；成语不在词库中时为空数组' },
        { name: 'homophones[].word', type: 'string', desc: '成语' },
        { name: 'homophones[].pinyin', type: 'string', desc: '带声调的拼音' },
        { name: 'homophones[].explanation', type: 'string', desc: '释义' },
      ],
      async handler({ query }) {
        const word = param(query, 'word', { required: true, max: 20 });
        return { data: idiomChain(word) };
      },
    },
  ],
};

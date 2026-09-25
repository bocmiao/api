import { HttpError, param } from '../../lib/http.js';
import { IDIOMS } from './data/idioms.js';
import { pick } from './seeded.js';
import { lazy, readDataJSON } from './lazy-json.js';

// 精校词库：拼音、释义、出处人工核对，例句为本站原创
export const IDIOM_ITEMS = IDIOMS.map(([word, pinyin, explanation, source, example], i) => ({
  id: i + 1, word, pinyin, explanation, source, example, dataSource: 'curated',
}));

// 新华词典成语（chinese-xinhua，MIT，见 data/dict/LICENSE），约 3 万条，已去掉与精校词库重复的词条。
// 文件约 7MB，第一次查到精校词库以外的词、或用 scope=all 时才读入；id 接在精校词库之后。
export const xinhuaIdioms = lazy(() => readDataJSON('dict/idioms.json').map(([word, pinyin, explanation, source, example], i) => ({
  id: IDIOMS.length + i + 1, word, pinyin, explanation, source, example, dataSource: 'xinhua',
})));

export const SCOPES = ['curated', 'all'];
export const CHAIN_LIMIT = 50;
const MAX_CANDIDATES = 5;
const HAN_RE = /^\p{Script=Han}{2,20}$/u;

// 去掉声调，ü 记作 v（避免“驴 lǘ”和“路 lù”混为一谈）
export const toneless = (s) => s.normalize('NFD').replace(/u\u0308/g, 'v').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const brief = (x) => ({ word: x.word, pinyin: x.pinyin, explanation: x.explanation, dataSource: x.dataSource });
const clean = (s) => String(s ?? '').replace(/\s+/g, '');
const push = (map, key, item) => (map.get(key) ?? map.set(key, []).get(key)).push(item);

// 按词、首字、首字读音（不计声调）建索引，接龙时不用每次扫全表
function buildIndex(items) {
  const byWord = new Map();
  const byFirst = new Map();
  const byFirstSound = new Map();
  for (const x of items) {
    byWord.set(x.word, x);
    push(byFirst, x.word[0], x);
    push(byFirstSound, toneless(x.pinyin.split(' ')[0]), x);
  }
  return { byWord, byFirst, byFirstSound };
}
const curatedIndex = lazy(() => buildIndex(IDIOM_ITEMS));
const xinhuaIndex = lazy(() => buildIndex(xinhuaIdioms()));
const indexesOf = (scope) => (scope === 'all' ? [curatedIndex(), xinhuaIndex()] : [curatedIndex()]);

// 先查精校词库，查不到再查新华词典（精校命中时不读新华词典文件）
export function findIdiom(word, scope = 'all') {
  return curatedIndex().byWord.get(word) ?? (scope === 'all' ? xinhuaIndex().byWord.get(word) : null) ?? null;
}

// 查不到时的候选：先是包含查询词的成语，再按与查询词共有的字数排序；同分时精校词库在前
export function similarIdioms(query, limit = MAX_CANDIDATES) {
  const q = clean(query);
  const chars = [...new Set(q)];
  if (!chars.length) return [];
  const scored = [];
  for (const list of [IDIOM_ITEMS, xinhuaIdioms()]) {
    for (const x of list) {
      const n = x.word.includes(q) ? 100 : chars.filter((ch) => x.word.includes(ch)).length;
      if (n > 0) scored.push([n, x]);
    }
  }
  return scored
    .sort((a, b) => b[0] - a[0] || a[1].id - b[1].id)
    .slice(0, limit)
    .map(([, x]) => x.word);
}

// word 为 null 时随机：scope=curated 只从精校词库里抽，scope=all 从两个词库合起来抽
export function lookupIdiom(word = null, rand = Math.random, { scope = 'curated' } = {}) {
  if (word == null) {
    if (scope !== 'all') return { ...pick(IDIOM_ITEMS, rand), random: true };
    const xinhua = xinhuaIdioms();
    const i = Math.floor(rand() * (IDIOM_ITEMS.length + xinhua.length));
    return { ...(i < IDIOM_ITEMS.length ? IDIOM_ITEMS[i] : xinhua[i - IDIOM_ITEMS.length]), random: true };
  }
  const q = clean(word);
  const hit = findIdiom(q, 'all');
  if (hit) return { ...hit, random: false };
  const candidates = similarIdioms(q);
  const err = new HttpError(404, candidates.length
    ? `词库里没有「${q}」，相近的成语：${candidates.join('、')}`
    : `词库里没有「${q}」`);
  err.candidates = candidates;
  throw err;
}

// 成语接龙：返回首字与 word 尾字相同的成语；word 在所选词库里时，另外给出首字与尾字同音（不计声调）的成语。
// scope=all 精校词库加新华词典（默认），scope=curated 只在精校词库里找；每类最多返回 limit 条，精校词库的排在前面
export function idiomChain(word, { scope = 'all', limit = CHAIN_LIMIT } = {}) {
  const q = clean(word);
  if (!HAN_RE.test(q)) throw new HttpError(400, 'word 须为 2~20 个汉字');
  const tail = q.at(-1);
  const indexes = indexesOf(scope);
  const known = findIdiom(q, scope);
  const tailPinyin = known ? known.pinyin.split(' ').at(-1) : null;
  const same = indexes.flatMap((idx) => idx.byFirst.get(tail) ?? []).filter((x) => x.word !== q);
  const sound = tailPinyin ? toneless(tailPinyin) : null;
  const homophones = sound
    ? indexes.flatMap((idx) => idx.byFirstSound.get(sound) ?? []).filter((x) => x.word[0] !== tail && x.word !== q)
    : [];
  const items = same.slice(0, limit).map(brief);
  return {
    word: q, scope, known: Boolean(known), tail, tailPinyin,
    total: same.length, count: items.length, items,
    homophoneTotal: homophones.length, homophones: homophones.slice(0, limit).map(brief),
  };
}

const SCOPE_DESC = `curated=精校词库（${IDIOMS.length} 条常用成语，含原创例句）；all=精校词库 + 新华词典（约 3 万条）`;
const DATA_SOURCE_DESC = '数据来源：curated=本站精校词库（拼音、释义、出处经人工核对，例句原创）；xinhua=新华词典开源数据 chinese-xinhua（未经人工校对，释义偶有缺字、标点）';

export default {
  name: 'idiom',
  category: 'fun',
  title: '成语词典',
  description: `查询成语的拼音、释义、出处和例句，不传参数随机一条；支持成语接龙。内置 ${IDIOMS.length} 条精校常用成语，查不到时再查约 3 万条新华词典成语`,
  source: '本地内置（精校成语库，例句为本站原创）+ 新华词典开源数据 chinese-xinhua（MIT）',
  routes: [
    {
      method: 'GET',
      path: '/api/idiom',
      summary: '查询成语（不传 word 时随机一条）',
      params: [
        { name: 'word', required: false, desc: '要查的成语（需完整匹配）；先查精校词库，查不到再查新华词典。不传则随机返回一条。都查不到返回 404，并在 message 中给出相近的成语', example: '画龙点睛' },
        { name: 'scope', required: false, default: 'curated', desc: `随机时的抽取范围（传 word 时不起作用）：${SCOPE_DESC}`, example: 'all' },
      ],
      fields: [
        { name: 'id', type: 'number', desc: `成语编号：精校词库为 1~${IDIOMS.length}，新华词典词条接在其后` },
        { name: 'word', type: 'string', desc: '成语' },
        { name: 'pinyin', type: 'string', desc: '带声调的拼音，每字一个音节、空格分隔；按词典惯例标原调（“一”“不”不标变调）' },
        { name: 'explanation', type: 'string', desc: '释义' },
        { name: 'source', type: 'string|null', desc: '出处。精校词条如“《史记·项羽本纪》”，写“典出”的表示成语由该处文字或故事概括而来；新华词典词条为出处书名加原文；出处无法确认或缺失时为 null' },
        { name: 'example', type: 'string|null', desc: '例句。精校词条为本站原创；新华词典词条为文献引例，括号里是引文出处，没有时为 null' },
        { name: 'dataSource', type: 'string', desc: DATA_SOURCE_DESC },
        { name: 'random', type: 'boolean', desc: '是否为随机返回（未传 word 时为 true）' },
      ],
      async handler({ query }) {
        const word = param(query, 'word', { max: 20 }) ?? null;
        const scope = param(query, 'scope', { default: 'curated', oneOf: SCOPES });
        return { data: lookupIdiom(word && clean(word) ? word : null, Math.random, { scope }) };
      },
    },
    {
      method: 'GET',
      path: '/api/idiom/chain',
      summary: '成语接龙：找首字与给定成语尾字相同的成语',
      params: [
        { name: 'word', required: true, desc: '上一个成语（2~20 个汉字，不必在词库中），取它的最后一个字来接龙', example: '一鸣惊人' },
        { name: 'scope', required: false, default: 'all', desc: `接龙用的词库：${SCOPE_DESC}`, example: 'curated' },
      ],
      fields: [
        { name: 'word', type: 'string', desc: '传入的成语（已去掉空白）' },
        { name: 'scope', type: 'string', desc: `实际使用的词库：${SCOPE_DESC}` },
        { name: 'known', type: 'boolean', desc: '传入的成语是否在所选词库中；在词库中时才能给出尾字读音和同音接龙' },
        { name: 'tail', type: 'string', desc: '用来接龙的尾字' },
        { name: 'tailPinyin', type: 'string|null', desc: '尾字在该成语中的读音（带声调）；成语不在所选词库中时为 null' },
        { name: 'total', type: 'number', desc: `首字与尾字相同的成语总数；超过 ${CHAIN_LIMIT} 条时 items 只返回前 ${CHAIN_LIMIT} 条` },
        { name: 'count', type: 'number', desc: '实际返回的同字接龙成语数，等于 items 的长度；为 0 表示词库里接不上' },
        { name: 'items', type: 'array', desc: `首字与尾字相同的成语（精校词库在前，各自按词库顺序；不含传入的成语本身；最多 ${CHAIN_LIMIT} 条）` },
        { name: 'items[].word', type: 'string', desc: '成语' },
        { name: 'items[].pinyin', type: 'string', desc: '带声调的拼音' },
        { name: 'items[].explanation', type: 'string', desc: '释义' },
        { name: 'items[].dataSource', type: 'string', desc: DATA_SOURCE_DESC },
        { name: 'homophoneTotal', type: 'number', desc: '同音接龙的成语总数' },
        { name: 'homophones', type: 'array', desc: `首字与尾字同音（不计声调）但不同字的成语，作为同音接龙的备选；成语不在所选词库中时为空数组；最多 ${CHAIN_LIMIT} 条` },
        { name: 'homophones[].word', type: 'string', desc: '成语' },
        { name: 'homophones[].pinyin', type: 'string', desc: '带声调的拼音' },
        { name: 'homophones[].explanation', type: 'string', desc: '释义' },
        { name: 'homophones[].dataSource', type: 'string', desc: DATA_SOURCE_DESC },
      ],
      async handler({ query }) {
        const word = param(query, 'word', { required: true, max: 20 });
        const scope = param(query, 'scope', { default: 'all', oneOf: SCOPES });
        return { data: idiomChain(word, { scope }) };
      },
    },
  ],
};

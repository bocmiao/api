// 从 chinese-xinhua / chinese-poetry 的原始 JSON 生成本目录与 ../poetry/ 下的精简数据。
// 不是接口模块，运行时不会被加载。用法：
//   node src/apis/fun/data/dict/build.js <原始数据目录>
// 原始数据目录下需有 dict/{idioms,xiehouyu,hanzi}.json、poetry/poems.json、poetry/raw/tangshi300.json。
// 生成的数据只保留接口用到的字段，并做了清理（见各函数注释），所以重新生成后请跑一遍 node --test。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDIOMS } from '../idioms.js';
import { XIEHOUYU } from '../xiehouyu.js';
import { XIEHOUYU_BLOCKLIST, isBlockedXiehouyu } from './blocklist.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2];
if (!SRC) {
  console.error('用法：node src/apis/fun/data/dict/build.js <原始数据目录>');
  process.exit(1);
}
const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(SRC, p), 'utf8'));
const writeJSON = (p, data) => {
  // 一条一行：便于 diff，又不带多余缩进
  const body = Array.isArray(data) ? `[\n${data.map((x) => JSON.stringify(x)).join(',\n')}\n]\n` : `${JSON.stringify(data)}\n`;
  fs.writeFileSync(path.join(HERE, p), body);
  console.log(p, Array.isArray(data) ? data.length : '', `${(Buffer.byteLength(body) / 1024).toFixed(0)} KB`);
};

const HAN = /\p{Script=Han}/u;
// 编码损坏后残留的符号：出现在释义里说明这一段文字已经丢字，无法恢复
const CORRUPT = /[♂♀≤≥‖×⊥§→←↑↓¤■□◆☆∥≮≯∝∮╞∪∩∽∠∑∞±＜＞＝ˇ¨「」『』]/u;

// 全角数字、字母转半角（标点保持全角）
const halfWidth = (s) => s.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

// 去掉配不上对的引号：原数据常把“：“”一起丢掉，只剩下后引号
export function balanceQuotes(s) {
  for (const [open, close] of [['“', '”'], ['‘', '’']]) {
    const chars = [...s];
    const stack = [];
    const drop = new Set();
    chars.forEach((c, i) => {
      if (c === open) stack.push(i);
      else if (c === close) (stack.length ? stack.pop() : drop.add(i));
    });
    for (const i of stack) drop.add(i);
    s = chars.filter((_, i) => !drop.has(i)).join('');
  }
  return s;
}

// 汉字之间的空白是排版残留，去掉；英文/数字之间的保留一个空格
const squeeze = (s) => s.replace(/\s+/g, (m, i, all) => (/[\x21-\x7e]/.test(all[i - 1] ?? '') && /[\x21-\x7e]/.test(all[i + m.length] ?? '') ? ' ' : ''));

function cleanIdiomText(raw, word, { star = false } = {}) {
  let s = String(raw ?? '').trim();
  if (!s || s === '无') return null;
  s = halfWidth(s)
    .replace(/∶/g, '：')
    .replace(/○/g, '〇')
    .replace(/◇/g, '。') // 义项分隔符
    .replace(/\?(?=[’”]|$)/g, '？')
    .replace(/～/g, word);
  s = squeeze(s);
  // ★ 只在例句里用来分隔引文和出处，出现在别处说明是乱码
  if (CORRUPT.test(s) || s.includes('?') || (!star && s.includes('★'))) return null;
  s = balanceQuotes(s).replace(/。{2,}/g, '。').replace(/[，；]。/g, '。').replace(/^。/, '');
  return s || null;
}

// 例句：“正文★出处” → “正文（出处）”
function cleanExample(raw, word) {
  const s = cleanIdiomText(raw, word, { star: true });
  if (!s) return null;
  const [text, ...src] = s.split('★');
  const from = src.join('').trim();
  return from ? `${text.trim()}（${from}）` : text.trim() || null;
}

const SYLLABLE = /^[a-zāáǎàēéěèīíǐìōóǒòūúǔùüǖǘǚǜ]+$/;
const normPinyin = (s) => String(s ?? '').normalize('NFC').replace(/ɡ/g, 'g').toLowerCase().trim().split(/\s+/);

function buildIdioms() {
  const curated = new Set(IDIOMS.map((x) => x[0]));
  const out = [];
  const seen = new Set();
  const stats = { raw: 0, curated: 0, shape: 0, pinyin: 0, corrupt: 0 };
  for (const x of readJSON('dict/idioms.json')) {
    stats.raw += 1;
    const word = String(x.word ?? '').replace(/\s+/g, '');
    const chars = [...word];
    // 只收 3~12 个汉字、不带标点的条目（带逗号的多是俗语，拼音也常常不全）
    if (!/^\p{Script=Han}{3,12}$/u.test(word) || seen.has(word)) { stats.shape += 1; continue; }
    if (curated.has(word)) { stats.curated += 1; continue; }
    const syl = normPinyin(x.pinyin);
    if (syl.length !== chars.length || !syl.every((p) => SYLLABLE.test(p))) { stats.pinyin += 1; continue; }
    const explanation = cleanIdiomText(x.explanation, word);
    if (!explanation) { stats.corrupt += 1; continue; }
    seen.add(word);
    // [成语, 拼音, 释义, 出处, 例句]，与 ../idioms.js 同构；出处、例句缺失或损坏时为 null
    out.push([word, syl.join(' '), explanation, cleanIdiomText(x.derivation, word), cleanExample(x.example, word)]);
  }
  console.log('idioms', stats);
  return out;
}

const XHY_TEXT = /^[\p{Script=Han}，、；：？！“”‘’《》（）…—·]+$/u;
function buildXiehouyu() {
  const curatedRiddles = new Set(XIEHOUYU.map(([r]) => r));
  const seen = new Set(XIEHOUYU.map(([r, a]) => `${r}|${a}`));
  const out = [];
  const stats = { raw: 0, empty: 0, odd: 0, blocked: 0, dup: 0 };
  for (const x of readJSON('dict/xiehouyu.json')) {
    stats.raw += 1;
    const riddle = balanceQuotes(String(x.riddle ?? '').replace(/\s+/g, '')).replace(/[，；、。]+$/, '');
    const answer = balanceQuotes(String(x.answer ?? '').replace(/\s+/g, '')).replace(/[，；、]+$/, '');
    if (!riddle || !answer) { stats.empty += 1; continue; }
    // 带拼音注音、乱码的条目（约 400 条，多为注音被截断）整条丢弃
    if (!XHY_TEXT.test(riddle) || !XHY_TEXT.test(answer) || riddle.length > 30 || answer.length > 60) { stats.odd += 1; continue; }
    if (isBlockedXiehouyu(riddle, answer)) { stats.blocked += 1; continue; }
    const key = `${riddle}|${answer}`;
    if (seen.has(key) || curatedRiddles.has(riddle)) { stats.dup += 1; continue; }
    seen.add(key);
    out.push([riddle, answer]);
  }
  console.log('xiehouyu', stats, `屏蔽词 ${XIEHOUYU_BLOCKLIST.length} 个`);
  return out;
}

// 康熙部首（214 个，由 Kangxi Radicals 区块做 NFKC 得到）+ 常见偏旁变体与简化部首
const RADICALS = new Set([
  ...Array.from({ length: 214 }, (_, i) => String.fromCodePoint(0x2f00 + i).normalize('NFKC')),
  ...'亻氵扌忄艹衤礻阝刂冫讠饣纟钅贝车见页门马鸟鱼韦龙齿黾麦卤风飞辶廴罒覀爫彐彑夂丬犭⺮⺈亠冖宀冂勹匚卩厶巛尢攵灬牜王耂肀疒癶禸糸纟虍衣言足镸长鸟龟鹵鹿麻黄黍黑鼎鼓鼠鼻齐'.split(''),
]);

// 释义开头的“字（繁）”写法，如“乐（樂）lè”“发（髮）fà”
const tradOf = (word, text) => [...new Set([...text.matchAll(new RegExp(`(?:^|\\n)${word}（(\\p{Script=Han})）`, 'gu'))].map((m) => m[1]).filter((c) => c !== word))];

// 释义里每个读音段落以“字+拼音”开头，如“行háng”“的 ·de”
const READING = /^[a-zāáǎàēéěèīíǐìōóǒòūúǔùüǖǘǚǜ]{1,7}$/;
function readingsOf(word, main, text) {
  const out = [];
  const add = (p) => {
    const s = p.normalize('NFC').replace(/ɡ/g, 'g').replace(/^·/, '').toLowerCase();
    if (!READING.test(s)) return;
    const bare = (x) => x.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ü/g, 'v');
    // 没标声调的（如“长 chang”）和已有读音同音时不重复收录
    if (out.includes(s) || (s === bare(s) && out.some((x) => bare(x) === s))) return;
    out.push(s);
  };
  for (const p of [].concat(main)) add(p);
  const re = new RegExp(`(?:^|\\n)${word}(?:（\\p{Script=Han}）)?\\s*·?([a-zāáǎàēéěèīíǐìōóǒòūúǔùüǖǘǚǜɡ]+)(?![a-z])`, 'gu');
  for (const m of text.matchAll(re)) add(m[1]);
  return out;
}

function cleanHanziText(raw) {
  return String(raw ?? '')
    .replace(/ɡ/g, 'g')
    .replace(/∶/g, '：')
    .split('\n')
    .map((line) => balanceQuotes(halfWidth(line).replace(/[♂♀≮≯¤■□◆☆∥‖§⊥]/gu, '').trim()))
    .filter((line) => line && !/^[─—\-－_]+$/.test(line) && !/^\?+$/.test(line))
    .join('\n');
}

function buildHanzi() {
  const out = new Map();
  const stats = { raw: 0, shape: 0, mismatch: 0, merged: 0, noRadical: 0, badRadical: 0 };
  for (const x of readJSON('dict/hanzi.json')) {
    stats.raw += 1;
    const word = String(x.word ?? '').trim();
    if ([...word].length !== 1 || !HAN.test(word)) { stats.shape += 1; continue; }
    const text = cleanHanziText(x.explanation);
    // 释义里连这个字都没出现、或只有问号的，多半是编码错位的条目，整条丢弃
    if (!text.includes(word) || text.replace(new RegExp(word, 'gu'), '').replace(/[\s?]/g, '') === '') { stats.mismatch += 1; continue; }
    // 原数据部首为空的条目，笔画数也不可靠（如“龘”记作 6 画），两者都置空
    let radical = String(x.radical ?? '').trim();
    let strokes = Number.isInteger(x.strokes) && x.strokes > 0 && x.strokes < 70 ? x.strokes : 0;
    if (!radical) { stats.noRadical += 1; strokes = 0; } else if (!RADICALS.has(radical)) { stats.badRadical += 1; radical = ''; }
    const prev = out.get(word);
    if (prev) {
      // 同一个字按读音拆成了多条（多见于生僻字）：读音、释义合并，部首笔画取第一条有值的
      stats.merged += 1;
      prev.main.push(String(x.pinyin ?? ''));
      if (!prev.text.includes(text)) prev.text += `\n${text}`;
      if (!prev.radical && radical) Object.assign(prev, { radical, strokes });
      continue;
    }
    out.set(word, { word, main: [String(x.pinyin ?? '')], radical, strokes, text });
  }
  console.log('hanzi', stats);
  // [字, 读音（空格分隔，第一个为常用读音）, 部首, 笔画（0 表示未知）, 繁体（可能多个字）, 释义]
  // 原数据的 old（繁体）字段大量错位（如“长”记作“閘”），只采用释义里明确写出的“字（繁）”
  const rows = [...out.values()].map((x) => [x.word, readingsOf(x.word, x.main, x.text).join(' '), x.radical, x.strokes, tradOf(x.word, x.text).join(''), x.text]);
  // 编码错位的另一种形态：繁体字条目里放的是别的字的内容（如“間”条目写的是“镚 bèng”）。
  // 某个简体字的释义写明繁体是 T，而 T 自己的条目读音跟这个简体字一个都对不上，就丢掉 T 的条目
  const bare = (p) => p.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const readings = new Map(rows.map((r) => [r[0], new Set(r[1].split(' ').filter(Boolean).map(bare))]));
  // 这个规则抓不到的已知错位条目，手工补上
  const bad = new Set(['間']);
  for (const [word, py, , , trad] of rows) {
    for (const t of trad) {
      const own = readings.get(t);
      if (own && own.size && !py.split(' ').some((p) => own.has(bare(p)))) bad.add(t);
    }
  }
  console.log('hanzi 繁体条目读音对不上，丢弃', bad.size, [...bad].join(''));
  return rows.filter((r) => !bad.has(r[0]) && r[1]);
}

// 诗词：标题只取正题（原数据把“正题·异题 / 异题”拼在一起），句中的“(xx 一作：yy)”异文注释抽到 notes
function buildPoems() {
  const poems = readJSON('poetry/poems.json');
  const raw = readJSON('poetry/raw/tangshi300.json').content.flatMap((g) => g.content);
  const ascii = { ',': '，', '?': '？', '!': '！', ':': '：', ';': '；' };
  let t = 0;
  return poems.map((p) => {
    let title = p.title.replace(/・/g, '·');
    if (p.dynasty === '唐') {
      const r = raw[t++];
      if (r.subchapter) title = [...title].slice(0, [...r.chapter].length).join('');
    }
    const notes = [];
    const joined = p.paragraphs.join('\u0000').replace(/\s*[(（]([^()（）]*)[)）]/g, (_, note) => {
      const n = note.replace(/\u0000/g, '').replace(/\s+/g, ' ').replace(/:/g, '：').trim();
      if (n) notes.push(n);
      return '';
    });
    const paragraphs = joined.split('\u0000').map((s) => s.replace(/[,?!:;]/g, (c) => ascii[c]).trim()).filter(Boolean);
    return { id: p.id, title, author: p.author, dynasty: p.dynasty, type: p.type, paragraphs, notes };
  });
}

writeJSON('idioms.json', buildIdioms());
writeJSON('xiehouyu.json', buildXiehouyu());
writeJSON('hanzi.json', buildHanzi());
const poems = buildPoems();
fs.writeFileSync(path.join(HERE, '../poetry/poems.json'), `[\n${poems.map((x) => JSON.stringify(x)).join(',\n')}\n]\n`);
console.log('poems', poems.length);

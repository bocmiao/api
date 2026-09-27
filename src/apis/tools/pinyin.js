import { HttpError, param } from '../../lib/http.js';
import { lazy, readDataJSON } from '../fun/lazy-json.js';
import { toSimplifiedChar } from './chinese-convert.js';

// 读音取自汉字字典的数据（fun/data/dict/hanzi.json，约 1.4 万字、3MB，同 /api/hanzi）。
// 第一次转换时读一次盘，只留下“字 → 读音数组”，释义等大字段随解析结果一起丢弃，常驻内存约 1MB；
// 不和 hanzi.js 共用它的索引（那份带释义），两者各自惰性加载，只用其中一个接口时只占一份。
const HAN = /\p{Script=Han}/u;

// 字典数据里少数常用字缺了常用读音或读音顺序不合常用习惯，这里修正（第一个为默认读音）
export const READING_FIX = {
  们: 'men mén',
  长: 'cháng zhǎng',
  为: 'wéi wèi',
  得: 'dé de děi',
  地: 'dì de',
  重: 'zhòng chóng',
  吧: 'ba bā',
  朝: 'cháo zhāo',
  参: 'cān shēn cēn',
  单: 'dān shàn chán',
  传: 'chuán zhuàn',
  处: 'chù chǔ',
  分: 'fēn fèn',
  曲: 'qǔ qū',
  冲: 'chōng chòng',
  片: 'piàn piān',
  系: 'xì jì',
  啊: 'a ā á ǎ à',
  啦: 'la lā',
  似: 'sì shì',
  教: 'jiào jiāo',
  都: 'dōu dū',
};

const readingIndex = lazy(() => {
  const map = new Map();
  for (const row of readDataJSON('dict/hanzi.json')) map.set(row[0], row[1].split(' ').filter(Boolean));
  for (const [c, r] of Object.entries(READING_FIX)) map.set(c, r.split(' '));
  return map;
});

// 查一个字的全部读音（带声调）；繁体字字典里没有时按对应的简体字查；查不到返回 []
export function readingsOf(char) {
  const index = readingIndex();
  return index.get(char) ?? index.get(toSimplifiedChar(char)) ?? [];
}

const TONE_MARKS = {
  ā: ['a', 1], á: ['a', 2], ǎ: ['a', 3], à: ['a', 4],
  ē: ['e', 1], é: ['e', 2], ě: ['e', 3], è: ['e', 4],
  ī: ['i', 1], í: ['i', 2], ǐ: ['i', 3], ì: ['i', 4],
  ō: ['o', 1], ó: ['o', 2], ǒ: ['o', 3], ò: ['o', 4],
  ū: ['u', 1], ú: ['u', 2], ǔ: ['u', 3], ù: ['u', 4],
  ǖ: ['ü', 1], ǘ: ['ü', 2], ǚ: ['ü', 3], ǜ: ['ü', 4],
  ń: ['n', 2], ň: ['n', 3], ǹ: ['n', 4], ḿ: ['m', 2],
};

// 把带声调的音节转成指定风格：tone 原样；number 声调数字放末尾（轻声不加数字）、ü 写作 v；none 去掉声调、ü 写作 v；initial 取首字母
export function formatSyllable(syllable, style = 'tone') {
  if (style === 'tone') return syllable;
  let tone = 0;
  let plain = '';
  for (const ch of syllable.normalize('NFC')) {
    const mark = TONE_MARKS[ch];
    if (mark) { plain += mark[0]; tone = mark[1]; } else plain += ch;
  }
  plain = plain.replace(/ü/g, 'v');
  if (style === 'initial') return plain[0] ?? '';
  if (style === 'number') return tone ? `${plain}${tone}` : plain;
  return plain;
}

export const STYLES = ['tone', 'number', 'none', 'initial'];
export const MAX_TEXT = 1000;

export function toPinyin(input, { style = 'tone', separator = ' ', heteronym = false } = {}) {
  if (!STYLES.includes(style)) throw new HttpError(400, `style 只能是 ${STYLES.join(' / ')}`);
  const chars = [...String(input ?? '')];
  if (!chars.length) throw new HttpError(400, 'text 不能为空');
  if (chars.length > MAX_TEXT) throw new HttpError(400, `text 过长（最多 ${MAX_TEXT} 个字）`);

  const items = [];
  const tokens = []; // 拼音音节与非汉字片段，最后用 separator 连接
  let run = '';
  let abbr = '';
  const flush = () => { if (run) tokens.push(run); run = ''; };
  for (const char of chars) {
    const readings = HAN.test(char) ? [...new Set(readingsOf(char).map((r) => formatSyllable(r, style)))] : [];
    if (!readings.length) {
      // 非汉字（及字典未收录的汉字）原样保留，相邻的连成一段
      items.push({ char, pinyin: null, readings: [], polyphonic: false });
      run += char;
      continue;
    }
    flush();
    items.push({ char, pinyin: readings[0], readings, polyphonic: readings.length > 1 });
    tokens.push(heteronym && readings.length > 1 ? readings.join('/') : readings[0]);
    abbr += formatSyllable(readingsOf(char)[0], 'initial').toUpperCase();
  }
  flush();

  // 纯空白片段不单独占位（分隔符已经隔开了），含换行的保留一个换行
  let text = '';
  let lineStart = true;
  for (const token of tokens) {
    if (!token.trim()) {
      if (token.includes('\n')) { text += '\n'; lineStart = true; }
      continue;
    }
    if (!lineStart) text += separator;
    text += token.trim();
    lineStart = false;
  }

  return {
    text: chars.join(''),
    style,
    pinyin: text,
    abbr,
    hanCount: items.filter((x) => x.pinyin !== null).length,
    chars: items,
  };
}

export default {
  name: 'pinyin',
  category: 'tools',
  title: '汉字转拼音',
  description: '把中文转成拼音，支持带声调、数字声调、无声调、首字母四种风格和多音字列表，附带拼音首字母缩写（如“中国→ZG”）。'
    + '多音字按单字最常用读音转换，不做词语上下文判断（如“银行”会得到 yín xíng），需要时可查看每个字的全部读音',
  source: '本地转换，读音数据来自新华字典开源数据 chinese-xinhua（MIT）',
  routes: [
    {
      method: 'GET',
      path: '/api/pinyin',
      summary: '汉字转拼音（带声调 / 数字声调 / 无声调 / 首字母）',
      params: [
        { name: 'text', required: true, desc: `要转换的文本，最多 ${MAX_TEXT} 个字；英文、数字、标点等非汉字原样保留`, example: '中国人民银行' },
        { name: 'style', default: 'tone', desc: '拼音风格：tone 带声调（zhōng）/ number 数字声调（zhong1，轻声不加数字，ü 写作 v）/ none 无声调（zhong）/ initial 首字母（z）', example: 'tone' },
        { name: 'separator', default: '空格', desc: '音节之间的分隔符，最多 5 个字符；传空值（separator=）表示不分隔', example: ' ' },
        { name: 'heteronym', default: 'false', desc: '是否在拼音结果里列出多音字的全部读音（用 / 分隔，如 zhōng/zhòng）：true / false', example: 'false' },
      ],
      fields: [
        { name: 'text', type: 'string', desc: '原文' },
        { name: 'style', type: 'string', desc: '拼音风格：tone / number / none / initial' },
        { name: 'pinyin', type: 'string', desc: '转换结果：每个汉字一个音节，用 separator 连接；非汉字按原样成段保留，空白只保留换行。多音字取最常用读音，heteronym=true 时列出全部读音' },
        { name: 'abbr', type: 'string', desc: '拼音首字母缩写（大写，只取汉字），如“中国”为“ZG”' },
        { name: 'hanCount', type: 'number', desc: '转换出拼音的汉字个数（字典未收录的生僻字不计入，原样保留）' },
        { name: 'chars', type: 'array', desc: '逐字结果，与原文的字符一一对应（按 Unicode 码位）' },
        { name: 'chars[].char', type: 'string', desc: '字符' },
        { name: 'chars[].pinyin', type: 'string|null', desc: '该字采用的读音（按 style 格式化）；非汉字或字典未收录时为 null' },
        { name: 'chars[].readings', type: 'array', desc: '该字的全部读音（按 style 格式化并去重，第一个为默认读音）；非汉字为空数组' },
        { name: 'chars[].polyphonic', type: 'boolean', desc: '是否多音字（按当前 style 去重后读音多于 1 个）' },
      ],
      async handler({ query }) {
        const text = param(query, 'text', { required: true, max: MAX_TEXT * 2 });
        const style = param(query, 'style', { default: 'tone', oneOf: STYLES });
        const separator = query.get('separator') ?? ' ';
        if (separator.length > 5) throw new HttpError(400, 'separator 过长（最多 5 个字符）');
        const heteronym = param(query, 'heteronym', { default: 'false', oneOf: ['true', 'false', '1', '0'] });
        return { data: toPinyin(text, { style, separator, heteronym: heteronym === 'true' || heteronym === '1' }) };
      },
    },
  ],
};

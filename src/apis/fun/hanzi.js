import { HttpError, param } from '../../lib/http.js';
import { lazy, readDataJSON } from './lazy-json.js';

// 新华字典汉字数据（chinese-xinhua，MIT，见 data/dict/LICENSE），约 1.4 万字，文件约 3MB，第一次查询时才读入。
// 每条：[字, 读音（空格分隔）, 部首, 笔画（0=未知）, 繁体（可能多个字）, 释义]，清理规则见 data/dict/build.js
const hanziIndex = lazy(() => new Map(readDataJSON('dict/hanzi.json').map((row) => [row[0], row])));

const ONE_HAN = /^\p{Script=Han}$/u;

export function parseHanzi([word, pinyin, radical, strokes, traditional, explanation]) {
  return {
    word,
    pinyin: pinyin.split(' ').filter(Boolean),
    radical: radical || null,
    strokes: strokes || null,
    traditional: [...traditional],
    explanation,
    unicode: `U+${word.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
  };
}

export function lookupHanzi(input) {
  const word = String(input ?? '').trim();
  if (!ONE_HAN.test(word)) throw new HttpError(400, 'word 须为 1 个汉字');
  const row = hanziIndex().get(word);
  if (!row) throw new HttpError(404, `字典里没有收录「${word}」`);
  return parseHanzi(row);
}

export const hanziCount = () => hanziIndex().size;

export default {
  name: 'hanzi',
  category: 'fun',
  title: '汉字字典',
  description: '查询单个汉字的拼音（含多音）、部首、笔画、繁体和释义，收录约 1.4 万字',
  source: '新华字典开源数据 chinese-xinhua（MIT）',
  routes: [
    {
      method: 'GET',
      path: '/api/hanzi',
      summary: '查询一个汉字的读音、部首、笔画、繁体与释义',
      params: [
        { name: 'word', required: true, desc: '要查的汉字，只能是 1 个汉字（前后空白会被去掉）；不是 1 个汉字返回 400，字典未收录返回 404', example: '乐' },
      ],
      fields: [
        { name: 'word', type: 'string', desc: '查询的汉字' },
        { name: 'pinyin', type: 'array', desc: '读音（带声调），多音字有多个，第一个为最常用的读音；轻声不标调，如“de”' },
        { name: 'radical', type: 'string|null', desc: '部首，如“女”“氵”；原数据缺失或明显错误时为 null（多见于生僻字）' },
        { name: 'strokes', type: 'number|null', desc: '总笔画数；原数据不可靠时（部首缺失的生僻字）为 null' },
        { name: 'traditional', type: 'array', desc: '繁体写法（取自释义中“乐（樂）”这类标注），一个简体字可能对应多个繁体，如“发”对应“發”“髮”；没有标注或简繁同形时为空数组' },
        { name: 'explanation', type: 'string', desc: '释义原文，多个读音、义项按行分隔（\\n）；“～”代指本字。数据来自开源词典，已去掉乱码符号和配不上对的引号，个别冒号、引号在原数据中已丢失' },
        { name: 'unicode', type: 'string', desc: 'Unicode 码位，如“U+4E50”' },
      ],
      async handler({ query }) {
        const word = param(query, 'word', { required: true, max: 10 });
        return { data: lookupHanzi(word) };
      },
    },
  ],
};

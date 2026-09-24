import { HttpError, param } from '../../lib/http.js';
import { todayBeijing } from '../life/lunar.js';
import { ANSWERS } from './data/answers.js';
import { seededRandom } from './seeded.js';

// 同一问题的不同写法视为同一个：全角转半角、去首尾空白、合并空白、去掉末尾标点、英文转小写
export function normalizeQuestion(q) {
  return String(q ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[\s?!.,~…。？！，、～]+$/u, '')
    .toLowerCase();
}

export function drawAnswer({ question = null, date = todayBeijing(), rand = Math.random } = {}) {
  let r = rand;
  let fixed = false;
  if (question != null) {
    const q = normalizeQuestion(question);
    if (!q) throw new HttpError(400, 'question 不能只包含空白或标点');
    r = seededRandom(`answer|${date}|${q}`);
    fixed = true;
  }
  const i = Math.floor(r() * ANSWERS.length);
  return {
    answer: ANSWERS[i],
    no: i + 1,
    total: ANSWERS.length,
    question: question == null ? null : question.trim(),
    date,
    fixed,
  };
}

export default {
  name: 'answer',
  category: 'fun',
  title: '答案之书',
  description: '心里默念一个问题，随机翻开一句答案；传入问题时同一天同一问题答案固定。仅供娱乐',
  source: '本地内置（原创答案库）',
  routes: [
    {
      method: 'GET',
      path: '/api/answer',
      summary: '随机返回一句答案，可传入问题固定当天答案',
      params: [
        {
          name: 'question',
          required: false,
          desc: '你的问题，最多 200 个字符。传入后按“北京时间日期 + 问题”生成答案，同一天同一问题答案相同；'
            + '比较前会去掉首尾空白和末尾标点、合并连续空白、英文转小写。不传则每次随机',
          example: '我该换工作吗？',
        },
      ],
      fields: [
        { name: 'answer', type: 'string', desc: '答案正文' },
        { name: 'no', type: 'number', desc: `答案在内置答案库中的序号（1~${ANSWERS.length}）` },
        { name: 'total', type: 'number', desc: '内置答案库的答案总数' },
        { name: 'question', type: 'string|null', desc: '你传入的问题（去掉首尾空白后原样返回）；未传 question 时为 null' },
        { name: 'date', type: 'string', desc: '生成答案所用的北京时间日期，YYYY-MM-DD；同一问题跨过北京时间 0 点后答案会变' },
        { name: 'fixed', type: 'boolean', desc: '答案是否固定：传了 question 时为 true（当天重复提问得到相同答案），未传时为 false（每次随机）' },
      ],
      async handler({ query }) {
        const question = param(query, 'question', { max: 200 }) ?? null;
        return { data: drawAnswer({ question }), updatedAt: new Date().toISOString() };
      },
    },
  ],
};

import { HttpError, param } from '../../lib/http.js';
import { todayBeijing } from '../life/lunar.js';
import {
  FORTUNE_LEVELS, FORTUNE_SIGNS, FORTUNE_ASPECTS, ASPECT_COMMENTS,
  LUCKY_COLORS, LUCKY_DIRECTIONS, FORTUNE_YI, FORTUNE_JI,
} from './data/fortune.js';
import { seededRandom, pick, randInt, sample } from './seeded.js';

export const FORTUNE_NOTICE = '运势由名字（或 IP）与日期计算得出，仅供娱乐，请勿当真';

export const normalizeName = (s) => String(s ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

export const levelOf = (score) => FORTUNE_LEVELS.find((l) => score >= l.min).level;

// key 形如 name:张三 / ip:1.2.3.4；同一 key 同一天结果固定
export function buildFortune(key, date, { name = null, basis = 'name' } = {}) {
  const r = seededRandom(`fortune|${date}|${key}`);
  // 两个均匀分布取平均（中间多、两头少），再略微上偏，范围 0~100
  const score = Math.round(100 * ((r() + r()) / 2) ** 0.8);
  const level = levelOf(score);
  const aspects = FORTUNE_ASPECTS.map(({ key: k, name: label }) => {
    const stars = Math.min(5, Math.max(1, Math.round(score / 25 + 1 + (r() - 0.5) * 2)));
    return { key: k, name: label, stars, comment: pick(ASPECT_COMMENTS[k][stars - 1], r) };
  });
  const color = pick(LUCKY_COLORS, r);
  return {
    date,
    name,
    basis,
    score,
    level,
    sign: pick(FORTUNE_SIGNS[level], r),
    aspects,
    luckyColor: { name: color.name, hex: color.hex },
    luckyNumber: randInt(1, 9, r),
    luckyDirection: pick(LUCKY_DIRECTIONS, r),
    yi: sample(FORTUNE_YI, 3, r),
    ji: sample(FORTUNE_JI, 3, r),
    notice: FORTUNE_NOTICE,
  };
}

export default {
  name: 'fortune',
  category: 'fun',
  title: '今日运势',
  description: '按名字（不传则按 IP）生成今日运势：综合评分、等级、签文、五项运势、幸运色/数字/方位、宜忌。仅供娱乐',
  source: '本地计算（原创文案）',
  routes: [
    {
      method: 'GET',
      path: '/api/fortune',
      summary: '今日运势（同一名字同一天结果固定，仅供娱乐）',
      params: [
        {
          name: 'name',
          required: false,
          desc: '名字或昵称，最多 20 个字符。以“北京时间日期 + 名字”的 SHA-256 哈希为随机种子，同一名字同一天结果相同；'
            + '比较前会去掉首尾空白、合并空白、英文转小写。不传时按调用者 IP 生成',
          example: '小明',
        },
      ],
      fields: [
        { name: 'date', type: 'string', desc: '运势对应的北京时间日期，YYYY-MM-DD；北京时间 0 点后换新一天的运势' },
        { name: 'name', type: 'string|null', desc: '传入的名字（去掉首尾空白）；未传 name、按 IP 生成时为 null（不回显 IP）' },
        { name: 'basis', type: 'string', desc: '随机种子依据：name（按名字生成）或 ip（未传 name，按调用者 IP 生成）' },
        { name: 'score', type: 'number', desc: '综合评分，0~100 的整数，越高越好' },
        {
          name: 'level',
          type: 'string',
          desc: '综合等级，由 score 决定：大吉（90~100）、吉（75~89）、中吉（60~74）、小吉（45~59）、平（30~44）、小凶（0~29）',
        },
        { name: 'sign', type: 'string', desc: '今日签文：两句七言的短诗，按 level 从对应文案中挑选（本项目原创，不是传统签文）' },
        { name: 'aspects', type: 'array', desc: '分项运势，固定 5 项，依次为事业、财富、感情、健康、学业' },
        { name: 'aspects[].key', type: 'string', desc: '分项标识：career（事业）、wealth（财富）、love（感情）、health（健康）、study（学业）' },
        { name: 'aspects[].name', type: 'string', desc: '分项中文名：事业、财富、感情、健康、学业' },
        { name: 'aspects[].stars', type: 'number', desc: '分项星级，1~5 的整数；与 score 正相关，但各项之间会有 ±1 星左右的浮动' },
        { name: 'aspects[].comment', type: 'string', desc: '分项点评，一句话，按星级从对应文案中挑选' },
        { name: 'luckyColor', type: 'object', desc: '幸运色' },
        { name: 'luckyColor.name', type: 'string', desc: '颜色名称，如 天蓝、竹青' },
        { name: 'luckyColor.hex', type: 'string', desc: '颜色的十六进制色值，#RRGGBB 格式（大写），可直接用于 CSS' },
        { name: 'luckyNumber', type: 'number', desc: '幸运数字，1~9 的整数' },
        { name: 'luckyDirection', type: 'string', desc: '幸运方位：正东、正南、正西、正北、东南、东北、西南、西北 之一' },
        { name: 'yi', type: 'array', desc: '今日宜：3 项不重复的日常活动（字符串数组），如“早睡早起”' },
        { name: 'ji', type: 'array', desc: '今日忌：3 项不重复的日常活动（字符串数组），如“熬夜”' },
        { name: 'notice', type: 'string', desc: '固定提示语：结果仅供娱乐，请勿当真' },
      ],
      async handler({ query, ip }) {
        const raw = param(query, 'name', { max: 20 });
        const date = todayBeijing();
        if (raw != null) {
          const key = normalizeName(raw);
          if (!key) throw new HttpError(400, 'name 不能只包含空白');
          return { data: buildFortune(`name:${key}`, date, { name: raw.trim(), basis: 'name' }) };
        }
        return { data: buildFortune(`ip:${ip || 'unknown'}`, date, { name: null, basis: 'ip' }) };
      },
    },
  ],
};

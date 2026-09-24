import { HttpError, param } from '../../lib/http.js';
import { LINGQIAN_SETS } from './data/lingqian.js';
import { pick } from './seeded.js';

export const LINGQIAN_TYPES = Object.keys(LINGQIAN_SETS);

const noticeFor = (item) => (item.verified
  ? '签文为传统文本，本签文字有把握与通行本一致（未与印本逐字比对）；白话解读仅供娱乐参考'
  : '签文为传统文本，本签尚未与底本逐字核对（verified=false），签号归属与用字可能与通行本有出入；解读仅供娱乐参考');

// 已收录原文（poem 不为 null）的签
export const availableItems = (type) => LINGQIAN_SETS[type].items.filter((x) => x.poem);

export function drawLingqian(type, no = null, rand = Math.random) {
  const set = LINGQIAN_SETS[type];
  if (!set) throw new HttpError(400, `type 只能是 ${LINGQIAN_TYPES.join(' / ')}`);
  const pool = set.items.filter((x) => x.poem);
  if (!pool.length) throw new HttpError(503, `${set.name}原文尚未收录（待对照底本核对后补充），暂不可用`);
  let item;
  if (no == null) {
    item = pick(pool, rand);
  } else {
    if (!Number.isInteger(no) || no < 1 || no > set.total) throw new HttpError(400, `no 须为 1~${set.total} 之间的整数`);
    item = set.items.find((x) => x.no === no);
    if (!item?.poem) throw new HttpError(404, `${set.name}第 ${no} 签原文尚未收录（待对照底本核对后补充），可不传 no 随机抽取`);
  }
  return {
    type,
    typeName: set.name,
    no: item.no,
    total: set.total,
    random: no == null,
    level: item.level,
    title: item.title,
    poem: [...item.poem],
    explain: item.explain,
    detail: item.detail,
    verified: item.verified,
    notice: noticeFor(item),
  };
}

export default {
  name: 'lingqian',
  category: 'fun',
  title: '灵签',
  description: '抽取或查询观音灵签（100 签），返回吉凶、签题、签诗、解曰与白话解读。文昌帝君灵签原文暂未收录。仅供娱乐',
  source: '传统签文（公有领域，部分待核对）',
  routes: [
    {
      method: 'GET',
      path: '/api/lingqian',
      summary: '抽签或按签号查询灵签',
      params: [
        {
          name: 'type',
          required: false,
          default: 'guanyin',
          desc: '灵签种类：guanyin（观音灵签，100 签）、wencheng（文昌帝君灵签，原文尚未收录，目前固定返回 HTTP 503）',
          example: 'guanyin',
        },
        {
          name: 'no',
          required: false,
          desc: '签号（观音灵签 1~100）。不传则从已收录原文的签中随机抽一签；指定的签原文尚未收录时返回 HTTP 404',
          example: '1',
        },
      ],
      fields: [
        { name: 'type', type: 'string', desc: '灵签种类：guanyin（观音灵签）' },
        { name: 'typeName', type: 'string', desc: '灵签种类中文名，如 观音灵签' },
        { name: 'no', type: 'number', desc: '签号，从 1 开始' },
        { name: 'total', type: 'number', desc: '该种灵签的总签数（观音灵签为 100）' },
        { name: 'random', type: 'boolean', desc: '是否为随机抽取：未传 no 时为 true，按签号查询时为 false' },
        {
          name: 'level',
          type: 'string|null',
          desc: '吉凶等级（传统签文原有，如 上上、上吉、中吉、中平、下下）；该签的吉凶原文尚未收录时为 null',
        },
        { name: 'title', type: 'string|null', desc: '签题（典故），如 钟离成道；该签的签题尚未收录时为 null' },
        { name: 'poem', type: 'array', desc: '签诗，按句拆分的字符串数组（通常 4 句七言），不含标点' },
        { name: 'explain', type: 'string|null', desc: '解曰（传统解签语，如“此卦……之象，……也”）；该签的解曰尚未收录时为 null' },
        {
          name: 'detail',
          type: 'string|null',
          desc: '详解：本项目根据签诗撰写的白话解读，不属于传统签文，也不在 verified 的核对范围内；没有解读时为 null',
        },
        {
          name: 'verified',
          type: 'boolean',
          desc: '本签传统文本的可信程度（全部签文均凭记忆整理，未与印本逐字比对）。'
            + 'true：有把握签题、吉凶、签诗、解曰（非 null 的部分）与通行本一致；'
            + 'false：没有把握，尚未与底本逐字核对，签号归属、签题和个别用字都可能与通行本有出入，请谨慎引用',
        },
        { name: 'notice', type: 'string', desc: '提示语：说明本签文字的可信程度（对应 verified），并提示白话解读仅供娱乐参考' },
      ],
      async handler({ query }) {
        const type = param(query, 'type', { default: 'guanyin', oneOf: LINGQIAN_TYPES });
        const total = LINGQIAN_SETS[type].total;
        // 种类未收录时 total 为 null，drawLingqian 会返回 503；这里只在签数已知时校验 no
        const no = total ? param(query, 'no', { int: true, min: 1, max: total }) : null;
        return { data: drawLingqian(type, no ?? null), updatedAt: new Date().toISOString() };
      },
    },
  ],
};

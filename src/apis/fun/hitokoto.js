import { fetchJSON, HttpError, param } from '../../lib/http.js';

const UPSTREAM = 'https://v1.hitokoto.cn/';

export const HITOKOTO_TYPES = {
  a: '动画', b: '漫画', c: '游戏', d: '文学', e: '原创', f: '来自网络',
  g: '其他', h: '影视', i: '诗词', j: '网易云', k: '哲学', l: '抖机灵',
};

// 上游不可用时的内置兜底
export const FALLBACK_HITOKOTO = [
  { type: 'a', hitokoto: '真相只有一个！', from: '名侦探柯南', from_who: '江户川柯南' },
  { type: 'a', hitokoto: '我是要成为海贼王的男人！', from: '海贼王', from_who: '蒙奇·D·路飞' },
  { type: 'a', hitokoto: '人的梦想，是不会终结的！', from: '海贼王', from_who: '马歇尔·D·蒂奇' },
  { type: 'a', hitokoto: '只要有想见的人，就不再是孤单一人。', from: '夏目友人帐', from_who: null },
  { type: 'b', hitokoto: '我要成为火影！', from: '火影忍者', from_who: '漩涡鸣人' },
  { type: 'b', hitokoto: '你已经死了。', from: '北斗神拳', from_who: '健次郎' },
  { type: 'c', hitokoto: 'El Psy Kongroo.', from: '命运石之门', from_who: '冈部伦太郎' },
  { type: 'c', hitokoto: '战争，战争从未改变。', from: '辐射', from_who: null },
  { type: 'd', hitokoto: '世界上只有一种英雄主义，就是在认清生活真相之后依然热爱生活。', from: '米开朗琪罗传', from_who: '罗曼·罗兰' },
  { type: 'd', hitokoto: '我们都在阴沟里，但仍有人仰望星空。', from: '温德米尔夫人的扇子', from_who: '王尔德' },
  { type: 'd', hitokoto: '所有的大人都曾经是小孩，虽然只有少数人记得。', from: '小王子', from_who: '圣埃克苏佩里' },
  { type: 'd', hitokoto: '黑夜给了我黑色的眼睛，我却用它寻找光明。', from: '一代人', from_who: '顾城' },
  { type: 'd', hitokoto: '从明天起，做一个幸福的人。', from: '面朝大海，春暖花开', from_who: '海子' },
  { type: 'e', hitokoto: '慢慢来，比较快。', from: 'API Hub', from_who: null },
  { type: 'f', hitokoto: 'Stay hungry, stay foolish.', from: '斯坦福大学毕业演讲', from_who: '史蒂夫·乔布斯' },
  { type: 'h', hitokoto: '希望是个好东西，也许是世间最好的东西，好东西是不会消逝的。', from: '肖申克的救赎', from_who: '安迪' },
  { type: 'h', hitokoto: '人生就像一盒巧克力，你永远不知道下一块会是什么味道。', from: '阿甘正传', from_who: '阿甘' },
  { type: 'h', hitokoto: '我命由我不由天。', from: '哪吒之魔童降世', from_who: '哪吒' },
  { type: 'h', hitokoto: '愿原力与你同在。', from: '星球大战', from_who: null },
  { type: 'i', hitokoto: '人生若只如初见，何事秋风悲画扇。', from: '木兰花·拟古决绝词柬友', from_who: '纳兰性德' },
  { type: 'i', hitokoto: '人生如逆旅，我亦是行人。', from: '临江仙·送钱穆父', from_who: '苏轼' },
  { type: 'i', hitokoto: '长风破浪会有时，直挂云帆济沧海。', from: '行路难', from_who: '李白' },
  { type: 'i', hitokoto: '路漫漫其修远兮，吾将上下而求索。', from: '离骚', from_who: '屈原' },
  { type: 'i', hitokoto: '且将新火试新茶，诗酒趁年华。', from: '望江南·超然台作', from_who: '苏轼' },
  { type: 'i', hitokoto: '山有木兮木有枝，心悦君兮君不知。', from: '越人歌', from_who: null },
  { type: 'j', hitokoto: '生活不止眼前的苟且，还有诗和远方的田野。', from: '生活不止眼前的苟且', from_who: '许巍' },
  { type: 'k', hitokoto: '知人者智，自知者明。', from: '道德经', from_who: '老子' },
  { type: 'k', hitokoto: '学而不思则罔，思而不学则殆。', from: '论语', from_who: '孔子' },
  { type: 'k', hitokoto: '我思故我在。', from: '谈谈方法', from_who: '笛卡尔' },
  { type: 'k', hitokoto: '人不能两次踏进同一条河流。', from: '残篇', from_who: '赫拉克利特' },
  { type: 'l', hitokoto: '人生苦短，我用 Python。', from: '网络', from_who: null },
  { type: 'l', hitokoto: '代码写得好，下班走得早。', from: '网络', from_who: null },
];

// "a,b" / "ab" → ['a','b']
export function parseTypes(raw) {
  if (!raw) return [];
  const list = [...new Set(raw.toLowerCase().replace(/[\s,|]/g, '').split(''))];
  if (!list.every((t) => t in HITOKOTO_TYPES)) throw new HttpError(400, 'type 只能是 a~l 的字母，多个用逗号分隔');
  return list;
}

export function buildHitokotoUrl(types = []) {
  const qs = new URLSearchParams({ encode: 'json', charset: 'utf-8' });
  for (const t of types) qs.append('c', t);
  return `${UPSTREAM}?${qs}`;
}

export function parseHitokoto(raw) {
  if (!raw || typeof raw.hitokoto !== 'string') throw new HttpError(502, '一言返回的数据格式无法识别');
  return {
    id: raw.id ?? null,
    uuid: raw.uuid ?? null,
    hitokoto: raw.hitokoto,
    type: raw.type,
    typeName: HITOKOTO_TYPES[raw.type] ?? '其他',
    from: raw.from ?? null,
    fromWho: raw.from_who ?? null,
    creator: raw.creator ?? null,
    length: raw.length ?? [...raw.hitokoto].length,
    url: raw.uuid ? `https://hitokoto.cn/?uuid=${raw.uuid}` : null,
    fallback: false,
  };
}

export function pickFallbackHitokoto(types = [], rand = Math.random) {
  const pool = types.length ? FALLBACK_HITOKOTO.filter((h) => types.includes(h.type)) : FALLBACK_HITOKOTO;
  const list = pool.length ? pool : FALLBACK_HITOKOTO;
  const h = list[Math.floor(rand() * list.length)];
  return {
    id: null, uuid: null, hitokoto: h.hitokoto, type: h.type, typeName: HITOKOTO_TYPES[h.type],
    from: h.from, fromWho: h.from_who, creator: null, length: [...h.hitokoto].length, url: null, fallback: true,
  };
}

export async function loadHitokoto(types = []) {
  try {
    return parseHitokoto(await fetchJSON(buildHitokotoUrl(types), { timeoutMs: 5000 }));
  } catch {
    return pickFallbackHitokoto(types);
  }
}

export default {
  name: 'hitokoto',
  category: 'fun',
  title: '一言',
  description: '随机返回一句动漫、文学、诗词、哲学等分类的句子',
  source: 'Hitokoto 一言',
  routes: [
    {
      method: 'GET',
      path: '/api/hitokoto',
      summary: '随机一言，上游不可用时返回内置句子',
      params: [
        {
          name: 'type',
          required: false,
          desc: '分类，可多选（逗号分隔）：' + Object.entries(HITOKOTO_TYPES).map(([k, v]) => `${k}=${v}`).join(' '),
          example: 'a,d',
        },
      ],
      async handler({ query }) {
        const types = parseTypes(param(query, 'type', { max: 30 }));
        // 随机接口不缓存
        return { data: await loadHitokoto(types), updatedAt: new Date().toISOString() };
      },
    },
  ],
};

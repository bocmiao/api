import { fetchJSON, HttpError } from '../../lib/http.js';

const UPSTREAM = 'https://v1.jinrishici.com/all.json';

export const FALLBACK_POEMS = [
  { content: '床前明月光，疑是地上霜。', title: '静夜思', author: '李白', dynasty: '唐' },
  { content: '人生得意须尽欢，莫使金樽空对月。', title: '将进酒', author: '李白', dynasty: '唐' },
  { content: '长风破浪会有时，直挂云帆济沧海。', title: '行路难·其一', author: '李白', dynasty: '唐' },
  { content: '会当凌绝顶，一览众山小。', title: '望岳', author: '杜甫', dynasty: '唐' },
  { content: '随风潜入夜，润物细无声。', title: '春夜喜雨', author: '杜甫', dynasty: '唐' },
  { content: '海内存知己，天涯若比邻。', title: '送杜少府之任蜀州', author: '王勃', dynasty: '唐' },
  { content: '落霞与孤鹜齐飞，秋水共长天一色。', title: '滕王阁序', author: '王勃', dynasty: '唐' },
  { content: '红豆生南国，春来发几枝。', title: '相思', author: '王维', dynasty: '唐' },
  { content: '大漠孤烟直，长河落日圆。', title: '使至塞上', author: '王维', dynasty: '唐' },
  { content: '野火烧不尽，春风吹又生。', title: '赋得古原草送别', author: '白居易', dynasty: '唐' },
  { content: '同是天涯沦落人，相逢何必曾相识。', title: '琵琶行', author: '白居易', dynasty: '唐' },
  { content: '春眠不觉晓，处处闻啼鸟。', title: '春晓', author: '孟浩然', dynasty: '唐' },
  { content: '欲穷千里目，更上一层楼。', title: '登鹳雀楼', author: '王之涣', dynasty: '唐' },
  { content: '身无彩凤双飞翼，心有灵犀一点通。', title: '无题·昨夜星辰昨夜风', author: '李商隐', dynasty: '唐' },
  { content: '此情可待成追忆，只是当时已惘然。', title: '锦瑟', author: '李商隐', dynasty: '唐' },
  { content: '停车坐爱枫林晚，霜叶红于二月花。', title: '山行', author: '杜牧', dynasty: '唐' },
  { content: '但愿人长久，千里共婵娟。', title: '水调歌头·明月几时有', author: '苏轼', dynasty: '宋' },
  { content: '竹杖芒鞋轻胜马，谁怕？一蓑烟雨任平生。', title: '定风波·莫听穿林打叶声', author: '苏轼', dynasty: '宋' },
  { content: '横看成岭侧成峰，远近高低各不同。', title: '题西林壁', author: '苏轼', dynasty: '宋' },
  { content: '众里寻他千百度，蓦然回首，那人却在，灯火阑珊处。', title: '青玉案·元夕', author: '辛弃疾', dynasty: '宋' },
  { content: '醉里挑灯看剑，梦回吹角连营。', title: '破阵子·为陈同甫赋壮词以寄之', author: '辛弃疾', dynasty: '宋' },
  { content: '寻寻觅觅，冷冷清清，凄凄惨惨戚戚。', title: '声声慢·寻寻觅觅', author: '李清照', dynasty: '宋' },
  { content: '莫道不销魂，帘卷西风，人比黄花瘦。', title: '醉花阴·薄雾浓云愁永昼', author: '李清照', dynasty: '宋' },
  { content: '山重水复疑无路，柳暗花明又一村。', title: '游山西村', author: '陆游', dynasty: '宋' },
  { content: '问渠那得清如许？为有源头活水来。', title: '观书有感·其一', author: '朱熹', dynasty: '宋' },
  { content: '人生自古谁无死？留取丹心照汗青。', title: '过零丁洋', author: '文天祥', dynasty: '宋' },
  { content: '无可奈何花落去，似曾相识燕归来。', title: '浣溪沙·一曲新词酒一杯', author: '晏殊', dynasty: '宋' },
  { content: '采菊东篱下，悠然见南山。', title: '饮酒·其五', author: '陶渊明', dynasty: '魏晋' },
  { content: '枯藤老树昏鸦，小桥流水人家。', title: '天净沙·秋思', author: '马致远', dynasty: '元' },
  { content: '人生若只如初见，何事秋风悲画扇。', title: '木兰花·拟古决绝词柬友', author: '纳兰性德', dynasty: '清' },
  { content: '关关雎鸠，在河之洲。窈窕淑女，君子好逑。', title: '关雎', author: '佚名', dynasty: '先秦' },
];

const EXTRA_DYNASTY = {
  唐: '王昌龄 岑参 高适 刘禹锡 柳宗元 韩愈 贺知章 温庭筠 元稹 李贺 张九龄 崔颢 韦应物 王翰 张继 杜秋娘 刘长卿',
  五代: '李煜 韦庄 冯延巳',
  宋: '柳永 欧阳修 范仲淹 王安石 秦观 周邦彦 姜夔 杨万里 黄庭坚 晏几道 岳飞 张先 贺铸 蒋捷 吴文英 叶绍翁 林升',
  元: '关汉卿 白朴 张养浩 王实甫',
  明: '杨慎 于谦 唐寅 汤显祖',
  清: '龚自珍 郑燮 袁枚 曹雪芹 仓央嘉措',
  两汉: '曹操 刘邦 司马迁 班固',
  魏晋: '曹植 曹丕 谢灵运 王羲之',
  先秦: '屈原 孔子 老子 庄子 孟子',
};
const AUTHOR_DYNASTY = new Map([
  ...Object.entries(EXTRA_DYNASTY).flatMap(([d, names]) => names.split(' ').map((n) => [n, d])),
  ...FALLBACK_POEMS.filter((p) => p.author !== '佚名').map((p) => [p.author, p.dynasty]),
]);

// all.json: { content, origin, author, category }，不含朝代
export function parsePoem(raw) {
  if (!raw || typeof raw.content !== 'string' || !raw.content) throw new HttpError(502, '今日诗词返回的数据格式无法识别');
  return {
    content: raw.content,
    title: raw.origin ?? null,
    author: raw.author ?? null,
    dynasty: AUTHOR_DYNASTY.get(raw.author) ?? null,
    category: raw.category ?? null,
    fallback: false,
  };
}

export function pickFallbackPoem(rand = Math.random) {
  const p = FALLBACK_POEMS[Math.floor(rand() * FALLBACK_POEMS.length)];
  return { ...p, category: null, fallback: true };
}

export async function loadPoem() {
  try {
    return parsePoem(await fetchJSON(UPSTREAM, { timeoutMs: 5000 }));
  } catch {
    return pickFallbackPoem();
  }
}

export default {
  name: 'poem',
  category: 'fun',
  title: '每日诗词',
  description: '随机一句古诗词，含标题、作者与朝代',
  source: '今日诗词 jinrishici.com',
  routes: [
    {
      method: 'GET',
      path: '/api/poem',
      summary: '随机古诗词名句，上游不可用时返回内置诗句',
      params: [],
      async handler() {
        return { data: await loadPoem(), updatedAt: new Date().toISOString() };
      },
    },
  ],
};

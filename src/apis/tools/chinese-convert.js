import fs from 'node:fs';
import { HttpError, param } from '../../lib/http.js';
import { lazy } from '../fun/lazy-json.js';

// 简繁对照表来自 OpenCC（Apache-2.0，见 data/opencc/LICENSE），约 50KB，第一次转换时才读入。
// 没用汉字字典（fun/data/dict/hanzi.json）里的繁体字段：那份数据只覆盖约 1300 字（“国”“时”“长”都没有），
// 且近一半是编码错位的错字（如“觉”记作“觴”、“进”记作“適”），拿来做转换会出错。
// 文件格式：条目以空格分隔，每条首字为原字，其后为候选（第一个为默认），见 data/opencc/LICENSE 说明。
const tables = lazy(() => {
  const raw = JSON.parse(fs.readFileSync(new URL('./data/opencc/chars.json', import.meta.url), 'utf8'));
  const parse = (s) => new Map(s.split(' ').map((entry) => {
    const [key, ...candidates] = [...entry];
    return [key, candidates];
  }));
  return { st: parse(raw.st), ts: parse(raw.ts) };
});

// 常见一简对多繁的词：逐字转换会选错的（如“头发”按字会成“頭發”），按词覆盖。只收读法、写法无争议的常用词。
// “面”在 OpenCC 默认表里是“麪”，这里按港台通行写法用“麵”（两者是异体，“麵”更常见）。
export const PHRASES_S2T = {
  // 发 → 髮（头发）
  头发: '頭髮', 理发: '理髮', 发型: '髮型', 白发: '白髮', 假发: '假髮', 染发: '染髮', 洗发: '洗髮', 毛发: '毛髮',
  短发: '短髮', 长发: '長髮', 秀发: '秀髮', 发廊: '髮廊', 发丝: '髮絲', 发夹: '髮夾', 理发店: '理髮店', 洗发水: '洗髮水',
  // 发 → 發（与默认一致，列出便于对照）
  发展: '發展', 出发: '出發', 发现: '發現',
  // 面 → 麵（面食）
  面条: '麵條', 面包: '麵包', 面粉: '麵粉', 方便面: '方便麵', 拉面: '拉麵', 面食: '麵食', 挂面: '掛麵', 炒面: '炒麵', 泡面: '泡麵',
  // 后 → 后（皇后）
  皇后: '皇后', 王后: '王后', 太后: '太后', 后妃: '后妃',
  // 干 → 乾 / 干
  干净: '乾淨', 干燥: '乾燥', 饼干: '餅乾', 干杯: '乾杯', 干旱: '乾旱', 干脆: '乾脆', 晒干: '曬乾', 干涉: '干涉', 干扰: '干擾',
  干预: '干預', 若干: '若干', 相干: '相干',
  // 历 → 曆（历法）
  日历: '日曆', 农历: '農曆', 阳历: '陽曆', 阴历: '陰曆', 公历: '公曆', 历法: '曆法', 挂历: '掛曆',
  // 台 → 颱 / 檯
  台风: '颱風', 台灯: '檯燈', 柜台: '櫃檯', 吧台: '吧檯',
  // 只 → 隻（量词）
  一只: '一隻', 两只: '兩隻', 几只: '幾隻', 船只: '船隻',
  // 系 → 係 / 繫
  关系: '關係', 联系: '聯繫', 维系: '維繫',
  // 复 → 複 / 覆
  复杂: '複雜', 重复: '重複', 复制: '複製', 复印: '複印', 复数: '複數', 复合: '複合', 答复: '答覆', 反复: '反覆',
  // 钟 → 鐘（钟表），默认是“鍾”
  时钟: '時鐘', 闹钟: '鬧鐘', 分钟: '分鐘', 钟表: '鐘錶', 钟头: '鐘頭', 钟声: '鐘聲', 点钟: '點鐘',
  // 表 → 錶
  手表: '手錶',
  // 准 → 准（批准）
  批准: '批准', 准许: '准許', 不准: '不准',
  // 冲 → 沖
  冲洗: '沖洗', 冲泡: '沖泡',
  // 松 → 鬆
  放松: '放鬆', 轻松: '輕鬆', 宽松: '寬鬆', 松开: '鬆開', 蓬松: '蓬鬆', 松散: '鬆散',
  // 斗 → 斗（非“鬥”）
  北斗: '北斗', 漏斗: '漏斗', 熨斗: '熨斗',
  // 谷 → 穀
  稻谷: '稻穀', 谷物: '穀物', 五谷: '五穀',
  // 获 → 穫
  收获: '收穫',
  // 尽 → 儘
  尽管: '儘管', 尽量: '儘量', 尽快: '儘快', 尽早: '儘早',
  // 签 → 簽
  签名: '簽名', 签字: '簽字', 签证: '簽證', 签署: '簽署', 签约: '簽約', 签到: '簽到',
  // 胡 → 鬍
  胡子: '鬍子', 胡须: '鬍鬚',
  // 汇 → 彙
  词汇: '詞彙',
  // 征 → 征（征战）
  征服: '征服', 长征: '長征', 出征: '出征',
  // 制 → 製
  制造: '製造', 制作: '製作', 制品: '製品', 印制: '印製', 绘制: '繪製',
  // 志 → 誌
  杂志: '雜誌', 日志: '日誌',
  // 借 → 藉
  借口: '藉口', 凭借: '憑藉',
  // 游 → 游（水中）
  游泳: '游泳', 上游: '上游', 下游: '下游',
  // 恶 → 噁
  恶心: '噁心',
  // 致 → 緻
  精致: '精緻', 细致: '細緻',
  // 划 → 划（划船）
  划船: '划船', 划算: '划算',
  // 云 → 云（说）
  人云亦云: '人云亦云',
  // 几 → 几（茶几）
  茶几: '茶几',
  // 周 → 週
  周末: '週末', 周年: '週年',
  // 采 → 采（神采）
  神采: '神采', 风采: '風采',
  // 家 → 傢
  家具: '傢俱', 家伙: '傢伙',
  // 御 → 禦
  防御: '防禦', 抵御: '抵禦',
  // 愿 → 願（默认已是），欲 → 慾
  食欲: '食慾', 欲望: '慾望',
  // 占 → 占（占卜）
  占卜: '占卜',
};

// 繁→简：逐字表里一繁对多简、默认会选错的词
export const PHRASES_T2S = {
  乾隆: '乾隆', 乾坤: '乾坤', 瞭解: '了解', 明瞭: '明了', 瞭望: '瞭望',
};

const phraseTable = (obj) => {
  const map = new Map(Object.entries(obj));
  const maxLen = Math.max(...Object.keys(obj).map((k) => [...k].length));
  return { map, maxLen };
};
const PHRASE = { traditional: phraseTable(PHRASES_S2T), simplified: phraseTable(PHRASES_T2S) };

export const MAX_TEXT = 5000;

// 单个繁体字对应的简体字（没有对应时返回原字），供拼音等模块查字典时回退用
export const toSimplifiedChar = (c) => tables().ts.get(c)?.[0] ?? c;

// 转换：词表优先（最长匹配），其余逐字查表；不在表里的字（含标点、英文）原样保留
export function convertChinese(input, to = 'traditional') {
  if (!['traditional', 'simplified'].includes(to)) throw new HttpError(400, 'to 只能是 traditional / simplified');
  const chars = [...String(input ?? '')];
  if (!chars.length) throw new HttpError(400, 'text 不能为空');
  if (chars.length > MAX_TEXT) throw new HttpError(400, `text 过长（最多 ${MAX_TEXT} 个字）`);
  const table = to === 'traditional' ? tables().st : tables().ts;
  const { map: phrases, maxLen } = PHRASE[to];

  const out = [];
  const ambiguous = new Map();
  let changed = 0;
  let phraseHits = 0;
  for (let i = 0; i < chars.length;) {
    let hit = null;
    for (let len = Math.min(maxLen, chars.length - i); len >= 2 && !hit; len--) {
      const key = chars.slice(i, i + len).join('');
      if (phrases.has(key)) hit = [key, phrases.get(key), len];
    }
    if (hit) {
      const [, value, len] = hit;
      const target = [...value];
      for (let k = 0; k < len; k++) if (target[k] !== chars[i + k]) changed++;
      out.push(value);
      phraseHits++;
      i += len;
      continue;
    }
    const c = chars[i];
    const candidates = table.get(c);
    if (candidates) {
      const chosen = candidates[0];
      if (chosen !== c) changed++;
      if (candidates.length > 1 && !ambiguous.has(c)) ambiguous.set(c, { char: c, chosen, candidates });
      out.push(chosen);
    } else {
      out.push(c);
    }
    i++;
  }
  return {
    to,
    text: out.join(''),
    length: chars.length,
    changed,
    phraseMatches: phraseHits,
    ambiguous: [...ambiguous.values()],
  };
}

export default {
  name: 'chinese-convert',
  category: 'tools',
  title: '简繁转换',
  description: '简体中文与繁体中文互相转换，内置常用词的一简对多繁修正（如“头发→頭髮”），并列出无法确定写法的字供核对',
  source: '本地转换，字表来自 OpenCC（Apache-2.0）',
  routes: [
    {
      method: 'GET',
      path: '/api/chinese/convert',
      summary: '简体转繁体或繁体转简体',
      params: [
        { name: 'text', required: true, desc: `要转换的文本，最多 ${MAX_TEXT} 个字；标点、英文、数字原样保留`, example: '头发和面条的发展时间' },
        { name: 'to', default: 'traditional', desc: '转换方向：traditional（简→繁）/ simplified（繁→简）', example: 'traditional' },
      ],
      fields: [
        { name: 'to', type: 'string', desc: '转换方向：traditional / simplified' },
        { name: 'text', type: 'string', desc: '转换结果。先按内置常用词表整词替换（如“头发→頭髮”“面条→麵條”），其余逐字按默认对应字转换；繁体采用 OpenCC 标准字形（如“里→裏”），不做台湾/香港用词转换（如“软件”不会变成“軟體”）' },
        { name: 'length', type: 'number', desc: '输入的字符数（按 Unicode 码位计）' },
        { name: 'changed', type: 'number', desc: '被改写的字数' },
        { name: 'phraseMatches', type: 'number', desc: '命中内置词表的次数' },
        { name: 'ambiguous', type: 'array', desc: '一字对多字、按默认写法转换的字（已被词表处理的不计入），每个字只列一次，建议人工核对；如简体“发”可能是“發”或“髮”' },
        { name: 'ambiguous[].char', type: 'string', desc: '原文中的字' },
        { name: 'ambiguous[].chosen', type: 'string', desc: '本次采用的写法（候选中的第一个）' },
        { name: 'ambiguous[].candidates', type: 'array', desc: '全部候选写法，第一个为默认' },
      ],
      async handler({ query }) {
        const text = param(query, 'text', { required: true, max: MAX_TEXT * 2 });
        const to = param(query, 'to', { default: 'traditional', oneOf: ['traditional', 'simplified'] });
        return { data: convertChinese(text, to) };
      },
    },
  ],
};

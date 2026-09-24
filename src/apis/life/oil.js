import { cache } from '../../lib/cache.js';
import { fetchText, HttpError, param, stripTags } from '../../lib/http.js';

// 省份 → qiyoujiage.com 页面路径
export const PROVINCES = {
  北京: 'beijing', 天津: 'tianjin', 上海: 'shanghai', 重庆: 'chongqing', 河北: 'hebei', 山西: 'shanxi',
  内蒙古: 'neimenggu', 辽宁: 'liaoning', 吉林: 'jilin', 黑龙江: 'heilongjiang', 江苏: 'jiangsu', 浙江: 'zhejiang',
  安徽: 'anhui', 福建: 'fujian', 江西: 'jiangxi', 山东: 'shandong', 河南: 'henan', 湖北: 'hubei', 湖南: 'hunan',
  广东: 'guangdong', 广西: 'guangxi', 海南: 'hainan', 四川: 'sichuan', 贵州: 'guizhou', 云南: 'yunnan',
  西藏: 'xizang', 陕西: 'shaanxi', 甘肃: 'gansu', 青海: 'qinghai', 宁夏: 'ningxia', 新疆: 'xinjiang',
};

export function normalizeProvince(input) {
  const s = input.trim().replace(/(省|市|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区)$/, '');
  return PROVINCES[s] ? s : null;
}

const GRADE_KEYS = { 92: 'p92', 95: 'p95', 98: 'p98', 0: 'p0' };

// 页面片段：<dl><dt>北京92#汽油</dt><dd>7.39</dd></dl> ...
export function parseOilPage(html, province) {
  const prices = { p92: null, p95: null, p98: null, p0: null };
  for (const m of html.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)) {
    const label = stripTags(m[1]);
    const g = /(\d{1,2})\s*[#号]\s*(汽油|柴油)/.exec(label);
    const v = Number.parseFloat(stripTags(m[2]));
    if (!g || !Number.isFinite(v)) continue;
    const key = GRADE_KEYS[g[1]];
    if (key && prices[key] == null) prices[key] = v;
  }
  if (Object.values(prices).every((v) => v == null)) throw new HttpError(502, '油价页面结构已变化，无法解析');
  const text = stripTags(html);
  const next = /下次油价[^。，,<]{0,20}?(\d{1,2}月\d{1,2}日\s*\d{1,2}时)\s*调整/.exec(text);
  const trend = /(预计[^。<]{0,60}?(?:上调|下调|搁浅|不调)[^。<，,]{0,40})/.exec(text);
  return {
    province,
    unit: '元/升',
    prices,
    nextAdjust: next ? next[1].replace(/\s+/g, '') : null,
    trend: trend ? trend[1].trim() : null,
  };
}

export async function loadOilPrice(province) {
  const slug = PROVINCES[province];
  return cache.wrap(`oil:${slug}`, 3 * 3600_000, async () =>
    parseOilPage(await fetchText(`http://www.qiyoujiage.com/${slug}.shtml`), province));
}

export default {
  name: 'oil',
  category: 'life',
  title: '今日油价',
  description: '各省 92/95/98 号汽油与 0 号柴油零售限价，及下次调价窗口',
  source: '汽油价格网 qiyoujiage.com（网页抓取）',
  unofficial: true,
  routes: [
    {
      method: 'GET',
      path: '/api/oil',
      summary: '查询某省今日油价',
      params: [{ name: 'province', default: '北京', desc: '省份名，如 北京、广东、内蒙古', example: '广东' }],
      async handler({ query }) {
        const raw = param(query, 'province', { default: '北京', max: 12 });
        const province = normalizeProvince(raw);
        if (!province) throw new HttpError(400, `不支持的省份：${raw}，可选：${Object.keys(PROVINCES).join('、')}`);
        return loadOilPrice(province);
      },
    },
  ],
};

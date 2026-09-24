import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError, param } from '../../lib/http.js';

const PHONE_RE = /^1[3-9]\d{9}$/;

// 号段 → 运营商（上游缺失时兜底；携号转网后以上游为准也可能不准）
const SEGMENTS = {
  中国移动: ['134', '135', '136', '137', '138', '139', '147', '148', '150', '151', '152', '157', '158', '159', '172', '178', '182', '183', '184', '187', '188', '195', '197', '198'],
  中国联通: ['130', '131', '132', '145', '146', '155', '156', '166', '167', '171', '175', '176', '185', '186', '196'],
  中国电信: ['133', '149', '153', '173', '174', '177', '180', '181', '189', '190', '191', '193', '199'],
  中国广电: ['192'],
};
const VIRTUAL = ['170', '162', '165', '167', '171'];

export function carrierBySegment(number) {
  const p3 = number.slice(0, 3);
  if (p3 === '170' || p3 === '162' || p3 === '165') return '虚拟运营商';
  for (const [name, list] of Object.entries(SEGMENTS)) if (list.includes(p3)) return name;
  return null;
}

const SP_MAP = { 移动: '中国移动', 联通: '中国联通', 电信: '中国电信', 广电: '中国广电' };

// 360：{ code: 0, data: { province, city, sp } }
export function parse360(raw, number) {
  if (!raw || Number(raw.code) !== 0 || !raw.data) throw new HttpError(502, '号码归属地查询失败');
  const { province = '', city = '', sp = '' } = raw.data;
  if (!province && !city && !sp) throw new HttpError(404, '未查到该号码的归属地');
  const carrier = SP_MAP[sp] ?? (sp || carrierBySegment(number));
  return {
    number,
    segment: number.slice(0, 7),
    province: province || null,
    city: city || province || null, // 直辖市上游 city 为空
    carrier,
    virtual: VIRTUAL.includes(number.slice(0, 3)),
    location: [province, city].filter((x, i, a) => x && a.indexOf(x) === i).join(' '),
  };
}

export async function loadPhoneArea(number) {
  const seg = number.slice(0, 7);
  // 归属地只取决于前 7 位号段，按号段缓存
  const res = await cache.wrap(`phone:${seg}`, 7 * 86_400_000, async () =>
    parse360(await fetchJSON(`https://cx.shouji.360.cn/phonearea.php?number=${encodeURIComponent(number)}`), number));
  return { ...res, data: { ...res.data, number } };
}

export default {
  name: 'phone',
  category: 'life',
  title: '手机号归属地',
  description: '查询中国大陆手机号的归属省市与运营商',
  source: '360 手机号码归属地（非官方）',
  unofficial: true,
  routes: [
    {
      method: 'GET',
      path: '/api/phone',
      summary: '查询手机号归属地与运营商',
      params: [{ name: 'number', required: true, desc: '11 位中国大陆手机号', example: '13800138000' }],
      async handler({ query }) {
        const number = param(query, 'number', { required: true }).replace(/[\s-]/g, '').replace(/^(\+?86)(?=1\d{10}$)/, '');
        if (!PHONE_RE.test(number)) throw new HttpError(400, 'number 须为 11 位中国大陆手机号');
        return loadPhoneArea(number);
      },
    },
  ],
};

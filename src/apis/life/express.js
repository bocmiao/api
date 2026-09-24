import { createHash } from 'node:crypto';
import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError, param, requireEnv } from '../../lib/http.js';

const QUERY_URL = 'https://poll.kuaidi100.com/poll/query.do';
const AUTO_URL = 'https://www.kuaidi100.com/autonumber/auto';

// 常用快递公司编码（快递100 com 参数）
export const COMPANIES = [
  { code: 'shunfeng', name: '顺丰速运', needPhone: true },
  { code: 'zhongtong', name: '中通快递' },
  { code: 'yuantong', name: '圆通速递' },
  { code: 'shentong', name: '申通快递' },
  { code: 'yunda', name: '韵达快递' },
  { code: 'jtexpress', name: '极兔速递' },
  { code: 'youzhengguonei', name: '邮政快递包裹' },
  { code: 'ems', name: 'EMS' },
  { code: 'jd', name: '京东物流' },
  { code: 'debangkuaidi', name: '德邦快递' },
  { code: 'debangwuliu', name: '德邦物流' },
  { code: 'zhongtongkuaiyun', name: '中通快运' },
  { code: 'annengwuliu', name: '安能物流' },
  { code: 'baishiwuliu', name: '百世快运' },
  { code: 'huitongkuaidi', name: '百世快递' },
  { code: 'danniao', name: '丹鸟' },
  { code: 'fengwang', name: '丰网速运' },
  { code: 'zhaijisong', name: '宅急送' },
  { code: 'kuayue', name: '跨越速运' },
  { code: 'yimidida', name: '壹米滴答' },
  { code: 'sxjdfreight', name: '顺心捷达' },
  { code: 'cainiao', name: '菜鸟速递' },
  { code: 'dhl', name: 'DHL' },
  { code: 'fedex', name: 'FedEx 国际' },
  { code: 'ups', name: 'UPS' },
  { code: 'usps', name: 'USPS' },
];

// 快递100 state 状态码
const STATE_TEXT = {
  0: '在途', 1: '揽收', 2: '疑难', 3: '签收', 4: '退签', 5: '派件', 6: '退回', 7: '转投', 8: '清关', 14: '拒签',
};

// sign = MD5(param + key + customer) 转大写
export function kuaidi100Sign(paramJson, key, customer) {
  return createHash('md5').update(paramJson + key + customer).digest('hex').toUpperCase();
}

export function buildQueryBody({ com, num, phone }, key, customer) {
  const p = { com, num, resultv2: '4', show: '0', order: 'desc' };
  if (phone) p.phone = phone;
  const paramJson = JSON.stringify(p);
  return new URLSearchParams({ customer, sign: kuaidi100Sign(paramJson, key, customer), param: paramJson }).toString();
}

export function parseKuaidi100(raw) {
  if (!raw || typeof raw !== 'object') throw new HttpError(502, '快递100 返回的数据格式无法识别');
  // 失败：{ result: false, returnCode: '400', message: '...' }
  if (raw.result === false || (raw.returnCode && raw.returnCode !== '200')) {
    const msg = raw.message || '查询失败';
    const code = String(raw.returnCode ?? '');
    if (code === '400' || code === '500') throw new HttpError(404, `快递100：${msg}`);
    throw new HttpError(502, `快递100：${msg}`);
  }
  if (!Array.isArray(raw.data)) throw new HttpError(502, '快递100 返回的数据格式无法识别');
  const company = COMPANIES.find((c) => c.code === raw.com);
  return {
    number: raw.nu,
    com: raw.com,
    company: company?.name ?? raw.com,
    state: Number(raw.state),
    stateText: STATE_TEXT[Number(raw.state)] ?? '未知',
    signed: raw.ischeck === '1',
    traces: raw.data.map((d) => ({
      time: d.ftime || d.time,
      context: d.context,
      location: d.location || d.areaName || null,
      status: d.status ?? null,
    })),
  };
}

// 智能单号识别：[{ comCode, lengthPre, noCount, noPre }]
export function parseAutoNumber(raw) {
  return Array.isArray(raw) ? raw.map((x) => x.comCode).filter(Boolean) : [];
}

async function detectCompany(num, key) {
  const res = await cache.wrap(`express:auto:${num}`, 86_400_000, async () =>
    parseAutoNumber(await fetchJSON(`${AUTO_URL}?num=${encodeURIComponent(num)}&key=${encodeURIComponent(key)}`)));
  if (!res.data.length) throw new HttpError(400, '无法识别快递公司，请传入 com 参数');
  return res.data[0];
}

export async function loadExpress({ number, com, phone }) {
  const key = requireEnv('KUAIDI100_KEY');
  const customer = requireEnv('KUAIDI100_CUSTOMER');
  const code = com || (await detectCompany(number, key));
  if (code.startsWith('shunfeng') && !phone) throw new HttpError(400, '顺丰单号需要提供收/寄件人手机号后四位（phone）');
  return cache.wrap(`express:${code}:${number}:${phone ?? ''}`, 10 * 60_000, async () =>
    parseKuaidi100(await fetchJSON(QUERY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: buildQueryBody({ com: code, num: number, phone }, key, customer),
    })));
}

export default {
  name: 'express',
  category: 'life',
  title: '快递查询',
  description: '通过快递100 查询物流轨迹，支持自动识别快递公司',
  source: '快递100',
  env: ['KUAIDI100_KEY', 'KUAIDI100_CUSTOMER'],
  routes: [
    {
      method: 'GET',
      path: '/api/express',
      summary: '查询快递物流轨迹',
      params: [
        { name: 'number', required: true, desc: '快递单号', example: 'YT1234567890123' },
        { name: 'com', desc: '快递公司编码，留空自动识别，见 /api/express/companies', example: 'yuantong' },
        { name: 'phone', desc: '收/寄件人手机号（或后四位），顺丰必填', example: '1234' },
      ],
      async handler({ query }) {
        const number = param(query, 'number', { required: true, pattern: /^[A-Za-z0-9-]{5,40}$/ });
        const com = param(query, 'com', { pattern: /^[a-z0-9]{2,30}$/ });
        const phone = param(query, 'phone', { pattern: /^(\d{4}|1\d{10})$/ });
        return loadExpress({ number, com, phone });
      },
    },
    {
      method: 'GET',
      path: '/api/express/companies',
      summary: '常用快递公司编码列表',
      params: [],
      async handler() {
        return { data: COMPANIES.map(({ code, name, needPhone }) => ({ code, name, needPhone: Boolean(needPhone) })) };
      },
    },
  ],
};

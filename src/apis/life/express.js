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
  // resultv2=4 时的细分状态
  101: '已下单', 102: '待揽收', 103: '已揽收',
  1001: '到达派件城市', 1002: '干线运输中', 1003: '转递中',
  201: '超时未签收', 202: '超时未更新', 203: '拒收', 204: '派件异常', 205: '柜或驿站超时未取',
  206: '无法联系', 207: '超区', 208: '滞留', 209: '破损', 210: '销单',
  301: '本人签收', 302: '派件异常后签收', 303: '代签', 304: '投柜或驿站签收',
  401: '已销单', 501: '已投柜或驿站', 10: '待清关', 11: '清关中', 12: '已清关', 13: '清关异常',
};

// 未收录的细分码归到所属大类：1xxx 为在途，三位码的首位即大类
function stateText(state) {
  if (STATE_TEXT[state]) return STATE_TEXT[state];
  if (state >= 1000 && state < 2000) return STATE_TEXT[0];
  if (state >= 100 && state < 1000) return STATE_TEXT[Math.floor(state / 100)] ?? '未知';
  return '未知';
}

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
    stateText: stateText(Number(raw.state)),
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
      fields: [
        { name: 'number', type: 'string', desc: '快递单号' },
        { name: 'com', type: 'string', desc: '快递公司编码（快递100 编码，如 yuantong）；未传 com 时为自动识别出的第一个候选' },
        { name: 'company', type: 'string', desc: '快递公司中文名，如 圆通速递；不在内置常用公司列表中时为编码本身' },
        { name: 'state', type: 'number', desc: '快递100 物流状态码。基础状态：0 在途、1 揽收、2 疑难、3 签收、4 退签、5 派件、6 退回、7 转投、8 清关、14 拒签。细分状态码（请求时开启了 resultv2=4）：101 已下单、102 待揽收、103 已揽收、1001 到达派件城市、1002 干线运输中、1003 转递中、201~210 各类疑难（超时未签收、超时未更新、拒收、派件异常、柜或驿站超时未取、无法联系、超区、滞留、破损、销单）、301 本人签收、302 派件异常后签收、303 代签、304 投柜或驿站签收、401 已销单、501 已投柜或驿站、10~13 清关各阶段。是否签收以 signed 为准' },
        { name: 'stateText', type: 'string', desc: '状态中文名，与 state 对应（含细分状态，如"本人签收""到达派件城市"）；未收录的细分码显示所属大类名，完全无法对应时为"未知"' },
        { name: 'signed', type: 'boolean', desc: '是否已签收（快递100 ischeck 为 1）' },
        { name: 'traces', type: 'array', desc: '物流轨迹，按时间倒序（最新一条在前）；刚下单尚无轨迹时为空数组' },
        { name: 'traces[].time', type: 'string', desc: '轨迹时间，YYYY-MM-DD HH:mm:ss（北京时间）' },
        { name: 'traces[].context', type: 'string', desc: '轨迹描述原文，如 "快件已到达【上海转运中心】"' },
        { name: 'traces[].location', type: 'string|null', desc: '所在地：优先用上游 location（如 上海市浦东新区）；为空时用行政区域解析结果 areaName（逗号分隔，如 上海,上海市,浦东新区）；都没有时为 null' },
        { name: 'traces[].status', type: 'string|null', desc: '该条轨迹的状态名称，如 揽收、在途、派件、签收；上游未返回时为 null' },
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
      fields: [
        { name: '[].code', type: 'string', desc: '快递公司编码，作为 /api/express 的 com 参数' },
        { name: '[].name', type: 'string', desc: '快递公司中文名' },
        { name: '[].needPhone', type: 'boolean', desc: '查询时是否必须提供 phone（收/寄件人手机号或后四位），目前仅顺丰为 true' },
      ],
      async handler() {
        return { data: COMPANIES.map(({ code, name, needPhone }) => ({ code, name, needPhone: Boolean(needPhone) })) };
      },
    },
  ],
};

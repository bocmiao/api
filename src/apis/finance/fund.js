import { cache } from '../../lib/cache.js';
import { fetchJSON, fetchText, HttpError, param } from '../../lib/http.js';

const CODE_RE = /^\d{6}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

// jsonpgz({"fundcode":"161725","name":"...","jzrq":"2024-09-20","dwjz":"0.6621","gsz":"0.6703","gszzl":"1.24","gztime":"2024-09-23 15:00"});
// 代码不存在或无估值时返回 jsonpgz();
export function parseEstimate(text) {
  const m = /jsonpgz\(\s*(\{[\s\S]*\})?\s*\)/.exec(text);
  if (!m) throw new HttpError(502, '基金估值返回的数据格式无法识别');
  if (!m[1]) throw new HttpError(404, '未找到该基金或该基金暂无估值');
  let o;
  try {
    o = JSON.parse(m[1]);
  } catch {
    throw new HttpError(502, '基金估值返回的数据格式无法识别');
  }
  const nav = num(o.dwjz);
  const estimate = num(o.gsz);
  return {
    code: o.fundcode,
    name: o.name,
    navDate: o.jzrq || null,
    nav,
    estimateNav: estimate,
    estimateChange: estimate != null && nav != null ? Math.round((estimate - nav) * 1e4) / 1e4 : null,
    estimateChangePercent: num(o.gszzl),
    estimateTime: o.gztime || null,
  };
}

// api.fund.eastmoney.com/f10/lsjz 历史净值
export function parseHistory(raw) {
  if (!raw || typeof raw !== 'object') throw new HttpError(502, '基金净值返回的数据格式无法识别');
  if (raw.ErrCode && raw.ErrCode !== 0) throw new HttpError(502, `基金净值上游错误：${raw.ErrMsg || raw.ErrCode}`);
  const list = raw.Data?.LSJZList;
  if (!Array.isArray(list)) throw new HttpError(502, '基金净值返回的数据格式无法识别');
  return {
    total: num(raw.TotalCount) ?? 0,
    page: num(raw.PageIndex) ?? 1,
    pageSize: num(raw.PageSize) ?? list.length,
    items: list.map((r) => ({
      date: r.FSRQ,
      nav: num(r.DWJZ),
      accNav: num(r.LJJZ),
      changePercent: num(r.JZZZL),
      purchaseStatus: r.SGZT || null,
      redeemStatus: r.SHZT || null,
      dividend: r.FHSP || null,
    })),
  };
}

export default {
  name: 'fund',
  category: 'finance',
  title: '基金估值与净值',
  description: '场外基金盘中实时估值、历史单位/累计净值',
  source: '天天基金 (东方财富)',
  unofficial: true,
  routes: [
    {
      method: 'GET',
      path: '/api/fund/estimate',
      summary: '基金盘中实时估值与涨跌',
      params: [{ name: 'code', required: true, desc: '6 位基金代码', example: '161725' }],
      fields: [
        { name: 'code', type: 'string', desc: '6 位基金代码' },
        { name: 'name', type: 'string', desc: '基金名称' },
        { name: 'navDate', type: 'string|null', desc: '最新已公布单位净值（nav）的日期，格式 YYYY-MM-DD，盘中一般为上一交易日；上游为空时为 null' },
        { name: 'nav', type: 'number|null', desc: 'navDate 当日的单位净值（元/份）；上游为空时为 null' },
        { name: 'estimateNav', type: 'number|null', desc: '盘中实时估算的单位净值（元/份），为天天基金的估算值，并非实际净值；上游为空时为 null' },
        { name: 'estimateChange', type: 'number|null', desc: '估算涨跌额（元/份）= estimateNav − nav，保留 4 位小数；两者任一为空时为 null' },
        { name: 'estimateChangePercent', type: 'number|null', desc: '估算涨跌幅，百分数（1.24 表示 +1.24%），相对 nav；上游为空时为 null' },
        { name: 'estimateTime', type: 'string|null', desc: '估值时间，格式 YYYY-MM-DD HH:mm，北京时间（UTC+8）；上游为空时为 null' },
      ],
      async handler({ query }) {
        const code = param(query, 'code', { required: true, pattern: CODE_RE });
        return cache.wrap(`fund:gz:${code}`, 60_000, async () => {
          const text = await fetchText(`https://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`, {
            headers: { referer: 'https://fund.eastmoney.com/' },
          });
          return parseEstimate(text);
        });
      },
    },
    {
      method: 'GET',
      path: '/api/fund/history',
      summary: '基金历史净值（分页）',
      params: [
        { name: 'code', required: true, desc: '6 位基金代码', example: '161725' },
        { name: 'page', default: 1, desc: '页码' },
        { name: 'size', default: 20, desc: '每页条数（1~49）' },
        { name: 'start', desc: '开始日期 YYYY-MM-DD', example: '2024-01-01' },
        { name: 'end', desc: '结束日期 YYYY-MM-DD', example: '2024-09-30' },
      ],
      fields: [
        { name: 'code', type: 'string', desc: '6 位基金代码（即请求参数 code）' },
        { name: 'total', type: 'number', desc: '符合条件（日期区间内）的净值记录总条数，用于分页；上游未给出时为 0' },
        { name: 'page', type: 'number', desc: '当前页码，从 1 开始；上游未给出时为 1' },
        { name: 'pageSize', type: 'number', desc: '每页条数；上游未给出时为本页实际条数' },
        { name: 'items', type: 'array', desc: '本页净值记录，按日期从新到旧排列（上游顺序）' },
        { name: 'items[].date', type: 'string', desc: '净值日期，格式 YYYY-MM-DD' },
        { name: 'items[].nav', type: 'number|null', desc: '单位净值（元/份）；上游为空时为 null' },
        { name: 'items[].accNav', type: 'number|null', desc: '累计净值（元/份，含成立以来的历次分红）；上游为空时为 null' },
        { name: 'items[].changePercent', type: 'number|null', desc: '日增长率，百分数（-0.45 表示 -0.45%），天天基金口径；上游为空时为 null' },
        { name: 'items[].purchaseStatus', type: 'string|null', desc: '当日申购状态，上游原文（如 开放申购、暂停申购、限制大额申购）；上游为空时为 null' },
        { name: 'items[].redeemStatus', type: 'string|null', desc: '当日赎回状态，上游原文（如 开放赎回、暂停赎回）；上游为空时为 null' },
        { name: 'items[].dividend', type: 'string|null', desc: '当日分红送配说明，上游原文（如 每份派现金0.0100元）；当日没有分红、拆分时为 null' },
      ],
      async handler({ query }) {
        const code = param(query, 'code', { required: true, pattern: CODE_RE });
        const page = param(query, 'page', { default: 1, int: true, min: 1, max: 1000 });
        const size = param(query, 'size', { default: 20, int: true, min: 1, max: 49 });
        const start = param(query, 'start', { default: '', pattern: DATE_RE });
        const end = param(query, 'end', { default: '', pattern: DATE_RE });
        const qs = new URLSearchParams({ fundCode: code, pageIndex: page, pageSize: size, startDate: start, endDate: end });
        return cache.wrap(`fund:ls:${qs}`, 10 * 60_000, async () => {
          const raw = await fetchJSON(`https://api.fund.eastmoney.com/f10/lsjz?${qs}`, {
            headers: { referer: 'https://fundf10.eastmoney.com/' },
          });
          return { code, ...parseHistory(raw) };
        });
      },
    },
  ],
};

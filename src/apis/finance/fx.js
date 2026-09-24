import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError, param } from '../../lib/http.js';

const UPSTREAM = 'https://open.er-api.com/v6/latest/';
const TTL_MS = 60 * 60_000; // 上游每日更新一次，缓存 1 小时足够
const CCY_RE = /^[A-Za-z]{3}$/;

export function parseRates(raw) {
  if (raw?.result !== 'success') {
    const type = raw?.['error-type'];
    if (type === 'unsupported-code') throw new HttpError(400, '不支持的货币代码');
    throw new HttpError(502, `汇率上游返回错误${type ? `：${type}` : ''}`);
  }
  if (!raw.rates || typeof raw.rates !== 'object') throw new HttpError(502, '汇率数据格式无法识别');
  const rates = {};
  for (const [k, v] of Object.entries(raw.rates)) {
    const n = Number(v);
    if (Number.isFinite(n)) rates[k] = n;
  }
  return {
    base: raw.base_code,
    updatedAt: raw.time_last_update_unix ? new Date(raw.time_last_update_unix * 1000).toISOString() : null,
    nextUpdateAt: raw.time_next_update_unix ? new Date(raw.time_next_update_unix * 1000).toISOString() : null,
    rates,
  };
}

// 供其他模块复用（如金价折算人民币）
export function loadRates(base) {
  const b = base.toUpperCase();
  return cache.wrap(`fx:${b}`, TTL_MS, async () => parseRates(await fetchJSON(UPSTREAM + encodeURIComponent(b))));
}

export function convert(parsed, to, amount) {
  const rate = parsed.rates[to];
  if (rate == null) throw new HttpError(400, `不支持的目标货币 ${to}`);
  return {
    from: parsed.base,
    to,
    amount,
    rate,
    result: Math.round(amount * rate * 1e6) / 1e6,
    updatedAt: parsed.updatedAt,
  };
}

function ccy(query, name, def) {
  return param(query, name, { default: def, pattern: CCY_RE }).toUpperCase();
}

export default {
  name: 'fx',
  category: 'finance',
  title: '汇率',
  description: '160+ 种货币的每日参考汇率与换算',
  source: 'ExchangeRate-API (open.er-api.com)',
  routes: [
    {
      method: 'GET',
      path: '/api/fx/rates',
      summary: '以指定货币为基准的全部汇率',
      params: [
        { name: 'base', default: 'USD', desc: '基准货币（ISO 4217 三位代码）', example: 'CNY' },
        { name: 'symbols', desc: '只返回这些货币，逗号分隔', example: 'CNY,EUR,JPY' },
      ],
      async handler({ query }) {
        const base = ccy(query, 'base', 'USD');
        const symbolsRaw = param(query, 'symbols', { pattern: /^[A-Za-z]{3}(,[A-Za-z]{3}){0,49}$/ });
        const res = await loadRates(base);
        if (!symbolsRaw) return res;
        const pick = {};
        for (const s of symbolsRaw.toUpperCase().split(',')) if (res.data.rates[s] != null) pick[s] = res.data.rates[s];
        return { ...res, data: { ...res.data, rates: pick } };
      },
    },
    {
      method: 'GET',
      path: '/api/fx/convert',
      summary: '货币换算',
      params: [
        { name: 'from', required: true, default: 'USD', desc: '源货币', example: 'USD' },
        { name: 'to', required: true, default: 'CNY', desc: '目标货币', example: 'CNY' },
        { name: 'amount', default: '1', desc: '金额', example: '100' },
      ],
      async handler({ query }) {
        const from = ccy(query, 'from', 'USD');
        const to = ccy(query, 'to', 'CNY');
        const amountRaw = param(query, 'amount', { default: '1', pattern: /^\d{1,15}(\.\d{1,8})?$/ });
        const amount = Number(amountRaw);
        const res = await loadRates(from);
        return { ...res, data: convert(res.data, to, amount) };
      },
    },
  ],
};

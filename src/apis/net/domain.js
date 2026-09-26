import { domainToUnicode } from 'node:url';
import { cache } from '../../lib/cache.js';
import { HttpError, param } from '../../lib/http.js';
import { normalizeDomain, parseRdap, rdapFetch, rdapServerMap } from '../tools/whois.js';
import { createGate } from './common.js';

const TIMEOUT_MS = 5000;
const gate = createGate(20);

// 常见的二级公共后缀（在这些后缀下注册的是三级域名）。不是完整的公共后缀列表，只覆盖常用的。
const SECOND_LEVEL = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'mil.cn',
  'com.hk', 'net.hk', 'org.hk', 'edu.hk', 'gov.hk', 'idv.hk',
  'com.tw', 'net.tw', 'org.tw', 'edu.tw', 'gov.tw', 'idv.tw',
  'com.mo', 'net.mo', 'org.mo',
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'ac.uk', 'gov.uk',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'co.kr', 'or.kr', 'ne.kr', 'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'org.nz', 'net.nz', 'com.sg', 'net.sg', 'org.sg', 'edu.sg', 'com.my', 'com.br', 'com.mx', 'co.in', 'co.za',
]);

// sub.example.com → example.com；a.example.com.cn → example.com.cn
export function registrableDomain(domain) {
  const labels = domain.split('.');
  const keep = labels.length >= 3 && SECOND_LEVEL.has(labels.slice(-2).join('.')) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

// IANA RDAP 引导文件：services 为 [[后缀...], [RDAP 服务器...]]
export function bootstrapTlds(json) {
  const set = new Set();
  for (const s of json?.services ?? []) for (const tld of s?.[0] ?? []) set.add(String(tld).toLowerCase());
  if (!set.size) throw new HttpError(502, 'RDAP 引导数据格式无法识别');
  return set;
}

async function rdapTlds() {
  return new Set(Object.keys(await rdapServerMap()));
}

// 返回接口 data（不含缓存信息）
export async function checkAvailability(input) {
  const normalized = normalizeDomain(input);
  if (!normalized) throw new HttpError(400, 'domain 不是合法的域名');
  const domain = registrableDomain(normalized);
  const tld = domain.split('.').at(-1);
  const base = {
    domain,
    unicode: domainToUnicode(domain) || domain,
    tld,
    status: 'unknown',
    available: null,
    reason: '',
    registrar: null,
    created: null,
    expires: null,
  };

  let tlds = null;
  try {
    tlds = await rdapTlds();
  } catch {
    tlds = null; // 引导数据暂时取不到时仍然查询，只是 404 无法区分"未注册"和"后缀不支持"
  }
  if (tlds && !tlds.has(tld)) {
    return { ...base, reason: `.${domainToUnicode(tld) || tld} 后缀的注册局没有提供 RDAP 查询服务，无法判断是否已注册，请到该后缀的注册局或注册商处查询` };
  }

  const res = await rdapFetch(domain, { timeoutMs: TIMEOUT_MS });
  if (res.status === 404) {
    if (!tlds) return { ...base, reason: 'RDAP 未查到该域名，但暂时无法确认该后缀是否支持 RDAP，结果仅供参考' };
    return { ...base, status: 'available', available: true, reason: '注册局的 RDAP 未查到该域名，通常表示尚未注册、可以注册（保留域名、溢价域名或刚删除的域名除外，以注册商实际结果为准）' };
  }
  if (res.status === 429) throw new HttpError(429, 'RDAP 服务限流，请稍后再试');
  if (res.status === 400 || res.status === 422) {
    return { ...base, reason: `注册局拒绝了该查询（HTTP ${res.status}），可能是保留或不允许注册的名称` };
  }
  if (!res.ok) throw new HttpError(502, `RDAP 服务返回 HTTP ${res.status}`);
  let raw;
  try {
    raw = await res.json();
  } catch {
    throw new HttpError(502, 'RDAP 返回的不是合法 JSON');
  }
  const info = parseRdap(raw);
  return {
    ...base,
    status: 'registered',
    available: false,
    reason: '该域名已被注册',
    registrar: info.registrar?.name ?? null,
    created: info.created,
    expires: info.expires,
  };
}

export default {
  name: 'domain-available',
  category: 'net',
  title: '域名注册查询',
  description: '通过 RDAP 判断域名是否已被注册，已注册时返回注册商与到期时间',
  source: 'RDAP（IANA 引导 + 各注册局官方服务器）',
  routes: [
    {
      method: 'GET',
      path: '/api/domain/available',
      summary: '查询域名是否已被注册',
      params: [
        { name: 'domain', required: true, desc: '域名，例如 example.com（支持中文域名；带子域名时自动取主域名）', example: 'example.com' },
      ],
      fields: [
        { name: 'domain', type: 'string', desc: '实际查询的主域名（ASCII 形式，小写；中文域名为 punycode；输入带子域名或 www 时已去掉，如 a.b.example.com.cn → example.com.cn）' },
        { name: 'unicode', type: 'string', desc: '域名的 Unicode 形式（如 例子.中国）；普通英文域名与 domain 相同' },
        { name: 'tld', type: 'string', desc: '顶级后缀（ASCII 形式，如 com、cn、xn--fiqs8s）' },
        { name: 'status', type: 'string', desc: '查询结果：registered 已注册；available 未查到注册记录（通常可以注册）；unknown 无法判断（后缀不支持 RDAP 等，原因见 reason）' },
        { name: 'available', type: 'boolean|null', desc: '是否可能可以注册：available 时为 true，registered 时为 false，unknown 时为 null' },
        { name: 'reason', type: 'string', desc: '结果的中文说明，unknown 时说明无法判断的原因' },
        { name: 'registrar', type: 'string|null', desc: '注册商名称（仅 registered 时可能有值）；未注册、无法判断或 RDAP 未提供时为 null' },
        { name: 'created', type: 'string|null', desc: '注册时间，ISO 8601 UTC 格式（仅 registered 时可能有值）；否则为 null' },
        { name: 'expires', type: 'string|null', desc: '到期时间，ISO 8601 UTC 格式（仅 registered 时可能有值）；否则为 null' },
      ],
      async handler({ query }) {
        const input = param(query, 'domain', { required: true, max: 253 });
        const normalized = normalizeDomain(input);
        if (!normalized) throw new HttpError(400, 'domain 不是合法的域名');
        return cache.wrap(`net:domain-available:${registrableDomain(normalized)}`, 10 * 60_000, () => gate(() => checkAvailability(normalized)));
      },
    },
  ],
};

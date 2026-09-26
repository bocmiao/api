import { domainToASCII } from 'node:url';
import { cache } from '../../lib/cache.js';
import { HttpError, param, upstreamError } from '../../lib/http.js';
import { outboundFetch } from '../../lib/proxy.js';

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

// 规范化并校验域名，支持中文域名（转为 punycode）
export function normalizeDomain(input) {
  let s = String(input ?? '').trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/\.$/, '');
  if (s.startsWith('www.') && s.split('.').length > 2) s = s.slice(4);
  const ascii = domainToASCII(s);
  if (!ascii || ascii.length > 253) return null;
  const labels = ascii.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) return null;
  if (!/^([a-z]{2,63}|xn--[a-z0-9-]+)$/.test(labels.at(-1))) return null;
  return ascii;
}

function vcardField(entity, field) {
  const props = entity?.vcardArray?.[1];
  if (!Array.isArray(props)) return null;
  const p = props.find((x) => x?.[0] === field);
  const v = p?.[3];
  return Array.isArray(v) ? v.filter(Boolean).join(' ') || null : v || null;
}

function findEntity(entities = [], role) {
  for (const e of entities) {
    if (e?.roles?.includes(role)) return e;
    const nested = findEntity(e?.entities, role);
    if (nested) return nested;
  }
  return null;
}

export function parseRdap(raw) {
  if (!raw || raw.objectClassName !== 'domain') throw new HttpError(502, 'RDAP 返回的数据格式无法识别');
  // 各注册局的时间格式不一（有的带毫秒或 +08:00），统一转成 ISO 8601 UTC
  const event = (...actions) => {
    const d = raw.events?.find((e) => actions.includes(e.eventAction))?.eventDate;
    const t = d ? Date.parse(d) : NaN;
    return Number.isNaN(t) ? d ?? null : new Date(t).toISOString();
  };
  const registrar = findEntity(raw.entities, 'registrar');
  const abuse = findEntity(registrar?.entities, 'abuse');
  return {
    domain: (raw.ldhName ?? '').toLowerCase(),
    unicodeName: raw.unicodeName ?? null,
    handle: raw.handle ?? null,
    registrar: registrar
      ? {
          name: vcardField(registrar, 'fn') ?? registrar.handle ?? null,
          ianaId: registrar.publicIds?.find((p) => /iana/i.test(p.type))?.identifier ?? null,
          url: registrar.links?.find((l) => l.rel === 'about' || l.rel === 'related')?.href ?? registrar.url ?? null,
          abuseEmail: vcardField(abuse, 'email'),
          abusePhone: vcardField(abuse, 'tel')?.replace(/^tel:/i, '') ?? null,
        }
      : null,
    status: raw.status ?? [],
    created: event('registration'),
    updated: event('last changed', 'last update'),
    expires: event('expiration', 'registrar expiration'),
    nameservers: (raw.nameservers ?? []).map((n) => (n.ldhName ?? n.unicodeName ?? '').toLowerCase()).filter(Boolean),
    dnssec: raw.secureDNS?.delegationSigned ?? null,
  };
}

const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';

// IANA RDAP 引导文件：services 为 [[后缀...], [RDAP 服务器...]]，整理成 { 后缀: [服务器...] }，https 优先
export function bootstrapServers(json) {
  const map = {};
  for (const s of json?.services ?? []) {
    const urls = (s?.[1] ?? []).map(String).sort((a, b) => Number(b.startsWith('https:')) - Number(a.startsWith('https:')));
    for (const tld of s?.[0] ?? []) map[String(tld).toLowerCase()] = urls;
  }
  if (!Object.keys(map).length) throw new HttpError(502, 'RDAP 引导数据格式无法识别');
  return map;
}

// 引导数据缓存一天；取不到时抛错，由调用方决定怎么退回
export async function rdapServerMap() {
  const r = await cache.wrap('net:rdap-bootstrap-map', 86_400_000, async () => {
    let res;
    try {
      res = await outboundFetch(BOOTSTRAP_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    } catch (err) {
      throw upstreamError(err, BOOTSTRAP_URL, 'RDAP 引导服务');
    }
    if (!res.ok) throw new HttpError(502, `RDAP 引导数据返回 HTTP ${res.status}`);
    return bootstrapServers(await res.json());
  });
  return r.data;
}

// 直接查询该后缀注册局自己的 RDAP 服务器；rdap.org 只作为最后的备用（它会拒绝部分云服务器 IP，返回 403）。
// 返回原始 Response（404 等状态由调用方解读）
export async function rdapFetch(domain, { timeoutMs = 8000 } = {}) {
  const tld = domain.split('.').at(-1);
  let servers = [];
  try {
    servers = (await rdapServerMap())[tld] ?? [];
  } catch { /* 引导数据暂时取不到：只用 rdap.org */ }
  const urls = [...servers.map((b) => `${b.replace(/\/*$/, '/')}domain/${domain}`), `https://rdap.org/domain/${domain}`];
  let lastErr;
  for (const url of urls) {
    let res;
    try {
      res = await outboundFetch(url, { headers: { accept: 'application/rdap+json, application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      lastErr = upstreamError(err, url, 'RDAP 服务');
      continue;
    }
    if (res.status === 403 || res.status >= 500) {
      lastErr = new HttpError(502, `RDAP 服务返回 HTTP ${res.status}（${new URL(url).hostname}）`);
      continue;
    }
    return res;
  }
  throw lastErr;
}

async function fetchRdap(domain) {
  const res = await rdapFetch(domain);
  if (res.status === 404) throw new HttpError(404, '未查到该域名的注册信息（可能未注册，或该后缀不支持 RDAP）');
  if (res.status === 429) throw new HttpError(429, 'RDAP 服务限流，请稍后再试');
  if (!res.ok) throw new HttpError(502, `RDAP 服务返回 HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new HttpError(502, 'RDAP 返回的不是合法 JSON');
  }
}

export default {
  name: 'whois',
  category: 'tools',
  title: '域名 Whois',
  description: '通过 RDAP 查询域名的注册商、状态、注册/到期时间与 DNS 服务器',
  source: 'RDAP（各注册局官方服务器，rdap.org 备用）',
  routes: [
    {
      method: 'GET',
      path: '/api/whois',
      summary: '查询域名注册信息',
      params: [{ name: 'domain', required: true, desc: '域名，例如 example.com', example: 'github.com' }],
      fields: [
        { name: 'domain', type: 'string', desc: '域名的 ASCII 形式（小写，中文域名为 punycode，如 xn--fsqu00a.xn--fiqs8s）' },
        { name: 'unicodeName', type: 'string|null', desc: '域名的 Unicode 形式（如 例子.中国），通常只有中文等国际化域名才有；RDAP 未提供时为 null' },
        { name: 'handle', type: 'string|null', desc: '注册局为该域名分配的对象 ID（如 2138514_DOMAIN_COM-VRSN）；RDAP 未提供时为 null' },
        { name: 'registrar', type: 'object|null', desc: '注册商信息；RDAP 中没有角色为 registrar 的实体时为 null' },
        { name: 'registrar.name', type: 'string|null', desc: '注册商名称（vCard 的 fn）；没有时退回注册商实体的 handle（通用顶级域通常就是 IANA 编号）；都没有时为 null' },
        { name: 'registrar.ianaId', type: 'string|null', desc: 'IANA 注册商编号（数字字符串，如 292）；RDAP 未提供时为 null（国家和地区顶级域较常见）' },
        { name: 'registrar.url', type: 'string|null', desc: '注册商链接：取注册商实体 links 中第一个 rel 为 about 或 related 的地址（可能是注册商官网，也可能是其 RDAP 查询地址）；没有时为 null' },
        { name: 'registrar.abuseEmail', type: 'string|null', desc: '注册商的滥用投诉邮箱；未提供时为 null' },
        { name: 'registrar.abusePhone', type: 'string|null', desc: '注册商的滥用投诉电话（已去掉 tel: 前缀，如 +1.2086851750）；未提供时为 null' },
        { name: 'status', type: 'array', desc: '域名状态列表，为 RDAP 状态值（由 EPP 状态码转换而来，全小写、单词间用空格）；RDAP 未提供时为空数组' },
        {
          name: 'status[]',
          type: 'string',
          desc: '单个状态值。常见取值：active 正常；inactive 未设置 DNS 服务器（无法解析）；client/server delete prohibited 禁止删除；'
            + 'client/server transfer prohibited 禁止转移到其他注册商；client/server update prohibited 禁止修改注册信息；client/server renew prohibited 禁止续费；'
            + 'client/server hold 暂停解析（域名无法访问）；pending create/delete/renew/restore/transfer/update 对应操作正在处理；'
            + 'redemption period 赎回期（已过期并进入删除流程，仍可赎回）；add period / auto renew period / renew period / transfer period 注册、自动续费、续费、转移后的宽限期。'
            + 'client 开头的由注册商设置，server 开头的由注册局设置；各类 prohibited 多为防止被盗转的保护锁，不代表域名异常',
        },
        { name: 'created', type: 'string|null', desc: '注册时间（RDAP registration 事件），统一为 ISO 8601 UTC 格式（如 1997-09-15T04:00:00.000Z）；RDAP 未提供时为 null' },
        { name: 'updated', type: 'string|null', desc: '注册信息最后修改时间（RDAP last changed 事件，不是 RDAP 数据库的刷新时间），格式同 created；未提供时为 null' },
        { name: 'expires', type: 'string|null', desc: '到期时间（RDAP expiration 或 registrar expiration 事件），格式同 created；未提供时为 null' },
        { name: 'nameservers', type: 'array', desc: 'DNS 服务器域名列表（小写，如 ns1.google.com）；没有设置 DNS 服务器时为空数组' },
        { name: 'dnssec', type: 'boolean|null', desc: '是否启用 DNSSEC（RDAP secureDNS.delegationSigned）：true 已启用，false 未启用；RDAP 未提供时为 null' },
      ],
      async handler({ query }) {
        const domain = normalizeDomain(param(query, 'domain', { required: true, max: 253 }));
        if (!domain) throw new HttpError(400, 'domain 不是合法的域名');
        const res = await cache.wrap(`whois:${domain}`, 6 * 3600_000, () => fetchRdap(domain));
        return { ...res, data: parseRdap(res.data) };
      },
    },
  ],
};

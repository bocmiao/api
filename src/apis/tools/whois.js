import { domainToASCII } from 'node:url';
import { cache } from '../../lib/cache.js';
import { HttpError, param } from '../../lib/http.js';

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
  const event = (...actions) => raw.events?.find((e) => actions.includes(e.eventAction))?.eventDate ?? null;
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
          abusePhone: vcardField(abuse, 'tel'),
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

async function fetchRdap(domain) {
  let res;
  try {
    res = await fetch(`https://rdap.org/domain/${domain}`, {
      headers: { accept: 'application/rdap+json, application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new HttpError(504, 'RDAP 服务响应超时');
    throw new HttpError(502, '无法连接 RDAP 服务');
  }
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
  source: 'RDAP (rdap.org)',
  routes: [
    {
      method: 'GET',
      path: '/api/whois',
      summary: '查询域名注册信息',
      params: [{ name: 'domain', required: true, desc: '域名，例如 example.com', example: 'github.com' }],
      async handler({ query }) {
        const domain = normalizeDomain(param(query, 'domain', { required: true, max: 253 }));
        if (!domain) throw new HttpError(400, 'domain 不是合法的域名');
        const res = await cache.wrap(`whois:${domain}`, 6 * 3600_000, () => fetchRdap(domain));
        return { ...res, data: parseRdap(res.data) };
      },
    },
  ],
};

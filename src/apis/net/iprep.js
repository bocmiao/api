// IP 信誉查询：DNSBL 黑名单 + ASN / 运营商判断是否机房 IP + PTR 反查，给出参考性的风险评分。
// DNSBL 查询方式：把 IP 反转后拼上黑名单区域查 A 记录（1.2.3.4 → 4.3.2.1.bl.spamcop.net），
// 有 127.x.x.x 答复表示被列入，NXDOMAIN 表示未列入。查询的区域是写死的，IP 须为公网地址。
import dns from 'node:dns';
import net from 'node:net';
import { cache } from '../../lib/cache.js';
import { HttpError, param } from '../../lib/http.js';
import { normalizeIp, loadIpInfo } from '../life/ip.js';
import { createGate, isBlockedIP, since } from './common.js';

const LIST_TIMEOUT_MS = 3000;
const gate = createGate(10);

export const DISCLAIMER = '评分由公开黑名单、IP 所属网络与反向解析按固定规则估算，仅供参考，不代表该 IP 一定安全或一定有害；'
  + '本接口无法可靠识别代理、VPN、住宅代理或 Tor 出口，机房判断基于 ASN / 运营商名称关键词，可能漏判或误判。';

// codes：返回码 → 含义；points：列入时的扣分。
// 不查 dnsbl.sorbs.net：SORBS 已于 2024 年停止服务，查询结果不再可信。
// Spamhaus 通过公共 DNS / 大型云 DNS 查询会被拒绝（返回 127.255.255.x），且商用须购买 DQS，默认不查，spamhaus=true 时才查。
export const DNSBLS = [
  { zone: 'bl.spamcop.net', name: 'SpamCop', points: 25, codes: { '127.0.0.2': '近期被用户举报发送垃圾邮件' } },
  { zone: 'b.barracudacentral.org', name: 'Barracuda BRBL', points: 25, codes: { '127.0.0.2': '发件信誉差（垃圾邮件来源）' } },
  { zone: 'dnsbl-1.uceprotect.net', name: 'UCEPROTECT Level 1', points: 20, codes: { '127.0.0.2': '该 IP 本身命中垃圾邮件陷阱（Level 1 只针对单个 IP）' } },
  { zone: 'psbl.surriel.com', name: 'PSBL', points: 20, codes: { '127.0.0.2': '向垃圾邮件陷阱发送过邮件' } },
  { zone: 'all.s5h.net', name: 's5h.net', points: 20, codes: { '127.0.0.2': '发送垃圾邮件或攻击行为' } },
  { zone: 'bl.blocklist.de', name: 'blocklist.de', points: 25, codes: { '127.0.0.2': '近期对服务器发起过攻击（SSH / 邮件 / 网站暴力破解等）' } },
  {
    zone: 'dnsbl.dronebl.org', name: 'DroneBL', points: 35,
    codes: {
      '127.0.0.3': 'IRC 僵尸', '127.0.0.5': '垃圾邮件 Bottler', '127.0.0.6': '未知类型的垃圾程序或僵尸', '127.0.0.7': 'DDoS 僵尸',
      '127.0.0.8': 'SOCKS 代理', '127.0.0.9': 'HTTP 代理', '127.0.0.10': '代理链', '127.0.0.11': '网页代理', '127.0.0.12': '开放 DNS 解析器',
      '127.0.0.13': '暴力破解攻击者', '127.0.0.14': '开放 WinGate 代理', '127.0.0.15': '被入侵的路由器 / 网关', '127.0.0.16': '自动入侵蠕虫',
      '127.0.0.17': '僵尸网络', '127.0.0.18': 'IRC 上的 DNS / MX 滥用', '127.0.0.19': '被滥用的 VPN 服务',
    },
  },
];

export const SPAMHAUS = {
  zone: 'zen.spamhaus.org', name: 'Spamhaus ZEN', points: 35,
  codes: {
    '127.0.0.2': 'SBL：已确认的垃圾邮件来源', '127.0.0.3': 'SBL CSS：垃圾邮件发送行为', '127.0.0.4': 'XBL：被入侵 / 感染的主机（漏洞利用）',
    '127.0.0.5': 'XBL：被入侵的主机', '127.0.0.6': 'XBL：被入侵的主机', '127.0.0.7': 'XBL：被入侵的主机', '127.0.0.9': 'DROP：被劫持或恶意网段',
    '127.0.0.10': 'PBL（ISP 登记）：动态 / 终端用户地址段，不应直接发信', '127.0.0.11': 'PBL（Spamhaus 维护）：动态 / 终端用户地址段，不应直接发信',
  },
  // 只命中 PBL（127.0.0.10/11）说明是家庭宽带等终端地址，不代表有恶意行为，只扣少量分
  pblPoints: 5,
};

// 查询被拒绝 / 无法查询的返回码（不代表 IP 被列入）
export const UNAVAILABLE_CODES = {
  '127.255.255.252': 'Spamhaus：查询格式错误',
  '127.255.255.254': 'Spamhaus：通过公共 / 开放 DNS 解析器查询被拒绝',
  '127.255.255.255': 'Spamhaus：查询次数超限',
};

// 机房 / 云服务商关键词（匹配 ASN 名称、ISP、组织名，不区分大小写）→ 显示名
export const HOSTING_KEYWORDS = [
  [/amazon|aws\b/i, 'Amazon AWS'], [/google cloud|google llc/i, 'Google Cloud'], [/microsoft|azure/i, 'Microsoft Azure'],
  [/alibaba|aliyun|alicloud/i, '阿里云'], [/tencent/i, '腾讯云'], [/huawei cloud|huaweicloud|huawei international/i, '华为云'],
  [/digitalocean/i, 'DigitalOcean'], [/\bovh/i, 'OVH'], [/hetzner/i, 'Hetzner'], [/vultr|choopa|the constant company/i, 'Vultr'],
  [/linode|akamai/i, 'Linode / Akamai'], [/oracle/i, 'Oracle Cloud'], [/contabo/i, 'Contabo'], [/scaleway|online s\.?a\.?s/i, 'Scaleway'],
  [/leaseweb/i, 'Leaseweb'], [/cloudflare/i, 'Cloudflare'], [/m247/i, 'M247'], [/datacamp/i, 'DataCamp（CDN77）'], [/ionos/i, 'IONOS'],
  [/kamatera/i, 'Kamatera'], [/hostinger/i, 'Hostinger'], [/psychz/i, 'Psychz'], [/quadranet/i, 'QuadraNet'], [/colocrossing/i, 'ColoCrossing'],
  [/frantech|buyvm|ponynet/i, 'BuyVM'], [/racknerd/i, 'RackNerd'], [/zenlayer/i, 'Zenlayer'], [/ucloud/i, 'UCloud'], [/kingsoft/i, '金山云'],
  [/volcano|bytedance|byteplus/i, '火山引擎'], [/baidu/i, '百度智能云'], [/fastly/i, 'Fastly'], [/g-core|gcore/i, 'G-Core Labs'],
  [/hosting|datacenter|data center|\bidc\b|server|\bvps\b|colo(cation)?\b/i, '机房 / 托管服务商'],
];

export function detectHosting(...names) {
  const text = names.filter(Boolean).join(' ');
  if (!text) return null;
  for (const [re, provider] of HOSTING_KEYWORDS) if (re.test(text)) return provider;
  return null;
}

export const dnsblName = (ip, zone) => `${ip.split('.').reverse().join('.')}.${zone}`;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const DNS_ERRORS = { ETIMEOUT: '查询超时（3 秒）', ESERVFAIL: 'DNS 返回 SERVFAIL', EREFUSED: 'DNS 拒绝查询', ECONNREFUSED: '无法连接 DNS 服务器' };

// 解读一个 DNSBL 的答复：listed 列入 / clean 未列入 / unavailable 无法查询 / error 出错 / skipped 未查询
export function interpretDnsbl(list, addrs) {
  const codes = [...new Set(addrs)].sort();
  if (!codes.length) return { status: 'clean', codes: [], meanings: [], error: null };
  const refused = codes.filter((c) => UNAVAILABLE_CODES[c] || c.startsWith('127.255.255.'));
  if (refused.length) return { status: 'unavailable', codes, meanings: refused.map((c) => UNAVAILABLE_CODES[c] ?? '查询被拒绝'), error: '该黑名单拒绝了本服务器所用 DNS 的查询，无法判断' };
  const bad = codes.filter((c) => !c.startsWith('127.'));
  if (bad.length) return { status: 'error', codes, meanings: [], error: '返回了非 127.x 的地址（DNS 可能被劫持），结果不可信' };
  return { status: 'listed', codes, meanings: codes.map((c) => list.codes[c] ?? `已列入（返回码 ${c}）`), error: null };
}

export async function queryDnsbl(resolver, ip, list, { timeoutMs = LIST_TIMEOUT_MS } = {}) {
  const t0 = performance.now();
  const base = { zone: list.zone, name: list.name };
  if (!net.isIPv4(ip)) return { ...base, status: 'skipped', codes: [], meanings: [], ms: 0, error: '暂不支持 IPv6 的黑名单查询' };
  try {
    const addrs = await withTimeout(resolver.resolve4(dnsblName(ip, list.zone)), timeoutMs);
    return { ...base, ...interpretDnsbl(list, addrs), ms: since(t0) };
  } catch (err) {
    if (err?.code === 'ENOTFOUND' || err?.code === 'ENODATA') return { ...base, status: 'clean', codes: [], meanings: [], ms: since(t0), error: null };
    return { ...base, status: 'error', codes: [], meanings: [], ms: since(t0), error: DNS_ERRORS[err?.code] ?? `查询失败（${err?.code ?? '未知错误'}）` };
  }
}

// 列入一个黑名单的扣分；只命中 Spamhaus PBL 时扣分较少
function listPoints(list, entry) {
  if (list === SPAMHAUS && entry.codes.every((c) => c === '127.0.0.10' || c === '127.0.0.11')) return SPAMHAUS.pblPoints;
  return list.points;
}

export const levelOf = (score) => (score >= 60 ? '高' : score >= 30 ? '中' : '低');

// 评分规则（满分 100，封顶）：
//   每个列入的黑名单按该名单权重加分（20~35），黑名单合计最多 70；
//   机房 / 云服务商 IP +20；没有 PTR 反向解析 +10
export function scoreReputation({ dnsbl, lists, datacenter, provider, ptr }) {
  const reasons = [];
  let blScore = 0;
  dnsbl.forEach((entry, i) => {
    if (entry.status !== 'listed') return;
    const points = listPoints(lists[i], entry);
    blScore += points;
    reasons.push({ rule: 'dnsbl', points, desc: `被 ${entry.name} 列入：${entry.meanings.join('；')}` });
  });
  if (blScore > 70) reasons.push({ rule: 'dnsbl-cap', points: 70 - blScore, desc: '黑名单合计最多计 70 分' });
  if (datacenter) reasons.push({ rule: 'datacenter', points: 20, desc: `属于机房 / 云服务商（${provider}），常被用作代理、爬虫或扫描源，普通用户较少直接使用` });
  if (ptr.status === 'none') reasons.push({ rule: 'no-ptr', points: 10, desc: '没有 PTR 反向解析记录（正规邮件服务器和多数运营商地址通常都有）' });
  const score = Math.max(0, Math.min(100, reasons.reduce((s, r) => s + r.points, 0)));
  return { riskScore: score, level: levelOf(score), reasons };
}

async function reversePtr(resolver, ip, timeoutMs) {
  const t0 = performance.now();
  try {
    const names = await withTimeout(resolver.reverse(ip), timeoutMs);
    const clean = [...new Set(names.map((n) => n.toLowerCase().replace(/\.$/, '')))];
    return { status: clean.length ? 'ok' : 'none', names: clean, ms: since(t0), error: null };
  } catch (err) {
    if (err?.code === 'ENOTFOUND' || err?.code === 'ENODATA') return { status: 'none', names: [], ms: since(t0), error: null };
    return { status: 'error', names: [], ms: since(t0), error: DNS_ERRORS[err?.code] ?? `查询失败（${err?.code ?? '未知错误'}）` };
  }
}

// 校验并规范化 ip 参数：只接受公网 IP
export function requirePublicIp(raw) {
  const ip = normalizeIp(raw);
  if (!net.isIP(ip)) throw new HttpError(400, 'ip 不是合法的 IPv4 / IPv6 地址');
  if (isBlockedIP(ip)) throw new HttpError(400, '只支持公网 IP，不接受内网或保留地址');
  return ip.toLowerCase();
}

const defaultResolver = () => new dns.promises.Resolver({ timeout: LIST_TIMEOUT_MS, tries: 1 });

// createResolver、ipInfo、timeoutMs 仅供测试替换。
// DNS 查询使用服务器的系统 DNS（查询的都是固定黑名单区域与 in-addr.arpa，不涉及用户输入的域名）
export async function checkReputation(rawIp, { spamhaus = false, createResolver = defaultResolver, ipInfo = loadIpInfo, timeoutMs = LIST_TIMEOUT_MS } = {}) {
  const ip = requirePublicIp(rawIp);
  const t0 = performance.now();
  const resolver = createResolver();
  const lists = spamhaus ? [...DNSBLS, SPAMHAUS] : DNSBLS;
  const [dnsbl, ptr, info] = await Promise.all([
    Promise.all(lists.map((l) => queryDnsbl(resolver, ip, l, { timeoutMs }))),
    reversePtr(resolver, ip, timeoutMs),
    Promise.resolve().then(() => ipInfo(ip)).then((r) => ({ data: r?.data ?? r, error: null }), (err) => ({ data: null, error: err?.message ?? '查询失败' })),
  ]);
  const g = info.data;
  const provider = detectHosting(g?.asn, g?.isp, g?.org) ?? detectHosting(...ptr.names.map((n) => (/\b(vps|server|cloud|compute|hosting|dedicated)\b/i.test(n) ? n : '')));
  const network = {
    asn: g?.asn ?? null,
    isp: g?.isp ?? null,
    org: g?.org ?? null,
    country: g?.country ?? null,
    location: g?.location ?? null,
    datacenter: Boolean(provider),
    provider: provider ?? null,
    error: info.error,
  };
  const count = (s) => dnsbl.filter((d) => d.status === s).length;
  return {
    ip,
    version: net.isIP(ip),
    ...scoreReputation({ dnsbl, lists, datacenter: network.datacenter, provider, ptr }),
    dnsbl: {
      checked: dnsbl.filter((d) => d.status === 'listed' || d.status === 'clean').length,
      listed: count('listed'),
      unavailable: count('unavailable') + count('error'),
      lists: dnsbl,
    },
    network,
    ptr,
    disclaimer: DISCLAIMER,
    ms: since(t0),
  };
}

export default {
  name: 'ip-reputation',
  category: 'net',
  title: 'IP 信誉查询',
  description: '查询公网 IP 是否被垃圾邮件 / 攻击黑名单（DNSBL）列入、是否机房 IP、PTR 反向解析，并给出参考风险评分',
  source: '公开 DNSBL 黑名单、ip-api.com、DNS 反向解析',
  routes: [
    {
      method: 'GET',
      path: '/api/ip/reputation',
      summary: 'IP 信誉：DNSBL 黑名单、机房判断、PTR 与参考风险评分',
      params: [
        { name: 'ip', required: true, desc: '公网 IPv4 或 IPv6 地址（IPv6 只查归属与 PTR，暂不查黑名单）；不接受内网和保留地址', example: '8.8.8.8' },
        { name: 'spamhaus', required: false, default: 'false', desc: '是否同时查询 Spamhaus ZEN：true / false。Spamhaus 拒绝来自公共 DNS 的查询，服务器使用公共 DNS 时会显示为 unavailable', example: 'false' },
      ],
      fields: [
        { name: 'ip', type: 'string', desc: '查询的 IP（IPv4 映射的 IPv6 地址已还原为 IPv4）' },
        { name: 'version', type: 'number', desc: 'IP 版本：4 或 6' },
        { name: 'riskScore', type: 'number', desc: '参考风险分 0~100，越高风险越大：每个列入的黑名单加 20~35 分（黑名单合计最多 70，只命中 Spamhaus PBL 加 5）、机房 IP 加 20、没有 PTR 加 10。仅供参考' },
        { name: 'level', type: 'string', desc: '风险等级：低（0~29）/ 中（30~59）/ 高（60~100）' },
        { name: 'reasons', type: 'array', desc: '每一项加分原因；没有任何风险项时为空数组' },
        { name: 'reasons[].rule', type: 'string', desc: '规则：dnsbl 被黑名单列入 / dnsbl-cap 黑名单封顶调整（负分）/ datacenter 机房 IP / no-ptr 没有反向解析' },
        { name: 'reasons[].points', type: 'number', desc: '该项分数（dnsbl-cap 为负数）' },
        { name: 'reasons[].desc', type: 'string', desc: '中文说明' },
        { name: 'dnsbl', type: 'object', desc: 'DNSBL 黑名单查询结果（每个列表超时 3 秒）' },
        { name: 'dnsbl.checked', type: 'number', desc: '成功得出结论（列入或未列入）的列表数' },
        { name: 'dnsbl.listed', type: 'number', desc: '列入该 IP 的列表数' },
        { name: 'dnsbl.unavailable', type: 'number', desc: '无法查询（被拒绝、超时、出错）的列表数' },
        { name: 'dnsbl.lists', type: 'array', desc: '每个黑名单的结果' },
        { name: 'dnsbl.lists[].zone', type: 'string', desc: '黑名单 DNS 区域，如 bl.spamcop.net' },
        { name: 'dnsbl.lists[].name', type: 'string', desc: '黑名单名称' },
        { name: 'dnsbl.lists[].status', type: 'string', desc: 'listed 已列入 / clean 未列入 / unavailable 查询被拒绝（如 Spamhaus 返回 127.255.255.254）/ error 超时或出错 / skipped 未查询（IPv6）' },
        { name: 'dnsbl.lists[].codes', type: 'array', desc: '黑名单返回的 A 记录（返回码，如 127.0.0.2）；未列入时为空数组' },
        { name: 'dnsbl.lists[].meanings', type: 'array', desc: '每个返回码的中文含义（如 DroneBL 的 127.0.0.9 表示 HTTP 代理）' },
        { name: 'dnsbl.lists[].ms', type: 'number', desc: '查询耗时（毫秒）' },
        { name: 'dnsbl.lists[].error', type: 'string|null', desc: '无法查询或出错的原因；正常时为 null' },
        { name: 'network', type: 'object', desc: 'IP 所属网络（来自 ip-api.com，与 /api/ip 相同数据源）' },
        { name: 'network.asn', type: 'string|null', desc: '自治系统编号与名称，如 "AS15169 Google LLC"；查询失败时为 null' },
        { name: 'network.isp', type: 'string|null', desc: '运营商 / ISP 名称' },
        { name: 'network.org', type: 'string|null', desc: '所属组织' },
        { name: 'network.country', type: 'string|null', desc: '国家（中文）' },
        { name: 'network.location', type: 'string|null', desc: '归属地（国家 省 市）' },
        { name: 'network.datacenter', type: 'boolean', desc: '是否判断为机房 / 云服务商 IP：按 ASN、ISP、组织名（及含 vps / server / cloud 等字样的 PTR）匹配 Amazon、Google Cloud、阿里云、腾讯云、DigitalOcean、OVH、Hetzner、Vultr、Linode 等关键词，可能漏判或误判' },
        { name: 'network.provider', type: 'string|null', desc: '匹配到的服务商名称；不是机房 IP 时为 null' },
        { name: 'network.error', type: 'string|null', desc: '归属查询失败的原因（此时 asn 等为 null，机房判断只能依据 PTR）；成功时为 null' },
        { name: 'ptr', type: 'object', desc: 'PTR 反向解析' },
        { name: 'ptr.status', type: 'string', desc: 'ok 有记录 / none 没有记录 / error 查询失败' },
        { name: 'ptr.names', type: 'array', desc: 'PTR 记录的域名（小写、去掉末尾的点）' },
        { name: 'ptr.ms', type: 'number', desc: '查询耗时（毫秒）' },
        { name: 'ptr.error', type: 'string|null', desc: '查询失败的原因；正常时为 null' },
        { name: 'disclaimer', type: 'string', desc: '说明：评分仅供参考；本接口不能保证识别代理、VPN、住宅代理或 Tor 出口' },
        { name: 'ms', type: 'number', desc: '总耗时（毫秒）' },
      ],
      async handler({ query }) {
        const ip = requirePublicIp(param(query, 'ip', { required: true, max: 64 }));
        const spamhaus = param(query, 'spamhaus', { default: 'false', oneOf: ['true', 'false', '1', '0'] });
        const on = spamhaus === 'true' || spamhaus === '1';
        return cache.wrap(`ip-reputation:${ip}:${on ? 1 : 0}`, 10 * 60_000, () => gate(() => checkReputation(ip, { spamhaus: on })));
      },
    },
  ],
};

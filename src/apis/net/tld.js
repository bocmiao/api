import { domainToASCII, domainToUnicode } from 'node:url';
import { cache } from '../../lib/cache.js';
import { HttpError, fetchText, param } from '../../lib/http.js';

const IANA_URL = 'https://data.iana.org/TLD/tlds-alpha-by-domain.txt';
const DAY_MS = 86_400_000;
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
export const TYPES = { gtld: 'gTLD', cctld: 'ccTLD', idn: 'IDN' };

// 常见中文相关后缀及常用后缀的中文说明（键为 Unicode 形式，启动时转成 ASCII）
const NOTES_BY_NAME = {
  cn: '中国大陆国家和地区顶级域，由 CNNIC 管理',
  中国: '中国大陆中文国家和地区顶级域（简体），与 .cn 同由 CNNIC 管理',
  中國: '中国大陆中文国家和地区顶级域（繁体），由 CNNIC 管理',
  hk: '中国香港地区顶级域',
  香港: '中国香港地区中文顶级域',
  mo: '中国澳门地区顶级域',
  澳門: '中国澳门地区中文顶级域',
  tw: '中国台湾地区顶级域',
  台湾: '中国台湾地区中文顶级域（简体）',
  台灣: '中国台湾地区中文顶级域（繁体）',
  sg: '新加坡国家顶级域',
  新加坡: '新加坡中文国家顶级域',
  公司: '中文通用顶级域「.公司」，面向企业，由 CNNIC 运营',
  网络: '中文通用顶级域「.网络」，由 CNNIC 运营',
  在线: '中文通用顶级域「.在线」',
  中文网: '中文通用顶级域「.中文网」',
  网址: '中文通用顶级域「.网址」',
  网店: '中文通用顶级域「.网店」，面向电商',
  商城: '中文通用顶级域「.商城」，面向电商',
  集团: '中文通用顶级域「.集团」，面向企业集团',
  企业: '中文通用顶级域「.企业」',
  商标: '中文通用顶级域「.商标」',
  我爱你: '中文通用顶级域「.我爱你」',
  游戏: '中文通用顶级域「.游戏」',
  娱乐: '中文通用顶级域「.娱乐」',
  手机: '中文通用顶级域「.手机」',
  信息: '中文通用顶级域「.信息」',
  移动: '中文品牌顶级域「.移动」',
  政务: '中文顶级域「.政务」，限中国党政机关注册',
  公益: '中文顶级域「.公益」，限中国公益机构注册',
  广东: '中文地理顶级域「.广东」',
  佛山: '中文地理顶级域「.佛山」',
  世界: '中文通用顶级域「.世界」',
  购物: '中文通用顶级域「.购物」',
  时尚: '中文通用顶级域「.时尚」',
  健康: '中文通用顶级域「.健康」',
  com: '商业机构，使用最广的通用顶级域',
  net: '网络服务机构，常作为 .com 的补充',
  org: '非营利组织',
  top: '新通用顶级域，由中国企业运营，国内注册量大',
  xyz: '新通用顶级域，价格低、注册量大',
  wang: '新通用顶级域「.wang」（网），由中国企业运营',
  ren: '新通用顶级域「.ren」（人），由中国企业运营',
  vip: '新通用顶级域，国内常用',
  shop: '新通用顶级域，面向电商',
  ltd: '新通用顶级域，面向有限公司',
  edu: '美国高等教育机构专用',
  gov: '美国政府机构专用',
  cc: '科科斯（基林）群岛国家顶级域，国内常作为通用域名使用',
  tv: '图瓦卢国家顶级域，常用于视频网站',
  io: '英属印度洋领地国家顶级域，常用于科技公司和开源项目',
  ai: '安圭拉国家顶级域，常用于人工智能相关网站',
  me: '黑山国家顶级域，常用于个人网站',
  co: '哥伦比亚国家顶级域，常作为 company 的缩写使用',
  us: '美国国家顶级域',
  uk: '英国国家顶级域',
  jp: '日本国家顶级域',
  kr: '韩国国家顶级域',
  arpa: '互联网基础设施专用（如 in-addr.arpa 反向解析），归入 gTLD 类型',
};
export const NOTES = Object.fromEntries(Object.entries(NOTES_BY_NAME).map(([k, v]) => [domainToASCII(k), v]));

// 上游不可用时使用的内置常用后缀（Unicode 形式）
const BUILTIN = [
  'com', 'net', 'org', 'info', 'biz', 'xyz', 'top', 'vip', 'shop', 'site', 'online', 'store', 'tech', 'app', 'dev', 'club', 'fun', 'icu',
  'live', 'pro', 'name', 'mobi', 'asia', 'cloud', 'link', 'work', 'art', 'ltd', 'wang', 'ren', 'ink', 'red', 'kim', 'group', 'news', 'blog',
  'design', 'space', 'website', 'email', 'today', 'life', 'world', 'zone', 'team', 'company', 'center', 'edu', 'gov', 'mil', 'int', 'arpa',
  'cn', 'hk', 'mo', 'tw', 'sg', 'us', 'uk', 'jp', 'kr', 'de', 'fr', 'ru', 'ca', 'au', 'in', 'io', 'co', 'me', 'tv', 'cc', 'ai', 'eu', 'nl', 'it',
  '中国', '中國', '香港', '澳門', '台湾', '台灣', '新加坡', '公司', '网络', '在线', '中文网', '网址', '网店', '商城', '集团', '企业', '商标', '我爱你',
  '游戏', '娱乐', '手机', '信息', '移动', '政务', '公益', '广东', '佛山', '世界', '购物', '时尚', '健康',
].map((t) => domainToASCII(t)).sort();

export function classifyTld(ascii) {
  if (ascii.startsWith('xn--')) return 'IDN';
  if (/^[a-z]{2}$/.test(ascii)) return 'ccTLD';
  return 'gTLD';
}

// 解析 IANA 列表：首行是 "# Version 2026092400, Last Updated ..."，其余每行一个大写后缀
export function parseTldList(text) {
  const lines = String(text).split(/\r?\n/);
  const version = lines.find((l) => l.startsWith('#'))?.replace(/^#\s*/, '').trim() || null;
  const tlds = lines.map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#') && /^[a-z0-9-]+$/.test(l));
  if (tlds.length < 100) throw new HttpError(502, 'IANA 后缀列表格式无法识别');
  return { version, tlds };
}

export function toItem(ascii) {
  const unicode = ascii.startsWith('xn--') ? domainToUnicode(ascii) || ascii : ascii;
  return { tld: ascii, unicode, type: classifyTld(ascii), note: NOTES[ascii] ?? null };
}

let lastFailure = 0;

// 返回 { data: { source, fallback, version, items }, cached?, updatedAt? }
async function loadList() {
  const builtin = () => ({ data: { source: 'builtin', fallback: true, version: null, items: BUILTIN.map(toItem) } });
  const hit = cache.get('net:tld-list');
  if (!hit?.fresh && Date.now() - lastFailure < RETRY_AFTER_FAILURE_MS) return hit ? { data: hit.value, cached: true, stale: true, updatedAt: hit.updatedAt } : builtin();
  try {
    return await cache.wrap('net:tld-list', DAY_MS, async () => {
      const { version, tlds } = parseTldList(await fetchText(IANA_URL, { timeoutMs: 5000 }));
      return { source: 'iana', fallback: false, version, items: tlds.map(toItem) };
    });
  } catch {
    lastFailure = Date.now();
    return builtin();
  }
}
export const resetTldState = () => { lastFailure = 0; };

// q 模糊搜索（ASCII、Unicode、中文说明都参与；完全相同的排最前，其次前缀匹配，再次包含），type 过滤
export function searchTlds(items, { q, type } = {}) {
  let list = type ? items.filter((i) => i.type === TYPES[type]) : items;
  if (q) {
    const needle = q.trim().toLowerCase().replace(/^\.+/, '');
    const asciiNeedle = domainToASCII(needle) || needle;
    const score = (i) => {
      if (i.tld === needle || i.tld === asciiNeedle || i.unicode === needle) return 0;
      if (i.tld.startsWith(needle) || i.unicode.startsWith(needle)) return 1;
      if (i.tld.includes(needle) || i.unicode.includes(needle) || (i.note ?? '').toLowerCase().includes(needle)) return 2;
      return -1;
    };
    list = list.map((i, idx) => ({ i, idx, s: score(i) })).filter((x) => x.s >= 0).sort((a, b) => a.s - b.s || a.idx - b.idx).map((x) => x.i);
  }
  return list;
}

export default {
  name: 'tld',
  category: 'net',
  title: '域名后缀列表',
  description: 'IANA 全部顶级域名后缀，分为通用（gTLD）、国家和地区（ccTLD）、国际化（IDN），支持搜索与中文说明',
  source: 'IANA',
  routes: [
    {
      method: 'GET',
      path: '/api/tld',
      summary: '查询顶级域名后缀列表',
      params: [
        { name: 'q', required: false, desc: '模糊搜索，匹配后缀（可带点，如 .cn）、中文形式（如 中国）或中文说明（如 电商）', example: 'cn' },
        { name: 'type', required: false, desc: '按类型过滤：gtld 通用顶级域、cctld 国家和地区顶级域、idn 国际化域名', example: 'idn' },
      ],
      fields: [
        { name: 'source', type: 'string', desc: '数据来源：iana 为 IANA 官方列表（缓存 1 天）；builtin 为上游不可用时的内置常用后缀' },
        { name: 'fallback', type: 'boolean', desc: '是否使用了内置的备用列表（true 时列表不完整，只有 107 个常用后缀）' },
        { name: 'version', type: 'string|null', desc: 'IANA 列表的版本说明（原文，如 Version 2026092400, Last Updated Wed Sep 24 07:07:01 2026 UTC）；使用内置列表时为 null' },
        { name: 'total', type: 'number', desc: '列表中的后缀总数（过滤前）' },
        { name: 'count', type: 'number', desc: '符合 q 和 type 条件的后缀数（即 items 的长度）' },
        { name: 'stats', type: 'object', desc: '各类型的后缀数量（过滤前）' },
        { name: 'stats.gTLD', type: 'number', desc: '通用顶级域数量（含 com、net 等传统后缀和新通用顶级域）' },
        { name: 'stats.ccTLD', type: 'number', desc: '国家和地区顶级域数量（两位字母，如 cn、us）' },
        { name: 'stats.IDN', type: 'number', desc: '国际化域名后缀数量（xn-- 开头，如 中国、公司）' },
        { name: 'items', type: 'array', desc: '后缀列表：未搜索时按字母顺序；搜索时按匹配程度排序（完全相同 → 前缀匹配 → 包含）' },
        { name: 'items[].tld', type: 'string', desc: '后缀的 ASCII 形式（小写，不带点；国际化域名为 punycode，如 xn--fiqs8s）' },
        { name: 'items[].unicode', type: 'string', desc: '显示用的形式：国际化域名解码为 Unicode（如 中国），其他与 tld 相同' },
        { name: 'items[].type', type: 'string', desc: '类型：gTLD 通用顶级域；ccTLD 国家和地区顶级域（两位字母）；IDN 国际化域名（xn-- 开头，包括中国、香港等中文国家和地区后缀）' },
        { name: 'items[].note', type: 'string|null', desc: '中文说明，仅常见的中文相关后缀（cn、中国、公司、网络、香港等）和常用后缀（com、io 等）有；其他为 null' },
      ],
      async handler({ query }) {
        const q = param(query, 'q', { max: 63 });
        const typeRaw = param(query, 'type', { max: 10 })?.toLowerCase();
        if (typeRaw && !TYPES[typeRaw]) throw new HttpError(400, 'type 只能是 gtld / cctld / idn');
        const res = await loadList();
        const all = res.data.items;
        const items = searchTlds(all, { q, type: typeRaw });
        const stats = { gTLD: 0, ccTLD: 0, IDN: 0 };
        for (const i of all) stats[i.type]++;
        const { items: _omit, ...meta } = res.data;
        return { ...res, data: { ...meta, total: all.length, count: items.length, stats, items } };
      },
    },
  ],
};

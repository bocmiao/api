import { HttpError, param } from '../../lib/http.js';
import { createGate, fetchFollow, readLimited, toHttpError, checkTarget, isBlockedIP } from './common.js';

const MAX_BYTES = 500 * 1024; // Google 只处理 robots.txt 的前 500KiB
const TIMEOUT_MS = 5000; // 每一跳
const TOTAL_TIMEOUT_MS = 10_000; // 含跳转的总时限
const MAX_PATH = 2048;
const gate = createGate(20);

const KEYS = {
  'user-agent': 'user-agent', useragent: 'user-agent', 'user agent': 'user-agent',
  allow: 'allow',
  disallow: 'disallow', dissallow: 'disallow', dissalow: 'disallow', disalow: 'disallow', diasllow: 'disallow', disallaw: 'disallow',
  'crawl-delay': 'crawl-delay', crawldelay: 'crawl-delay',
  sitemap: 'sitemap', 'site-map': 'sitemap',
};

// 解析 robots.txt：连续的 User-agent 行组成一组，后面跟该组的 Allow / Disallow / Crawl-delay。
// 空的 Disallow 表示不限制，直接忽略；出现在任何 User-agent 之前的规则按规范忽略。Sitemap 与分组无关。
export function parseRobots(text, baseUrl) {
  const groups = [];
  const sitemaps = new Set();
  let current = null;
  let lastWasAgent = false;
  for (let line of String(text).replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const hash = line.indexOf('#');
    if (hash !== -1) line = line.slice(0, hash);
    // 用 indexOf 找冒号再校验键名，不用带回溯的正则（单行可能很长）
    const colon = line.indexOf(':');
    if (colon <= 0 || colon > 64) continue;
    const rawKey = line.slice(0, colon).trim().toLowerCase();
    if (!/^[a-z][a-z -]*$/.test(rawKey)) continue;
    const key = KEYS[rawKey];
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) groups.push((current = { agents: [], rules: [], crawlDelay: null }));
      if (value) current.agents.push(value);
      lastWasAgent = true;
      continue;
    }
    if (key === 'sitemap') {
      try {
        const u = new URL(value, baseUrl).href;
        if (/^https?:/.test(u)) sitemaps.add(u);
      } catch { /* 忽略无效地址 */ }
      continue;
    }
    if (!key) continue;
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'crawl-delay') {
      const n = Number(value);
      if (value && Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    } else if (value) {
      current.rules.push({ type: key, path: value });
    }
  }
  return { groups: groups.filter((g) => g.agents.length), sitemaps: [...sitemaps] };
}

// 路径规范化：非 ASCII 字符按 UTF-8 百分号编码，已有的 %xx 统一为大写，便于规则与路径比较
export function normalizeRobotsPath(s) {
  return String(s)
    .replace(/%[0-9a-f]{2}/gi, (x) => x.toUpperCase())
    .replace(/[^\x00-\x7f]+/g, (x) => encodeURIComponent(x));
}

// 规则是否匹配路径（从路径开头匹配；* 匹配任意字符序列，结尾的 $ 表示必须匹配到路径末尾）。
// 用位集（Shift-And）记录"模式已匹配到路径的哪些位置"，时间复杂度 O(模式长度 × 路径长度 / 32)，
// 不用正则，恶意构造的规则（如大量 *）也不会引起回溯爆炸。
export function robotsMatch(pattern, path) {
  let pat = pattern;
  const anchored = pat.endsWith('$');
  if (anchored) pat = pat.slice(0, -1);
  const n = path.length;
  const words = (n >>> 5) + 1;
  const masks = new Map();
  const maskOf = (ch) => {
    let m = masks.get(ch);
    if (!m) {
      m = new Uint32Array(words);
      for (let i = 0; i < n; i++) if (path[i] === ch) m[i >>> 5] |= 1 << (i & 31);
      masks.set(ch, m);
    }
    return m;
  };
  let cur = new Uint32Array(words);
  let next = new Uint32Array(words);
  cur[0] = 1; // 位置 0：还没匹配任何字符
  for (let k = 0; k < pat.length; k++) {
    const ch = pat[k];
    if (ch === '*') {
      // 从当前最小的已匹配位置起，之后的位置全部可达
      let w = 0;
      while (w < words && !cur[w]) w++;
      if (w === words) return false;
      const low = cur[w] & -cur[w];
      cur[w] |= ~(low - 1);
      for (let j = w + 1; j < words; j++) cur[j] = 0xffffffff;
      continue;
    }
    const m = maskOf(ch);
    let carry = 0;
    let any = 0;
    for (let w = 0; w < words; w++) {
      const v = cur[w] & m[w];
      next[w] = (v << 1) | carry;
      carry = v >>> 31;
      any |= next[w];
    }
    if (!any) return false;
    [cur, next] = [next, cur];
  }
  return anchored ? (cur[n >>> 5] & (1 << (n & 31))) !== 0 : true;
}

// User-agent 取产品名部分（Googlebot/2.1 → googlebot）
const agentToken = (s) => (String(s).trim().toLowerCase().match(/^[a-z0-9_*.-]+/)?.[0] ?? '');

// 选出对该爬虫生效的组：先找名称完全相同的组；没有时找名称是其前缀的组（如 googlebot 之于 googlebot-image，取最长）；
// 仍没有时用 * 组。多个同名组的规则合并。
export function selectGroups(groups, agent) {
  const token = agentToken(agent) || '*';
  const byName = (name) => groups.filter((g) => g.agents.some((a) => agentToken(a) === name));
  if (token !== '*') {
    const exact = byName(token);
    if (exact.length) return { name: token, groups: exact };
    const prefixes = [...new Set(groups.flatMap((g) => g.agents.map(agentToken)))]
      .filter((a) => a !== '*' && a && token.startsWith(`${a}-`))
      .sort((a, b) => b.length - a.length);
    if (prefixes.length) return { name: prefixes[0], groups: byName(prefixes[0]) };
  }
  const star = byName('*');
  return { name: star.length ? '*' : null, groups: star };
}

// 按 Google 规范判断：在生效组的规则里取匹配长度最长的一条；Allow 与 Disallow 一样长时 Allow 优先；没有匹配则允许
export function isAllowed(parsed, agent, path) {
  const target = normalizeRobotsPath(path);
  const { name, groups } = selectGroups(parsed.groups, agent);
  let best = null;
  if (target !== '/robots.txt') {
    for (const g of groups) {
      for (const r of g.rules) {
        const pat = normalizeRobotsPath(r.path);
        if (!robotsMatch(pat, target)) continue;
        const len = pat.length;
        if (!best || len > best.len || (len === best.len && r.type === 'allow' && best.rule.type === 'disallow')) best = { len, rule: r };
      }
    }
  }
  return { group: name, allowed: best ? best.rule.type === 'allow' : true, rule: best ? { ...best.rule } : null };
}

function pathOf(input) {
  let s = String(input).trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      s = u.pathname + u.search;
    } catch {
      throw new HttpError(400, 'path 不合法');
    }
  }
  if (!s.startsWith('/')) s = `/${s}`;
  return s;
}

// blocked 仅供测试替换
export async function analyzeRobots(rawUrl, { path, agent, blocked = isBlockedIP } = {}) {
  let origin;
  try {
    origin = checkTarget(rawUrl, blocked).origin;
  } catch (err) {
    throw toHttpError(err);
  }
  const robotsUrl = `${origin}/robots.txt`;
  let r;
  try {
    r = await fetchFollow(robotsUrl, {
      blocked, maxRedirects: 5, timeoutMs: TIMEOUT_MS, signal: AbortSignal.timeout(TOTAL_TIMEOUT_MS), headers: { accept: 'text/plain,*/*;q=0.8' },
    });
  } catch (err) {
    throw toHttpError(err);
  }
  const status = r.res.statusCode;
  let policy = 'rules';
  let note = null;
  let parsed = { groups: [], sitemaps: [] };
  let size = null;
  let truncated = false;
  if (status >= 200 && status < 300) {
    let body;
    try {
      body = await readLimited(r.res, { maxBytes: MAX_BYTES, decompress: true, signal: r.signal });
    } catch (err) {
      throw toHttpError(err, r.signal);
    }
    size = body.bytes;
    truncated = body.truncated;
    parsed = parseRobots(new TextDecoder('utf-8').decode(body.body), r.url.href);
    if (!parsed.groups.length) note = 'robots.txt 中没有有效的 User-agent 分组，视为允许抓取所有路径';
    if (truncated) note = 'robots.txt 超过 500KB，只解析了前 500KB（与 Google 的处理方式相同）';
  } else {
    r.res.destroy();
    if (status >= 400 && status < 500) {
      policy = 'allow-all';
      note = `robots.txt 不存在或无法访问（HTTP ${status}），按规范视为允许所有爬虫抓取全部路径`;
    } else {
      policy = 'disallow-all';
      note = `robots.txt 返回服务器错误（HTTP ${status}），按 Google 规范暂时视为禁止抓取全部路径`;
    }
  }

  let check = null;
  if (path != null || agent != null) {
    const p = pathOf(path ?? '/');
    const a = agent ?? '*';
    if (policy === 'rules') {
      check = { agent: a, path: p, ...isAllowed(parsed, a, p) };
    } else {
      check = { agent: a, path: p, group: null, allowed: policy === 'allow-all', rule: null };
    }
  }

  return {
    url: robotsUrl,
    finalUrl: r.url.href,
    status,
    found: policy === 'rules',
    policy,
    note,
    size,
    truncated,
    groups: parsed.groups,
    sitemaps: parsed.sitemaps,
    check,
  };
}

export default {
  name: 'robots',
  category: 'net',
  title: 'Robots 分析',
  description: '抓取并解析网站的 robots.txt：按 User-agent 分组的规则、Crawl-delay、Sitemap，并可判断某个爬虫能否抓取指定路径',
  source: '目标网站 /robots.txt',
  routes: [
    {
      method: 'GET',
      path: '/api/robots',
      summary: '解析 robots.txt，判断爬虫能否抓取某路径',
      params: [
        { name: 'url', required: true, desc: '网站地址（http / https），会读取其根目录的 /robots.txt', example: 'https://github.com' },
        { name: 'path', required: false, desc: '要判断的路径（如 /search?q=1，也可以是完整网址）；传了 path 或 agent 才会返回 check', example: '/search' },
        { name: 'agent', required: false, default: '*', desc: '爬虫名称（User-agent 的产品名，如 Googlebot、Baiduspider）；不传时按 * 组判断', example: 'Googlebot' },
      ],
      fields: [
        { name: 'url', type: 'string', desc: '读取的 robots.txt 地址（站点根目录，如 https://github.com/robots.txt）' },
        { name: 'finalUrl', type: 'string', desc: '跟随跳转后实际读取的地址（最多跳转 5 次）；没有跳转时与 url 相同' },
        { name: 'status', type: 'number', desc: 'robots.txt 的 HTTP 状态码' },
        { name: 'found', type: 'boolean', desc: '是否成功读取到 robots.txt（状态码 2xx）' },
        { name: 'policy', type: 'string', desc: '整体策略：rules 按文件中的规则；allow-all 文件不存在（4xx），允许抓取全部；disallow-all 服务器错误（5xx），按 Google 规范暂时视为全部禁止' },
        { name: 'note', type: 'string|null', desc: '补充说明（如"robots.txt 不存在……允许所有爬虫抓取全部路径"、文件超过 500KB 被截断）；正常解析时为 null' },
        { name: 'size', type: 'number|null', desc: '读取的 robots.txt 大小（字节，解压后，最多 512000）；未读取到时为 null' },
        { name: 'truncated', type: 'boolean', desc: '文件是否超过 500KB 被截断（超出部分不解析）' },
        { name: 'groups', type: 'array', desc: '按 User-agent 分组的规则，顺序与文件一致；同一爬虫出现在多个组时判断时会合并' },
        { name: 'groups[].agents', type: 'array', desc: '该组适用的 User-agent 列表（原文，如 *、Googlebot）' },
        { name: 'groups[].agents[]', type: 'string', desc: '单个 User-agent' },
        { name: 'groups[].rules', type: 'array', desc: '该组的 Allow / Disallow 规则，顺序与文件一致；空的 Disallow（表示不限制）不列出' },
        { name: 'groups[].rules[].type', type: 'string', desc: '规则类型：allow 允许、disallow 禁止' },
        { name: 'groups[].rules[].path', type: 'string', desc: '路径规则原文，从路径开头匹配；* 匹配任意字符，结尾的 $ 表示必须到路径末尾（如 /*.pdf$）' },
        { name: 'groups[].crawlDelay', type: 'number|null', desc: 'Crawl-delay（秒，两次抓取的最小间隔；Google 不支持该指令，Bing、百度等部分爬虫参考）；未设置时为 null' },
        { name: 'sitemaps', type: 'array', desc: 'Sitemap 地址列表（绝对地址，已去重）；没有声明时为空数组' },
        { name: 'sitemaps[]', type: 'string', desc: '单个 Sitemap 地址' },
        { name: 'check', type: 'object|null', desc: '路径判断结果；没有传 path 和 agent 时为 null' },
        { name: 'check.agent', type: 'string', desc: '判断用的爬虫名称（未传 agent 时为 *）' },
        { name: 'check.path', type: 'string', desc: '判断的路径（含查询字符串，以 / 开头）' },
        { name: 'check.group', type: 'string|null', desc: '生效的 User-agent 组名（小写产品名）：先找名称完全相同的组，其次找名称是其前缀的组（如 googlebot 之于 googlebot-image），最后用 *；没有可用的组或 policy 不是 rules 时为 null' },
        { name: 'check.allowed', type: 'boolean', desc: '是否允许抓取：按 Google 规范取匹配长度最长的规则，Allow 与 Disallow 一样长时 Allow 优先，没有匹配的规则时允许；policy 为 allow-all 时为 true、disallow-all 时为 false' },
        { name: 'check.rule', type: 'object|null', desc: '决定结果的规则；没有规则匹配时为 null' },
        { name: 'check.rule.type', type: 'string', desc: '规则类型：allow / disallow' },
        { name: 'check.rule.path', type: 'string', desc: '规则的路径原文' },
      ],
      async handler({ query }) {
        const url = param(query, 'url', { required: true, max: 2048 });
        const path = param(query, 'path', { max: MAX_PATH });
        const agent = param(query, 'agent', { max: 100 });
        return { data: await gate(() => analyzeRobots(url, { path, agent })) };
      },
    },
  ],
};

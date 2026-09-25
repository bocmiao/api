// 邮件相关检测：域名的邮件安全配置（SPF / DMARC / DKIM / MX）与邮箱地址有效性。
// 只做 DNS 查询，且只发往固定的公共 DNS（见 dns.js 的 DNS_SERVERS），不连接目标的邮件服务器，也不做 SMTP 探测。
// c-ares 在 UDP 应答被截断（TC 位）时会自动改用 TCP 重查，TXT 记录很多的域名（SPF 常被挤出 UDP 应答）也能取全，因此不需要 DoH 补查。
import dns from 'node:dns';
import { HttpError, param } from '../../lib/http.js';
import { cache } from '../../lib/cache.js';
import { createGate, parseHost, isBlockedIP, BLOCKED_MSG, since } from './common.js';
import { DNS_SERVERS, classifyDnsError } from './dns.js';

const DNS_SERVER = DNS_SERVERS.cloudflare;
const FALLBACK_SERVER = DNS_SERVERS.alidns;
const QUERY_TIMEOUT_MS = 6000;
const gate = createGate(20);

const defaultResolver = (opts) => new dns.promises.Resolver(opts);

function makeResolver(createResolver) {
  const r = createResolver({ timeout: 2500, tries: 2 });
  r.setServers([DNS_SERVER, FALLBACK_SERVER]);
  return r;
}

// 一次查询：{ status: ok / empty / nxdomain / error, records, error }；整体超时后按 error 处理
async function query(resolver, method, name, timeoutMs) {
  let timer;
  try {
    const records = await Promise.race([
      resolver[method](name),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ECANCELLED' })), timeoutMs); }),
    ]);
    return { status: records.length ? 'ok' : 'empty', records, error: null };
  } catch (err) {
    return { records: [], ...classifyDnsError(err) };
  } finally {
    clearTimeout(timer);
  }
}

const txtOf = (r) => r.records.map((chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks)));

function requireMailDomain(raw) {
  let s = String(raw ?? '').trim();
  if (s.includes('@')) s = s.slice(s.lastIndexOf('@') + 1);
  const h = parseHost(s);
  if (!h || h.ip) throw new HttpError(400, 'domain 不是合法的域名');
  if (h.local) throw new HttpError(400, BLOCKED_MSG);
  return h.host;
}

// ---------- 邮件安全配置 ----------

// DKIM 选择器由邮件服务商自定，无法枚举，只能尝试常见的
export const COMMON_SELECTORS = [
  'default', 'selector1', 'selector2', 'google', 'k1', 'k2', 's1', 's2', 'dkim', 'mail', 'smtp', 'key1', 'mxvault', 'zoho', 'qq', 'aliyun',
];
const SPF_LOOKUP = new Set(['include', 'a', 'mx', 'ptr', 'exists', 'redirect']);
const ALL_POLICY = {
  '-': { policy: 'fail', text: '严格拒绝（-all）', score: 45 },
  '~': { policy: 'softfail', text: '软拒绝（~all）', score: 38 },
  '?': { policy: 'neutral', text: '中立（?all），起不到保护作用', score: 15 },
  '+': { policy: 'pass', text: '允许所有服务器（+all），等于没有保护', score: 0 },
};
const DMARC_POLICY = {
  reject: { text: '拒收（reject）', score: 55 },
  quarantine: { text: '隔离到垃圾箱（quarantine）', score: 45 },
  none: { text: '仅监控（none），不拦截伪造邮件', score: 20 },
};

// 分析 SPF：返回 { found, record, all, policy, lookups, issues, score }
export function analyzeSpf(txt) {
  const records = txt.filter((r) => /^v=spf1(\s|$)/i.test(r.trim()));
  if (!records.length) {
    return { found: false, record: null, all: null, policy: null, lookups: 0, issues: ['没有 SPF 记录，任何服务器都可以冒用该域名发信'], score: 0 };
  }
  const issues = [];
  if (records.length > 1) issues.push(`存在 ${records.length} 条 SPF 记录，按规范只能有一条，多条会导致校验失败（permerror）`);
  const record = records[0].trim();
  const terms = record.split(/\s+/).slice(1).filter(Boolean);
  let lookups = 0;
  let all = null;
  let redirect = false;
  for (const t of terms) {
    const body = t.replace(/^[+\-~?]/, '').toLowerCase();
    const mech = body.split(/[:=/]/, 1)[0];
    if (SPF_LOOKUP.has(mech)) lookups++;
    if (mech === 'redirect') redirect = true;
    if (body === 'all') all = /^[+\-~?]/.test(t) ? t[0] : '+';
  }
  if (lookups > 10) issues.push(`包含 ${lookups} 个需要 DNS 查询的机制，超过 10 个的上限，会导致校验失败（permerror）`);
  let policy = null;
  let score;
  if (all) {
    ({ policy, score } = ALL_POLICY[all]);
    if (all === '+' || all === '?') issues.push(`SPF 策略为${ALL_POLICY[all].text}`);
  } else if (redirect) {
    policy = 'redirect';
    score = 38;
  } else {
    issues.push('SPF 记录没有以 all 结尾，未列出的服务器会按中立处理');
    score = 15;
  }
  if (records.length > 1 || lookups > 10) score = Math.min(score, 10);
  return { found: true, record, all: all ? `${all}all` : null, policy, lookups, issues, score };
}

// 解析 DMARC 标签（k=v; k=v），键名转小写
function dmarcTags(record) {
  const tags = {};
  for (const part of record.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim().toLowerCase();
    if (!(k in tags)) tags[k] = part.slice(eq + 1).trim();
  }
  return tags;
}

export function analyzeDmarc(txt) {
  const records = txt.filter((r) => /^v\s*=\s*DMARC1\s*(;|$)/i.test(r.trim()));
  if (!records.length) {
    return {
      found: false, record: null, policy: null, subdomainPolicy: null, percent: null, reportTo: null, issues: ['没有 DMARC 记录，收件方不知道该如何处理冒用该域名的邮件'], score: 0,
    };
  }
  const record = records[0].trim();
  const tags = dmarcTags(record);
  const p = (tags.p ?? '').toLowerCase();
  const pct = tags.pct != null && /^\d{1,3}$/.test(tags.pct) ? Math.min(100, Number(tags.pct)) : 100;
  const issues = [];
  if (records.length > 1) issues.push('存在多条 DMARC 记录，按规范只能有一条，多条会被忽略');
  if (!DMARC_POLICY[p]) issues.push('DMARC 记录缺少有效的 p= 策略');
  else if (p === 'none') issues.push('DMARC 策略为 none，只监控不拦截');
  if (!tags.rua) issues.push('没有设置 rua 汇总报告地址，收不到 DMARC 报告');
  if (pct < 100) issues.push(`策略只对 ${pct}% 的邮件生效`);
  let score = records.length > 1 ? 10 : DMARC_POLICY[p]?.score ?? 5;
  if (pct < 100 && score > 20) score = Math.round(20 + (score - 20) * (pct / 100));
  return {
    found: true,
    record,
    policy: DMARC_POLICY[p] ? p : null,
    subdomainPolicy: tags.sp ? tags.sp.toLowerCase() : null,
    percent: pct,
    reportTo: tags.rua || null,
    issues,
    score,
  };
}

const isDkim = (r) => /(^|;)\s*v\s*=\s*DKIM1\b/i.test(r) || /(^|;)\s*p\s*=/i.test(r);

export const gradeOf = (score) => (score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 50 ? 'C' : score >= 25 ? 'D' : 'F');

// createResolver、timeoutMs 仅供测试替换
export async function checkEmailSecurity(rawDomain, { selector, createResolver = defaultResolver, timeoutMs = QUERY_TIMEOUT_MS } = {}) {
  const domain = requireMailDomain(rawDomain);
  let selectors = COMMON_SELECTORS;
  if (selector) {
    const s = String(selector).trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,63}(\.[a-z0-9_-]{1,63}){0,3}$/.test(s)) throw new HttpError(400, 'selector 只能包含字母、数字、点、横线和下划线');
    selectors = [s];
  }
  const t0 = performance.now();
  const resolver = makeResolver(createResolver);
  const [mx, root, dmarcRes, ...dkimRes] = await Promise.all([
    query(resolver, 'resolveMx', domain, timeoutMs),
    query(resolver, 'resolveTxt', domain, timeoutMs),
    query(resolver, 'resolveTxt', `_dmarc.${domain}`, timeoutMs),
    ...selectors.map((s) => query(resolver, 'resolveTxt', `${s}._domainkey.${domain}`, timeoutMs)),
  ]);
  resolver.cancel?.();
  if (root.status === 'error' && dmarcRes.status === 'error' && mx.status === 'error') throw new HttpError(502, `DNS 查询失败：${root.error}`);
  if (root.status === 'nxdomain' && mx.status === 'nxdomain') throw new HttpError(404, '域名不存在（NXDOMAIN）');

  const mxRecords = mx.records
    .map((r) => ({ exchange: r.exchange || '.', priority: r.priority }))
    .sort((a, b) => a.priority - b.priority);
  const nullMx = mxRecords.length === 1 && mxRecords[0].exchange === '.';
  const { score: spfScore, ...spf } = analyzeSpf(txtOf(root));
  const { score: dmarcScore, ...dmarc } = analyzeDmarc(txtOf(dmarcRes));
  const found = selectors.filter((_, i) => txtOf(dkimRes[i]).some(isDkim));

  const suggestions = [];
  if (!spf.found) suggestions.push(mxRecords.length && !nullMx ? '添加 SPF 记录，列出允许代表该域名发信的服务器，并以 -all 或 ~all 结尾' : '该域名如果不发邮件，添加 "v=spf1 -all" 明确声明不发信，防止被冒用');
  else if (spf.all === '~all') suggestions.push('确认所有发信渠道都已加入 SPF 后，可把 ~all 改为 -all');
  else if (spf.all === '+all' || spf.all === '?all') suggestions.push('把 SPF 结尾的 +all / ?all 改为 ~all 或 -all');
  for (const i of spf.issues) if (/多条|超过/.test(i)) suggestions.push(`修复 SPF：${i}`);
  if (!dmarc.found) suggestions.push('在 _dmarc 子域名添加 DMARC 记录，可以先用 "v=DMARC1; p=none; rua=mailto:你的邮箱" 收集报告');
  else if (dmarc.policy === 'none') suggestions.push('观察 DMARC 报告确认没有误伤后，把策略从 none 逐步升级为 quarantine、reject');
  else if (dmarc.policy === 'quarantine') suggestions.push('观察 DMARC 报告确认没有误伤后，把策略从 quarantine 升级为 reject');
  else if (!dmarc.policy) suggestions.push('修正 DMARC 记录，加上 p=none / quarantine / reject 之一');
  if (dmarc.found && !dmarc.reportTo) suggestions.push('在 DMARC 记录中加上 rua=mailto:你的邮箱，接收每日汇总报告');
  if (!found.length && !nullMx) suggestions.push(selector ? `选择器 ${selectors[0]} 下没有 DKIM 记录，请核对邮件头 DKIM-Signature 中的 s= 值` : '在邮件服务商后台开启 DKIM 签名，并按提示添加 DNS 记录（常见选择器下没找到，不代表一定没有配置）');
  if (!mxRecords.length) suggestions.push('域名没有 MX 记录，无法接收邮件（包括 DMARC 报告和退信）；如确实不收信，可设置 Null MX（优先级 0，交换服务器为 "."）');

  const score = spfScore + dmarcScore;
  return {
    domain,
    score,
    grade: gradeOf(score),
    mx: { found: mxRecords.length > 0 && !nullMx, nullMx, records: mxRecords.slice(0, 10), error: mx.status === 'error' ? mx.error : null },
    spf,
    dmarc,
    dkim: {
      found: found.length > 0,
      selectors: found,
      checked: selectors,
      note: found.length ? null : 'DKIM 选择器由邮件服务商自定，常见选择器下没找到不代表没有配置；可在收到的邮件头 DKIM-Signature 中找到 s= 的值，用 selector 参数再查',
    },
    suggestions,
    ms: since(t0),
  };
}

export const emailSecurity = {
  name: 'email-security',
  category: 'net',
  title: '邮件安全检测',
  description: '检测域名的邮件防伪造配置：SPF、DMARC、DKIM（常见选择器探测）与 MX 记录，给出评分、等级和中文修复建议',
  source: '公共 DNS（Cloudflare / 阿里）',
  routes: [
    {
      method: 'GET',
      path: '/api/email/security',
      summary: '检测 SPF / DMARC / DKIM / MX 配置并评分',
      params: [
        { name: 'domain', required: true, desc: '域名（支持中文域名）；也可以直接传邮箱地址，取 @ 后面的部分', example: 'github.com' },
        { name: 'selector', required: false, desc: 'DKIM 选择器（邮件头 DKIM-Signature 中 s= 的值）；不传时依次尝试 default、selector1、google 等常见选择器', example: 'selector1' },
      ],
      fields: [
        { name: 'domain', type: 'string', desc: '检测的域名（ASCII 形式，中文域名已转为 punycode）' },
        { name: 'score', type: 'number', desc: '评分 0~100：SPF 最多 45 分 + DMARC 最多 55 分（DKIM 无法可靠探测，不计分）' },
        { name: 'grade', type: 'string', desc: '等级：A（≥90）/ B（≥75）/ C（≥50）/ D（≥25）/ F' },
        { name: 'mx', type: 'object', desc: 'MX 记录（收信服务器）' },
        { name: 'mx.found', type: 'boolean', desc: '是否有可用的 MX 记录（Null MX 不算）' },
        { name: 'mx.nullMx', type: 'boolean', desc: '是否为 Null MX（RFC 7505，明确声明该域名不收邮件）' },
        { name: 'mx.records', type: 'array', desc: 'MX 记录，按优先级从高到低（数字从小到大），最多 10 条' },
        { name: 'mx.records[].exchange', type: 'string', desc: '邮件交换服务器域名；Null MX 为 "."' },
        { name: 'mx.records[].priority', type: 'number', desc: '优先级，数字越小越优先' },
        { name: 'mx.error', type: 'string|null', desc: 'MX 查询出错时的原因（如 DNS 服务器响应超时）；正常或没有记录时为 null' },
        { name: 'spf', type: 'object', desc: 'SPF（发信服务器白名单）检测结果' },
        { name: 'spf.found', type: 'boolean', desc: '是否有 v=spf1 开头的 TXT 记录' },
        { name: 'spf.record', type: 'string|null', desc: 'SPF 记录原文（多条时为第一条）；没有时为 null' },
        { name: 'spf.all', type: 'string|null', desc: '结尾的 all 机制：-all / ~all / ?all / +all；没有 all 时为 null' },
        { name: 'spf.policy', type: 'string|null', desc: '对未列出服务器的处理：fail 拒绝 / softfail 软拒绝 / neutral 中立 / pass 放行 / redirect 由 redirect 指向的域名决定；没有 SPF 或没有 all 时为 null' },
        { name: 'spf.lookups', type: 'number', desc: '需要额外 DNS 查询的机制数（include / a / mx / ptr / exists / redirect，只算本条记录），超过 10 会导致校验失败' },
        { name: 'spf.issues', type: 'array', desc: 'SPF 存在的问题（中文说明），没有问题时为空数组' },
        { name: 'dmarc', type: 'object', desc: 'DMARC（伪造邮件处理策略）检测结果，查询 _dmarc.<域名> 的 TXT 记录' },
        { name: 'dmarc.found', type: 'boolean', desc: '是否有 v=DMARC1 记录' },
        { name: 'dmarc.record', type: 'string|null', desc: 'DMARC 记录原文；没有时为 null' },
        { name: 'dmarc.policy', type: 'string|null', desc: 'p= 策略：none 仅监控 / quarantine 隔离 / reject 拒收；没有记录或取值无效时为 null' },
        { name: 'dmarc.subdomainPolicy', type: 'string|null', desc: 'sp= 子域名策略；未设置时为 null（沿用 p=）' },
        { name: 'dmarc.percent', type: 'number|null', desc: 'pct= 策略生效比例（0~100，未设置为 100）；没有记录时为 null' },
        { name: 'dmarc.reportTo', type: 'string|null', desc: 'rua= 汇总报告接收地址原文（如 mailto:dmarc@example.com）；未设置时为 null' },
        { name: 'dmarc.issues', type: 'array', desc: 'DMARC 存在的问题（中文说明），没有问题时为空数组' },
        { name: 'dkim', type: 'object', desc: 'DKIM（邮件签名公钥）探测结果' },
        { name: 'dkim.found', type: 'boolean', desc: '是否在尝试的选择器中找到了 DKIM 记录' },
        { name: 'dkim.selectors', type: 'array', desc: '找到 DKIM 记录的选择器' },
        { name: 'dkim.checked', type: 'array', desc: '尝试过的选择器（传了 selector 时只有它）' },
        { name: 'dkim.note', type: 'string|null', desc: '没找到时的说明；找到时为 null' },
        { name: 'suggestions', type: 'array', desc: '中文修复建议，按重要程度排列；配置完善时为空数组' },
        { name: 'ms', type: 'number', desc: '全部 DNS 查询的总耗时（毫秒，并行查询）' },
      ],
      async handler({ query: q }) {
        const domain = requireMailDomain(param(q, 'domain', { required: true, max: 300 }));
        const selector = param(q, 'selector', { max: 100 });
        return cache.wrap(`email-security:${domain}:${selector ?? ''}`, 10 * 60_000, () => gate(() => checkEmailSecurity(domain, { selector })));
      },
    },
  ],
};

// ---------- 邮箱有效性 ----------

const LOCAL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}$/;

// 常见一次性（临时）邮箱域名，仅内置少量常见的；完整名单有十几万条，不适合内置
export const DISPOSABLE_DOMAINS = new Set([
  '10minutemail.com', '10minutemail.net', '20minutemail.com', '33mail.com', 'anonaddy.me', 'burnermail.io', 'byom.de', 'dispostable.com',
  'dropmail.me', 'emailondeck.com', 'fakeinbox.com', 'fakemail.net', 'getairmail.com', 'getnada.com', 'guerrillamail.biz', 'guerrillamail.com',
  'guerrillamail.de', 'guerrillamail.info', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamailblock.com', 'harakirimail.com', 'inboxbear.com',
  'incognitomail.org', 'jetable.org', 'mail-temp.com', 'mailcatch.com', 'maildrop.cc', 'mailinator.com', 'mailinator.net', 'mailnesia.com',
  'mailpoof.com', 'mintemail.com', 'moakt.com', 'mohmal.com', 'mytemp.email', 'nada.email', 'sharklasers.com', 'spam4.me', 'spamgourmet.com',
  'temp-mail.io', 'temp-mail.org', 'tempail.com', 'tempmail.com', 'tempmail.dev', 'tempmail.net', 'tempmailo.com', 'tempr.email', 'throwawaymail.com',
  'trashmail.com', 'trashmail.de', 'trashmail.net', 'yopmail.com', 'yopmail.fr', 'yopmail.net', 'linshiyouxiang.net', 'bccto.me', 'chacuo.net',
  'emailtemporanea.net', 'grr.la', 'pokemail.net', 'mailto.plus', 'fexpost.com', 'fexbox.org', 'rover.info',
]);

// 常见免费邮箱（用于拼写纠错与 freeProvider 标记）
export const FREE_PROVIDERS = new Set([
  'qq.com', 'foxmail.com', '163.com', '126.com', 'yeah.net', '139.com', '189.cn', 'sina.com', 'sina.cn', 'sohu.com', 'aliyun.com', '88.com',
  'gmail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com', 'me.com', 'protonmail.com', 'proton.me',
  'gmx.com', 'mail.com', 'zoho.com', 'yandex.com', 'aol.com',
]);

const ROLE_ACCOUNTS = new Set([
  'admin', 'administrator', 'info', 'support', 'sales', 'contact', 'service', 'noreply', 'no-reply', 'postmaster', 'webmaster', 'hostmaster',
  'hr', 'help', 'abuse', 'marketing', 'office', 'billing', 'security', 'root', 'team', 'jobs', 'press', 'feedback', 'kefu',
]);

function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

// 常见邮箱域名的拼写纠错（如 gmial.com → gmail.com）；域名长度已由 parseHost 限制在 253 以内
export function suggestDomain(domain) {
  if (FREE_PROVIDERS.has(domain) || domain.length > 40) return null;
  let best = null;
  for (const p of FREE_PROVIDERS) {
    const d = levenshtein(domain, p);
    if (d > 0 && d <= (p.length <= 7 ? 1 : 2) && (!best || d < best.d)) best = { p, d };
  }
  return best?.p ?? null;
}

// 邮箱格式检查：返回 { local, domain }（domain 为 ASCII 小写），不合法返回 null
export function parseEmail(input) {
  const s = String(input ?? '').trim();
  if (s.length > 254) return null;
  const at = s.lastIndexOf('@');
  if (at <= 0) return null;
  const local = s.slice(0, at);
  if (!LOCAL_RE.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  const h = parseHost(s.slice(at + 1));
  if (!h || h.ip || h.local || /[/:]/.test(s.slice(at + 1))) return null;
  return { local, domain: h.host };
}

export async function checkEmail(rawEmail, { createResolver = defaultResolver, timeoutMs = QUERY_TIMEOUT_MS, blocked = isBlockedIP } = {}) {
  const input = String(rawEmail ?? '').trim();
  const parsed = parseEmail(input);
  if (!parsed) {
    const at = input.lastIndexOf('@');
    return {
      email: input, validFormat: false, local: at > 0 ? input.slice(0, at) : input, domain: at > 0 ? input.slice(at + 1).toLowerCase() : '',
      mxFound: null, mxRecords: [], fallbackA: false, disposable: false, freeProvider: false, roleAccount: false, didYouMean: null,
      result: 'undeliverable', reasons: ['邮箱格式不正确'],
    };
  }
  const { local, domain } = parsed;
  const labels = domain.split('.');
  const disposable = labels.some((_, i) => i < labels.length - 1 && DISPOSABLE_DOMAINS.has(labels.slice(i).join('.')));
  const roleAccount = ROLE_ACCOUNTS.has(local.toLowerCase());
  const suggestion = suggestDomain(domain);

  const resolver = makeResolver(createResolver);
  const mx = await query(resolver, 'resolveMx', domain, timeoutMs);
  const records = mx.records.map((r) => ({ exchange: r.exchange || '.', priority: r.priority })).sort((a, b) => a.priority - b.priority);
  const nullMx = records.length === 1 && records[0].exchange === '.';
  let mxFound = null;
  let fallbackA = false;
  if (nullMx) mxFound = false;
  else if (records.length) mxFound = true;
  else if (mx.status === 'nxdomain') mxFound = false;
  else if (mx.status === 'empty') {
    // 没有 MX 时按 RFC 5321 退回到域名的 A / AAAA 记录收信；解析到内网地址的不算
    const [a, aaaa] = await Promise.all([query(resolver, 'resolve4', domain, timeoutMs), query(resolver, 'resolve6', domain, timeoutMs)]);
    const ips = [...a.records, ...aaaa.records].map(String);
    if (ips.some((ip) => !blocked(ip))) {
      mxFound = true;
      fallbackA = true;
    } else if (a.status !== 'error' && aaaa.status !== 'error') mxFound = false;
  }
  resolver.cancel?.();

  const reasons = [];
  let result = 'unknown';
  if (mxFound === false) {
    result = 'undeliverable';
    reasons.push(nullMx ? '域名设置了 Null MX，明确声明不接收邮件' : mx.status === 'nxdomain' ? '域名不存在' : '域名没有 MX 记录，也没有可用的 A / AAAA 记录，无法收信');
  } else {
    if (mxFound) reasons.push(fallbackA ? '格式正确；域名没有 MX 记录，但有 A / AAAA 记录，可按规范直接投递' : '格式正确，域名有 MX 记录，可以收信');
    else reasons.push(`DNS 查询失败（${mx.error ?? '未知错误'}），无法确认域名能否收信`);
    if (disposable) reasons.push('这是一次性临时邮箱，通常注册后即丢弃');
    if (roleAccount) reasons.push('这是公共角色账号（如 admin、support），通常由多人共用');
    if (mxFound) result = disposable || roleAccount ? 'risky' : 'deliverable';
    else if (disposable) result = 'risky';
  }
  if (suggestion) reasons.push(`域名疑似拼写错误，是否想输入 ${suggestion}？`);

  return {
    email: `${local}@${domain}`,
    validFormat: true,
    local,
    domain,
    mxFound,
    mxRecords: records.slice(0, 5),
    fallbackA,
    disposable,
    freeProvider: FREE_PROVIDERS.has(domain),
    roleAccount,
    didYouMean: suggestion ? `${local}@${suggestion}` : null,
    result,
    reasons,
  };
}

export const emailCheck = {
  name: 'email-check',
  category: 'net',
  title: '邮箱有效性检测',
  description: '检测邮箱地址是否有效：格式校验、域名 MX 解析、一次性临时邮箱与公共账号识别、常见域名拼写纠错；不连接邮件服务器',
  source: '公共 DNS（Cloudflare / 阿里）+ 内置名单',
  routes: [
    {
      method: 'GET',
      path: '/api/email/check',
      summary: '检测邮箱格式、域名能否收信、是否临时邮箱',
      params: [
        { name: 'email', required: true, desc: '邮箱地址（域名部分支持中文域名）', example: 'zhangsan@gmial.com' },
      ],
      fields: [
        { name: 'email', type: 'string', desc: '规范化后的邮箱（域名转为小写 ASCII）；格式不正确时为原始输入（去掉首尾空白）' },
        { name: 'validFormat', type: 'boolean', desc: '格式是否正确' },
        { name: 'local', type: 'string', desc: '@ 前的用户名部分（保持原样，不改大小写）' },
        { name: 'domain', type: 'string', desc: '@ 后的域名部分（小写；中文域名已转为 punycode）' },
        { name: 'mxFound', type: 'boolean|null', desc: '域名能否收信：有 MX 记录，或没有 MX 但有公网 A / AAAA 记录时为 true；域名不存在、Null MX、都没有时为 false；DNS 查询失败或格式不正确时为 null' },
        { name: 'mxRecords', type: 'array', desc: 'MX 记录，按优先级从高到低，最多 5 条' },
        { name: 'mxRecords[].exchange', type: 'string', desc: '邮件交换服务器域名' },
        { name: 'mxRecords[].priority', type: 'number', desc: '优先级，数字越小越优先' },
        { name: 'fallbackA', type: 'boolean', desc: '是否因为没有 MX 记录而退回到 A / AAAA 记录判断能收信' },
        { name: 'disposable', type: 'boolean', desc: '是否为一次性临时邮箱（内置几十个常见域名，含其子域名；名单不全）' },
        { name: 'freeProvider', type: 'boolean', desc: '是否为公共免费邮箱（QQ、163、Gmail、Outlook 等）' },
        { name: 'roleAccount', type: 'boolean', desc: '是否为 admin、support、noreply 这类公共角色账号' },
        { name: 'didYouMean', type: 'string|null', desc: '疑似拼写错误时给出的修正建议（如 zhangsan@gmail.com）；没有时为 null' },
        { name: 'result', type: 'string', desc: '结论：deliverable 可投递 / risky 有风险（临时邮箱或角色账号）/ undeliverable 无法投递 / unknown 无法判断（DNS 查询失败）' },
        { name: 'reasons', type: 'array', desc: '结论的依据（中文说明）' },
      ],
      async handler({ query: q }) {
        const email = param(q, 'email', { required: true, max: 320 });
        return cache.wrap(`email-check:${String(email).trim()}`, 10 * 60_000, () => gate(() => checkEmail(email)));
      },
    },
  ],
};

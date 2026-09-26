// HTTP 安全响应头检测。可达性、完整耗时明细、HTTP/2、证书等见 /api/site/check，这里只附带状态码、跳转链、压缩和总耗时作为上下文。
import { param } from '../../lib/http.js';
import { createGate, fetchFollow, readLimited, toHttpError, isBlockedIP, statusText, since } from './common.js';

const gate = createGate(20);
const HOP_TIMEOUT_MS = 5000;
const TOTAL_TIMEOUT_MS = 10_000;

const headerValue = (headers, name) => {
  const v = headers[name];
  if (v === undefined) return null;
  return Array.isArray(v) ? v.join(', ') : String(v);
};

const pass = (detail) => ({ ratio: 1, status: 'pass', detail });
const warn = (ratio, detail) => ({ ratio, status: 'warn', detail });
const fail = (detail) => ({ ratio: 0, status: 'fail', detail });

// 每项：响应头、中文名、权重（总和 100）、修复建议、评判函数（返回 null 表示未配置）
export const CHECKS = [
  {
    header: 'strict-transport-security', name: 'HSTS 强制 HTTPS', weight: 25,
    advice: '添加 Strict-Transport-Security: max-age=31536000; includeSubDomains，让浏览器始终用 HTTPS 访问',
    judge(value, ctx) {
      if (!ctx.https) return fail('最终页面没有使用 HTTPS，HSTS 无法生效');
      if (!value) return null;
      const m = /max-age\s*=\s*"?(\d+)/i.exec(value);
      if (!m) return warn(0.3, '缺少有效的 max-age');
      const maxAge = Number(m[1]);
      if (maxAge === 0) return fail('max-age=0，相当于关闭 HSTS');
      if (maxAge < 15552000) return warn(0.5, `max-age 只有 ${maxAge} 秒，建议不少于半年（15552000）`);
      return pass(`已开启，有效期 ${Math.floor(maxAge / 86400)} 天${/includesubdomains/i.test(value) ? '，包含子域名' : ''}${/preload/i.test(value) ? '，已声明 preload' : ''}`);
    },
  },
  {
    header: 'content-security-policy', name: 'CSP 内容安全策略', weight: 25,
    advice: '添加 Content-Security-Policy 限制脚本、样式等资源的来源，这是防御 XSS 最有效的手段',
    judge(value, ctx) {
      if (!value) return ctx.headers['content-security-policy-report-only'] ? warn(0.3, '只有 Report-Only 模式，仅上报不拦截') : null;
      const weak = ["'unsafe-inline'", "'unsafe-eval'"].filter((k) => value.toLowerCase().includes(k));
      const onlyFrame = !/(default-src|script-src)/i.test(value);
      if (onlyFrame) return warn(0.5, '已配置，但没有限制 default-src / script-src，对 XSS 防护有限');
      return weak.length ? warn(0.7, `已配置，但包含 ${weak.join('、')}，防护效果打折扣`) : pass('已配置');
    },
  },
  {
    header: 'x-frame-options', name: '防点击劫持', weight: 15,
    advice: '添加 X-Frame-Options: SAMEORIGIN，或在 CSP 中设置 frame-ancestors，防止页面被嵌入到恶意网站',
    judge(value, ctx) {
      if (/frame-ancestors/i.test(headerValue(ctx.headers, 'content-security-policy') ?? '')) return pass('已通过 CSP 的 frame-ancestors 限制');
      if (!value) return null;
      return /^\s*(deny|sameorigin)\s*$/i.test(value) ? pass(`已配置（${value.trim()}）`) : warn(0.5, `取值 ${value.slice(0, 60)} 无效或已被浏览器废弃，建议改用 DENY 或 SAMEORIGIN`);
    },
  },
  {
    header: 'x-content-type-options', name: '禁止 MIME 类型嗅探', weight: 10,
    advice: '添加 X-Content-Type-Options: nosniff，防止浏览器把文件当成脚本执行',
    judge: (value) => (value == null ? null : /^\s*nosniff\s*$/i.test(value) ? pass('已配置') : fail('取值应为 nosniff')),
  },
  {
    header: 'referrer-policy', name: 'Referrer 策略', weight: 10,
    advice: '添加 Referrer-Policy: strict-origin-when-cross-origin，避免把完整网址泄露给第三方网站',
    judge: (value) => (value == null ? null : /unsafe-url|no-referrer-when-downgrade/i.test(value) ? warn(0.3, `${value.slice(0, 60)} 会把完整网址发给第三方`) : pass(`已配置（${value.slice(0, 60)}）`)),
  },
  {
    header: 'permissions-policy', name: '浏览器功能权限', weight: 5,
    advice: '添加 Permissions-Policy，关闭用不到的摄像头、麦克风、定位等浏览器功能',
    judge: (value) => (value == null ? null : pass('已配置')),
  },
  {
    header: 'cross-origin-opener-policy', name: '跨源窗口隔离（COOP）', weight: 5,
    advice: '添加 Cross-Origin-Opener-Policy: same-origin，隔离跨站打开的窗口',
    judge: (value) => (value == null ? null : /unsafe-none/i.test(value) ? warn(0.3, 'unsafe-none 相当于没有隔离') : pass(`已配置（${value.slice(0, 60)}）`)),
  },
  {
    header: 'cross-origin-resource-policy', name: '跨源资源策略（CORP）', weight: 5,
    advice: '添加 Cross-Origin-Resource-Policy: same-site，限制其他网站加载你的资源',
    judge: (value) => (value == null ? null : pass(`已配置（${value.slice(0, 60)}）`)),
  },
];

// 只返回 Cookie 名称和缺少的安全属性，不返回取值
export function checkCookies(headers, https) {
  const raw = headers['set-cookie'];
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return list.slice(0, 30).map((c) => {
    const attrs = c.split(';').slice(1).map((a) => a.trim().split('=')[0].toLowerCase());
    const missing = [];
    if (https && !attrs.includes('secure')) missing.push('Secure');
    if (!attrs.includes('httponly')) missing.push('HttpOnly');
    if (!attrs.includes('samesite')) missing.push('SameSite');
    return { name: c.split('=')[0].trim().slice(0, 60), missing };
  }).filter((c) => c.missing.length);
}

export function infoLeaks(headers) {
  const out = [];
  const server = headerValue(headers, 'server');
  if (server && /\d+\.\d+/.test(server)) out.push({ header: 'server', value: server.slice(0, 200), advice: '隐藏具体版本号，避免被针对已知漏洞攻击' });
  for (const name of ['x-powered-by', 'x-aspnet-version', 'x-aspnetmvc-version', 'x-generator']) {
    const v = headerValue(headers, name);
    if (v) out.push({ header: name, value: v.slice(0, 200), advice: '删除这个响应头，它暴露了网站使用的技术栈' });
  }
  return out;
}

export const gradeOf = (s) => (s >= 95 ? 'A+' : s >= 85 ? 'A' : s >= 70 ? 'B' : s >= 55 ? 'C' : s >= 40 ? 'D' : 'F');

// 纯函数：根据响应头给出逐项结论和评分
export function analyzeHeaders(headers, { https }) {
  const ctx = { https, headers };
  let score = 0;
  const checks = CHECKS.map((c) => {
    const value = headerValue(headers, c.header);
    const v = c.judge(value, ctx) ?? fail('未配置');
    score += c.weight * v.ratio;
    return {
      header: c.header, name: c.name, status: v.status, value: value == null ? null : value.slice(0, 500), detail: v.detail, advice: v.status === 'pass' ? null : c.advice, weight: c.weight,
    };
  });
  const leaks = infoLeaks(headers);
  score = Math.max(0, Math.round(score - leaks.length * 3));
  return { score, grade: gradeOf(score), checks, cookies: checkCookies(headers, https), infoLeaks: leaks };
}

// blocked 仅供测试替换
export async function checkHeaders(rawUrl, { blocked = isBlockedIP } = {}) {
  const t0 = performance.now();
  const signal = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
  let r;
  try {
    r = await fetchFollow(rawUrl, {
      method: 'GET',
      blocked,
      maxRedirects: 5,
      timeoutMs: HOP_TIMEOUT_MS,
      signal,
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-encoding': 'gzip, deflate, br',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
  } catch (err) {
    throw toHttpError(err, signal);
  }
  const { res, url, hops } = r;
  // 只需要响应头；读少量内容后断开，保证连接正常结束
  await readLimited(res, { maxBytes: 16 * 1024, signal }).catch(() => null);
  const https = url.protocol === 'https:';
  const enc = String(res.headers['content-encoding'] ?? '').trim().toLowerCase();
  const status = res.statusCode;
  return {
    url: hops[0].url,
    finalUrl: url.href,
    status,
    statusText: statusText(status),
    redirects: hops.length - 1,
    hops: hops.map((h) => ({ url: h.url, status: h.status, statusText: statusText(h.status) })),
    https,
    compression: enc && enc !== 'identity' ? enc : 'none',
    ms: since(t0),
    ...analyzeHeaders(res.headers, { https }),
  };
}

export default {
  name: 'site-headers',
  category: 'net',
  title: 'HTTP 安全头检测',
  description: '检测网站的 HTTP 安全响应头（HSTS、CSP、X-Frame-Options、X-Content-Type-Options、Referrer-Policy、Permissions-Policy 等），逐项给出结论、评分和修复建议，并检查 Cookie 属性与版本号泄露',
  source: '目标网站',
  routes: [
    {
      method: 'GET',
      path: '/api/site/headers',
      summary: '检测 HTTP 安全响应头并评分',
      params: [
        { name: 'url', required: true, desc: '网址（http / https），只允许公网地址；跟随最多 5 次跳转，每一跳都会检查，检测的是最终页面的响应头', example: 'https://www.baidu.com' },
      ],
      fields: [
        { name: 'url', type: 'string', desc: '检测的起始网址（规范化后）' },
        { name: 'finalUrl', type: 'string', desc: '跟随跳转后的最终网址' },
        { name: 'status', type: 'number', desc: '最终响应的 HTTP 状态码' },
        { name: 'statusText', type: 'string', desc: '状态码的中文说明' },
        { name: 'redirects', type: 'number', desc: '跳转次数（0~5）' },
        { name: 'hops', type: 'array', desc: '跳转链，第一项是起始网址，最后一项是最终网址（更详细的耗时见 /api/site/check）' },
        { name: 'hops[].url', type: 'string', desc: '该跳的网址' },
        { name: 'hops[].status', type: 'number', desc: '该跳的 HTTP 状态码' },
        { name: 'hops[].statusText', type: 'string', desc: '该跳状态码的中文说明' },
        { name: 'https', type: 'boolean', desc: '最终网址是否为 HTTPS' },
        { name: 'compression', type: 'string', desc: '最终响应的压缩方式：gzip / br / deflate（请求时声明支持这三种）；未压缩为 none，其他取值为 Content-Encoding 原值（小写）' },
        { name: 'ms', type: 'number', desc: '总耗时（毫秒，含全部跳转）' },
        { name: 'score', type: 'number', desc: '评分 0~100：各项按权重累加，每处版本号泄露扣 3 分' },
        { name: 'grade', type: 'string', desc: '等级：A+（≥95）/ A（≥85）/ B（≥70）/ C（≥55）/ D（≥40）/ F' },
        { name: 'checks', type: 'array', desc: '逐项检测结果，固定 8 项' },
        { name: 'checks[].header', type: 'string', desc: '响应头名称（小写）' },
        { name: 'checks[].name', type: 'string', desc: '中文名称' },
        { name: 'checks[].status', type: 'string', desc: '结论：pass 通过 / warn 需改进 / fail 缺失或无效' },
        { name: 'checks[].value', type: 'string|null', desc: '当前取值（最多 500 字符）；未配置时为 null' },
        { name: 'checks[].detail', type: 'string', desc: '结论说明' },
        { name: 'checks[].advice', type: 'string|null', desc: '修复建议；通过时为 null' },
        { name: 'checks[].weight', type: 'number', desc: '该项在总分中的权重（满分）' },
        { name: 'cookies', type: 'array', desc: '缺少安全属性的 Cookie（只返回名称，不返回取值）；都没问题时为空数组' },
        { name: 'cookies[].name', type: 'string', desc: 'Cookie 名称' },
        { name: 'cookies[].missing', type: 'array', desc: '缺少的属性：Secure（仅 HTTPS 页面检查）/ HttpOnly / SameSite' },
        { name: 'infoLeaks', type: 'array', desc: '暴露服务器软件或版本的响应头；没有时为空数组' },
        { name: 'infoLeaks[].header', type: 'string', desc: '响应头名称（server / x-powered-by 等）' },
        { name: 'infoLeaks[].value', type: 'string', desc: '响应头取值（最多 200 字符）' },
        { name: 'infoLeaks[].advice', type: 'string', desc: '修复建议' },
      ],
      async handler({ query }) {
        const url = param(query, 'url', { required: true, max: 2048 });
        return { data: await gate(() => checkHeaders(url)) };
      },
    },
  ],
};

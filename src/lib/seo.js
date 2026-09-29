// 搜索引擎优化：网页是单页应用，服务器返回的 index.html 原本只有一个加载动画，
// 百度等不执行 JS 的爬虫看不到任何内容。这里按页面地址在服务端写好标题、描述、规范链接、分享卡片、结构化数据，
// 并在 <main> 里预先放入页面主要内容（接口列表、接口文档），浏览器加载完脚本后由前端正常渲染替换。
// 另外提供 sitemap.xml 和 robots.txt。
import { categories, modules } from '../apis/index.js';
import { isModuleEnabled } from './modules.js';
import { config } from '../config.js';
import { localChangelog, RUNNING_VERSION } from './updater.js';

const SITE = 'Miao API';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const enabled = () => modules.filter((m) => isModuleEnabled(m.name));
const routeCount = (list) => list.reduce((n, m) => n + m.routes.length, 0);

export { siteOrigin } from './origin.js';
import { siteOrigin } from './origin.js';

function homeBody(list) {
  const total = list.length;
  return `<div class="wrap seo-pre" style="padding:40px 20px">
<h1>${SITE}：免费聚合 API 接口平台</h1>
<p>一个 Key 调用 ${total} 个常用接口（${routeCount(list)} 个调用地址），涵盖${categories.filter((c) => list.some((m) => m.category === c.id)).map((c) => c.title).join('、')}等分类。统一 JSON 格式，每个返回字段都有中文说明，支持跨域，免注册每天可免费调用。</p>
${categories.map((c) => {
    const ms = list.filter((m) => m.category === c.id);
    if (!ms.length) return '';
    return `<section><h2>${esc(c.title)}接口（${ms.length} 个）</h2><ul>${ms.map((m) => `<li><a href="/docs/${encodeURIComponent(m.name)}">${esc(m.title)} API</a>：${esc(m.description ?? '')}</li>`).join('')}</ul></section>`;
  }).join('\n')}
</div>`;
}

function moduleBody(m, cat) {
  const routes = m.routes.map((r) => {
    const params = (r.params ?? []).map((p) => `<li><code>${esc(p.name)}</code>${p.required ? '（必填）' : ''}：${esc(p.desc ?? '')}${p.example != null && p.example !== '' ? `，示例 <code>${esc(p.example)}</code>` : ''}</li>`).join('');
    const fields = (r.fields ?? []).slice(0, 30).map((f) => `<li><code>${esc(f.name)}</code>（${esc(f.type)}）：${esc(f.desc)}</li>`).join('');
    return `<section><h2>${esc(r.summary ?? r.path)}</h2>
<p><code>${esc(r.method)} ${esc(r.path)}</code></p>
${params ? `<h3>请求参数</h3><ul>${params}</ul>` : '<p>无需参数。</p>'}
${fields ? `<h3>返回字段</h3><ul>${fields}</ul>` : ''}</section>`;
  }).join('\n');
  return `<div class="wrap seo-pre" style="padding:40px 20px">
<nav><a href="/">接口</a> / ${esc(cat?.title ?? '')} / ${esc(m.title)}</nav>
<h1>${esc(m.title)} API</h1>
<p>${esc(m.description ?? '')}</p>
${m.suspended ? `<p><b>该接口暂不可用</b>：${esc(m.suspended)}</p>` : ''}
${m.source ? `<p>数据来源：${esc(m.source)}</p>` : ''}
<p>返回统一的 JSON 格式 <code>{ code, message, cached, stale, updatedAt, data }</code>，支持跨域，免注册每天可免费调用 100 次，注册后每天 10000 次。</p>
${routes}
</div>`;
}

const DOCS_BODY = `<div class="wrap seo-pre" style="padding:40px 20px">
<h1>${SITE} 开发文档</h1>
<p>所有接口以 <code>/api/</code> 开头，绝大多数是 GET 请求，参数直接拼在网址后面。返回统一的 JSON 格式：<code>{ code, message, cached, stale, updatedAt, data }</code>，code 为 200 表示成功。</p>
<p>接口已开启跨域（CORS），网页前端可以直接调用。不登录时按 IP 每天可免费调用 100 次；注册后创建 API Key，通过请求头 <code>X-API-Key</code> 传入，每天 10000 次。</p>
<p>支持订阅 Epic 周免、游戏限免、必应壁纸等主题，更新时推送到微信（Server 酱）、Bark、Telegram、钉钉、飞书、企业微信、邮件或自定义 Webhook。</p>
<p><a href="/">浏览全部接口</a> · <a href="/status">运行状态</a></p>
</div>`;

// 用户交流群：群号和加群链接可在后台「系统设置 → 基础」修改，群号填 0 不显示
export const DEFAULT_QQ_GROUP = '2639496';
export const DEFAULT_QQ_NAME = 'MiaoClub';
export const DEFAULT_QQ_LINK = 'https://qm.qq.com/q/vj3vttbYh';
export function community() {
  const raw = String(process.env.COMMUNITY_QQ ?? '').trim();
  const qq = raw === '' ? DEFAULT_QQ_GROUP : raw === '0' ? null : raw;
  if (!qq) return null;
  const isDefault = qq === DEFAULT_QQ_GROUP;
  // 默认的群名和加群链接只属于默认群号，换了群号不会误用
  const link = String(process.env.COMMUNITY_QQ_LINK ?? '').trim() || (isDefault ? DEFAULT_QQ_LINK : '');
  const name = String(process.env.COMMUNITY_QQ_NAME ?? '').trim() || (isDefault ? DEFAULT_QQ_NAME : '');
  return { qq, name: name || null, link: /^https?:\/\//.test(link) ? link : null };
}
export function communityHtml(label = '用户 QQ 群') {
  const c = community();
  if (!c) return '';
  const title = c.name ? `${label}「${esc(c.name)}」` : label;
  return c.link
    ? `${title}：<a href="${esc(c.link)}" target="_blank" rel="noopener">${esc(c.qq)}（点击加群）</a>`
    : `${title}：<b>${esc(c.qq)}</b>`;
}

// 根据地址返回页面信息；status 为 404 表示页面不存在
export function pageMeta(path) {
  const list = enabled();
  const seg = path.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const total = list.length;
  if (!seg.length) {
    return {
      title: `${SITE} - 免费聚合 API 接口平台 | 游戏限免、热榜、天气、节假日等 ${total} 个常用接口`,
      description: `${SITE} 免费聚合 ${total} 个常用 API 接口：Epic 游戏限免、微博知乎热搜、天气预报、节假日、汇率、诗词、二维码、DNS 与 SSL 检测等。统一 JSON 格式，字段中文说明，支持跨域，免注册即可调用。`,
      keywords: '免费API,API接口,聚合API,开放API,Epic免费游戏API,热搜API,天气API,节假日API,二维码API,Miao API',
      body: homeBody(list),
      schema: 'home',
    };
  }
  if (seg[0] === 'docs' && seg.length === 1) {
    return { title: `开发文档 - 调用方式、API Key 与推送 | ${SITE}`, description: `${SITE} 开发文档：接口调用方式、统一返回格式、API Key 与调用额度、跨域调用和订阅推送说明。`, body: DOCS_BODY };
  }
  if (seg[0] === 'docs' && seg.length === 2) {
    const m = list.find((x) => x.name === seg[1]);
    if (!m) return { status: 404, title: `页面不存在 | ${SITE}`, description: '', noindex: true };
    const cat = categories.find((c) => c.id === m.category);
    const summaries = m.routes.map((r) => r.summary).filter(Boolean).join('、');
    return {
      title: `${m.title} API 接口 - 免费调用 | ${SITE}`,
      description: clip(`${m.title} API：${m.description ?? ''}。${summaries ? `${summaries}。` : ''}免费调用，统一 JSON 格式，含参数说明、返回字段中文注释与示例代码。`, 160),
      keywords: `${m.title}API,${m.title}接口,免费${m.title}API,${cat?.title ?? ''}API,Miao API`,
      body: moduleBody(m, cat),
      schema: 'module',
      module: m,
      category: cat,
    };
  }
  if (seg[0] === 'status' && seg.length === 1) {
    return { title: `运行状态 - 各接口实时可用性 | ${SITE}`, description: `${SITE} 各接口最近 24 小时的调用量、平均耗时与失败率，实时查看哪些接口运行正常。` };
  }
  // 登录、控制台、管理后台等不需要被收录
  return { title: SITE, description: '', noindex: true };
}

function jsonLd(meta, origin, url) {
  const graph = [];
  if (meta.schema === 'home') {
    graph.push({ '@type': 'WebSite', name: SITE, url: `${origin}/`, inLanguage: 'zh-CN', description: meta.description });
    graph.push({
      '@type': 'SoftwareApplication', name: SITE, applicationCategory: 'DeveloperApplication', operatingSystem: 'Web',
      url: `${origin}/`, offers: { '@type': 'Offer', price: '0', priceCurrency: 'CNY' }, license: 'https://www.gnu.org/licenses/gpl-3.0.html',
    });
  }
  if (meta.schema === 'module') {
    graph.push({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: '接口', item: `${origin}/` },
        { '@type': 'ListItem', position: 2, name: meta.category?.title ?? '', item: `${origin}/` },
        { '@type': 'ListItem', position: 3, name: meta.module.title, item: url },
      ],
    });
    graph.push({ '@type': 'WebAPI', name: `${meta.module.title} API`, description: meta.description, url, documentation: url, provider: { '@type': 'Organization', name: SITE, url: `${origin}/` } });
  }
  if (!graph.length) return '';
  // </ 转义，防止 JSON 里的内容提前结束 <script>
  return `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c')}</script>\n`;
}

// 把页面信息写进 index.html
export function renderPage(html, path, origin) {
  const meta = pageMeta(path);
  const url = `${origin}${path === '/' ? '/' : path}`;
  const head = [
    `<title>${esc(meta.title)}</title>`,
    meta.description ? `<meta name="description" content="${esc(meta.description)}">` : '',
    meta.keywords ? `<meta name="keywords" content="${esc(meta.keywords)}">` : '',
    meta.noindex ? '<meta name="robots" content="noindex, nofollow">' : `<link rel="canonical" href="${esc(url)}">`,
    ...(meta.noindex ? [] : [
      `<meta property="og:type" content="website">`,
      `<meta property="og:site_name" content="${SITE}">`,
      `<meta property="og:title" content="${esc(meta.title)}">`,
      `<meta property="og:description" content="${esc(meta.description)}">`,
      `<meta property="og:url" content="${esc(url)}">`,
      `<meta property="og:image" content="${esc(origin)}/og.png">`,
      `<meta property="og:locale" content="zh_CN">`,
      '<meta name="twitter:card" content="summary_large_image">',
    ]),
  ].filter(Boolean).join('\n');
  let out = html
    .replace(/<title>[^<]*<\/title>/, head)
    .replace(/<meta name="description"[^>]*>\n?/, '');
  out = out.replace('</head>', `${jsonLd(meta, origin, url)}</head>`);
  if (meta.body) out = out.replace(/<main id="main">[\s\S]*?<\/main>/, `<main id="main">${meta.body}</main>`);
  const ch = communityHtml();
  out = out.replace('{{COMMUNITY}}', ch ? ` · ${ch}` : '');
  return { status: meta.status ?? 200, html: out };
}

// 产品发布页（/about）：把接口数量、额度、分类卡片等填进 about.html
const CAT_INFO = {
  games: ['🎮', 'Epic 周免、Steam / GOG 限免、PS Plus 会免、Xbox Game Pass', 'epic'],
  hot: ['🔥', '微博、知乎、B 站、抖音、百度、GitHub Trending、Hacker News', 'hot-weibo'],
  life: ['☀️', '天气、节假日、农历黄历、油价、IP / 手机号归属地、个税', 'weather'],
  finance: ['📈', '汇率换算、股票行情、基金净值、加密货币、金价银价', 'fx'],
  fun: ['✨', '一言、诗词、成语词典、必应壁纸、每日英语、豆瓣电影', 'hitokoto'],
  ai: ['🤖', '文本摘要、情感分析、AI 翻译、智能对话', 'ai'],
  tools: ['🛠️', '二维码、短链接、翻译、时间戳、Base64、JWT、正则测试', 'qrcode'],
  net: ['🌐', 'DNS、SSL 证书、网站测速、Ping、多节点检测、Whois', 'dns'],
};
const fmtInt = (n) => Number(n).toLocaleString('en-US');

// 发布页里的用户群：页脚一行、底部按钮、常见问题一条；不显示群时全部为空
function aboutCommunity() {
  const c = community();
  if (!c) return { COMMUNITY: '', COMMUNITY_BTN: '', COMMUNITY_FAQ: '' };
  const qq = esc(c.qq);
  return {
    COMMUNITY: ` · ${communityHtml()}`,
    COMMUNITY_BTN: c.link
      ? `<a class="lp-btn" href="${esc(c.link)}" target="_blank" rel="noopener">加入 QQ 群 ${qq}</a>`
      : `<button class="lp-btn" type="button" data-copy="${qq}" title="点击复制群号">QQ 群 ${qq}（点击复制）</button>`,
    COMMUNITY_FAQ: `<details><summary>遇到问题去哪里反馈？</summary><p>欢迎加入用户 QQ 群${c.name ? `「${esc(c.name)}」` : ''} <b>${qq}</b>${c.link ? `（<a href="${esc(c.link)}" target="_blank" rel="noopener" style="color:var(--brand)">点击加群</a>）` : ''}，也可以到 <a href="https://github.com/bocmiao/api/issues" target="_blank" rel="noopener" style="color:var(--brand)">GitHub Issues</a> 提交问题和建议。</p></details>`,
  };
}

export function renderAbout(html, origin) {
  const list = enabled();
  const cats = categories.map((c) => {
    const n = list.filter((m) => m.category === c.id).length;
    if (!n) return '';
    const [ico, desc, doc] = CAT_INFO[c.id] ?? ['•', '', ''];
    const href = list.some((m) => m.name === doc) ? `/docs/${doc}` : '/';
    return `<a class="cat reveal" href="${href}"><div class="cat-top"><span class="cat-ico" aria-hidden="true">${ico}</span><span class="cat-n">${n}</span></div><h3>${esc(c.title)}</h3><p>${esc(desc)}</p></a>`;
  }).filter(Boolean);
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication', name: SITE, applicationCategory: 'DeveloperApplication', operatingSystem: 'Web, Linux, Docker',
        url: `${origin}/about`, softwareVersion: RUNNING_VERSION, license: 'https://www.gnu.org/licenses/gpl-3.0.html',
        codeRepository: 'https://github.com/bocmiao/api', offers: { '@type': 'Offer', price: '0', priceCurrency: 'CNY' },
        description: `开源免费的聚合 API 接口平台，提供 ${list.length} 个常用接口。`,
      },
      {
        '@type': 'FAQPage',
        mainEntity: [
          ['Miao API 是免费的吗？', `是的。在线站点不注册每天可免费调用 ${config.limits.anonDaily} 次，免费注册后每天 ${config.limits.userDaily} 次；自己部署则没有任何限制。`],
          ['调用需要 API Key 吗？', '不需要。大多数接口直接请求就能用；注册后创建 API Key 可获得更高额度。'],
          ['可以部署到自己的服务器吗？', '可以。项目以 GPL v3 协议开源，只需要 Node.js 22.13 以上或 Docker，没有任何第三方依赖。'],
        ].map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
      },
    ],
  };
  const vars = {
    ORIGIN: esc(origin), MODULES: String(list.length), ROUTES: String(routeCount(list)), CAT_COUNT: String(cats.length),
    ANON: fmtInt(config.limits.anonDaily), USER: fmtInt(config.limits.userDaily), VERSION: esc(RUNNING_VERSION),
    CATS: cats.join(''),
    ...aboutCommunity(),
    JSONLD: `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`,
  };
  return html.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

export function sitemap(origin) {
  const lastmod = localChangelog()[0]?.date?.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  const urls = [
    ['/', '1.0', 'daily'], ['/about', '0.9', 'weekly'], ['/docs', '0.8', 'weekly'], ['/status', '0.5', 'hourly'],
    ...enabled().map((m) => [`/docs/${encodeURIComponent(m.name)}`, '0.7', 'weekly']),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(([p, pr, cf]) => `  <url><loc>${esc(origin + p)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}<changefreq>${cf}</changefreq><priority>${pr}</priority></url>`).join('\n')}
</urlset>
`;
}

export function robots(origin) {
  return `User-agent: *
Allow: /
Disallow: /api/
Disallow: /s/
Disallow: /admin
Disallow: /console
Disallow: /login
Disallow: /register
Disallow: /reset
Disallow: /auth/
Disallow: /account/

Sitemap: ${origin}/sitemap.xml
`;
}

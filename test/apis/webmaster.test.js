// 站长类接口：HTTP 安全头、邮件安全、邮箱有效性、RSS、网页正文 / Markdown、整站文字抓取、App Store 搜索。
// 不访问外网：网站类用 127.0.0.1 上的测试服务器 + 替换 dns.lookup；DNS 类注入假的 Resolver；App Store 替换 fetch。
import { test, describe, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns';
import zlib from 'node:zlib';

import netModules from '../../src/apis/net/index.js';
import { isBlockedIP } from '../../src/lib/netguard.js';
import { BLOCKED_MSG } from '../../src/apis/net/common.js';
import { checkHeaders, analyzeHeaders } from '../../src/apis/net/headers.js';
import {
  checkEmailSecurity, analyzeSpf, analyzeDmarc, checkEmail, parseEmail, suggestDomain, COMMON_SELECTORS,
} from '../../src/apis/net/email.js';
import { parseXml, interpretFeed, decodeXmlEntities, discoverFeed, loadFeed } from '../../src/apis/net/rss.js';
import { tokenize, pairUp, selectRegion, extractText, toMarkdown } from '../../src/apis/net/readable.js';
import { loadWebText, loadWebMarkdown } from '../../src/apis/net/webpage.js';
import { startCrawl, getCrawlResult, scopeOf, _resetCrawlTasks, _sweepCrawlTasks, _crawlTaskCount } from '../../src/apis/net/crawl.js';
import { formatApp } from '../../src/apis/net/appstore.js';
import { assertFieldsDocumented, matcher } from '../helpers/fields.js';

const q = (obj) => new URLSearchParams(obj);
const NEW = ['site-headers', 'email-security', 'email-check', 'rss', 'web-content', 'crawl', 'appstore'];
const modules = netModules.filter((m) => NEW.includes(m.name));
const routes = modules.flatMap((m) => m.routes);
const route = (path) => routes.find((r) => r.path === path);
const allowLoopback = (ip) => ip !== '127.0.0.1' && isBlockedIP(ip);

// ---------------- 字段说明：双向校验（与 net.test.js 相同） ----------------

const typeOf = (v) => (v == null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
function collectValues(value, prefix = '', out = new Map()) {
  const add = (p, v) => {
    if (!out.has(p)) out.set(p, []);
    out.get(p).push(v);
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      add(`${prefix}[]`, item);
      collectValues(item, `${prefix}[]`, out);
    }
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = prefix ? `${prefix}.${k}` : k;
      add(p, v);
      collectValues(v, p, out);
    }
  }
  return out;
}
const checked = new Set();
function checkFields(r, ...samples) {
  for (const s of samples) assertFieldsDocumented(r, s);
  const values = new Map();
  for (const s of samples) for (const [p, vs] of collectValues(s)) values.set(p, [...(values.get(p) ?? []), ...vs]);
  const uncovered = [];
  const wrongType = [];
  for (const f of r.fields) {
    const re = matcher(f.name);
    const vs = [...values].filter(([p]) => re.test(p)).flatMap(([, v]) => v);
    if (!vs.some((v) => v != null)) uncovered.push(f.name);
    const bad = [...new Set(vs.map(typeOf))].filter((t) => !f.type.split('|').includes(t));
    if (bad.length) wrongType.push(`${f.name}（声明 ${f.type}，实际出现 ${bad.join('/')}）`);
  }
  assert.deepEqual(uncovered, [], `${r.path} 的样例没有覆盖这些字段：${uncovered.join(', ')}`);
  assert.deepEqual(wrongType, [], `${r.path} 的字段类型与声明不符：${wrongType.join('；')}`);
  checked.add(`${r.method} ${r.path}`);
}

// ---------------- 假 DNS 与测试服务器 ----------------

const HOSTS = {
  'site.test.example': ['127.0.0.1'],
  'crawl.test.example': ['127.0.0.1'],
  'www.crawl.test.example': ['127.0.0.1'],
  'other.test.example': ['127.0.0.1'],
  'blockall.test.example': ['127.0.0.1'],
  'internal.test.example': ['10.0.0.5'],
};
function fakeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const list = net.isIP(hostname) ? [hostname] : HOSTS[hostname];
  if (!list) return process.nextTick(callback, Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
  const addrs = list.map((address) => ({ address, family: net.isIP(address) }));
  return process.nextTick(() => (options.all ? callback(null, addrs) : callback(null, addrs[0].address, addrs[0].family)));
}

let server;
let PORT;
let hits = [];
const base = (host = 'site.test.example') => `http://${host}:${PORT}`;

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE rss [<!ENTITY boom "BOOM">]>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>示例 &amp; 博客</title>
  <link>https://blog.example.com/</link>
  <atom:link rel="self" href="https://blog.example.com/feed.xml"/>
  <description><![CDATA[记录 <b>技术</b>]]></description>
  <language>zh-CN</language>
  <lastBuildDate>Tue, 22 Sep 2026 08:00:00 +0800</lastBuildDate>
  <image><url>/logo.png</url></image>
  <item>
    <title><![CDATA[你好，<b>世界</b> & a < b]]></title>
    <link>/posts/1</link>
    <description>&lt;p&gt;第一篇 &amp;amp; 摘要 &amp;boom;&lt;/p&gt;</description>
    <content:encoded><![CDATA[<p>全文 <script>x</script></p>]]></content:encoded>
    <pubDate>Tue, 22 Sep 2026 08:00:00 GMT</pubDate>
    <dc:creator>张三</dc:creator>
    <category>随笔</category><category>技术</category><category>随笔</category>
    <guid isPermaLink="false">post-1</guid>
    <enclosure url="/audio/1.mp3" type="audio/mpeg" length="1024"/>
  </item>
  <item>
    <title>第二篇</title>
    <guid>https://blog.example.com/posts/2</guid>
    <pubDate>not a date</pubDate>
  </item>
</channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">
  <title type="text">Atom Feed</title>
  <subtitle>sub</subtitle>
  <link rel="self" href="/atom.xml"/>
  <link rel="alternate" href="https://atom.example.com/"/>
  <updated>2026-01-01T00:00:00Z</updated>
  <icon>/icon.png</icon>
  <author><name>Feed Author</name></author>
  <entry>
    <title type="html">&lt;i&gt;Entry&lt;/i&gt; One</title>
    <link href="/e/1"/>
    <link rel="enclosure" href="/e/1.mp3" type="audio/mpeg"/>
    <id>urn:uuid:1</id>
    <published>2026-01-02T03:04:05Z</published>
    <category term="t1" label="Tag One"/>
    <summary type="html">&lt;b&gt;Hello&lt;/b&gt; world</summary>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Full <b>content</b></p></div></content>
  </entry>
</feed>`;

const ARTICLE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>文章标题 - 站点</title>
<meta name="description" content="一篇示例文章"><link rel="alternate" type="application/rss+xml" href="/feed.xml">
<style>body{}</style><script>var a = "<article>";</script></head>
<body><header><a href="/">站点首页</a></header><nav><a href="/a">导航一</a></nav>
<article><h1>正文标题</h1><p>这是<strong>第一段</strong>正文，包含<a href="/link">一个链接</a>和<code>a_b</code>。${'正文内容。'.repeat(40)}</p>
<h2>第二部分</h2><ul><li>列表一</li><li>列表二<ol><li>子项</li></ol></li></ul>
<pre><code class="language-js">const x = 1;
console.log(\`\`\`x\`\`\`);</code></pre>
<blockquote>引用的话</blockquote>
<table><tr><th>名称</th><th>值</th></tr><tr><td>a|b</td><td>1</td></tr></table>
<p><img src="/img/1.png" alt="示意图"><br>换行后</p><div hidden>隐藏内容</div></article>
<aside>侧边栏</aside><footer>版权所有</footer></body></html>`;

function crawlSite(req, res, host, p) {
  const page = (body, extra = {}) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...extra }); res.end(body); };
  if (host.startsWith('blockall.')) {
    if (p === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /\n'); }
    return page('<p>should not be fetched</p>');
  }
  if (host.startsWith('other.')) return page('<title>other</title><p>站外页面</p>');
  if (p === '/robots.txt') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('User-agent: *\nDisallow: /private\n\nUser-agent: MiaoApiBot\nDisallow: /private\nDisallow: /bot-only-blocked\nCrawl-delay: 0\n');
  }
  const link = (h) => `<a href="${h}">${h}</a>`;
  if (p === '/') {
    return page(`<html><head><title>首页</title></head><body><main><h1>首页</h1><p>欢迎。${'首页正文。'.repeat(30)}</p>
      ${['/a', '/b', '/private/secret', '/bot-only-blocked', `http://other.test.example:${PORT}/x`, '/file.pdf', '/redir-out', '/redir-in', '/binary', '/missing', 'mailto:a@b.com', '#top', '/a#frag'].map(link).join(' ')}
      </main></body></html>`);
  }
  if (p === '/a') return page(`<title>页面 A</title><p>A 的内容</p>${link('/deep/1')}`);
  if (p === '/b') return page(`<title>页面 B</title><p>B 的内容</p>${link('/')}${link('/a')}`);
  if (p === '/deep/1') return page(`<title>深层</title><p>深层内容</p>${link('/deep/2')}`);
  if (p === '/deep/2') return page('<title>更深</title><p>更深内容</p>');
  if (p === '/redir-out') { res.writeHead(302, { location: `http://other.test.example:${PORT}/landing` }); return res.end(); }
  if (p === '/redir-in') { res.writeHead(301, { location: '/landed' }); return res.end(); }
  if (p === '/landed') return page('<title>跳转后</title><p>站内跳转后的页面</p>');
  if (p === '/binary') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(Buffer.alloc(10)); }
  if (p === '/big') return page(`<title>大页面</title><p>${'字'.repeat(120_000)}</p>`);
  if (p === '/to-internal') { res.writeHead(302, { location: 'http://10.0.0.1/' }); return res.end(); }
  res.writeHead(404, { 'content-type': 'text/html' });
  return res.end('<p>not found</p>');
}

function handler(req, res) {
  const host = String(req.headers.host).split(':')[0];
  const p = req.url;
  hits.push({ host, path: p, at: Date.now(), ua: req.headers['user-agent'] });
  if (host.endsWith('crawl.test.example') || host.startsWith('other.') || host.startsWith('blockall.')) return crawlSite(req, res, host, p);
  const send = (status, headers, body = '') => { res.writeHead(status, headers); res.end(body); };
  switch (p) {
    case '/secure': {
      const body = zlib.gzipSync(Buffer.from('<html><body>ok</body></html>'));
      return send(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-encoding': 'gzip',
        'strict-transport-security': 'max-age=31536000; includeSubDomains',
        'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'strict-origin-when-cross-origin',
        'permissions-policy': 'camera=()',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-resource-policy': 'same-site',
        server: 'nginx/1.18.0',
        'x-powered-by': 'PHP/8.1',
        'set-cookie': ['sid=secret-value; Path=/; HttpOnly', 'ok=1; Secure; HttpOnly; SameSite=Lax'],
      }, body);
    }
    case '/bare': return send(200, { 'content-type': 'text/html', 'x-frame-options': 'ALLOW-FROM https://a.com', 'referrer-policy': 'unsafe-url' }, 'bare');
    case '/redir': return send(301, { location: '/bare' });
    case '/to-internal': return send(302, { location: 'http://10.0.0.1/admin' });
    case '/to-dns-internal': return send(302, { location: `http://internal.test.example:${PORT}/` });
    case '/feed.xml': return send(200, { 'content-type': 'application/rss+xml; charset=utf-8' }, RSS);
    case '/atom.xml': return send(200, { 'content-type': 'application/atom+xml' }, ATOM);
    case '/gbk.xml': return send(200, { 'content-type': 'text/xml' }, Buffer.concat([Buffer.from('<?xml version="1.0" encoding="GBK"?><rss version="2.0"><channel><title>'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('</title></channel></rss>')]));
    case '/blog': return send(200, { 'content-type': 'text/html; charset=utf-8' }, ARTICLE);
    case '/nofeed': return send(200, { 'content-type': 'text/html' }, '<html><body><p>hi</p></body></html>');
    case '/notfeed.xml': return send(200, { 'content-type': 'text/xml' }, '<?xml version="1.0"?><root><a/></root>');
    case '/article': return send(200, { 'content-type': 'text/html; charset=utf-8' }, ARTICLE);
    case '/article-br': return send(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'br' }, zlib.brotliCompressSync(Buffer.from(ARTICLE)));
    case '/pdf': return send(200, { 'content-type': 'application/pdf' }, '%PDF');
    case '/500': return send(500, { 'content-type': 'text/html' }, 'err');
    default: return send(404, { 'content-type': 'text/html' }, 'nf');
  }
}

before(async () => {
  mock.method(dns, 'lookup', fakeLookup);
  server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;
});
after(() => {
  server.close();
  server.closeAllConnections?.();
  mock.restoreAll();
});
beforeEach(() => { hits = []; });

// ---------------- 注册 ----------------

test('新增的 net 路由都已注册，参数与字段有说明', () => {
  assert.deepEqual(modules.map((m) => m.name), NEW);
  assert.deepEqual(routes.map((r) => `${r.method} ${r.path}`), [
    'GET /api/site/headers', 'GET /api/email/security', 'GET /api/email/check', 'GET /api/rss', 'GET /api/web/text', 'GET /api/web/markdown',
    'POST /api/crawl', 'GET /api/crawl/result', 'GET /api/appstore/search',
  ]);
  const allPaths = netModules.flatMap((m) => m.routes.map((r) => `${r.method} ${r.path}`));
  assert.equal(new Set(allPaths).size, allPaths.length, 'net 分类内没有重复路由');
  for (const m of modules) {
    assert.equal(m.category, 'net');
    assert.ok(m.title && m.description && m.source, m.name);
    for (const r of m.routes) {
      assert.ok(Array.isArray(r.params) && r.params.length, `${r.path} 缺少 params`);
      for (const p of r.params) assert.ok(p.desc && p.example != null, `${r.path} ${p.name}`);
      assert.ok(r.fields?.length, `${r.path} 缺少 fields`);
    }
  }
});

// ---------------- HTTP 安全头 ----------------

describe('/api/site/headers', () => {
  test('安全头齐全的网站：逐项结论、评分、Cookie、版本泄露、压缩', async () => {
    const d = await checkHeaders(`${base()}/secure`, { blocked: allowLoopback });
    assert.equal(d.status, 200);
    assert.equal(d.compression, 'gzip');
    assert.equal(d.https, false);
    const by = Object.fromEntries(d.checks.map((c) => [c.header, c]));
    assert.equal(by['strict-transport-security'].status, 'fail', 'http 页面 HSTS 无效');
    assert.equal(by['content-security-policy'].status, 'warn');
    assert.match(by['content-security-policy'].detail, /unsafe-inline/);
    assert.equal(by['x-frame-options'].status, 'pass', 'frame-ancestors 视为已防护');
    assert.equal(by['x-content-type-options'].status, 'pass');
    assert.equal(by['x-content-type-options'].advice, null);
    assert.deepEqual(d.cookies, [{ name: 'sid', missing: ['SameSite'] }], '只返回名称，不返回 Cookie 值');
    assert.ok(!JSON.stringify(d).includes('secret-value'));
    assert.deepEqual(d.infoLeaks.map((x) => x.header), ['server', 'x-powered-by']);
    assert.equal(d.checks.reduce((s, c) => s + c.weight, 0), 100);
    assert.ok(d.score > 0 && d.score < 100);
  });

  test('HTTPS 下的 HSTS 评判与等级', () => {
    const full = analyzeHeaders({
      'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
      'content-security-policy': "default-src 'self'",
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'permissions-policy': 'geolocation=()',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
    }, { https: true });
    assert.equal(full.score, 100);
    assert.equal(full.grade, 'A+');
    const short = analyzeHeaders({ 'strict-transport-security': 'max-age=600' }, { https: true });
    assert.equal(short.checks[0].status, 'warn');
    assert.equal(analyzeHeaders({}, { https: true }).grade, 'F');
    const cookies = analyzeHeaders({ 'set-cookie': ['a=1'] }, { https: true }).cookies;
    assert.deepEqual(cookies[0].missing, ['Secure', 'HttpOnly', 'SameSite']);
  });

  test('跟随跳转、每一跳检查内网地址', async () => {
    const d = await checkHeaders(`${base()}/redir`, { blocked: allowLoopback });
    assert.equal(d.redirects, 1);
    assert.equal(d.finalUrl, `${base()}/bare`);
    assert.equal(d.checks.find((c) => c.header === 'x-frame-options').status, 'warn');
    assert.equal(d.checks.find((c) => c.header === 'referrer-policy').status, 'warn');
    await assert.rejects(checkHeaders(`${base()}/to-internal`, { blocked: allowLoopback }), { status: 400, message: BLOCKED_MSG });
    await assert.rejects(checkHeaders(`${base()}/to-dns-internal`, { blocked: allowLoopback }), { status: 400 });
    await assert.rejects(route('/api/site/headers').handler({ query: q({ url: 'http://127.0.0.1/' }) }), { status: 400 });
    await assert.rejects(route('/api/site/headers').handler({ query: q({ url: 'file:///etc/passwd' }) }), { status: 400 });
    checkFields(route('/api/site/headers'), d, await checkHeaders(`${base()}/secure`, { blocked: allowLoopback }));
  });
});

// ---------------- 邮件安全 / 邮箱检测 ----------------

// 假的 dns.promises.Resolver：table[name][method] 为结果；Error 抛出；缺失的方法为 ENODATA，缺失的域名为 ENOTFOUND
function fakeResolver(table, calls = []) {
  return () => ({
    servers: null,
    setServers(s) { this.servers = s; },
    cancel() {},
    ...Object.fromEntries(['resolveMx', 'resolveTxt', 'resolve4', 'resolve6'].map((m) => [m, async (name) => {
      calls.push(`${m} ${name}`);
      const entry = table[name];
      if (!entry) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      const v = entry[m];
      if (v instanceof Error) throw v;
      if (v === undefined) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
      return v;
    }])),
  });
}
const timeoutErr = () => Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });

const MAIL_DNS = {
  'good.example': {
    resolveMx: [{ exchange: 'mx2.good.example', priority: 20 }, { exchange: 'mx1.good.example', priority: 10 }],
    resolveTxt: [['v=spf1 include:_spf.good.example ', '-all'], ['google-site-verification=xxx']],
  },
  '_dmarc.good.example': { resolveTxt: [['v=DMARC1; p=reject; sp=quarantine; rua=mailto:d@good.example']] },
  'selector1._domainkey.good.example': { resolveTxt: [['v=DKIM1; k=rsa; p=MIGf']] },
  'weak.example': { resolveMx: timeoutErr(), resolveTxt: [['v=spf1 +all'], ['v=spf1 -all']] },
  '_dmarc.weak.example': { resolveTxt: [['v=DMARC1; p=none; pct=50']] },
  'nomail.example': { resolveMx: [{ exchange: '', priority: 0 }], resolveTxt: [['hello']] },
  'fallback.example': { resolve4: ['93.184.216.34'] },
  'internal-a.example': { resolve4: ['10.0.0.1'] },
  'gmail.com': { resolveMx: [{ exchange: 'gmail-smtp-in.l.google.com', priority: 5 }] },
  'gmial.com': { resolveMx: [{ exchange: 'mx.gmial.com', priority: 10 }] },
  'mailinator.com': { resolveMx: [{ exchange: 'mail.mailinator.com', priority: 1 }] },
  'broken.example': { resolveMx: timeoutErr() },
};

describe('/api/email/security', () => {
  test('SPF / DMARC 解析', () => {
    assert.equal(analyzeSpf(['v=spf1 mx include:a include:b ~all']).lookups, 3);
    assert.equal(analyzeSpf(['v=spf1 mx include:a include:b ~all']).policy, 'softfail');
    assert.equal(analyzeSpf(['v=spf1 redirect=_spf.x.com']).policy, 'redirect');
    const many = analyzeSpf([`v=spf1 ${Array.from({ length: 11 }, (_, i) => `include:i${i}.com`).join(' ')} -all`]);
    assert.equal(many.score, 10);
    assert.ok(many.issues.some((i) => /超过 10/.test(i)));
    assert.equal(analyzeSpf(['v=spf1 a']).all, null);
    assert.equal(analyzeDmarc(['v=DMARC1;p=QUARANTINE']).policy, 'quarantine');
    assert.equal(analyzeDmarc(['v=DMARC1; p=bogus']).policy, null);
    assert.equal(analyzeDmarc([]).found, false);
  });

  test('配置完善的域名：高分、DKIM 选择器、MX 排序', async () => {
    const calls = [];
    const d = await checkEmailSecurity('User@Good.Example', { createResolver: fakeResolver(MAIL_DNS, calls) });
    assert.equal(d.domain, 'good.example');
    assert.equal(d.score, 100);
    assert.equal(d.grade, 'A');
    assert.equal(d.spf.record, 'v=spf1 include:_spf.good.example -all', 'TXT 分片拼接');
    assert.equal(d.spf.all, '-all');
    assert.deepEqual(d.mx.records.map((r) => r.priority), [10, 20]);
    assert.deepEqual(d.dkim.selectors, ['selector1']);
    assert.equal(d.dkim.checked.length, COMMON_SELECTORS.length);
    assert.equal(d.dkim.note, null);
    assert.equal(d.dmarc.subdomainPolicy, 'quarantine');
    assert.ok(calls.includes('resolveTxt _dmarc.good.example'));
  });

  test('配置薄弱的域名：问题与中文建议；DNS 出错；Null MX；自定义选择器；非法输入', async () => {
    const make = fakeResolver(MAIL_DNS);
    const weak = await checkEmailSecurity('weak.example', { createResolver: make });
    assert.equal(weak.spf.score, undefined, 'score 不外露');
    assert.ok(weak.spf.issues.some((i) => /2 条 SPF/.test(i)));
    assert.equal(weak.dmarc.policy, 'none');
    assert.equal(weak.dmarc.percent, 50);
    assert.ok(weak.mx.error);
    assert.ok(weak.suggestions.length >= 3);
    assert.ok(['D', 'F'].includes(weak.grade));
    const nomail = await checkEmailSecurity('nomail.example', { createResolver: make, selector: 'Custom' });
    assert.equal(nomail.mx.nullMx, true);
    assert.equal(nomail.mx.found, false);
    assert.deepEqual(nomail.dkim.checked, ['custom']);
    assert.ok(nomail.suggestions.some((s) => s.includes('v=spf1 -all')));
    await assert.rejects(checkEmailSecurity('nope.example', { createResolver: make }), { status: 404 });
    await assert.rejects(checkEmailSecurity('good.example', { createResolver: make, selector: 'a b' }), { status: 400 });
    for (const bad of ['127.0.0.1', 'localhost', 'not a domain', '']) {
      await assert.rejects(checkEmailSecurity(bad, { createResolver: make }), { status: 400 }, bad);
    }
    checkFields(route('/api/email/security'), weak, nomail, await checkEmailSecurity('good.example', { createResolver: make }));
  });
});

describe('/api/email/check', () => {
  test('格式、纠错、一次性邮箱、角色账号', async () => {
    assert.equal(parseEmail('a..b@x.com'), null);
    assert.equal(parseEmail('.a@x.com'), null);
    assert.equal(parseEmail('a@127.0.0.1'), null);
    assert.equal(parseEmail('a@localhost'), null);
    assert.deepEqual(parseEmail(' Zhang.San+tag@例子.公司 '), { local: 'Zhang.San+tag', domain: 'xn--fsqu00a.xn--55qx5d' });
    assert.equal(suggestDomain('gmial.com'), 'gmail.com');
    assert.equal(suggestDomain('qq.com'), null);
    assert.equal(suggestDomain('totally-different.org'), null);
    const make = fakeResolver(MAIL_DNS);
    const typo = await checkEmail('zhangsan@gmial.com', { createResolver: make });
    assert.equal(typo.result, 'deliverable');
    assert.equal(typo.didYouMean, 'zhangsan@gmail.com');
    const temp = await checkEmail('x@mailinator.com', { createResolver: make });
    assert.equal(temp.disposable, true);
    assert.equal(temp.result, 'risky');
    const role = await checkEmail('Admin@gmail.com', { createResolver: make });
    assert.equal(role.roleAccount, true);
    assert.equal(role.freeProvider, true);
    const fb = await checkEmail('a@fallback.example', { createResolver: make });
    assert.equal(fb.mxFound, true);
    assert.equal(fb.fallbackA, true);
    const internal = await checkEmail('a@internal-a.example', { createResolver: make });
    assert.equal(internal.mxFound, false, '只解析到内网地址的不算能收信');
    const nx = await checkEmail('a@nope.example', { createResolver: make });
    assert.equal(nx.result, 'undeliverable');
    const nullMx = await checkEmail('a@nomail.example', { createResolver: make });
    assert.equal(nullMx.result, 'undeliverable');
    const broken = await checkEmail('a@broken.example', { createResolver: make });
    assert.equal(broken.mxFound, null);
    assert.equal(broken.result, 'unknown');
    const bad = await checkEmail('not-an-email', { createResolver: make });
    assert.equal(bad.validFormat, false);
    assert.equal(bad.result, 'undeliverable');
    checkFields(route('/api/email/check'), typo, temp, role, fb, nx, broken, bad);
  });
});

// ---------------- RSS ----------------

describe('/api/rss', () => {
  test('实体解码只解一次、非法码点保留原文', () => {
    assert.equal(decodeXmlEntities('&amp;lt; &#38;lt; &#x4e2d; &#99999999; &unknown; &nbsp;'), '&lt; &lt; 中 &#99999999; &unknown;  ');
  });

  test('RSS 2.0：CDATA、实体、分类去重、附件、DOCTYPE 实体不展开', () => {
    const f = interpretFeed(parseXml(RSS), 'https://blog.example.com/feed.xml', { includeContent: true });
    assert.equal(f.format, 'rss');
    assert.equal(f.version, '2.0');
    assert.equal(f.feed.title, '示例 & 博客');
    assert.equal(f.feed.description, '记录 技术');
    assert.equal(f.feed.link, 'https://blog.example.com/', 'atom:link 不会覆盖 link');
    assert.equal(f.feed.image, 'https://blog.example.com/logo.png');
    assert.equal(f.feed.updated, '2026-09-22T00:00:00.000Z');
    const [a, b] = f.items;
    assert.equal(a.title, '你好，世界 & a < b', '去掉 HTML 标签，孤立的 < 保留');
    assert.equal(a.link, 'https://blog.example.com/posts/1');
    assert.equal(a.summary, '第一篇 & 摘要 &boom;', '内部子集里的实体不展开');
    assert.deepEqual(a.categories, ['随笔', '技术']);
    assert.equal(a.guid, 'post-1');
    assert.deepEqual(a.enclosure, { url: 'https://blog.example.com/audio/1.mp3', type: 'audio/mpeg', length: 1024 });
    assert.match(a.content, /全文/);
    assert.equal(b.link, 'https://blog.example.com/posts/2', 'guid 作为链接');
    assert.equal(b.published, null);
    assert.equal(b.author, null);
  });

  test('Atom：xhtml 内容、作者继承、label 分类', () => {
    const f = interpretFeed(parseXml(ATOM), 'https://atom.example.com/atom.xml', { includeContent: true });
    assert.equal(f.format, 'atom');
    assert.equal(f.feed.link, 'https://atom.example.com/');
    assert.equal(f.feed.language, 'en');
    assert.equal(f.feed.image, 'https://atom.example.com/icon.png');
    const [e] = f.items;
    assert.equal(e.title, 'Entry One');
    assert.equal(e.author, 'Feed Author');
    assert.deepEqual(e.categories, ['Tag One']);
    assert.equal(e.summary, 'Hello world');
    assert.match(e.content, /Full/);
    assert.equal(e.enclosure.url, 'https://atom.example.com/e/1.mp3');
  });

  test('RDF（RSS 1.0）与不是订阅源的 XML', () => {
    const rdf = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><channel rdf:about="x"><title>R</title><link>https://r.example/</link></channel><item rdf:about="https://r.example/1"><title>I1</title><link>https://r.example/1</link><dc:date>2026-02-03</dc:date></item></rdf:RDF>`;
    const f = interpretFeed(parseXml(rdf), 'https://r.example/rss');
    assert.equal(f.format, 'rdf');
    assert.equal(f.items[0].title, 'I1');
    assert.equal(f.items[0].published, '2026-02-03T00:00:00.000Z');
    assert.equal(interpretFeed(parseXml('<root/>'), 'https://x/'), null);
    assert.equal(interpretFeed(parseXml('not xml at all'), 'https://x/'), null);
  });

  test('解析器是线性时间：恶意构造的输入不会卡住', () => {
    const inputs = [
      '<a '.repeat(200_000),
      `<rss>${'<![CDATA['.repeat(100_000)}`,
      `<rss><channel>${'<a>'.repeat(100_000)}${'</b>'.repeat(100_000)}`,
      `<rss a="${'x'.repeat(500_000)}`,
      `<x>${'&#'.repeat(300_000)}</x>`,
    ];
    const t0 = performance.now();
    for (const s of inputs) parseXml(s);
    assert.ok(performance.now() - t0 < 3000, `耗时 ${performance.now() - t0}ms`);
  });

  test('抓取：订阅源、自动发现、GBK、非订阅源、SSRF', async () => {
    const d = await loadFeed(`${base()}/feed.xml`, { limit: 1, includeContent: true, blocked: allowLoopback });
    assert.equal(d.total, 2);
    assert.equal(d.items.length, 1);
    assert.equal(d.discovered, false);
    const disc = await loadFeed(`${base()}/blog`, { blocked: allowLoopback });
    assert.equal(disc.discovered, true);
    assert.equal(disc.feedUrl, `${base()}/feed.xml`);
    assert.equal(disc.items[0].content, undefined);
    const atom = await loadFeed(`${base()}/atom.xml`, { blocked: allowLoopback });
    assert.equal(atom.format, 'atom');
    assert.equal((await loadFeed(`${base()}/gbk.xml`, { blocked: allowLoopback })).feed.title, '中文');
    await assert.rejects(loadFeed(`${base()}/nofeed`, { blocked: allowLoopback }), { status: 422 });
    await assert.rejects(loadFeed(`${base()}/notfeed.xml`, { blocked: allowLoopback }), { status: 422 });
    await assert.rejects(loadFeed(`${base()}/500`, { blocked: allowLoopback }), { status: 502 });
    await assert.rejects(loadFeed(`${base()}/to-internal`, { blocked: allowLoopback }), { status: 400 });
    await assert.rejects(loadFeed(`${base()}/to-dns-internal`, { blocked: allowLoopback }), { status: 400 });
    await assert.rejects(route('/api/rss').handler({ query: q({ url: 'http://10.0.0.1/feed' }) }), { status: 400 });
    assert.equal(discoverFeed('<link rel="alternate" type="application/atom+xml" href="javascript:alert(1)">', 'https://x.com/'), null);
    checkFields(route('/api/rss'), d, disc, atom);
  });
});

// ---------------- 网页正文 / Markdown ----------------

describe('/api/web/text 与 /api/web/markdown', () => {
  test('正文区域选择：article 优先，跳过导航 / 页脚 / 隐藏内容', () => {
    const tokens = tokenize(ARTICLE);
    const pair = pairUp(tokens);
    assert.equal(selectRegion(tokens, pair, 'main').kind, 'article');
    assert.equal(selectRegion(tokens, pair, 'all').kind, 'body');
    const main = extractText(ARTICLE, { mode: 'main' });
    assert.ok(main.text.startsWith('正文标题'));
    for (const noise of ['导航一', '侧边栏', '版权所有', '隐藏内容', 'var a']) assert.ok(!main.text.includes(noise), noise);
    assert.deepEqual(main.headings, [{ level: 1, text: '正文标题' }, { level: 2, text: '第二部分' }]);
    const all = extractText(ARTICLE, { mode: 'all' });
    assert.ok(all.text.includes('导航一') && all.text.includes('版权所有'));
    assert.ok(!all.text.includes('隐藏内容'));
  });

  test('Markdown 转换', () => {
    const { markdown } = toMarkdown(ARTICLE, 'https://ex.com/dir/page');
    assert.match(markdown, /^# 正文标题/);
    assert.match(markdown, /这是\*\*第一段\*\*正文，包含\[一个链接\]\(https:\/\/ex\.com\/link\)和`a_b`/);
    assert.match(markdown, /\n## 第二部分\n/);
    assert.match(markdown, /\n- 列表一\n- 列表二\n {3}1\. 子项/);
    assert.match(markdown, /````js\nconst x = 1;\nconsole\.log\(```x```\);\n````/, '代码块围栏比内容里的反引号更长');
    assert.match(markdown, /\n> 引用的话\n/);
    assert.match(markdown, /\| 名称 \| 值 \|\n\| --- \| --- \|\n\| a\\\|b \| 1 \|/);
    assert.match(markdown, /!\[示意图\]\(https:\/\/ex\.com\/img\/1\.png\)\\\n换行后/);
    assert.ok(!markdown.includes('侧边栏') && !markdown.includes('\n\n\n'));
    const plain = toMarkdown(ARTICLE, 'https://ex.com/', { links: false, images: false }).markdown;
    assert.ok(plain.includes('包含一个链接和') && !plain.includes('!['));
    assert.equal(toMarkdown('<a href="javascript:alert(1)">x</a>', 'https://ex.com/').markdown, 'x', '只保留 http / https / mailto 链接');
  });

  test('转换器是线性时间：恶意构造的 HTML 不会卡住', () => {
    const inputs = ['<a '.repeat(200_000), '<b>'.repeat(100_000), '<table><td>'.repeat(50_000), '<ul><li>'.repeat(50_000), `<div>${'<article>x'.repeat(50_000)}`];
    const t0 = performance.now();
    for (const s of inputs) {
      toMarkdown(s, 'https://x.com/');
      extractText(s);
    }
    assert.ok(performance.now() - t0 < 5000, `耗时 ${performance.now() - t0}ms`);
  });

  test('抓取网页：压缩、截断、非 HTML、SSRF', async () => {
    const t = await loadWebText(`${base()}/article`, { blocked: allowLoopback });
    assert.equal(t.title, '文章标题 - 站点');
    assert.equal(t.lang, 'zh-CN');
    assert.equal(t.region, 'article');
    const cut = await loadWebText(`${base()}/article-br`, { maxLength: 100, mode: 'all', blocked: allowLoopback });
    assert.equal(cut.truncated, true);
    assert.equal(cut.text.length, 100);
    const md = await loadWebMarkdown(`${base()}/article`, { blocked: allowLoopback });
    assert.match(md.markdown, /^# 正文标题/);
    const bare = await loadWebMarkdown(`${base()}/nofeed`, { blocked: allowLoopback });
    assert.equal(bare.title, null);
    assert.equal(bare.markdown, 'hi');
    await assert.rejects(loadWebText(`${base()}/pdf`, { blocked: allowLoopback }), { status: 415 });
    await assert.rejects(loadWebText(`${base()}/to-internal`, { blocked: allowLoopback }), { status: 400 });
    await assert.rejects(loadWebMarkdown(`${base()}/to-dns-internal`, { blocked: allowLoopback }), { status: 400 });
    await assert.rejects(route('/api/web/text').handler({ query: q({ url: 'http://192.168.1.1/' }) }), { status: 400 });
    await assert.rejects(route('/api/web/markdown').handler({ query: q({ url: 'http://localhost/' }) }), { status: 400 });
    checkFields(route('/api/web/text'), t, cut);
    checkFields(route('/api/web/markdown'), md, bare);
  });
});

// ---------------- 整站文字抓取 ----------------

describe('/api/crawl', () => {
  const crawlSamples = [];
  beforeEach(() => _resetCrawlTasks());
  const crawl = (params, opts = {}) => new Promise((resolve, reject) => {
    try {
      const created = startCrawl(params, { blocked: allowLoopback, minDelayMs: 0, ip: '1.2.3.4', ...opts, onDone: (t) => resolve({ created, id: t.id }) });
    } catch (err) {
      reject(err);
    }
  });
  const result = (id, query = {}) => route('/api/crawl/result').handler({ query: q({ task_id: id, ...query }) }).then((r) => r.data);

  test('范围判断', () => {
    const site = scopeOf(new URL('https://www.a.com/docs/intro'), 'site');
    assert.ok(site(new URL('http://a.com/x')));
    assert.ok(!site(new URL('https://b.com/')));
    assert.ok(!site(new URL('https://a.com:8443/')));
    const path = scopeOf(new URL('https://a.com/docs/intro'), 'path');
    assert.ok(path(new URL('https://a.com/docs/other')));
    assert.ok(!path(new URL('https://a.com/blog/')));
  });

  test('只抓同站、遵守 robots、跳过非 HTML 与站外跳转、站内跳转跟随', async () => {
    const { created, id } = await crawl({ url: `${base('crawl.test.example')}/`, maxPages: 20, maxDepth: 1 });
    assert.equal(created.status, 'running');
    assert.match(created.taskId, /^[0-9a-f-]{36}$/);
    const r = await result(id);
    assert.equal(r.status, 'done', r.error);
    const urls = r.pages.map((p) => new URL(p.url).pathname);
    assert.deepEqual(urls.sort(), ['/', '/a', '/b', '/landed', '/missing'].sort());
    const paths = hits.map((h) => `${h.host}${h.path}`);
    assert.ok(!paths.some((p) => p.includes('/private')), 'robots.txt 禁止的路径没有请求');
    assert.ok(!paths.some((p) => p.includes('/bot-only-blocked')), '按 MiaoApiBot 组的规则匹配');
    assert.ok(!paths.some((p) => p.startsWith('other.')), '站外链接与站外跳转都不请求');
    assert.ok(!paths.some((p) => p.endsWith('/file.pdf')), '按扩展名跳过文件');
    assert.ok(!paths.some((p) => p.includes('/deep/')), 'max_depth=1');
    assert.equal(paths.filter((p) => p === 'crawl.test.example/a').length, 1, '去重（含 # 片段）');
    assert.ok(hits.every((h) => /MiaoApiBot/.test(h.ua) || h.path === '/robots.txt'));
    const missing = r.pages.find((p) => p.url.endsWith('/missing'));
    assert.equal(missing.status, 404);
    assert.match(missing.error, /404/);
    const home = r.pages.find((p) => p.url.endsWith(':' + PORT + '/'));
    assert.equal(home.title, '首页');
    assert.ok(home.text.startsWith('首页'));
    assert.equal(r.progress.crawled, 5);
    assert.equal(r.progress.failed, 1);
    assert.ok(r.progress.skipped >= 4);
    const noText = await result(id, { include_text: 'false', offset: '1', limit: '2' });
    assert.equal(noText.pages.length, 2);
    assert.equal(noText.pages[0].text, undefined);
    crawlSamples.push(r);
  });

  test('页面上限、深度、串行与请求间隔', async () => {
    const { id } = await crawl({ url: `${base('crawl.test.example')}/`, maxPages: 3, maxDepth: 3 }, { minDelayMs: 40 });
    const r = await result(id);
    assert.equal(r.total, 3);
    assert.equal(r.progress.maxPages, 3);
    assert.ok(r.progress.queued > 0);
    const times = hits.filter((h) => h.host === 'crawl.test.example').map((h) => h.at);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 35, `请求间隔 ${times[i] - times[i - 1]}ms`);
  });

  test('单页文字上限', async () => {
    const { id } = await crawl({ url: `${base('crawl.test.example')}/big`, maxPages: 1, maxDepth: 0 });
    const r = await result(id);
    assert.equal(r.pages[0].truncated, true);
    assert.equal(r.pages[0].text.length, 100_000);
    assert.equal(r.pages[0].length, 120_000, '<title> 不计入正文');
  });

  test('robots.txt 禁止全部：起始页被跳过', async () => {
    const { id } = await crawl({ url: `${base('blockall.test.example')}/`, maxPages: 5 });
    const r = await result(id);
    assert.equal(r.status, 'done');
    assert.equal(r.total, 0);
    assert.match(r.note, /robots/);
    assert.ok(!hits.some((h) => h.path === '/'), '没有请求被禁止的页面');
    crawlSamples.push(r);
  });

  test('SSRF：内网起始地址直接拒绝，解析到内网的任务失败，跳转到内网的页面跳过', async () => {
    assert.throws(() => startCrawl({ url: 'http://10.0.0.1/' }, { ip: '1.1.1.1' }), { status: 400 });
    assert.throws(() => startCrawl({ url: 'http://localhost:8080/' }, { ip: '1.1.1.1' }), { status: 400 });
    assert.throws(() => startCrawl({ url: 'ftp://a.com/' }, { ip: '1.1.1.1' }), { status: 400 });
    const { id } = await crawl({ url: `http://internal.test.example:${PORT}/` });
    const r = await result(id);
    assert.equal(r.status, 'failed');
    assert.match(r.error, /内网/);
    const redir = await result((await crawl({ url: `${base('crawl.test.example')}/to-internal`, maxPages: 2 })).id);
    assert.equal(redir.status, 'done');
    assert.equal(redir.total, 0);
    assert.ok(redir.progress.skipped >= 1);
    checkFields(route('/api/crawl/result'), ...crawlSamples, r, redir);
  });

  test('并发上限、参数上限、任务过期', async () => {
    const make = (ip, user) => startCrawl({ url: `${base('crawl.test.example')}/`, maxPages: 1, maxDepth: 0 }, { blocked: allowLoopback, minDelayMs: 0, ip, user });
    make('9.9.9.9');
    assert.throws(() => make('9.9.9.9'), { status: 429 }, '未登录每个 IP 同时 1 个');
    make(null, { id: 7 });
    make(null, { id: 7 });
    assert.throws(() => make(null, { id: 7 }), { status: 429 }, '登录用户同时 2 个');
    make('8.8.8.8');
    make('7.7.7.7');
    assert.throws(() => make('6.6.6.6'), { status: 503 }, '全局最多 5 个');
    assert.throws(() => startCrawl({ url: `${base('crawl.test.example')}/`, maxPages: 30 }, { ip: '5.5.5.5' }), { status: 400 }, '未登录最多 20 页');
    await assert.rejects(route('/api/crawl').handler({ body: { url: 'https://a.com', max_pages: 51 }, query: q({}), ip: '5.5.5.5' }), { status: 400 });
    await assert.rejects(route('/api/crawl').handler({ body: { url: 'https://a.com', scope: 'all' }, query: q({}), ip: '5.5.5.5' }), { status: 400 });
    await assert.rejects(result('00000000-0000-0000-0000-000000000000'), { status: 404 });
    // 等这些任务结束，再验证过期清理
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(_crawlTaskCount() >= 5);
    _sweepCrawlTasks(Date.now() + 31 * 60_000);
    assert.equal(_crawlTaskCount(), 0);
  });

  test('创建接口：请求体参数与字段说明', async () => {
    const res = await route('/api/crawl').handler({
      body: { url: `https://example.com/docs/`, max_pages: 1, max_depth: 0, scope: 'path', mode: 'all' }, query: q({}), user: null, ip: '4.4.4.4',
    });
    assert.deepEqual(res.data.options, { maxPages: 1, maxDepth: 0, scope: 'path', mode: 'all' });
    checkFields(route('/api/crawl'), res.data);
  });
});

after(() => _resetCrawlTasks());

// ---------------- App Store ----------------

describe('/api/appstore/search', () => {
  const RAW = {
    wrapperType: 'software', kind: 'software', trackId: 414478124, trackName: '微信', bundleId: 'com.tencent.xin', sellerName: 'Tencent', price: 0, formattedPrice: '免费',
    currency: 'CNY', averageUserRating: 4.12345, userRatingCount: 100, version: '8.0.50', primaryGenreName: '社交', genres: ['社交', '生活'], fileSizeBytes: '524288000',
    minimumOsVersion: '15.0', contentAdvisoryRating: '12+', releaseDate: '2011-01-21T01:32:15Z', currentVersionReleaseDate: '2026-09-08T04:16:59Z', releaseNotes: '修复问题',
    artworkUrl512: 'https://is1.mzstatic.com/512.jpg', trackViewUrl: 'https://apps.apple.com/cn/app/id414478124?uo=4', description: '微'.repeat(400),
  };

  test('格式化', () => {
    const a = formatApp(RAW);
    assert.equal(a.rating, 4.1);
    assert.equal(a.sizeMB, 500);
    assert.equal(a.url, 'https://apps.apple.com/cn/app/id414478124');
    assert.equal(a.description.length, 300);
    const b = formatApp({ trackId: 1, trackName: 'x' });
    assert.equal(b.rating, null);
    assert.equal(b.formattedPrice, null);
  });

  test('搜索与按 ID 查询（mock fetch）', async (t) => {
    const urls = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
      urls.push(String(url));
      if (String(url).includes('term=429')) return new Response('slow down', { status: 429 });
      return Response.json({ resultCount: 2, results: [RAW, { wrapperType: 'track', kind: 'song', trackId: 2 }] });
    });
    const r = route('/api/appstore/search');
    const res = await r.handler({ query: q({ keyword: '微信', country: 'us', limit: '5' }) });
    assert.equal(res.data.total, 1, '过滤掉非软件结果');
    assert.equal(res.data.countryName, '美国');
    const u = new URL(urls[0]);
    assert.equal(u.origin + u.pathname, 'https://itunes.apple.com/search');
    assert.equal(u.searchParams.get('term'), '微信');
    assert.equal(u.searchParams.get('entity'), 'software');
    const byId = await r.handler({ query: q({ id: '414478124' }) });
    assert.equal(byId.data.keyword, null);
    assert.match(urls[1], /\/lookup\?id=414478124&country=cn/);
    await assert.rejects(r.handler({ query: q({}) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ keyword: 'x', country: 'xx' }) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ id: '12a' }) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ keyword: '429' }) }), { status: 503 });
    checkFields(r, res.data, byId.data);
  });
});

// ---------------- 覆盖检查 ----------------

test('每个新增路由都做了双向字段校验', () => {
  const expected = routes.map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(expected.filter((k) => !checked.has(k)), []);
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';

const { handle } = await import('../src/app.js');

let server, base;
before(async () => {
  server = createServer(handle).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const nav = { 'sec-fetch-mode': 'navigate', accept: 'text/html,application/xhtml+xml' };
// fetch 会强制把 Sec-Fetch-Mode 设为 cors，模拟浏览器打开页面要用 http.request
function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    request(`${base}${path}`, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject).end();
  });
}

test('浏览器直接打开页面地址时返回网页', async () => {
  for (const p of ['/', '/docs', '/docs/epic', '/status', '/login', '/console/keys', '/admin/users', '/admin/settings/keys/GITHUB_TOKEN']) {
    const r = await get(p, nav);
    assert.equal(r.status, 200, p);
    assert.match(r.headers['content-type'], /text\/html/, p);
    assert.match(r.headers['cache-control'], /private/, `${p} 不能被 CDN 缓存`);
    assert.match(r.headers.vary, /Sec-Fetch-Mode/, p);
    assert.match(r.body, /<main id="main">/, p);
  }
});

test('没有 Sec-Fetch-Mode 的旧浏览器按 Accept 判断', async () => {
  const r = await get('/docs/epic', { accept: 'text/html' });
  assert.match(r.headers['content-type'], /text\/html/);
  const curl = await get('/status', { accept: '*/*' });
  assert.match(curl.headers['content-type'], /json/, '命令行调用照常返回 JSON');
});

test('网页程序用 fetch 取数据时同一地址照常返回 JSON', async () => {
  const r = await fetch(`${base}/status`);
  assert.match(r.headers.get('content-type'), /json/);
  assert.equal((await r.json()).code, 200);
  const admin = await fetch(`${base}/admin/users`);
  assert.ok(admin.status === 401 || admin.status === 403);
  assert.match(admin.headers.get('content-type'), /json/);
});

test('/api/ 接口、短链接和静态文件不受页面路由影响', async () => {
  const api = await get('/api/tools/uuid', nav);
  assert.match(api.headers['content-type'], /json/);
  const short = await get('/s/zzzzzz', nav);
  assert.doesNotMatch(short.body, /<main id="main">/);
  const js = await get('/app.js', nav);
  assert.match(js.headers['content-type'], /javascript/);
});

test('不存在的页面返回网页和 404 状态', async () => {
  const r = await get('/no-such-page', nav);
  assert.equal(r.status, 404);
  assert.match(r.headers['content-type'], /text\/html/);
  const json = await fetch(`${base}/no-such-page`);
  assert.equal(json.status, 404);
  assert.match(json.headers.get('content-type'), /json/);
});

test('前端不再使用 #/ 地址', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const f of ['public/app.js', 'public/index.html']) {
    const src = await readFile(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.ok(!/href="#\//.test(src) && !/location\.hash\s*=/.test(src), f);
  }
});

test('SEO：接口文档页在服务端写好标题、描述、规范链接和正文', async () => {
  const r = await get('/docs/epic', { 'user-agent': 'Mozilla/5.0 (compatible; Baiduspider/2.0)', accept: '*/*', host: 'api.example.com' });
  assert.equal(r.status, 200, '爬虫不带 Accept: text/html 也能拿到页面');
  assert.match(r.body, /<title>Epic 每周免费游戏 API 接口 - 免费调用 \| Miao API<\/title>/);
  assert.match(r.body, /<meta name="description" content="Epic 每周免费游戏 API：/);
  assert.match(r.body, /<link rel="canonical" href="http:\/\/api\.example\.com\/docs\/epic">/);
  assert.match(r.body, /<meta property="og:image" content="http:\/\/api\.example\.com\/og\.png">/);
  assert.match(r.body, /"@type":"WebAPI"/);
  assert.match(r.body, /<h1>Epic 每周免费游戏 API<\/h1>/);
  assert.match(r.body, /GET \/api\/epic\/free/);
  assert.equal((r.body.match(/<meta name="description"/g) ?? []).length, 1, '原来的描述被替换，不重复');
});

test('SEO：首页列出全部接口链接；不存在的接口 404 且不收录；登录页不收录', async () => {
  const home = await get('/', { accept: '*/*' });
  assert.match(home.body, /<h1>Miao API：免费聚合 API 接口平台<\/h1>/);
  assert.match(home.body, /<a href="\/docs\/epic">/);
  assert.match(home.body, /"@type":"WebSite"/);
  const missing = await get('/docs/no-such-api', nav);
  assert.equal(missing.status, 404);
  assert.match(missing.body, /noindex/);
  const login = await get('/login', nav);
  assert.match(login.body, /<meta name="robots" content="noindex, nofollow">/);
  // 恶意 Host 不会被写进页面
  const evil = await get('/', { host: 'evil.com"><script>' });
  assert.doesNotMatch(evil.body, /evil\.com"/);
});

test('SEO：/status 对爬虫返回页面，对网页程序和命令行返回 JSON', async () => {
  const bot = await get('/status', { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)', accept: '*/*' });
  assert.match(bot.headers['content-type'], /text\/html/);
  assert.match(bot.body, /<title>运行状态/);
  const curl = await get('/status', { 'user-agent': 'curl/8.0', accept: '*/*' });
  assert.match(curl.headers['content-type'], /json/);
});

test('robots.txt 与 sitemap.xml', async () => {
  const robots = await get('/robots.txt', { host: 'api.example.com' });
  assert.match(robots.headers['content-type'], /text\/plain/);
  assert.match(robots.body, /Disallow: \/api\//);
  assert.match(robots.body, /Sitemap: http:\/\/api\.example\.com\/sitemap\.xml/);
  const sm = await get('/sitemap.xml', { host: 'api.example.com' });
  assert.match(sm.headers['content-type'], /xml/);
  assert.match(sm.body, /<loc>http:\/\/api\.example\.com\/docs\/epic<\/loc>/);
  assert.match(sm.body, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  const og = await get('/og.png');
  assert.equal(og.headers['content-type'], 'image/png');
});

test('产品发布页 /about：填好接口数量等信息，不留模板占位符，也在站点地图里', async () => {
  for (const headers of [nav, { accept: '*/*' }]) {
    const r = await get('/about', { ...headers, host: 'api.example.com' });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.doesNotMatch(r.body, /\{\{[A-Z_]+\}\}/, '占位符全部替换');
    assert.match(r.body, /<link rel="canonical" href="http:\/\/api\.example\.com\/about">/);
    assert.match(r.body, /"@type":"FAQPage"/);
    assert.match(r.body, /<a class="cat reveal" href="\/docs\/epic">/);
    assert.match(r.body, /<b>\d+<\/b><span>个常用接口<\/span>/);
  }
  const raw = await get('/about.html', nav);
  assert.doesNotMatch(raw.body, /\{\{[A-Z_]+\}\}/, '直接访问模板文件也会被填好');
  const sm = await get('/sitemap.xml', { host: 'api.example.com' });
  assert.match(sm.body, /<loc>http:\/\/api\.example\.com\/about<\/loc>/);
  const js = await get('/about.js');
  assert.match(js.headers['content-type'], /javascript/);
  const img = await get('/img/playground.jpg');
  assert.equal(img.headers['content-type'], 'image/jpeg');
});

test('用户 QQ 群：默认显示群号；填了加群链接可点击；填 0 不显示', async () => {
  const prevQ = process.env.COMMUNITY_QQ;
  const prevL = process.env.COMMUNITY_QQ_LINK;
  try {
    delete process.env.COMMUNITY_QQ;
    delete process.env.COMMUNITY_QQ_LINK;
    const home = await get('/', nav);
    assert.match(home.body, /用户 QQ 群「MiaoClub」：<a href="https:\/\/qm\.qq\.com\/q\/vj3vttbYh" target="_blank" rel="noopener">2639496（点击加群）<\/a>/);
    const about = await get('/about', nav);
    assert.match(about.body, /加入 QQ 群 2639496/);
    assert.match(about.body, /遇到问题去哪里反馈/);
    const cat = await (await fetch(`${base}/api`)).json();
    assert.deepEqual(cat.data.community, { qq: '2639496', name: 'MiaoClub', link: 'https://qm.qq.com/q/vj3vttbYh' });

    // 换了群号：不再使用默认的群名和链接，没填链接时显示群号、可复制
    process.env.COMMUNITY_QQ = '12345678';
    const other = await get('/docs', nav);
    assert.match(other.body, /用户 QQ 群：<b>12345678<\/b>/);
    assert.match((await get('/about', nav)).body, /data-copy="12345678"/);
    process.env.COMMUNITY_QQ_LINK = 'https://qm.qq.com/q/abc123';
    assert.match((await get('/docs', nav)).body, /<a href="https:\/\/qm\.qq\.com\/q\/abc123" target="_blank" rel="noopener">12345678（点击加群）<\/a>/);

    process.env.COMMUNITY_QQ = '0';
    const hidden = await get('/', nav);
    assert.doesNotMatch(hidden.body, /QQ 群/);
    assert.doesNotMatch(hidden.body, /\{\{COMMUNITY/);
    assert.doesNotMatch((await get('/about', nav)).body, /QQ 群|\{\{COMMUNITY/);
  } finally {
    if (prevQ == null) delete process.env.COMMUNITY_QQ; else process.env.COMMUNITY_QQ = prevQ;
    if (prevL == null) delete process.env.COMMUNITY_QQ_LINK; else process.env.COMMUNITY_QQ_LINK = prevL;
  }
});

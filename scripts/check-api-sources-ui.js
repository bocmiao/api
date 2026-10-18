// Browser acceptance uses the real app/styles with a synthetic catalog only.
// Every browser request is fulfilled locally; no API handler, login or AI call runs.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
process.env.DB_FILE = ':memory:';
const { catalog } = await import('../src/registry.js');
const fixture = catalog({ includeDisabled: true });
const out = resolve(process.env.UI_EVIDENCE_DIR || 'data/api-sources-ui-evidence');
mkdirSync(out, { recursive: true });
const pub = new URL('../public/', import.meta.url);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
const errors = [], checks = [], blockedExternal = [];
try {
  const context = await browser.newContext({ reducedMotion: 'reduce', timezoneId: 'Asia/Shanghai' });
  await context.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname !== 'miao.test') { blockedExternal.push(u.hostname); return route.abort(); }
    if (u.pathname === '/api') return route.fulfill({ json: { code: 200, data: fixture } });
    if (u.pathname === '/auth/me') return route.fulfill({ json: { code: 200, data: { user: null, quota: null } } });
    if (u.pathname === '/stats/modules') return route.fulfill({ json: { code: 200, data: {} } });
    if (u.pathname.startsWith('/stats/module/')) return route.fulfill({ json: { code: 200, data: { routes: {} } } });
    if (route.request().resourceType() === 'document') return route.fulfill({ contentType: 'text/html', body: readFileSync(new URL('index.html', pub), 'utf8').replace('{{COMMUNITY}}', '') });
    if (/^\/[a-z-]+\.(js|css|svg)$/.test(u.pathname)) return route.fulfill({ contentType: u.pathname.endsWith('.js') ? 'text/javascript' : u.pathname.endsWith('.css') ? 'text/css' : 'image/svg+xml', body: readFileSync(new URL(basename(u.pathname), pub)) });
    return route.fulfill({ status: 503, json: { code: 503, message: '本地验收未调用业务数据' } });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const scenarios = [['/', 'home'], ['/docs/boxoffice', 'boxoffice'], ['/docs/poem', 'poem'], ['/docs/hitokoto', 'hitokoto'], ['/docs/ip', 'ip'], ['/docs/phone', 'phone'], ['/docs/mc-server', 'minecraft'], ['/docs/steam-info', 'steam'], ['/docs/hot-weibo', 'weibo'], ['/docs/psplus', 'psplus'], ['/docs/qq-avatar', 'qq-avatar'], ['/docs', 'docs']];
  for (const [width, height] of [[1360, 1000], [390, 844], [320, 800]]) {
    await page.setViewportSize({ width, height });
    for (const [path, name] of scenarios) {
      await page.goto('http://miao.test' + path, { waitUntil: 'networkidle' });
      await page.locator('#main h1').waitFor();
      assert.equal(await page.locator('#main > .wrap > .empty').count(), 0, 'main page renders without a load error');
      if (name === 'home') {
        assert.equal(await page.locator('.api-card').count(), 129);
        assert.doesNotMatch(await page.locator('a.api-card[href="/docs/boxoffice"]').innerText(), /暂不可用|已关闭/);
        assert.equal(await page.locator('.api-card .badge').filter({ hasText: /^非官方$/ }).count(), 0);
        for (const text of ['本地计算', '本地数据', '目标直查', '平台网页源', '官方公开源', '第三方数据', '混合来源', '默认本地']) assert.ok((await page.locator('.api-card .badge').filter({ hasText: new RegExp('^' + text + '$') }).count()) > 0, text);
      } else if (name === 'docs') assert.match(await page.locator('#main').innerText(), /不表示经过第三方代理/);
      else {
        assert.ok(await page.locator('.source-note').isVisible(), path);
        assert.ok((await page.locator('.source-note').innerText()).length > 10);
        if (name === 'boxoffice') {
          assert.match(await page.locator('#main').innerText(), /piaofang\.maoyan\.com\/dashboard-ajax\/movie/);
          assert.doesNotMatch(await page.locator('#main').innerText(), /该接口暂不可用/);
        }
        if (['poem', 'hitokoto'].includes(name)) assert.match(await page.locator('#main').innerText(), /provider/);
        if (['ip', 'phone'].includes(name)) assert.match(await page.locator('#main').innerText(), /offline/);
        if (name === 'minecraft') assert.match(await page.locator('.source-note').innerText(), /Server List Ping/);
      }
      const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      if (layout.scrollWidth > layout.width) {
        await page.screenshot({ path: `${out}/overflow-${name}-${width}.png`, fullPage: true });
        console.log(JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('body *')].map((e) => ({ tag: e.tagName, cls: e.className?.baseVal ?? e.className, text: e.textContent.slice(0, 50), rect: { x: e.getBoundingClientRect().x, right: e.getBoundingClientRect().right, width: e.getBoundingClientRect().width } })).filter((e) => e.rect.right > innerWidth + 1).slice(0, 25)), null, 2));
      }
      assert.ok(layout.scrollWidth <= layout.width, name + ':' + JSON.stringify(layout));
      if (['home', 'poem', 'ip', 'minecraft', 'weibo', 'docs'].includes(name)) await page.screenshot({ path: `${out}/${name}-${width}.png`, fullPage: true });
      checks.push({ path, viewport: { width, height }, layout });
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blockedExternal, []);
  writeFileSync(out + '/browser-results.json', JSON.stringify({ passed: true, synthetic: true, realAppAndStyles: true, catalogModules: 129, routeCount: 204, browser: await browser.version(), checks, pageErrors: errors, blockedExternal, backendHandlersInvoked: 0 }, null, 2));
  console.log(`Passed ${checks.length} real-UI checks; no external browser requests or backend API calls.`);
} finally { await browser.close(); }

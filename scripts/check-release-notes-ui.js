// Isolated release-note acceptance: exact historical/current renderers and local
// synthetic API results. No account login, update install, network or deployment.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { legacyReleaseCheck } from '../test/helpers/update-release.js';

const out = resolve(process.env.UI_EVIDENCE_DIR || 'data/release-0.12.0-evidence');
mkdirSync(out, { recursive: true });
const { result: legacy, requests } = await legacyReleaseCheck();
writeFileSync(out + '/legacy-read-result.json', JSON.stringify({ synthetic: true, result: legacy, localMockRequests: requests }, null, 2));
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const globals = source.slice(0, source.indexOf('// ---------- 请求'));
const helpers = source.slice(source.indexOf('const shortDate ='), source.indexOf('async function checkUpdate()'));
const current = source.slice(source.indexOf('async function checkUpdate()'), source.indexOf('const sleep =', source.indexOf('async function checkUpdate()')));
const historical = readFileSync(new URL('../test/fixtures/update-v0.11.1-renderer.txt', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const oldIdentity = { version: '0.11.1', sha: 'b'.repeat(40), installedAt: '2026-10-15T15:50:41Z' };
const modern = { ...legacy, canInstall: true, comparisonUnknown: false, upToDate: false,
  current: { ...legacy.current, runningIdentity: oldIdentity, diskIdentity: oldIdentity, restartNeeded: false },
  notesScope: 'versions', targetNotes: [], commitRangeUnavailable: false };
const errors = [], blockedRequests = [], checks = [];
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
try {
  const context = await browser.newContext({ reducedMotion: 'reduce', timezoneId: 'Asia/Shanghai' });
  await context.route('**/*', (route) => { blockedRequests.push(route.request().url()); return route.abort(); });
  for (const [name, renderer, fixture] of [['legacy-v0111', historical, legacy], ['current', current, modern]]) {
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setContent(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
      <title>本地 v0.12.0 更新说明验收</title><style>${css}</style></head><body>
      <main><div class="wrap" style="padding:28px 20px 80px"><p class="small faint">本地合成验收 · ${name} → v0.12.0 · 非线上运行状态</p>
      <div class="card" id="update-card"><div class="card-head"><h2>系统更新</h2><button class="btn sm" id="check-update">检查更新</button></div>
      <div class="card-pad" id="update-body"></div></div></div></main></body></html>`);
    await page.evaluate((value) => { globalThis.__fixture = value; }, fixture);
    await page.addScriptTag({ content: `${globals}\n${helpers}\nconst api = async () => structuredClone(globalThis.__fixture);\nconst runUpdate = () => { throw new Error('Install disabled in acceptance fixture'); };\n${renderer}\nglobalThis.__renderRelease = checkUpdate;` });
    await page.evaluate(() => globalThis.__renderRelease());
    const visible = await page.locator('.upd-changes').innerText();
    for (const re of [/60 秒简报/, /首次导入/, /503/, /全自动发现/, /账号 ID\/Key ID/]) assert.match(visible, re);
    assert.doesNotMatch(visible, /Git blob|ahead\/identical|launcher|Chromium|20 秒/);
    assert.match(await page.locator('.upd-status').innerText(), /发现新版本 v0\.12\.0/);
    assert.doesNotMatch(await page.locator('#update-body').innerText(), /部分提交未提供面向用户的说明/);
    assert.equal(await page.locator('.upd-changes li').count(), 7);
    for (const [label, width, height] of [['desktop', 1360, 1000], ['mobile-390', 390, 844], ['mobile-320', 320, 800]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => document.fonts.ready);
      const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      assert.ok(layout.scrollWidth <= layout.width, name + ' overflow: ' + JSON.stringify(layout));
      const file = `${name}-${label}.png`;
      await page.screenshot({ path: out + '/' + file, fullPage: true });
      checks.push({ renderer: name, viewport: { width, height }, layout, screenshot: file, notes: 7, newVersionLabel: true, firstImportAndDiscoveryWarnings: true });
    }
    await page.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(blockedRequests, [], 'No page network request is expected');
  const result = { passed: true, browser: await browser.version(), synthetic: true,
    historicalSource: '2f0ded7d62e6c5ec923055812d0a7a041924d7f7 (exact functions, not asserted as production SHA)',
    stylesheet: 'current public/styles.css', checks, pageErrors: errors, networkRequests: blockedRequests, remoteWrites: 0 };
  writeFileSync(out + '/browser-results.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }

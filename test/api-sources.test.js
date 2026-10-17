import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
process.env.DB_FILE = ':memory:';
const { modules } = await import('../src/apis/index.js');
const { catalog } = await import('../src/registry.js');
const { moduleSourceInfo, SOURCE_TYPES, SOURCE_PROFILE_NAMES } = await import('../src/lib/api-sources.js');
const { loadPoem } = await import('../src/apis/fun/poem.js');
const { loadHitokoto, HITOKOTO_TYPES } = await import('../src/apis/fun/hitokoto.js');
const { loadHolidayYear } = await import('../src/apis/life/holiday.js');
const { loadIpInfo } = await import('../src/apis/life/ip.js');
const { loadPhoneArea } = await import('../src/apis/life/phone.js');
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const route = (path) => modules.flatMap((m) => m.routes).find((r) => r.path === path);
const call = (path, query) => route(path).handler({ query: new URLSearchParams(query) });
function noNetwork() {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Outbound forbidden in local-path test'); };
  return () => assert.equal(calls, 0, 'even an attempted request followed by fallback is forbidden');
}

test('all registered modules have explicit audited sources; catalog and README counts agree', () => {
  assert.equal(modules.length, 129);
  const count = modules.reduce((n, m) => n + m.routes.length, 0);
  assert.equal(count, 204);
  assert.deepEqual([...SOURCE_PROFILE_NAMES].sort(), modules.map((m) => m.name).sort());
  for (const m of catalog({ includeDisabled: true }).modules) {
    assert.ok(m.sourceInfo.kind in SOURCE_TYPES, m.name);
    assert.ok(m.sourceInfo.summary.length > 10, m.name);
    assert.equal(typeof m.unofficial, 'boolean', 'legacy field retained');
    if (m.sourceInfo.kind.startsWith('local-')) assert.equal(m.sourceInfo.network, 'none');
  }
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, new RegExp(`${modules.length} 个常用接口（${count} 个调用地址）`));
  assert.equal(moduleSourceInfo('mc-server').kind, 'direct-target');
  assert.equal(moduleSourceInfo('psplus').kind, 'first-party-api');
  assert.equal(moduleSourceInfo('steam-info').kind, 'mixed');
  assert.equal(moduleSourceInfo('hot-hackernews').kind, 'mixed');
  assert.equal(moduleSourceInfo('qq-avatar').network, 'client');
  assert.equal(moduleSourceInfo('new-unknown-module').kind, 'unknown');
  const info = moduleSourceInfo('mc-server'); info.label = 'mutated';
  assert.equal(moduleSourceInfo('mc-server').label, '目标直查');
});

test('default poem/hitokoto routes never attempt outbound, preserve fields and all category filters', async () => {
  const check = noNetwork();
  const p = (await call('/api/poem', '')).data;
  assert.deepEqual(Object.keys(p).sort(), ['content', 'title', 'author', 'dynasty', 'category', 'fallback'].sort());
  assert.equal(p.fallback, true); assert.equal(p.category, null);
  for (const type of Object.keys(HITOKOTO_TYPES)) {
    const h = (await call('/api/hitokoto', 'type=' + type)).data;
    assert.equal(h.type, type); assert.equal(h.fallback, true);
    for (const k of ['id', 'uuid', 'creator', 'url']) assert.equal(h[k], null);
    assert.ok(h.hitokoto.length > 0);
  }
  await assert.rejects(call('/api/poem', 'provider=https://evil.example'), { status: 400 });
  await assert.rejects(call('/api/hitokoto', 'provider=other'), { status: 400 });
  await assert.rejects(call('/api/hitokoto', 'type=z'), { status: 400 });
  check();
});

test('explicit original providers retain online success and local failure fallback', async () => {
  let calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(String(url).includes('jinrishici')
      ? { content: '会当凌绝顶，一览众山小。', origin: '望岳', author: '杜甫', category: '古诗文' }
      : { id: 1, uuid: 'fixture', hitokoto: 'Fixture', type: 'g' }));
  };
  assert.equal((await call('/api/poem', 'provider=jinrishici')).data.fallback, false);
  assert.equal((await call('/api/hitokoto', 'provider=hitokoto&type=g')).data.fallback, false);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].startsWith('https://v1.jinrishici.com/'));
  assert.ok(calls[1].startsWith('https://v1.hitokoto.cn/'));
  globalThis.fetch = async () => { throw new Error('offline fixture'); };
  assert.equal((await loadPoem({ provider: 'jinrishici' })).fallback, true);
  assert.equal((await loadHitokoto(['g'], { provider: 'hitokoto' })).type, 'g');
});

test('builtin holiday schedules use no outbound and returned copies cannot corrupt future results', async () => {
  const check = noNetwork();
  for (const year of [2025, 2026]) {
    const data = await loadHolidayYear(year);
    assert.equal(data.source, 'builtin'); assert.ok(data.days.length > 30);
    const expected = data.days.length; data.days.length = 0;
    assert.equal((await loadHolidayYear(year)).days.length, expected);
  }
  const data = await loadHolidayYear(2026);
  assert.equal(data.days.find((d) => d.date === '2026-01-04').isOffDay, false);
  assert.equal(data.days.find((d) => d.date === '2026-02-23').isOffDay, true);
  check();
});

test('IP/phone offline paths never call providers, including missing IPv6 and number segments', async () => {
  const check = noNetwork();
  const ip = (await call('/api/ip', 'ip=8.8.8.8&mode=offline')).data;
  assert.equal(ip.source, 'ip2region'); assert.equal(ip.asn, null);
  await assert.rejects(loadIpInfo('2606:4700:4700::1111', { mode: 'offline', withAsn: true }), { status: 404 });
  const phone = (await call('/api/phone', 'number=13800138000&mode=offline')).data;
  assert.equal(phone.source, 'phonedata');
  await assert.rejects(loadPhoneArea('19999999999', { mode: 'offline' }), { status: 404 });
  await assert.rejects(call('/api/ip', 'ip=8.8.8.8&mode=other'), { status: 400 });
  await assert.rejects(call('/api/phone', 'number=13800138000&mode=other'), { status: 400 });
  check();
});

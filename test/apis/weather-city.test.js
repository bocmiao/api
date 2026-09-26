import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import lifeModules from '../../src/apis/life/index.js';
import { parseOpenMeteoSearch, parseQWeatherSearch, parseOpenMeteoGet } from '../../src/apis/life/weather.js';
import { assertFieldsDocumented, collectPaths, matcher } from '../helpers/fields.js';

const json = (name) => JSON.parse(readFileSync(new URL(`../fixtures/life/${name}`, import.meta.url), 'utf8'));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.QWEATHER_KEY;
  delete process.env.QWEATHER_HOST;
});
// 按 URL 片段返回预置响应的假 fetch（先匹配先用）
function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    for (const [frag, body] of Object.entries(routes)) {
      if (String(url).includes(frag)) {
        if (typeof body === 'number') return new Response('err', { status: body });
        return new Response(JSON.stringify(body), { status: 200 });
      }
    }
    return new Response('no mock', { status: 500 });
  };
  return calls;
}
const route = (path) => lifeModules.flatMap((m) => m.routes).find((r) => r.path === path);
const call = (path, qs = '') => route(path).handler({ query: new URLSearchParams(qs), params: {} });
const useQWeather = () => { process.env.QWEATHER_KEY = 'k-city'; };

// Open-Meteo 搜索"汝阳"的样例
const OM_SEARCH = {
  results: [
    { id: 1786640, name: '汝阳县', latitude: 34.15, longitude: 112.47, feature_code: 'PPLA3', country_code: 'CN', timezone: 'Asia/Shanghai',
      population: 45000, country: '中国', admin1: '河南省', admin2: '洛阳市', admin3: '汝阳县' },
    { id: 1786641, name: '汝阳', latitude: 30.1, longitude: 110.2, feature_code: 'PPL', country_code: 'CN', timezone: 'Asia/Shanghai',
      country: '中国', admin1: '湖北省' },
  ],
  generationtime_ms: 0.5,
};
// 和风 GeoAPI 搜索"汝阳"的样例
const QW_SEARCH = {
  code: '200',
  location: [
    { name: '汝阳', id: '101180309', lat: '34.15323', lon: '112.47379', adm2: '洛阳', adm1: '河南省', country: '中国', tz: 'Asia/Shanghai',
      utcOffset: '+08:00', isDst: '0', type: 'city', rank: '33', fxLink: 'https://www.qweather.com/weather/ruyang-101180309.html' },
  ],
};
// Open-Meteo /v1/get 直接返回地点对象
const OM_GET = { id: 1786640, name: '汝阳县', latitude: 34.15, longitude: 112.47, timezone: 'Asia/Shanghai', country: '中国', admin1: '河南省', admin2: '洛阳市' };

describe('城市搜索解析', () => {
  test('两种数据源输出字段一致，缺的为 null', () => {
    const om = parseOpenMeteoSearch(OM_SEARCH);
    const qw = parseQWeatherSearch(QW_SEARCH);
    assert.deepEqual(Object.keys(om[0]).sort(), Object.keys(qw[0]).sort());
    assert.deepEqual(om[0], {
      id: '1786640', name: '汝阳县', adm1: '河南省', adm2: '洛阳市', adm3: '汝阳县', country: '中国', countryCode: 'CN',
      lat: 34.15, lon: 112.47, timezone: 'Asia/Shanghai', type: 'PPLA3', population: 45000,
    });
    assert.equal(om[1].adm2, null);
    assert.equal(om[1].population, null);
    assert.deepEqual(qw[0], {
      id: '101180309', name: '汝阳', adm1: '河南省', adm2: '洛阳', adm3: null, country: '中国', countryCode: null,
      lat: 34.15323, lon: 112.47379, timezone: 'Asia/Shanghai', type: 'city', population: null,
    });
    assert.deepEqual(parseOpenMeteoSearch({ generationtime_ms: 1 }), []);
    assert.deepEqual(parseQWeatherSearch({ code: '200' }), []);
  });
  test('Open-Meteo get：对象或 results 包装都能解析，错误返回 null', () => {
    assert.equal(parseOpenMeteoGet(OM_GET).id, '1786640');
    assert.equal(parseOpenMeteoGet({ results: [OM_GET] }).lat, 34.15);
    assert.equal(parseOpenMeteoGet({ error: true, reason: 'not found' }), null);
    assert.equal(parseOpenMeteoGet(null), null);
  });
});

describe('/api/weather/city', () => {
  test('默认 Open-Meteo，URL 参数正确，结果缓存', async () => {
    const calls = mockFetch({ 'geocoding-api.open-meteo.com/v1/search': OM_SEARCH });
    const r = await call('/api/weather/city', 'q=汝阳OM&limit=5');
    assert.equal(r.data.provider, 'open-meteo');
    assert.equal(r.data.query, '汝阳OM');
    assert.equal(r.data.count, 2);
    assert.equal(r.data.items[0].id, '1786640');
    const u = new URL(calls[0].url);
    assert.equal(u.searchParams.get('name'), '汝阳OM');
    assert.equal(u.searchParams.get('count'), '5');
    assert.equal(u.searchParams.get('language'), 'zh');

    const again = await call('/api/weather/city', 'q=汝阳OM&limit=5');
    assert.equal(again.cached, true);
    assert.equal(calls.length, 1);
  });
  test('无结果时 count 为 0', async () => {
    mockFetch({ 'geocoding-api.open-meteo.com/v1/search': { generationtime_ms: 0.1 } });
    const r = await call('/api/weather/city', 'q=不存在的地方');
    assert.deepEqual(r.data.items, []);
    assert.equal(r.data.count, 0);
  });
  test('配置和风后用 GeoAPI，number 参数，provider 为 qweather', async () => {
    useQWeather();
    process.env.QWEATHER_HOST = 'abc.re.qweatherapi.com';
    const calls = mockFetch({ '/geo/v2/city/lookup': QW_SEARCH });
    const r = await call('/api/weather/city', 'q=汝阳QW');
    assert.equal(r.data.provider, 'qweather');
    assert.equal(r.data.items[0].id, '101180309');
    const u = new URL(calls[0].url);
    assert.equal(u.host, 'abc.re.qweatherapi.com');
    assert.equal(u.searchParams.get('location'), '汝阳QW');
    assert.equal(u.searchParams.get('number'), '10');
    assert.equal(calls[0].opts.headers['X-QW-Api-Key'], 'k-city');
  });
  test('和风无结果（code 404）返回空列表，其他错误码为 502', async () => {
    useQWeather();
    mockFetch({ '/geo/v2/city/lookup': { code: '404' } });
    assert.equal((await call('/api/weather/city', 'q=和风查无')).data.count, 0);
    mockFetch({ '/geo/v2/city/lookup': { code: '401' } });
    await assert.rejects(call('/api/weather/city', 'q=和风出错'), { status: 502 });
  });
  test('参数校验', async () => {
    await assert.rejects(call('/api/weather/city', ''), { status: 400 });
    await assert.rejects(call('/api/weather/city', 'q=%20%20'), { status: 400 });
    await assert.rejects(call('/api/weather/city', `q=${'长'.repeat(31)}`), { status: 400 });
    await assert.rejects(call('/api/weather/city', 'q=汝阳&limit=0'), { status: 400 });
    await assert.rejects(call('/api/weather/city', 'q=汝阳&limit=21'), { status: 400 });
    await assert.rejects(call('/api/weather/city', 'q=汝阳&limit=abc'), { status: 400 });
  });
  test('返回字段都有说明，说明里的字段都被样例覆盖', async () => {
    mockFetch({ 'geocoding-api.open-meteo.com/v1/search': OM_SEARCH });
    const om = (await call('/api/weather/city', 'q=字段汝阳OM')).data;
    useQWeather();
    mockFetch({ '/geo/v2/city/lookup': QW_SEARCH });
    const qw = (await call('/api/weather/city', 'q=字段汝阳QW')).data;
    const r = route('/api/weather/city');
    for (const d of [om, qw]) assertFieldsDocumented(r, d);
    const seen = [...new Set([om, qw].flatMap((d) => [...collectPaths(d)]))];
    const unseen = r.fields.map((f) => f.name).filter((n) => !seen.some((p) => matcher(n).test(p)));
    assert.deepEqual(unseen, []);
    for (const p of r.params) assert.ok(p.desc && p.example, p.name);
  });
});

describe('/api/weather 按 id 查询与重名候选', () => {
  test('Open-Meteo：id 反查坐标后查询，location.id 返回编号', async () => {
    const calls = mockFetch({ 'geocoding-api.open-meteo.com/v1/get': OM_GET, 'api.open-meteo.com/v1/forecast': json('openmeteo-forecast.json') });
    const r = await call('/api/weather', 'id=1786640');
    assert.equal(r.data.provider, 'open-meteo');
    assert.equal(r.data.location.id, '1786640');
    assert.equal(r.data.location.name, '汝阳县');
    assert.deepEqual(r.data.candidates, []);
    const u = new URL(calls[0].url);
    assert.equal(u.pathname, '/v1/get');
    assert.equal(u.searchParams.get('id'), '1786640');
    assert.ok(calls[1].url.includes('latitude=34.15'));
    assert.ok(calls[1].url.includes('longitude=112.47'));

    // 天气结果缓存：再次查询不发请求
    const again = await call('/api/weather', 'id=1786640');
    assert.equal(again.cached, true);
    assert.equal(calls.length, 2);
  });
  test('Open-Meteo：id 查不到返回 404', async () => {
    mockFetch({ 'geocoding-api.open-meteo.com/v1/get': { error: true, reason: 'Not found' } });
    await assert.rejects(call('/api/weather', 'id=999999999'), { status: 404 });
  });
  test('和风：LocationID 直接查询天气，GeoAPI 补全地点信息', async () => {
    useQWeather();
    const calls = mockFetch({ '/geo/v2/city/lookup': QW_SEARCH, '/v7/weather/now': json('qweather-now.json'), '/v7/weather/7d': json('qweather-7d.json') });
    const r = await call('/api/weather', 'id=101180309');
    assert.equal(r.data.provider, 'qweather');
    assert.equal(r.data.location.id, '101180309');
    assert.equal(r.data.location.admin, '河南省 洛阳');
    assert.equal(r.data.location.timezone, 'Asia/Shanghai');
    assert.deepEqual(r.data.candidates, []);
    assert.equal(new URL(calls[0].url).searchParams.get('location'), '101180309');
    for (const c of calls.slice(1)) assert.equal(new URL(c.url).searchParams.get('location'), '101180309');
  });
  test('按城市名：仍取第一个结果，其他候选放在 candidates', async () => {
    const calls = mockFetch({ 'geocoding-api.open-meteo.com/v1/search': OM_SEARCH, 'api.open-meteo.com/v1/forecast': json('openmeteo-forecast.json') });
    const r = await call('/api/weather', 'city=汝阳重名OM');
    assert.equal(r.data.location.id, '1786640');
    assert.deepEqual(r.data.candidates, [{ id: '1786641', name: '汝阳', adm1: '湖北省', adm2: null, country: '中国' }]);
    assert.equal(new URL(calls[0].url).searchParams.get('count'), '6');

    useQWeather();
    const many = { code: '200', location: Array.from({ length: 8 }, (_, i) => ({ ...QW_SEARCH.location[0], id: `10118030${i}`, name: `汝阳${i}` })) };
    const qcalls = mockFetch({ '/geo/v2/city/lookup': many, '/v7/weather/now': json('qweather-now.json'), '/v7/weather/7d': json('qweather-7d.json') });
    const q = await call('/api/weather', 'city=汝阳重名QW');
    assert.equal(q.data.location.id, '101180300');
    assert.equal(q.data.candidates.length, 5);
    assert.deepEqual(q.data.candidates.map((c) => c.id), ['101180301', '101180302', '101180303', '101180304', '101180305']);
    assert.equal(new URL(qcalls[0].url).searchParams.get('number'), '6');
  });
  test('按经纬度查询时 candidates 为空、没有 location.id', async () => {
    mockFetch({ 'api.open-meteo.com/v1/forecast': json('openmeteo-forecast.json') });
    const r = await call('/api/weather', 'lat=34.15&lon=112.47');
    assert.deepEqual(r.data.candidates, []);
    assert.equal('id' in r.data.location, false);
  });
  test('参数校验：三选一、id 格式', async () => {
    await assert.rejects(call('/api/weather', 'id=1&city=北京'), { status: 400 });
    await assert.rejects(call('/api/weather', 'id=1&lat=30&lon=120'), { status: 400 });
    await assert.rejects(call('/api/weather', 'city=北京&lat=30&lon=120'), { status: 400 });
    await assert.rejects(call('/api/weather', 'id=abc-123'), { status: 400 });
    await assert.rejects(call('/api/weather', `id=${'1'.repeat(21)}`), { status: 400 });
  });
});

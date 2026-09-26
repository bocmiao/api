import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import lifeModules from '../../src/apis/life/index.js';
import { getLunarInfo, solarToLunar, parseDate, solarTermDay, solarTermTime, SOLAR_TERMS, todayBeijing } from '../../src/apis/life/lunar.js';
import { parseHolidayCn, fallbackYear, holidayInfoFrom, holidayPeriods, nextHolidayFrom, getHolidayInfo, getNextHoliday } from '../../src/apis/life/holiday.js';
import { parseOpenMeteoGeo, parseOpenMeteoForecast, parseQWeatherGeo, parseQWeather, wmoText, windDirText, windScale, loadWeather } from '../../src/apis/life/weather.js';
import { kuaidi100Sign, buildQueryBody, parseKuaidi100, parseAutoNumber, COMPANIES } from '../../src/apis/life/express.js';
import { normalizeIp, isPrivateIp, parseIpApi } from '../../src/apis/life/ip.js';
import { parse360, carrierBySegment } from '../../src/apis/life/phone.js';
import { parseBaiduHistory } from '../../src/apis/life/history.js';
import { parseViki60s, parseZhihu60s } from '../../src/apis/life/news60s.js';
import { parseOilPage, normalizeProvince } from '../../src/apis/life/oil.js';
import { assertFieldsDocumented, collectPaths, matcher } from '../helpers/fields.js';

const fx = (name) => readFileSync(new URL(`../fixtures/life/${name}`, import.meta.url), 'utf8');
const json = (name) => JSON.parse(fx(name));

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
// 按 URL 片段返回预置响应的假 fetch
function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    for (const [frag, body] of Object.entries(routes)) {
      if (String(url).includes(frag)) {
        if (body instanceof Error) throw body;
        if (typeof body === 'number') return new Response('not found', { status: body });
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
      }
    }
    return new Response('no mock', { status: 500 });
  };
  return calls;
}
const route = (path) => lifeModules.flatMap((m) => m.routes).find((r) => r.path === path);
const call = (path, qs = '', extra = {}) => route(path).handler({ query: new URLSearchParams(qs), params: {}, ...extra });

describe('模块注册', () => {
  test('所有路由都有 params 描述、source', () => {
    const paths = lifeModules.flatMap((m) => m.routes.map((r) => r.path));
    for (const p of ['/api/weather', '/api/holiday', '/api/holiday/next', '/api/holiday/year', '/api/lunar', '/api/oil',
      '/api/express', '/api/express/companies', '/api/ip', '/api/phone', '/api/history/today', '/api/news/60s']) {
      assert.ok(paths.includes(p), p);
    }
    for (const m of lifeModules) {
      assert.equal(m.category, 'life');
      assert.ok(m.source, m.name);
      for (const r of m.routes) for (const p of r.params) assert.ok(p.desc, `${r.path} ${p.name}`);
    }
  });
});

describe('农历', () => {
  test('2024-02-10 为甲辰龙年正月初一', () => {
    const d = getLunarInfo('2024-02-10');
    assert.equal(d.lunar.monthName + d.lunar.dayName, '正月初一');
    assert.equal(d.yearName, '甲辰龙年');
    assert.equal(d.ganzhi.month, '丙寅');
    assert.ok(d.festivals.includes('春节'));
  });
  test('2026-02-17 为丙午马年正月初一', () => {
    const d = getLunarInfo('2026-02-17');
    assert.equal(d.lunar.text, '二〇二六年正月初一');
    assert.equal(d.yearName, '丙午马年');
    assert.equal(d.ganzhi.month, '庚寅');
  });
  test('闰月、除夕、中秋', () => {
    const l = solarToLunar(parseDate('2023-03-22'));
    assert.deepEqual([l.year, l.month, l.day, l.isLeap], [2023, 2, 1, true]);
    assert.equal(getLunarInfo('2023-03-22').lunar.monthName, '闰二月');
    assert.ok(getLunarInfo('2026-02-16').festivals.includes('除夕'));
    assert.ok(getLunarInfo('2026-09-25').festivals.includes('中秋节'));
    assert.ok(getLunarInfo('2026-06-19').festivals.includes('端午节'));
    // 闰月不重复计节日
    assert.equal(getLunarInfo('2020-06-01').lunar.monthName, '闰四月');
  });
  test('干支日：2000-01-01 戊午日', () => {
    assert.equal(getLunarInfo('2000-01-01').ganzhi.day, '戊午');
  });
  test('节气日期与已知数据一致', () => {
    const day = (y, name) => new Date(solarTermDay(y, SOLAR_TERMS.indexOf(name))).toISOString().slice(0, 10);
    assert.equal(day(2024, '立春'), '2024-02-04');
    assert.equal(day(2024, '清明'), '2024-04-04');
    assert.equal(day(2024, '夏至'), '2024-06-21');
    assert.equal(day(2024, '冬至'), '2024-12-21');
    assert.equal(day(2025, '冬至'), '2025-12-21');
    assert.equal(day(2026, '清明'), '2026-04-05');
    // 2024 春分 北京时间 11:06
    const t = new Date(solarTermTime(2024, SOLAR_TERMS.indexOf('春分'))).toISOString().slice(11, 16);
    assert.ok(['11:05', '11:06', '11:07'].includes(t), t);
    assert.equal(getLunarInfo('2024-02-04').solarTerm.today, '立春');
    const n = getLunarInfo('2026-09-24').solarTerm;
    assert.equal(n.current.name, '秋分');
    assert.equal(n.next.name, '寒露');
    assert.equal(n.next.days, 14);
  });
  test('建除与宜忌', () => {
    const a = getLunarInfo('2024-02-10').almanac; // 寅月辰日 → 满
    assert.equal(a.jianchu, '满');
    assert.ok(a.yi.length && a.ji.length);
    assert.equal(a.chong, '冲狗');
  });
  test('范围与格式校验', () => {
    assert.throws(() => getLunarInfo('1899-12-31'), { status: 400 });
    assert.throws(() => getLunarInfo('2024-02-30'), { status: 400 });
    assert.equal(todayBeijing(Date.parse('2026-09-24T17:00:00Z')), '2026-09-25');
  });
  test('Intl 中文历交叉校验（近年）', () => {
    const f = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { timeZone: 'UTC', month: 'numeric', day: 'numeric' });
    for (let t = Date.UTC(2019, 0, 1); t < Date.UTC(2027, 0, 1); t += 86_400_000) {
      const parts = Object.fromEntries(f.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
      assert.equal(solarToLunar(t).day, Number(parts.day), new Date(t).toISOString());
    }
  });
});

describe('节假日', () => {
  const y2026 = parseHolidayCn(json('holiday-cn-2026.json'), 2026);
  test('解析 holiday-cn 并与内置 2026 兜底一致', () => {
    assert.equal(y2026.year, 2026);
    assert.deepEqual(fallbackYear(2026).days, y2026.days);
    assert.equal(fallbackYear(2030), null);
    assert.throws(() => parseHolidayCn({}), { status: 502 });
  });
  test('放假、调休上班、周末、工作日', () => {
    assert.deepEqual(
      ['2026-10-01', '2026-10-10', '2026-09-26', '2026-09-24', '2026-10-17'].map((d) => holidayInfoFrom(y2026, d).type),
      ['holiday', 'workday', 'holiday', 'normal', 'weekend'],
    );
    const w = holidayInfoFrom(y2026, '2026-02-14');
    assert.equal(w.isWorkday, true);
    assert.equal(w.note, '春节调休上班');
    assert.equal(holidayInfoFrom(y2026, '2026-02-17').name, '春节');
  });
  test('假期段与下一个假期', () => {
    const periods = holidayPeriods(y2026);
    assert.equal(periods.length, 7);
    assert.deepEqual(periods.find((p) => p.name === '春节'), { name: '春节', start: '2026-02-15', end: '2026-02-23', days: 9, workdays: ['2026-02-14', '2026-02-28'] });
    const r = nextHolidayFrom([y2026], '2026-09-24');
    assert.equal(r.current, null);
    assert.equal(r.next.name, '中秋节');
    assert.equal(r.next.daysUntil, 1);
    const r2 = nextHolidayFrom([y2026], '2026-10-02');
    assert.equal(r2.current.name, '国庆节');
    assert.equal(r2.current.dayIndex, 2);
    assert.equal(r2.next, null);
  });
  test('2025 兜底：国庆中秋 8 天', () => {
    const p = holidayPeriods(fallbackYear(2025)).at(-1);
    assert.equal(p.days, 8);
    assert.deepEqual(p.workdays, ['2025-09-28', '2025-10-11']);
  });
  test('上游失败时使用内置数据；未公布年份返回空', async () => {
    mockFetch({ '2025.json': new Error('down'), '2031.json': 404 });
    const d = await getHolidayInfo('2025-01-28');
    assert.equal(d.type, 'holiday');
    assert.equal(d.name, '春节');
    const e = await getHolidayInfo('2031-01-04');
    assert.equal(e.published, false);
    assert.equal(e.type, 'weekend');
  });
  test('/api/holiday/next 跨年查找', async () => {
    mockFetch({ '2032.json': { year: 2032, days: [{ name: '元旦', date: '2032-01-01', isOffDay: true }] }, '2033.json': 404 });
    const { data } = await getNextHoliday('2032-12-01').then((data) => ({ data }));
    assert.equal(data.next, null);
    const r = await getNextHoliday('2031-12-30');
    assert.equal(r.next.name, '元旦');
    assert.equal(r.next.daysUntil, 2);
  });
  test('参数校验', async () => {
    await assert.rejects(call('/api/holiday', 'date=2026-13-01'), { status: 400 });
    await assert.rejects(call('/api/holiday/year', 'year=abc'), { status: 400 });
  });
});

describe('天气', () => {
  test('WMO、风向、风级', () => {
    assert.equal(wmoText(0), '晴');
    assert.equal(wmoText(95), '雷阵雨');
    assert.equal(wmoText(1234), '未知');
    assert.equal(windDirText(225), '西南风');
    assert.equal(windDirText(350), '北风');
    assert.equal(windScale(0.5), '0');
    assert.equal(windScale(11.2), '2');
    assert.equal(windScale(200), '12');
  });
  test('Open-Meteo 解析', () => {
    const loc = parseOpenMeteoGeo(json('openmeteo-geo.json'));
    assert.equal(loc.name, '北京市');
    assert.equal(parseOpenMeteoGeo(json('openmeteo-empty.json')), null);
    const w = parseOpenMeteoForecast(json('openmeteo-forecast.json'), loc);
    assert.equal(w.provider, 'open-meteo');
    assert.equal(w.location.timezone, 'Asia/Shanghai');
    assert.equal(w.current.temp, 24.3);
    assert.equal(w.current.weather, '多云');
    assert.equal(w.current.windDir, '西南风');
    assert.equal(w.daily.length, 7);
    assert.deepEqual(w.daily[1], {
      date: '2026-09-25', weather: '小雨', weatherNight: null, code: '61', tempMax: 22.4, tempMin: 14.8, precip: 3.2,
      precipProb: 70, windDir: '东风', windScale: '3', uvIndex: 2.3, sunrise: '06:05', sunset: '18:08',
    });
    assert.throws(() => parseOpenMeteoForecast({ error: true, reason: 'x' }, loc), { status: 502 });
  });
  test('和风天气解析，输出结构与 Open-Meteo 一致', () => {
    const loc = parseQWeatherGeo(json('qweather-geo.json'));
    assert.equal(loc.id, '101010100');
    assert.equal(loc.admin, '北京市 北京');
    const w = parseQWeather(json('qweather-now.json'), json('qweather-7d.json'), loc);
    assert.equal(w.provider, 'qweather');
    assert.equal(w.current.temp, 24);
    assert.equal(w.current.weather, '多云');
    assert.equal(w.daily[0].weatherNight, '晴');
    assert.equal(w.daily[6].tempMax, 24);
    const om = parseOpenMeteoForecast(json('openmeteo-forecast.json'), parseOpenMeteoGeo(json('openmeteo-geo.json')));
    assert.deepEqual(Object.keys(w.current).sort(), Object.keys(om.current).sort());
    assert.deepEqual(Object.keys(w.daily[0]).sort(), Object.keys(om.daily[0]).sort());
  });
  test('按城市走 Open-Meteo，URL 编码中文', async () => {
    delete process.env.QWEATHER_KEY;
    const calls = mockFetch({ 'geocoding-api.open-meteo.com': json('openmeteo-geo.json'), 'api.open-meteo.com/v1/forecast': json('openmeteo-forecast.json') });
    const r = await call('/api/weather', 'city=北京测试');
    assert.equal(r.data.provider, 'open-meteo');
    assert.ok(calls[0].url.includes(`name=${encodeURIComponent('北京测试')}`));
    assert.ok(calls[0].url.includes('language=zh'));
    assert.ok(calls[1].url.includes('latitude=39.9075'));
  });
  test('配置 QWEATHER_KEY 后走和风，专属 Host', async () => {
    process.env.QWEATHER_KEY = 'k123';
    process.env.QWEATHER_HOST = 'https://abc.re.qweatherapi.com/';
    try {
      const calls = mockFetch({ '/geo/v2/city/lookup': json('qweather-geo.json'), '/v7/weather/now': json('qweather-now.json'), '/v7/weather/7d': json('qweather-7d.json') });
      const r = await loadWeather({ city: '北京和风' });
      assert.equal(r.data.provider, 'qweather');
      assert.ok(calls.every((c) => c.url.startsWith('https://abc.re.qweatherapi.com/')));
      assert.equal(calls[0].opts.headers['X-QW-Api-Key'], 'k123');
      assert.ok(calls[1].url.includes('location=101010100'));
    } finally {
      delete process.env.QWEATHER_KEY;
      delete process.env.QWEATHER_HOST;
    }
  });
  test('经纬度校验', async () => {
    await assert.rejects(call('/api/weather', 'lat=91&lon=10'), { status: 400 });
    await assert.rejects(call('/api/weather', 'lat=30'), { status: 400 });
  });
});

describe('快递', () => {
  test('签名 = MD5(param + key + customer) 大写', () => {
    const p = '{"com":"yuantong","num":"YT1"}';
    const expect = createHash('md5').update(`${p}KEYCUST`).digest('hex').toUpperCase();
    assert.equal(kuaidi100Sign(p, 'KEY', 'CUST'), expect);
    const body = new URLSearchParams(buildQueryBody({ com: 'shunfeng', num: 'SF1', phone: '1234' }, 'KEY', 'CUST'));
    assert.equal(body.get('customer'), 'CUST');
    assert.equal(JSON.parse(body.get('param')).phone, '1234');
    assert.equal(body.get('sign'), kuaidi100Sign(body.get('param'), 'KEY', 'CUST'));
  });
  test('解析物流轨迹', () => {
    const r = parseKuaidi100(json('kuaidi100-query.json'));
    assert.equal(r.company, '圆通速递');
    assert.equal(r.state, 3);
    assert.equal(r.stateText, '签收');
    assert.equal(r.signed, true);
    assert.equal(r.traces.length, 4);
    assert.equal(r.traces[1].location, '上海市浦东新区');
    assert.equal(r.traces[0].location, '上海,上海市,浦东新区');
    assert.throws(() => parseKuaidi100(json('kuaidi100-error.json')), { status: 404, message: '快递100：找不到对应公司' });
    assert.deepEqual(parseAutoNumber(json('kuaidi100-auto.json')), ['yuantong', 'ems']);
    assert.ok(COMPANIES.some((c) => c.code === 'jtexpress'));
  });
  test('未配置 Key 返回 503，顺丰缺手机号 400', async () => {
    delete process.env.KUAIDI100_KEY;
    await assert.rejects(call('/api/express', 'number=YT7530122849021&com=yuantong'), { status: 503 });
    process.env.KUAIDI100_KEY = 'K';
    process.env.KUAIDI100_CUSTOMER = 'C';
    try {
      await assert.rejects(call('/api/express', 'number=SF1234567890&com=shunfeng'), { status: 400 });
      const calls = mockFetch({ 'poll.kuaidi100.com': json('kuaidi100-query.json') });
      const r = await call('/api/express', 'number=YT7530122849021&com=yuantong');
      assert.equal(r.data.number, 'YT7530122849021');
      assert.equal(calls[0].opts.method, 'POST');
      assert.equal(calls[0].opts.headers['content-type'], 'application/x-www-form-urlencoded');
    } finally {
      delete process.env.KUAIDI100_KEY;
      delete process.env.KUAIDI100_CUSTOMER;
    }
    await assert.rejects(call('/api/express', 'number=<script>'), { status: 400 });
  });
});

describe('IP', () => {
  test('规整与私有地址判断', () => {
    assert.equal(normalizeIp('::ffff:1.2.3.4'), '1.2.3.4');
    assert.equal(normalizeIp('[2001:4860::8888]'), '2001:4860::8888');
    for (const ip of ['10.0.0.1', '172.20.1.1', '192.168.1.1', '127.0.0.1', '100.64.0.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      assert.equal(isPrivateIp(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '114.114.114.114', '2001:4860:4860::8888']) assert.equal(isPrivateIp(ip), false, ip);
  });
  test('解析 ip-api', () => {
    const r = parseIpApi(json('ipapi-success.json'));
    assert.equal(r.location, '中国 广东 深圳');
    assert.equal(r.isp, 'Chinanet');
    assert.throws(() => parseIpApi(json('ipapi-fail.json')), { status: 400 });
  });
  test('handler：默认取调用者 IP，拒绝内网与非法 IP', async () => {
    await assert.rejects(call('/api/ip', '', { ip: '::ffff:192.168.0.2' }), { status: 400, message: /内网/ });
    await assert.rejects(call('/api/ip', 'ip=1.2.3'), { status: 400 });
    const calls = mockFetch({ 'ip-api.com': json('ipapi-success.json') });
    // 国内 IPv4 由本地 ip2region 命中，不请求 ip-api
    const r = await call('/api/ip', '', { ip: '::ffff:113.88.1.1' });
    assert.equal(r.data.city, '深圳');
    assert.equal(r.data.source, 'ip2region');
    assert.equal(calls.length, 0);
    // IPv6 仍走 ip-api
    const v6 = await call('/api/ip', 'ip=2408:8000::1');
    assert.equal(v6.data.source, 'ip-api');
    assert.ok(calls[0].url.startsWith('http://ip-api.com/json/2408%3A8000%3A%3A1?lang=zh-CN'));
  });
});

describe('手机号', () => {
  test('解析 360 与号段运营商', () => {
    const r = parse360(json('phone-360.json'), '13800138000');
    assert.equal(r.carrier, '中国移动');
    assert.equal(r.location, '广东 深圳');
    const m = parse360(json('phone-360-municipality.json'), '13012345678');
    assert.equal(m.city, '北京');
    assert.equal(m.location, '北京');
    assert.equal(carrierBySegment('19912345678'), '中国电信');
    assert.equal(carrierBySegment('19212345678'), '中国广电');
    assert.throws(() => parse360({ code: 1 }, '13800138000'), { status: 502 });
  });
  test('号码校验，支持 +86 前缀', async () => {
    await assert.rejects(call('/api/phone', 'number=12345'), { status: 400 });
    await assert.rejects(call('/api/phone', 'number=12800138000'), { status: 400 });
    mockFetch({ 'cx.shouji.360.cn': json('phone-360.json') });
    const r = await call('/api/phone', 'number=%2B8613800138001');
    assert.equal(r.data.number, '13800138001');
  });
});

describe('历史上的今天', () => {
  test('解析百度百科并去除 HTML', () => {
    const list = parseBaiduHistory(json('baidu-history-09.json'), '09', '24');
    assert.equal(list.length, 3);
    assert.deepEqual(list.map((x) => x.year), ['1896', '1949', '1991']);
    assert.equal(list[1].title, '中国人民政治协商会议第一届全体会议继续举行');
    assert.equal(list[1].desc, '1949年9月24日，政协会议 继续举行大会发言。');
    assert.equal(list[0].typeText, '出生');
    assert.ok(list[1].link.startsWith('https://'));
    assert.throws(() => parseBaiduHistory({}, '09', '24'), { status: 502 });
  });
  test('日期校验', async () => {
    await assert.rejects(call('/api/history/today', 'date=02-30'), { status: 400 });
    await assert.rejects(call('/api/history/today', 'date=13-01'), { status: 400 });
    mockFetch({ 'eventsOnHistory/09.json': json('baidu-history-09.json') });
    const r = await call('/api/history/today', 'date=09-25');
    assert.equal(r.data.events[0].title, '鲁迅诞辰');
  });
});

describe('60 秒读懂世界', () => {
  test('解析 60s API', () => {
    const r = parseViki60s(json('viki-60s.json'));
    assert.equal(r.date, '2026-09-24');
    assert.equal(r.news.length, 3);
    assert.equal(r.news[0], '国务院常务会议部署进一步扩大内需举措');
    assert.equal(r.tip, '人生没有白走的路，每一步都算数。');
  });
  test('解析知乎专栏备用源', () => {
    const r = parseZhihu60s(json('zhihu-60s.json'));
    assert.equal(r.news.length, 3);
    assert.equal(r.news[2], '中秋国庆假期临近，多地文旅部门发布出行提示&提醒');
    assert.equal(r.tip, '人生没有白走的路，每一步都算数。');
    assert.equal(r.date, '2026-09-24');
  });
  test('主源失败时回退知乎', async () => {
    mockFetch({ '60s.viki.moe': 404, 'zhihu.com': json('zhihu-60s.json') });
    const r = await call('/api/news/60s');
    assert.equal(r.data.source, 'zhihu.com');
  });
});

describe('油价', () => {
  test('解析页面', () => {
    const r = parseOilPage(fx('qiyoujiage-beijing.html'), '北京');
    assert.deepEqual(r.prices, { p92: 7.39, p95: 7.87, p98: 9.37, p0: 7.07 });
    assert.equal(r.nextAdjust, '9月29日24时');
    assert.match(r.trend, /上调/);
    assert.throws(() => parseOilPage('<html></html>', '北京'), { status: 502 });
  });
  test('省份规整', async () => {
    assert.equal(normalizeProvince('广西壮族自治区'), '广西');
    assert.equal(normalizeProvince('北京市'), '北京');
    assert.equal(normalizeProvince('火星'), null);
    await assert.rejects(call('/api/oil', 'province=火星'), { status: 400 });
  });
});

describe('返回字段说明', () => {
  // 样例数据里的字段都要有说明；反过来，说明里的每个字段也至少在一份样例里出现，确保样例覆盖了可选字段
  function assertFieldsCovered(path, samples) {
    const r = route(path);
    for (const data of samples) assertFieldsDocumented(r, data);
    const seen = new Set(samples.flatMap((d) => [...collectPaths(d)]));
    const unseen = r.fields.map((f) => f.name).filter((name) => ![...seen].some((p) => matcher(name).test(p)));
    assert.deepEqual(unseen, [], `${path} 的样例没有覆盖这些字段：${unseen.join(', ')}`);
  }

  test('/api/weather：Open-Meteo 与和风天气，按城市与按经纬度', async () => {
    const samples = [];
    delete process.env.QWEATHER_KEY;
    mockFetch({ 'geocoding-api.open-meteo.com': json('openmeteo-geo.json'), 'api.open-meteo.com/v1/forecast': json('openmeteo-forecast.json') });
    const om = (await call('/api/weather', 'city=字段说明城市OM')).data;
    assert.equal(om.provider, 'open-meteo');
    samples.push(om, (await call('/api/weather', 'lat=31.23&lon=121.47')).data);

    process.env.QWEATHER_KEY = 'k-fields';
    try {
      mockFetch({ '/geo/v2/city/lookup': json('qweather-geo.json'), '/v7/weather/now': json('qweather-now.json'), '/v7/weather/7d': json('qweather-7d.json') });
      const qw = (await call('/api/weather', 'city=字段说明城市QW')).data;
      assert.equal(qw.provider, 'qweather');
      assert.equal(qw.location.id, '101010100');
      const qwCoord = (await call('/api/weather', 'lat=22.54&lon=114.06')).data;
      assert.equal(qwCoord.provider, 'qweather');
      assert.equal(qwCoord.location.timezone, null);
      samples.push(qw, qwCoord);
    } finally {
      delete process.env.QWEATHER_KEY;
    }
    assertFieldsCovered('/api/weather', samples);
  });

  test('/api/holiday、/api/holiday/next、/api/holiday/year', async () => {
    mockFetch({ '2026.json': json('holiday-cn-2026.json'), '2027.json': 404 });
    const days = await Promise.all(['2026-10-01', '2026-10-10', '2026-09-26', '2026-09-24'].map((d) => call('/api/holiday', `date=${d}`)));
    assert.deepEqual(days.map((r) => r.data.type), ['holiday', 'workday', 'holiday', 'normal']);
    assertFieldsCovered('/api/holiday', days.map((r) => r.data));

    const next = (await call('/api/holiday/next', 'date=2026-02-16')).data;
    assert.equal(next.current.name, '春节');
    assert.equal(next.next.name, '清明节');
    assertFieldsCovered('/api/holiday/next', [next, (await call('/api/holiday/next', 'date=2026-10-08')).data]);

    const year = (await call('/api/holiday/year', 'year=2026')).data;
    assert.equal(year.source, 'holiday-cn');
    assert.ok(year.papers.length && year.periods.length);
    assertFieldsCovered('/api/holiday/year', [year]);
  });

  test('/api/lunar', async () => {
    const samples = await Promise.all(['2026-09-23', '2026-09-25', '2023-03-22'].map((d) => call('/api/lunar', `date=${d}`)));
    assert.equal(samples[0].data.solarTerm.today, '秋分');
    assertFieldsCovered('/api/lunar', samples.map((r) => r.data));
  });

  test('/api/oil', async () => {
    mockFetch({ 'qiyoujiage.com/beijing': fx('qiyoujiage-beijing.html') });
    const r = await call('/api/oil', 'province=北京市');
    assert.equal(r.data.prices.p92, 7.39);
    assertFieldsCovered('/api/oil', [r.data]);
  });

  test('/api/express、/api/express/companies', async () => {
    process.env.KUAIDI100_KEY = 'K';
    process.env.KUAIDI100_CUSTOMER = 'C';
    try {
      mockFetch({ 'autonumber/auto': json('kuaidi100-auto.json'), 'poll.kuaidi100.com': json('kuaidi100-query.json') });
      const r = await call('/api/express', 'number=YT7530122849021');
      assert.equal(r.data.com, 'yuantong');
      assertFieldsCovered('/api/express', [r.data]);
    } finally {
      delete process.env.KUAIDI100_KEY;
      delete process.env.KUAIDI100_CUSTOMER;
    }
    const companies = (await call('/api/express/companies')).data;
    assert.equal(companies.find((c) => c.code === 'shunfeng').needPhone, true);
    assertFieldsCovered('/api/express/companies', [companies]);
  });

  test('/api/ip', async () => {
    mockFetch({ 'ip-api.com': json('ipapi-success.json') });
    const r = await call('/api/ip', 'ip=113.88.1.2');
    assert.equal(r.data.location, '中国 广东 深圳');
    const v6 = await call('/api/ip', 'ip=2408:8000::2');
    assertFieldsCovered('/api/ip', [r.data, v6.data]);
  });

  test('/api/phone', async () => {
    mockFetch({ 'number=140': json('phone-360-municipality.json') });
    const a = (await call('/api/phone', 'number=13800138000')).data; // 本地号段库
    const b = (await call('/api/phone', 'number=14000000000')).data; // 本地没有，回落 360
    assert.equal(a.source, 'phonedata');
    assert.equal(b.source, '360');
    assert.equal(b.location, '北京');
    assertFieldsCovered('/api/phone', [a, b]);
  });

  test('/api/history/today', async () => {
    mockFetch({ 'eventsOnHistory/09.json': json('baidu-history-09.json') });
    const r = await call('/api/history/today', 'date=09-24');
    assert.equal(r.data.events.length, 3);
    assertFieldsCovered('/api/history/today', [r.data]);
  });

  test('/api/news/60s：主源与知乎备用源', async () => {
    mockFetch({ '60s.viki.moe': json('viki-60s.json') });
    const viki = (await call('/api/news/60s', 'date=2026-09-24')).data;
    assert.equal(viki.source, '60s.viki.moe');
    mockFetch({ '60s.viki.moe': 404, 'zhihu.com': json('zhihu-60s.json') });
    const zhihu = (await call('/api/news/60s')).data;
    assert.equal(zhihu.source, 'zhihu.com');
    assertFieldsCovered('/api/news/60s', [viki, zhihu]);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import jieqi, { yearTerms, nextTerm } from '../../src/apis/life/jieqi.js';
import sun, { computeSun, moonPhase, moonPhaseTime, moonIllumination } from '../../src/apis/life/sun.js';
import worldtime, { resolveZone, resolveZones, worldTime, convertTime, parseWallTime } from '../../src/apis/life/worldtime.js';
import progress, { timeProgress, parseProgressDate, progressBar, isoWeek } from '../../src/apis/life/progress.js';
import { zonedToUtc, zoneOffset, isDST, normalizeZone } from '../../src/apis/life/tz-util.js';
import { assertFieldsDocumented } from '../helpers/fields.js';

const MODULES = [jieqi, sun, worldtime, progress];
const route = (path) => MODULES.flatMap((m) => m.routes).find((r) => r.path === path);
const call = (path, qs = '') => route(path).handler({ query: new URLSearchParams(qs), params: {}, ip: '127.0.0.1' });
// 用参数示例调用（与自动巡检一致）
const exampleQs = (r) => new URLSearchParams(r.params.filter((p) => p.example != null).map((p) => [p.name, p.example])).toString();
const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const near = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg}：${actual} 与 ${expected} 相差超过 ${tol}`);

describe('模块元数据', () => {
  test('名称、分类与参数示例', () => {
    assert.deepEqual(MODULES.map((m) => m.name), ['jieqi', 'sun', 'worldtime', 'progress']);
    for (const m of MODULES) {
      assert.equal(m.category, 'life');
      assert.ok(m.title && m.description && m.source);
      for (const r of m.routes) {
        assert.ok(r.path.startsWith('/api/'));
        for (const p of r.params) {
          if (p.required) assert.ok(p.example != null, `${r.path} 必填参数 ${p.name} 缺少 example`);
        }
      }
    }
  });

  test('用参数示例调用每个路由都成功，且字段都有说明', async () => {
    for (const m of MODULES) {
      for (const r of m.routes) {
        const { data } = await r.handler({ query: new URLSearchParams(exampleQs(r)), params: {} });
        assertFieldsDocumented(r, data);
      }
    }
  });

  test('不传可选参数时也能返回，且字段都有说明', async () => {
    for (const path of ['/api/jieqi', '/api/jieqi/next', '/api/moon', '/api/time/world', '/api/progress']) {
      assertFieldsDocumented(route(path), (await call(path)).data);
    }
    assertFieldsDocumented(route('/api/sun'), (await call('/api/sun', 'lat=31.23&lon=121.47')).data);
    assertFieldsDocumented(route('/api/time/convert'), (await call('/api/time/convert', 'time=09:00')).data);
  });
});

describe('二十四节气', () => {
  test('2026 年节气日期与时刻', () => {
    const { year, count, terms } = yearTerms(2026);
    assert.equal(year, 2026);
    assert.equal(count, 24);
    assert.equal(terms[0].name, '小寒');
    assert.equal(terms[23].name, '冬至');
    const by = Object.fromEntries(terms.map((t) => [t.name, t]));
    assert.equal(by['立春'].date, '2026-02-04');
    assert.equal(by['清明'].date, '2026-04-05');
    assert.equal(by['夏至'].date, '2026-06-21');
    assert.equal(by['秋分'].time, '2026-09-23 08:05');
    assert.equal(by['冬至'].date, '2026-12-22');
    assert.equal(by['春分'].longitude, 0);
    assert.equal(by['立春'].season, '春');
    // 日期递增
    for (let i = 1; i < 24; i++) assert.ok(terms[i].time > terms[i - 1].time);
  });

  test('2024 年夏至交节时刻（约 04:51）', () => {
    const t = yearTerms(2024).terms.find((x) => x.name === '夏至');
    assert.equal(t.date, '2024-06-21');
    near(hm(t.time.slice(11)), hm('04:51'), 2, '夏至时刻');
  });

  test('当前节气与下一个节气', () => {
    const r = nextTerm('2026-09-27');
    assert.equal(r.today, null);
    assert.equal(r.current.name, '秋分');
    assert.equal(r.current.daysSince, 4);
    assert.equal(r.next.name, '寒露');
    assert.equal(r.next.date, '2026-10-08');
    assert.equal(r.next.days, 11);
    assert.match(r.text, /寒露还有 11 天/);
    const d = nextTerm('2026-09-23');
    assert.equal(d.today, '秋分');
    assert.match(d.text, /^今天是秋分/);
    // 跨年：冬至之后下一个是次年小寒
    const e = nextTerm('2026-12-30');
    assert.equal(e.current.name, '冬至');
    assert.equal(e.next.name, '小寒');
    assert.equal(e.next.date.slice(0, 4), '2027');
  });

  test('参数校验', async () => {
    await assert.rejects(call('/api/jieqi', 'year=1800'), { status: 400 });
    await assert.rejects(call('/api/jieqi', 'year=abc'), { status: 400 });
    await assert.rejects(call('/api/jieqi/next', 'date=2026-02-30'), { status: 400 });
    await assert.rejects(call('/api/jieqi/next', 'date=昨天'), { status: 400 });
  });
});

describe('日出日落', () => {
  test('北京 2024-06-21（夏至）', () => {
    const s = computeSun({ lat: 39.9042, lon: 116.4074, date: '2024-06-21', tz: 'Asia/Shanghai' });
    assert.equal(s.status, 'normal');
    near(hm(s.sunrise), hm('04:46'), 2, '日出');
    near(hm(s.sunset), hm('19:47'), 2, '日落');
    near(hm(s.solarNoon), hm('12:16'), 2, '正午');
    near(s.dayLengthMinutes, 15 * 60, 5, '白昼时长');
    assert.ok(hm(s.civilDawn) < hm(s.sunrise) && hm(s.civilDusk) > hm(s.sunset));
    assert.equal(s.utcOffset, '+08:00');
    assert.match(s.iso.sunrise, /^2024-06-21T04:4\d:\d{2}\+08:00$/);
    near(s.noonAltitude, 73.5, 0.3, '正午太阳高度');
  });

  test('纽约 2024-03-20（夏令时）与悉尼', () => {
    const s = computeSun({ lat: 40.7128, lon: -74.006, date: '2024-03-20', tz: 'America/New_York' });
    assert.equal(s.utcOffset, '-04:00');
    near(hm(s.sunrise), hm('06:59'), 3, '纽约日出');
    near(hm(s.sunset), hm('19:09'), 3, '纽约日落');
    const syd = computeSun({ lat: -33.8688, lon: 151.2093, date: '2024-12-21', tz: 'Australia/Sydney' });
    near(hm(syd.sunrise), hm('05:41'), 3, '悉尼日出');
    near(hm(syd.sunset), hm('20:05'), 3, '悉尼日落');
  });

  test('极昼与极夜', () => {
    const day = computeSun({ lat: 78.22, lon: 15.65, date: '2024-06-21', tz: 'Arctic/Longyearbyen' });
    assert.equal(day.status, 'polar_day');
    assert.equal(day.sunrise, null);
    assert.equal(day.sunset, null);
    assert.equal(day.dayLengthMinutes, 1440);
    const night = computeSun({ lat: 78.22, lon: 15.65, date: '2024-12-21', tz: 'Arctic/Longyearbyen' });
    assert.equal(night.status, 'polar_night');
    assert.equal(night.dayLengthMinutes, 0);
    assert.equal(night.iso.sunset, null);
  });

  test('参数校验', async () => {
    await assert.rejects(call('/api/sun', 'lon=121.47'), { status: 400 });
    await assert.rejects(call('/api/sun', 'lat=31.23'), { status: 400 });
    await assert.rejects(call('/api/sun', 'lat=91&lon=10'), { status: 400 });
    await assert.rejects(call('/api/sun', 'lat=abc&lon=10'), { status: 400 });
    await assert.rejects(call('/api/sun', 'lat=31&lon=121&tz=Mars/Base'), { status: 400 });
    await assert.rejects(call('/api/sun', 'lat=31&lon=121&date=2024-13-01'), { status: 400 });
    await assert.rejects(call('/api/sun', 'lat=31&lon=121&date=1800-01-01'), { status: 400 });
    await assert.rejects(call('/api/moon', 'tz=abc'), { status: 400 });
  });

  test('接口按所选时区返回', async () => {
    const { data } = await call('/api/sun', 'lat=51.5074&lon=-0.1278&date=2026-06-21&tz=Europe/London');
    assert.equal(data.date, '2026-06-21');
    assert.equal(data.utcOffset, '+01:00');
    near(hm(data.sunrise), hm('04:43'), 3, '伦敦日出');
    assert.equal(typeof data.moon.phase, 'string');
  });
});

describe('月相', () => {
  const utc = (ms) => new Date(ms).toISOString();
  test('朔望时刻（Meeus 算法）', () => {
    // 2000-01-06 18:14 UTC 新月；2024-09-18 02:34 UTC 满月
    near(moonPhaseTime(0), Date.UTC(2000, 0, 6, 18, 14), 3 * 60_000, `新月 ${utc(moonPhaseTime(0))}`);
    const k = Math.round((Date.UTC(2024, 8, 18) - Date.UTC(2000, 0, 6)) / (29.530588861 * 86_400_000) - 0.5) + 0.5;
    near(moonPhaseTime(k), Date.UTC(2024, 8, 18, 2, 34), 3 * 60_000, `满月 ${utc(moonPhaseTime(k))}`);
  });

  test('2024-09-18 北京为满月', () => {
    const r = moonPhase(Date.UTC(2024, 8, 18, 4), 'Asia/Shanghai');
    assert.equal(r.phase, '满月');
    assert.equal(r.phaseKey, 'full');
    assert.ok(r.illumination > 99);
    near(r.age, 14.9, 0.5, '月龄');
    assert.equal(r.nextNewMoon.date, '2024-10-03');
    assert.equal(r.nextFullMoon.date, '2024-10-17');
    assert.equal(r.lastNewMoon.date, '2024-09-03');
  });

  test('新月、上弦、蛾眉、残月', () => {
    // 2024-01-11 11:57 UTC 新月
    assert.equal(moonPhase(Date.UTC(2024, 0, 11, 4), 'Asia/Shanghai').phase, '新月');
    // 2024-01-18 03:53 UTC 上弦
    assert.equal(moonPhase(Date.UTC(2024, 0, 18, 4), 'Asia/Shanghai').phase, '上弦月');
    const crescent = moonPhase(Date.UTC(2024, 0, 14, 4), 'Asia/Shanghai');
    assert.equal(crescent.phase, '蛾眉月');
    assert.equal(crescent.waxing, true);
    assert.ok(crescent.illumination > 5 && crescent.illumination < 40);
    const waning = moonPhase(Date.UTC(2024, 0, 8, 4), 'Asia/Shanghai');
    assert.equal(waning.phase, '残月');
    assert.equal(waning.waxing, false);
    assert.equal(moonPhase(Date.UTC(2024, 0, 22, 4), 'Asia/Shanghai').phase, '盈凸月');
  });

  test('照亮比例', () => {
    assert.ok(moonIllumination(Date.UTC(2024, 0, 11, 12)).fraction < 0.01);
    assert.ok(moonIllumination(Date.UTC(2024, 8, 18, 3)).fraction > 0.99);
  });

  test('/api/moon 指定日期', async () => {
    const { data } = await call('/api/moon', 'date=2024-09-18');
    assert.equal(data.date, '2024-09-18');
    assert.equal(data.phase, '满月');
    assert.equal(data.tz, 'Asia/Shanghai');
  });
});

describe('世界时间', () => {
  test('时区解析：IANA、中文城市、UTC±N', () => {
    assert.equal(resolveZone('东京'), 'Asia/Tokyo');
    assert.equal(resolveZone('北京'), 'Asia/Shanghai');
    assert.equal(resolveZone('asia/tokyo'), 'Asia/Tokyo');
    assert.equal(resolveZone('Asia/Kolkata'), 'Asia/Kolkata');
    assert.equal(resolveZone('UTC+8'), 'Etc/GMT-8');
    assert.equal(normalizeZone('Nope/Zone'), null);
    assert.deepEqual(resolveZones('北京，上海,Asia/Shanghai 纽约'), ['Asia/Shanghai', 'America/New_York']);
    assert.throws(() => resolveZone('火星'), { status: 400 });
  });

  test('当前时间与偏移', () => {
    const now = Date.UTC(2026, 6, 1, 12, 0, 0);
    const r = worldTime(['Asia/Shanghai', 'America/New_York', 'Asia/Kathmandu', 'Australia/Sydney'], now);
    assert.equal(r.utc, '2026-07-01T12:00:00Z');
    assert.equal(r.timestamp, now / 1000);
    const [sh, ny, ktm, syd] = r.zones;
    assert.equal(sh.datetime, '2026-07-01 20:00:00');
    assert.equal(sh.city, '北京');
    assert.equal(sh.weekday, '星期三');
    assert.equal(sh.offset, '+08:00');
    assert.equal(sh.isDST, false);
    assert.equal(ny.offset, '-04:00');
    assert.equal(ny.isDST, true);
    assert.equal(ny.time, '08:00');
    assert.equal(ktm.offset, '+05:45');
    assert.equal(syd.isDST, false); // 南半球 7 月是冬天
    assert.equal(worldTime(['Australia/Sydney'], Date.UTC(2026, 0, 1)).zones[0].isDST, true);
  });

  test('时区换算与夏令时', () => {
    const r = convertTime('2026-10-01 09:00', 'Asia/Shanghai', ['America/New_York', 'Europe/London', 'Asia/Tokyo']);
    assert.equal(r.utc, '2026-10-01T01:00:00Z');
    const [ny, ldn, tyo] = r.results;
    assert.equal(ny.datetime, '2026-09-30 21:00:00');
    assert.equal(ny.dayDiff, -1);
    assert.equal(ny.diffHours, -12);
    assert.match(ny.text, /纽约 2026-09-30 21:00 星期三（前一天）/);
    assert.equal(ldn.time, '02:00');
    assert.equal(tyo.time, '10:00');
    assert.equal(tyo.diffHours, 1);
    // 冬令时：纽约与北京差 13 小时
    assert.equal(convertTime('2026-12-01 09:00', 'Asia/Shanghai', ['America/New_York']).results[0].time, '20:00');
    // 纽约夏令时开始（2026-03-08 02:00 拨到 03:00）
    assert.throws(() => convertTime('2026-03-08 02:30', 'America/New_York', ['UTC']), { status: 400 });
    assert.equal(convertTime('2026-03-08 03:30', 'America/New_York', ['UTC']).utc, '2026-03-08T07:30:00Z');
    // 夏令时结束（2026-11-01 01:30 出现两次，取第一次 EDT）
    const amb = convertTime('2026-11-01 01:30', 'America/New_York', ['UTC']);
    assert.equal(amb.from.ambiguous, true);
    assert.equal(amb.utc, '2026-11-01T05:30:00Z');
    assert.equal(convertTime('2026-11-01 03:00', 'America/New_York', ['UTC']).utc, '2026-11-01T08:00:00Z');
  });

  test('墙上时间与 UTC 互转', () => {
    assert.deepEqual(zonedToUtc({ year: 2026, month: 7, day: 1, hour: 20 }, 'Asia/Shanghai'), { ms: Date.UTC(2026, 6, 1, 12), ambiguous: false });
    assert.equal(zoneOffset(Date.UTC(2026, 6, 1), 'Europe/London'), 60);
    assert.equal(isDST(Date.UTC(2026, 0, 1), 'Europe/London'), false);
    const w = parseWallTime('08:15', 'Asia/Tokyo', Date.UTC(2026, 0, 1, 20));
    assert.deepEqual([w.year, w.month, w.day, w.hour, w.minute], [2026, 1, 2, 8, 15]);
  });

  test('参数校验', async () => {
    await assert.rejects(call('/api/time/world', 'zones=Mars/Base'), { status: 400 });
    await assert.rejects(call('/api/time/world', `zones=${Array.from({ length: 21 }, () => 'UTC').join(',')}`), { status: 400, message: /最多 20/ });
    await assert.rejects(call('/api/time/convert', ''), { status: 400 });
    await assert.rejects(call('/api/time/convert', 'time=明天早上'), { status: 400 });
    await assert.rejects(call('/api/time/convert', 'time=2026-02-30 09:00'), { status: 400 });
    await assert.rejects(call('/api/time/convert', 'time=2026-10-01 25:00'), { status: 400 });
    await assert.rejects(call('/api/time/convert', 'time=2026-10-01 09:00&from=abc'), { status: 400 });
  });

  test('接口默认目标时区不含源时区', async () => {
    const { data } = await call('/api/time/convert', 'time=2026-10-01 09:00&from=东京');
    assert.equal(data.from.zone, 'Asia/Tokyo');
    assert.ok(!data.results.some((r) => r.zone === 'Asia/Tokyo'));
    assert.equal(data.results.length, 4);
  });
});

describe('时间进度', () => {
  test('按日期（当天结束）计算', () => {
    const { at, endOfDay } = parseProgressDate('2026-09-29');
    const r = timeProgress(at, 10, endOfDay);
    assert.equal(r.now, '2026-09-29 24:00');
    assert.equal(r.weekday, '星期二');
    assert.equal(r.weekNumber, 40);
    assert.equal(r.year.percent, 74.52);
    assert.equal(r.year.elapsed, 272);
    assert.equal(r.year.remaining, 93);
    assert.equal(r.year.text, '2026 年已过去 74.52%，还剩 93 天');
    assert.equal(r.year.bar, '▓▓▓▓▓▓▓░░░');
    assert.equal(r.quarter.name, '第三季度');
    assert.equal(r.quarter.total, 92);
    assert.equal(r.quarter.end, '2026-09-30');
    assert.equal(r.month.total, 30);
    assert.equal(r.month.remaining, 1);
    assert.equal(r.week.start, '2026-09-28');
    assert.equal(r.week.end, '2026-10-04');
    assert.equal(r.week.elapsed, 2);
    assert.equal(r.week.percent, 28.57);
    assert.equal(r.day.percent, 100);
    assert.match(r.text, /^2026 年已过去 74\.52%，还剩 93 天\n年/);
    assert.equal(r.text.split('\n').length, 6);
  });

  test('按具体时刻计算', () => {
    const { at } = parseProgressDate('2024-02-29 12:00');
    const r = timeProgress(at);
    assert.equal(r.year.total, 366); // 闰年
    assert.equal(r.month.total, 29);
    assert.equal(r.day.percent, 50);
    assert.equal(r.day.elapsed, 12);
    assert.equal(r.day.remaining, 12);
    assert.equal(r.day.unit, '小时');
    assert.equal(r.week.elapsed, 3); // 周四中午：周一至周三已过完
    assert.equal(r.week.remaining, 3);
    assert.equal(r.quarter.name, '第一季度');
    assert.equal(r.year.bar.length, 20);
    // 1 月 1 日 00:00 进度为 0
    const z = timeProgress(parseProgressDate('2026-01-01 00:00').at);
    assert.equal(z.year.percent, 0);
    assert.equal(z.year.remaining, 365);
    assert.equal(z.year.bar, '░'.repeat(20));
  });

  test('进度条与 ISO 周', () => {
    assert.equal(progressBar(0, 5), '░░░░░');
    assert.equal(progressBar(100, 5), '▓▓▓▓▓');
    assert.equal(progressBar(50, 10), '▓▓▓▓▓░░░░░');
    assert.deepEqual(isoWeek(Date.UTC(2027, 0, 1)), { year: 2026, week: 53 });
    assert.deepEqual(isoWeek(Date.UTC(2026, 0, 1)), { year: 2026, week: 1 });
  });

  test('参数校验', async () => {
    await assert.rejects(call('/api/progress', 'date=2026-13-01'), { status: 400 });
    await assert.rejects(call('/api/progress', 'date=abc'), { status: 400 });
    await assert.rejects(call('/api/progress', 'date=2026-01-01 24:30'), { status: 400 });
    await assert.rejects(call('/api/progress', 'width=3'), { status: 400 });
    await assert.rejects(call('/api/progress', 'width=abc'), { status: 400 });
    const { data } = await call('/api/progress', 'date=2026-09-29&width=10');
    assert.equal(data.year.text, '2026 年已过去 74.52%，还剩 93 天');
  });
});

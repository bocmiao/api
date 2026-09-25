// life 分类纯计算接口：个税、身份证校验、经纬度距离、单位换算、年龄、工作日、健康指标、数独
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import lifeModules from '../../src/apis/life/index.js';
import { taxBy, monthlyWithholding, annualTax, bonusTax, ANNUAL_BRACKETS, MONTHLY_BRACKETS } from '../../src/apis/life/tax.js';
import { checkIdCard, checkDigitOf, PROVINCES, ageOn } from '../../src/apis/life/idcard.js';
import { geoDistance, EARTH_RADIUS_M } from '../../src/apis/life/geo.js';
import { convertUnit, findUnit, listUnits } from '../../src/apis/life/unit.js';
import { ageInfo, constellationOf } from '../../src/apis/life/age.js';
import { countWorkdays, addWorkdays, makeYearLoader } from '../../src/apis/life/workdays.js';
import { healthCalc, mifflin, navyBodyFat } from '../../src/apis/life/health.js';
import { solve, parsePuzzle, generate, LEVELS } from '../../src/apis/life/sudoku.js';
import { calcBMI } from '../../src/apis/life/bmi.js';
import { solarToLunar, parseDate } from '../../src/apis/life/lunar.js';
import { assertFieldsDocumented, collectPaths, matcher } from '../helpers/fields.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/life/${name}`, import.meta.url), 'utf8'));

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    for (const [frag, body] of Object.entries(routes)) {
      if (String(url).includes(frag)) {
        if (body instanceof Error) throw body;
        if (typeof body === 'number') return new Response('x', { status: body });
        return new Response(JSON.stringify(body), { status: 200 });
      }
    }
    return new Response('no mock', { status: 500 });
  };
  return calls;
}

const route = (path) => lifeModules.flatMap((m) => m.routes).find((r) => r.path === path);
const call = (path, qs = '') => route(path).handler({ query: new URLSearchParams(qs), params: {} });
const data = async (path, qs) => (await call(path, qs)).data;

// 样例里的字段都要有说明；说明里的每个字段也至少在一份样例里出现
function assertFieldsCovered(path, samples) {
  const r = route(path);
  for (const d of samples) assertFieldsDocumented(r, d);
  const seen = new Set(samples.flatMap((d) => [...collectPaths(d)]));
  const unseen = r.fields.map((f) => f.name).filter((name) => ![...seen].some((p) => matcher(name).test(p)));
  assert.deepEqual(unseen, [], `${path} 的样例没有覆盖这些字段：${unseen.join(', ')}`);
}

const NEW_PATHS = ['/api/tax/income', '/api/idcard/check', '/api/geo/distance', '/api/unit', '/api/unit/list', '/api/age', '/api/workdays', '/api/health/calc', '/api/sudoku'];

describe('注册', () => {
  test('新路由已注册在 life，且都有 params 说明与示例', () => {
    for (const p of NEW_PATHS) {
      const r = route(p);
      assert.ok(r, p);
      for (const x of r.params) {
        assert.ok(x.desc, `${p} ${x.name} desc`);
        assert.ok(x.example != null, `${p} ${x.name} example`);
      }
    }
    const names = lifeModules.map((m) => m.name);
    assert.equal(new Set(names).size, names.length, 'life 模块名不重复');
    const paths = lifeModules.flatMap((m) => m.routes.map((r) => r.path));
    assert.equal(new Set(paths).size, paths.length, 'life 路由不重复');
  });
});

describe('个人所得税', () => {
  test('年度税率表：七级、边界值与速算扣除数连续', () => {
    assert.equal(ANNUAL_BRACKETS.length, 7);
    assert.deepEqual(ANNUAL_BRACKETS.map((b) => b[1]), [3, 10, 20, 25, 30, 35, 45]);
    assert.deepEqual(MONTHLY_BRACKETS.map((b) => b[1]), [3, 10, 20, 25, 30, 35, 45]);
    // 在每个分界点，两档算出的税额相同，说明速算扣除数正确
    for (const table of [ANNUAL_BRACKETS, MONTHLY_BRACKETS]) {
      for (let i = 0; i < table.length - 1; i++) {
        const [limit, rate, quick] = table[i];
        const [, nextRate, nextQuick] = table[i + 1];
        assert.equal(limit * rate / 100 - quick, limit * nextRate / 100 - nextQuick, `分界 ${limit}`);
      }
    }
    // 年度表每档边界：[应纳税所得额, 税率, 税额]
    const cases = [
      [0, 3, 0], [1, 3, 0.03], [36000, 3, 1080], [36000.01, 10, 1080], [36001, 10, 1080.1],
      [144000, 10, 11880], [144001, 20, 11880.2], [300000, 20, 43080], [300001, 25, 43080.25],
      [420000, 25, 73080], [420001, 30, 73080.3], [660000, 30, 145080], [660001, 35, 145080.35],
      [960000, 35, 250080], [960001, 45, 250080.45], [1000000, 45, 268080],
    ];
    for (const [taxable, rate, tax] of cases) {
      const r = taxBy(ANNUAL_BRACKETS, taxable);
      assert.equal(r.rate, rate, `${taxable} 税率`);
      assert.equal(r.tax, tax, `${taxable} 税额`);
    }
    assert.equal(taxBy(ANNUAL_BRACKETS, 500000).quickDeduction, 52920);
  });

  test('月度累计预扣：月薪 1 万无扣除，第 8 个月跨档，全年 3480', () => {
    const r = monthlyWithholding({ income: 10000 });
    assert.deepEqual(r.months.map((m) => m.tax), [150, 150, 150, 150, 150, 150, 150, 430, 500, 500, 500, 500]);
    assert.deepEqual(r.months.map((m) => m.rate), [3, 3, 3, 3, 3, 3, 3, 10, 10, 10, 10, 10]);
    assert.equal(r.months[7].cumulativeTaxable, 40000);
    assert.equal(r.months[7].quickDeduction, 2520);
    assert.equal(r.months[11].cumulativeTax, 3480);
    assert.equal(r.total.tax, 3480);
    assert.equal(r.total.afterTax, 120000 - 3480);
    assert.equal(r.total.effectiveRate, 2.9);
    assert.equal(annualTax({ income: 120000 }).tax, 3480);
  });

  test('五险一金、专项附加扣除：全年预扣合计等于年度汇算', () => {
    const m = { income: 30000, insurance: 4500, special: 3000, other: 500 };
    const r = monthlyWithholding(m);
    const a = annualTax({ income: 360000, insurance: 54000, special: 36000, other: 6000 });
    assert.equal(a.taxable, 204000);
    assert.equal(a.rate, 20);
    assert.equal(a.tax, 204000 * 0.2 - 16920);
    assert.equal(r.total.tax, a.tax);
    assert.equal(r.months[0].tax, 510); // 17000 × 3%
    assert.equal(r.months[0].afterTax, 30000 - 4500 - 510);
    // 小数金额按分计算
    assert.equal(monthlyWithholding({ income: 8888.88, insurance: 888.88 }).months[0].tax, 90);
  });

  test('收入不超过起征点或扣除后为负：不交税', () => {
    assert.equal(monthlyWithholding({ income: 5000 }).total.tax, 0);
    assert.equal(monthlyWithholding({ income: 8000, insurance: 1000, special: 3000 }).total.tax, 0);
    assert.equal(annualTax({ income: 60000 }).tax, 0);
    assert.equal(annualTax({ income: 50000 }).taxable, 0);
  });

  test('年终奖单独计税：按月换算表，36000 与 36001 的临界', () => {
    assert.deepEqual(bonusTax(36000), { amount: 36000, monthlyAverage: 3000, rate: 3, quickDeduction: 0, tax: 1080, afterTax: 34920 });
    const b = bonusTax(36001);
    assert.equal(b.rate, 10);
    assert.equal(b.quickDeduction, 210);
    assert.equal(b.tax, 3390.1);
    assert.equal(bonusTax(144000).tax, 14190);
    assert.equal(bonusTax(144001).tax, 27390.2);
    assert.equal(bonusTax(960000).tax, 960000 * 0.35 - 7160);
    assert.equal(bonusTax(0).tax, 0);
  });

  test('接口参数校验与字段', async () => {
    await assert.rejects(call('/api/tax/income', ''), { status: 400 });
    await assert.rejects(call('/api/tax/income', 'income=-1'), { status: 400 });
    await assert.rejects(call('/api/tax/income', 'income=abc'), { status: 400 });
    await assert.rejects(call('/api/tax/income', 'income=100.123'), { status: 400 });
    await assert.rejects(call('/api/tax/income', 'income=1000&insurance=2000'), { status: 400 });
    await assert.rejects(call('/api/tax/income', 'income=1000&mode=year'), { status: 400 });
    await assert.rejects(call('/api/tax/income', 'income=1000&months=13'), { status: 400 });
    const monthly = await data('/api/tax/income', 'income=20000&insurance=3000&special=2000&bonus=36000');
    assert.equal(monthly.taxable, 10000);
    assert.equal(monthly.tax, 300);
    assert.equal(monthly.months.length, 12);
    assert.equal(monthly.brackets.length, 7);
    assert.equal(monthly.brackets[6].max, null);
    const three = await data('/api/tax/income', 'income=20000&months=3');
    assert.equal(three.months.length, 3);
    const annual = await data('/api/tax/income', 'mode=annual&income=240000&insurance=36000');
    assert.equal(annual.tax, 144000 * 0.1 - 2520);
    assert.equal(annual.bonus, null);
    assertFieldsCovered('/api/tax/income', [monthly, annual]);
  });
});

describe('身份证号校验', () => {
  const make = (first17) => first17 + checkDigitOf(first17);

  test('省级代码共 34 个', () => {
    assert.equal(Object.keys(PROVINCES).length, 34);
    assert.equal(PROVINCES[44], '广东省');
    assert.equal(PROVINCES[82], '澳门特别行政区');
  });

  test('GB 11643 标准示例号码合法（末位 X，小写也可以）', () => {
    const r = checkIdCard('11010519491231002X', '2026-09-25');
    assert.equal(r.valid, true);
    assert.equal(r.reason, null);
    assert.deepEqual(r.checks, { format: true, province: true, birthday: true, checkDigit: true });
    assert.equal(r.province, '北京市');
    assert.equal(r.birthday, '1949-12-31');
    assert.equal(r.age, 76);
    assert.equal(r.gender, '女');
    assert.equal(checkIdCard('11010519491231002x', '2026-09-25').valid, true);
    assert.equal(checkIdCard(' 110105 19491231 002X ', '2026-09-25').valid, true);
  });

  test('校验位：每一位改动都能被发现', () => {
    const id = make('44030420000229123');
    assert.equal(checkIdCard(id, '2026-09-25').valid, true);
    for (const d of '0123456789X') {
      if (d === id[17]) continue;
      const r = checkIdCard(id.slice(0, 17) + d, '2026-09-25');
      assert.equal(r.valid, false);
      assert.equal(r.checks.checkDigit, false);
      assert.equal(r.reason, '校验位错误');
    }
    // 余数为 2 时校验位是 X
    assert.equal(checkDigitOf('11010519491231002'), 'X');
  });

  test('出生日期：闰日、不存在的日期、1900 年以前、未来', () => {
    const at = (birth) => checkIdCard(make(`440304${birth}123`), '2026-09-25');
    assert.equal(at('20000229').checks.birthday, true);
    assert.equal(at('19000229').checks.birthday, false); // 1900 不是闰年
    assert.equal(at('19990230').checks.birthday, false);
    assert.equal(at('19991301').checks.birthday, false);
    assert.equal(at('18991231').checks.birthday, false);
    assert.equal(at('20260926').checks.birthday, false);
    assert.equal(at('20260925').checks.birthday, true);
    const bad = at('19990230');
    assert.equal(bad.valid, false);
    assert.equal(bad.birthday, null);
    assert.equal(bad.age, null);
    assert.match(bad.reason, /出生日期/);
  });

  test('年龄按生日是否已过计算', () => {
    const id = make('32010219900926001');
    assert.equal(checkIdCard(id, '2026-09-25').age, 35);
    assert.equal(checkIdCard(id, '2026-09-26').age, 36);
    assert.equal(ageOn('2000-02-29', '2001-02-28'), 0);
    assert.equal(ageOn('2000-02-29', '2001-03-01'), 1);
  });

  test('性别：第 17 位奇数男偶数女', () => {
    assert.equal(checkIdCard(make('32010219900926001'), '2026-09-25').gender, '男');
    assert.equal(checkIdCard(make('32010219900926002'), '2026-09-25').gender, '女');
  });

  test('省级代码无效', () => {
    const r = checkIdCard(make('99010219900926001'), '2026-09-25');
    assert.equal(r.valid, false);
    assert.equal(r.checks.province, false);
    assert.equal(r.province, null);
    assert.equal(r.provinceCode, '99');
    assert.match(r.reason, /省级/);
  });

  test('15 位老号码：无校验位，出生年补 19', () => {
    const r = checkIdCard('110105491231002', '2026-09-25');
    assert.equal(r.valid, true);
    assert.equal(r.birthday, '1949-12-31');
    assert.equal(r.checks.checkDigit, null);
    assert.equal(r.gender, '女');
    assert.equal(checkIdCard('110105490231002', '2026-09-25').valid, false);
  });

  test('格式错误', () => {
    for (const s of ['', '1101051949123100', '11010519491231002Y', 'X10105194912310021', '1101051949123100211']) {
      const r = checkIdCard(s, '2026-09-25');
      assert.equal(r.valid, false, s);
      assert.equal(r.checks.format, false);
      assert.equal(r.checks.province, null);
      assert.equal(r.gender, null);
      assert.match(r.reason, /格式/);
    }
  });

  test('接口不回显完整号码，字段说明完整', async () => {
    await assert.rejects(call('/api/idcard/check', ''), { status: 400 });
    await assert.rejects(call('/api/idcard/check', `id=${'1'.repeat(30)}`), { status: 400 });
    const ok = await data('/api/idcard/check', 'id=11010519491231002X');
    assert.equal(ok.masked, '110105********002X');
    assert.ok(!JSON.stringify(ok).includes('11010519491231002X'));
    const bad = await data('/api/idcard/check', 'id=abc');
    const old = await data('/api/idcard/check', 'id=110105491231002');
    assertFieldsCovered('/api/idcard/check', [ok, bad, old]);
  });
});

describe('经纬度距离', () => {
  test('北京—上海约 1067 km，方位东南', () => {
    const r = geoDistance(39.9042, 116.4074, 31.2304, 121.4737);
    assert.ok(Math.abs(r.kilometers - 1067.3) < 1, String(r.kilometers));
    assert.equal(r.direction, '东南');
    assert.ok(r.bearing > 150 && r.bearing < 156);
    assert.ok(Math.abs(r.meters / 1000 - r.kilometers) < 0.001);
    assert.ok(Math.abs(r.miles * 1.609344 - r.kilometers) < 0.01);
    assert.ok(Math.abs(r.nauticalMiles * 1.852 - r.kilometers) < 0.01);
  });

  test('特殊情形：重合、正北、赤道正东、对跖点、跨 180° 经线', () => {
    const same = geoDistance(30, 120, 30, 120);
    assert.equal(same.meters, 0);
    assert.equal(same.bearing, null);
    assert.equal(same.direction, null);
    const north = geoDistance(0, 0, 10, 0);
    assert.equal(north.bearing, 0);
    assert.equal(north.direction, '北');
    const east = geoDistance(0, 0, 0, 1);
    assert.equal(east.bearing, 90);
    assert.equal(east.direction, '东');
    assert.ok(Math.abs(east.kilometers - (Math.PI * EARTH_RADIUS_M) / 180 / 1000) < 0.001);
    const anti = geoDistance(0, 0, 0, 180);
    assert.ok(Math.abs(anti.meters - Math.PI * EARTH_RADIUS_M) < 1);
    const dateline = geoDistance(0, 179.5, 0, -179.5);
    assert.ok(Math.abs(dateline.kilometers - 111.195) < 0.01);
    assert.equal(dateline.direction, '东');
  });

  test('接口参数校验、可关闭方位角', async () => {
    await assert.rejects(call('/api/geo/distance', 'lat1=91&lon1=0&lat2=0&lon2=0'), { status: 400 });
    await assert.rejects(call('/api/geo/distance', 'lat1=0&lon1=181&lat2=0&lon2=0'), { status: 400 });
    await assert.rejects(call('/api/geo/distance', 'lat1=0&lon1=0&lat2=0'), { status: 400 });
    await assert.rejects(call('/api/geo/distance', 'lat1=x&lon1=0&lat2=0&lon2=0'), { status: 400 });
    const a = await data('/api/geo/distance', 'lat1=39.9042&lon1=116.4074&lat2=31.2304&lon2=121.4737');
    const b = await data('/api/geo/distance', 'lat1=39.9042&lon1=116.4074&lat2=31.2304&lon2=121.4737&bearing=0');
    assert.equal(b.bearing, null);
    assert.equal(b.meters, a.meters);
    assertFieldsCovered('/api/geo/distance', [a, b]);
  });
});

describe('单位换算', () => {
  const conv = (v, f, t) => convertUnit(v, f, t).result;

  test('中国市制', () => {
    assert.equal(conv(1, '斤', 'kg'), 0.5);
    assert.equal(conv(1, 'jin', 'liang'), 10);
    assert.equal(conv(1, '两', 'g'), 50);
    assert.equal(conv(1, '钱', 'g'), 5);
    assert.equal(conv(1, '担', '斤'), 100);
    assert.equal(conv(1, '里', 'm'), 500);
    assert.equal(conv(1, '公里', '里'), 2);
    assert.equal(conv(1, 'm', '尺'), 3);
    assert.equal(conv(1, '丈', '尺'), 10);
    assert.equal(conv(1, '尺', '寸'), 10);
    assert.equal(conv(1, '亩', 'm2'), 666.666666667);
    assert.equal(conv(15, '亩', '公顷'), 1);
    assert.equal(conv(1, '顷', '亩'), 100);
    assert.equal(conv(1, 'mu', 'fen_area'), 10);
  });

  test('国际与英美单位', () => {
    assert.equal(conv(1, 'mi', 'km'), 1.609344);
    assert.equal(conv(1, 'in', 'cm'), 2.54);
    assert.equal(conv(1, 'lb', 'kg'), 0.45359237);
    assert.equal(conv(1, 'gal', 'l'), 3.785411784);
    assert.equal(conv(1, 'm3', 'l'), 1000);
    assert.equal(conv(0.3, 'm', 'cm'), 30);
    assert.equal(conv(36, 'km/h', 'm/s'), 10);
    assert.equal(conv(1, 'h', 's'), 3600);
    assert.equal(conv(1, '时辰', 'h'), 2);
    assert.equal(conv(1, 'atm', 'kPa'), 101.325);
    assert.equal(conv(1, 'kcal', 'kJ'), 4.184);
    assert.equal(conv(1, '度', 'kWh'), 1);
    assert.equal(conv(180, 'deg', 'rad'), 3.14159265359);
  });

  test('数据存储：十进制与二进制前缀、比特与字节区分大小写', () => {
    assert.equal(conv(1, 'GiB', 'B'), 1073741824);
    assert.equal(conv(1, 'GB', 'B'), 1e9);
    assert.equal(conv(1, 'MiB', 'KiB'), 1024);
    assert.equal(conv(1, 'B', 'bit'), 8);
    assert.equal(conv(100, 'Mb', 'MB'), 12.5);
    assert.equal(findUnit('gib').unit.id, 'GiB'); // 忽略大小写后唯一
    assert.throws(() => findUnit('mb'), { status: 400 });
    assert.throws(() => findUnit('kb'), { status: 400 });
  });

  test('温度：换算与绝对零度', () => {
    assert.equal(conv(100, 'C', 'F'), 212);
    assert.equal(conv(32, 'F', 'C'), 0);
    assert.equal(conv(-40, '℃', '℉'), -40);
    assert.equal(conv(0, 'K', 'C'), -273.15);
    assert.equal(conv(0, 'C', 'R'), 491.67);
    assert.equal(conv(-273.15, 'C', 'K'), 0);
    assert.throws(() => convertUnit(-300, 'C', 'K'), { status: 400 });
    assert.throws(() => convertUnit(-1, 'K', 'C'), { status: 400 });
  });

  test('不同类、未知单位报错；不传 to 返回同类全部', () => {
    assert.throws(() => convertUnit(1, 'kg', 'm'), { status: 400 });
    assert.throws(() => convertUnit(1, 'foo', 'm'), { status: 400 });
    const r = convertUnit(2, '斤', null);
    assert.equal(r.result, null);
    assert.equal(r.to, null);
    assert.equal(r.all.find((x) => x.unit === 'kg').value, 1);
  });

  test('单位代号与别名不冲突', () => {
    const seen = new Map();
    for (const c of listUnits()) {
      for (const u of c.units) {
        for (const k of [u.unit, ...u.aliases]) {
          assert.ok(!seen.has(k) || seen.get(k) === u.unit, `${k} 同时指向 ${seen.get(k)} 与 ${u.unit}`);
          seen.set(k, u.unit);
        }
      }
    }
    for (const cat of ['length', 'mass', 'area', 'volume', 'temperature', 'speed', 'data', 'time']) {
      assert.ok(listUnits().some((c) => c.category === cat), cat);
    }
  });

  test('接口与字段', async () => {
    await assert.rejects(call('/api/unit', 'from=kg&to=g'), { status: 400 });
    await assert.rejects(call('/api/unit', 'value=1&to=g'), { status: 400 });
    await assert.rejects(call('/api/unit', 'value=1e999&from=kg&to=g'), { status: 400 });
    const a = await data('/api/unit', 'value=3&from=斤&to=kg');
    assert.equal(a.text, '3 斤（市斤） = 1.5 千克');
    const b = await data('/api/unit', 'value=1&from=亩');
    assertFieldsCovered('/api/unit', [a, b]);
    const list = await data('/api/unit/list');
    assertFieldsCovered('/api/unit/list', [list]);
  });
});

describe('年龄 / 生肖 / 星座', () => {
  test('基本信息与生日倒计时', () => {
    const r = ageInfo('1995-08-20', '2026-09-25');
    assert.equal(r.age, 31);
    assert.equal(r.nominalAge, 32);
    assert.equal(r.zodiac, '猪');
    assert.equal(r.ganzhiYear, '乙亥');
    assert.equal(r.constellation.name, '狮子座');
    assert.equal(r.lunar.text, '乙亥年七月廿五');
    assert.equal(r.daysLived, 11359);
    assert.deepEqual(r.nextBirthday, { date: '2027-08-20', weekday: '星期五', daysUntil: 329, turning: 32, isToday: false });
    const l = solarToLunar(parseDate(r.nextLunarBirthday.date));
    assert.deepEqual([l.month, l.day, l.isLeap], [7, 25, false]);
    assert.equal(r.nextLunarBirthday.text, '七月廿五');
  });

  test('生肖按春节换年；虚岁每过春节加 1', () => {
    // 1996 年春节是 2 月 19 日
    assert.equal(ageInfo('1996-02-18', '2026-09-25').zodiac, '猪');
    assert.equal(ageInfo('1996-02-19', '2026-09-25').zodiac, '鼠');
    // 2026 年春节是 2 月 17 日
    assert.equal(ageInfo('2025-12-31', '2026-02-16').nominalAge, 1);
    assert.equal(ageInfo('2025-12-31', '2026-02-17').nominalAge, 2);
    assert.equal(ageInfo('2025-12-31', '2026-02-17').age, 0);
  });

  test('当天出生、当天生日、闰日出生', () => {
    const born = ageInfo('2026-09-25', '2026-09-25');
    assert.equal(born.age, 0);
    assert.equal(born.nominalAge, 1);
    assert.equal(born.nextBirthday.isToday, true);
    assert.equal(born.nextLunarBirthday.daysUntil, 0);
    const bday = ageInfo('1990-09-25', '2026-09-25');
    assert.equal(bday.age, 36);
    assert.equal(bday.nextBirthday.daysUntil, 0);
    assert.equal(bday.nextBirthday.turning, 36);
    const leap = ageInfo('2000-02-29', '2001-02-28');
    assert.equal(leap.age, 1);
    assert.equal(leap.nextBirthday.isToday, true);
    const before = ageInfo('2000-02-29', '2001-02-27');
    assert.equal(before.age, 0);
    assert.equal(before.nextBirthday.date, '2001-02-28');
    assert.equal(ageInfo('2000-02-29', '2003-03-01').nextBirthday.date, '2004-02-29');
  });

  test('闰月出生按同名普通月过农历生日', () => {
    const r = ageInfo('2020-06-01', '2026-09-25'); // 2020 年闰四月初十
    assert.equal(r.lunar.isLeap, true);
    assert.equal(r.lunar.text, '庚子年闰四月初十');
    const l = solarToLunar(parseDate(r.nextLunarBirthday.date));
    assert.deepEqual([l.month, l.day, l.isLeap], [4, 10, false]);
    assert.equal(r.nextLunarBirthday.text, '四月初十');
  });

  test('星座边界', () => {
    const cases = [[1, 1, '摩羯座'], [1, 19, '摩羯座'], [1, 20, '水瓶座'], [2, 18, '水瓶座'], [2, 19, '双鱼座'], [3, 21, '白羊座'],
      [6, 21, '双子座'], [6, 22, '巨蟹座'], [8, 22, '狮子座'], [8, 23, '处女座'], [10, 23, '天秤座'], [10, 24, '天蝎座'],
      [12, 21, '射手座'], [12, 22, '摩羯座'], [12, 31, '摩羯座']];
    for (const [m, d, name] of cases) assert.equal(constellationOf(m, d).name, name, `${m}-${d}`);
  });

  test('接口校验与字段', async () => {
    await assert.rejects(call('/api/age', ''), { status: 400 });
    await assert.rejects(call('/api/age', 'birthday=1995-02-30'), { status: 400 });
    await assert.rejects(call('/api/age', 'birthday=1900-01-01'), { status: 400 });
    await assert.rejects(call('/api/age', 'birthday=2026-09-26&date=2026-09-25'), { status: 400 });
    await assert.rejects(call('/api/age', 'birthday=1995/08/20'), { status: 400 });
    const a = await data('/api/age', 'birthday=1995-08-20&date=2026-09-25');
    const b = await data('/api/age', 'birthday=1990-01-01');
    assertFieldsCovered('/api/age', [a, b]);
  });
});

describe('工作日计算', () => {
  test('区间统计：含中秋、国庆与调休', async () => {
    mockFetch({ '2026.json': fixture('holiday-cn-2026.json') });
    const r = await countWorkdays('2026-09-20', '2026-10-11');
    assert.equal(r.totalDays, 22);
    assert.equal(r.workdays, 11);
    assert.equal(r.holidays, 10);
    assert.equal(r.weekends, 1);
    assert.equal(r.adjustedWorkdays, 2);
    assert.equal(r.offDays, 11);
    assert.deepEqual(r.holidayDetail, [{ name: '中秋节', days: 3 }, { name: '国庆节', days: 7 }]);
    assert.deepEqual(r.years, [{ year: 2026, source: 'holiday-cn', published: true }]);
    assert.equal(r.complete, true);
    assert.equal(r.degraded, false);
    const one = await countWorkdays('2026-10-10', '2026-10-10');
    assert.equal(one.workdays, 1);
  });

  test('推算 N 个工作日：跳过假期，支持往前推和 0', async () => {
    mockFetch({ '2026.json': fixture('holiday-cn-2026.json') });
    const a = await addWorkdays('2026-09-30', 1);
    assert.equal(a.result, '2026-10-08');
    assert.equal(a.calendarDays, 8);
    assert.equal(a.weekday, '星期四');
    assert.equal((await addWorkdays('2026-10-08', -1)).result, '2026-09-30');
    assert.equal((await addWorkdays('2026-10-09', 1)).result, '2026-10-10'); // 周六调休上班
    assert.equal((await addWorkdays('2026-10-09', 0)).result, '2026-10-09');
    assert.equal((await addWorkdays('2026-09-24', 1)).result, '2026-09-28'); // 跳过中秋三天
  });

  test('下一年未公布（404）只按周末算，并标注', async () => {
    mockFetch({ '2026.json': fixture('holiday-cn-2026.json'), '2027.json': 404 });
    const r = await countWorkdays('2026-12-28', '2027-01-08');
    assert.deepEqual(r.years.map((y) => [y.year, y.source, y.published]), [[2026, 'holiday-cn', true], [2027, 'none', false]]);
    assert.equal(r.complete, false);
    assert.equal(r.degraded, false);
    assert.equal(r.workdays, 10); // 2027-01-01 周五未公布，按工作日算
  });

  test('上游失败：有内置数据用 builtin，没有则降级为 unavailable', async () => {
    mockFetch({ '2025.json': 500, '2030.json': new Error('network down') });
    const b = await countWorkdays('2025-10-01', '2025-10-12');
    assert.equal(b.years[0].source, 'builtin');
    assert.equal(b.holidays, 8);
    assert.equal(b.adjustedWorkdays, 1); // 10-11 周六补班
    const d = await countWorkdays('2030-01-01', '2030-01-07');
    assert.deepEqual(d.years, [{ year: 2030, source: 'unavailable', published: false }]);
    assert.equal(d.degraded, true);
    assert.equal(d.workdays, 5);
    // 注入的加载器同样适用
    const loader = makeYearLoader(async () => { throw new Error('x'); });
    assert.equal((await countWorkdays('2031-01-01', '2031-01-01', loader)).degraded, true);
  });

  test('接口校验与字段', async () => {
    mockFetch({ '2026.json': fixture('holiday-cn-2026.json'), '2027.json': 404 });
    await assert.rejects(call('/api/workdays', 'start=2026-10-01'), { status: 400 });
    await assert.rejects(call('/api/workdays', 'start=2026-10-01&end=2026-09-01'), { status: 400 });
    await assert.rejects(call('/api/workdays', 'start=2026-10-01&end=2026-10-02&days=1'), { status: 400 });
    await assert.rejects(call('/api/workdays', 'start=2026-10-01&end=2030-10-02'), { status: 400 });
    await assert.rejects(call('/api/workdays', 'start=2026-10-01&days=501'), { status: 400 });
    await assert.rejects(call('/api/workdays', 'start=2006-10-01&days=1'), { status: 400 });
    await assert.rejects(call('/api/workdays', 'start=2026-02-30&days=1'), { status: 400 });
    const between = await data('/api/workdays', 'start=2026-09-28&end=2026-10-11');
    const add = await data('/api/workdays', 'start=2026-09-28&days=10');
    assert.equal(add.result, '2026-10-16'); // 9-29、9-30、10-8、10-9、10-10（补班）、10-12~10-16
    assertFieldsCovered('/api/workdays', [between, add]);
  });
});

describe('健康指标', () => {
  test('Mifflin-St Jeor 与 TDEE', () => {
    assert.equal(mifflin({ gender: 'male', weight: 70, height: 175, age: 30 }), 1648.75);
    assert.equal(mifflin({ gender: 'female', weight: 55, height: 160, age: 25 }), 1264);
    const r = healthCalc({ gender: 'male', age: 30, height: 175, weight: 70, activity: 'moderate' });
    assert.equal(r.bmr, 1649);
    assert.equal(r.tdee, Math.round(1648.75 * 1.55));
    assert.equal(r.calories.loss, r.tdee - 500);
    assert.equal(r.bmi.value, calcBMI(175, 70).bmi);
    assert.equal(r.idealWeight.bmiMin, calcBMI(175, 70).normalWeight.min);
    assert.equal(r.idealWeight.broca, 67.5);
    assert.equal(r.idealWeight.devine, 70.5);
    assert.equal(r.heartRate.max, 187);
    assert.equal(r.bodyFat.navy, null);
    assert.match(r.disclaimer, /仅供参考/);
  });

  test('体脂率估算', () => {
    const m = healthCalc({ gender: 'male', age: 30, height: 175, weight: 70, waist: 82, neck: 38 });
    assert.equal(m.bodyFat.bmiMethod, Math.round((1.2 * 22.9 + 0.23 * 30 - 10.8 - 5.4) * 10) / 10);
    assert.ok(m.bodyFat.navy > 10 && m.bodyFat.navy < 20);
    const f = healthCalc({ gender: 'female', age: 28, height: 162, weight: 55, waist: 70, neck: 32, hip: 94 });
    assert.ok(f.bodyFat.navy > 20 && f.bodyFat.navy < 32, String(f.bodyFat.navy));
    assert.equal(healthCalc({ gender: 'female', age: 28, height: 162, weight: 55, waist: 70, neck: 32 }).bodyFat.navy, null);
    assert.equal(navyBodyFat({ gender: 'male', height: 175, waist: 30, neck: 40 }), null);
  });

  test('接口校验与字段', async () => {
    await assert.rejects(call('/api/health/calc', 'gender=x&age=30&height=175&weight=70'), { status: 400 });
    await assert.rejects(call('/api/health/calc', 'gender=male&age=17&height=175&weight=70'), { status: 400 });
    await assert.rejects(call('/api/health/calc', 'gender=male&age=30&height=175'), { status: 400 });
    await assert.rejects(call('/api/health/calc', 'gender=male&age=30&height=175&weight=70&activity=lazy'), { status: 400 });
    const a = await data('/api/health/calc', 'gender=男&age=30&height=175&weight=70&waist=82&neck=38');
    assert.equal(a.gender, 'male');
    const b = await data('/api/health/calc', 'gender=female&age=40&height=160&weight=60&activity=sedentary');
    assertFieldsCovered('/api/health/calc', [a, b]);
  });
});

describe('数独', () => {
  const PUZZLE = '530070000600195000098000060800060003400803001700020006060000280000419005000080079';
  const ANSWER = '534678912672195348198342567859761423426853791713924856961537284287419635345286179';
  const validGrid = (s) => {
    const groups = [];
    for (let i = 0; i < 9; i++) {
      groups.push([...Array(9).keys()].map((j) => s[i * 9 + j]));
      groups.push([...Array(9).keys()].map((j) => s[j * 9 + i]));
      groups.push([...Array(9).keys()].map((j) => s[(Math.floor(i / 3) * 3 + Math.floor(j / 3)) * 9 + (i % 3) * 3 + (j % 3)]));
    }
    return groups.every((g) => new Set(g).size === 9 && !g.includes('0'));
  };

  test('求解经典题目，唯一解', () => {
    assert.deepEqual(solve(parsePuzzle(PUZZLE), 2), [ANSWER]);
    assert.equal(parsePuzzle(PUZZLE.replace(/0/g, '.')).join(''), PUZZLE);
  });

  test('无解、多解、冲突、格式错误', () => {
    const noSolution = `123456780${'000000009'}${'0'.repeat(63)}`;
    assert.deepEqual(solve(parsePuzzle(noSolution), 2), []);
    assert.equal(solve(new Array(81).fill(0), 2).length, 2);
    assert.throws(() => parsePuzzle(`11${'0'.repeat(79)}`), { status: 400 });
    assert.throws(() => parsePuzzle('123'), { status: 400 });
  });

  test('各难度生成：唯一解、与答案一致、提示数达标', () => {
    for (const level of Object.keys(LEVELS)) {
      const g = generate(level, 3000);
      const puzzle = g.puzzle.join('');
      const solution = g.solution.join('');
      assert.ok(validGrid(solution), level);
      for (let i = 0; i < 81; i++) if (puzzle[i] !== '0') assert.equal(puzzle[i], solution[i]);
      assert.equal(g.clues, g.puzzle.filter(Boolean).length);
      assert.ok(g.clues >= LEVELS[level].clues);
      assert.deepEqual(solve(g.puzzle, 2), [solution]);
    }
  });

  test('接口与字段', async () => {
    await assert.rejects(call('/api/sudoku', 'difficulty=insane'), { status: 400 });
    await assert.rejects(call('/api/sudoku', 'puzzle=123'), { status: 400 });
    const gen = await data('/api/sudoku', 'difficulty=easy');
    assert.equal(gen.mode, 'generate');
    assert.equal(gen.puzzleRows.length, 9);
    const solved = await data('/api/sudoku', `puzzle=${PUZZLE}`);
    assert.equal(solved.solution, ANSWER);
    assert.equal(solved.unique, true);
    const none = await data('/api/sudoku', `puzzle=123456780000000009${'0'.repeat(63)}`);
    assert.equal(none.solvable, false);
    assert.equal(none.unique, null);
    assert.equal(none.solution, null);
    const multi = await data('/api/sudoku', `puzzle=${'0'.repeat(81)}`);
    assert.equal(multi.unique, false);
    assertFieldsCovered('/api/sudoku', [gen, solved, none]);
  });
});

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { default: module, parseBoxOffice } = await import('../src/apis/fun/boxoffice.js');
const { cache } = await import('../src/lib/cache.js');
const actualFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = actualFetch; cache.store.clear(); cache.pending.clear(); });

const RAW = {
  movieList: {
    list: [
      {
        box: 295242755, splitBox: 261944190,
        boxRate: '31.1%', showCount: 106557, showCountRate: '25.1%',
        avgShowView: '0.7', avgSeatView: '0.4%',
        sumBoxDesc: '3.57亿', sumSplitBoxDesc: '3.18亿',
        movieInfo: { movieId: 1586199, movieName: '生化危机：爆发夜', releaseInfo: '上映14天' },
      },
      {
        box: '--', splitBox: null,
        boxRate: null, showCount: '--', showCountRate: null,
        avgShowView: null, avgSeatView: null,
        sumBoxDesc: null, sumSplitBoxDesc: null,
        movieInfo: { movieId: null, movieName: '无数据影片', releaseInfo: '' },
      },
    ],
    nationBoxInfo: {
      nationBoxSplitUnit: { num: '947.9', unit: '万' },
      nationSplitBoxSplitUnit: { num: '843.6', unit: '万' },
    },
    updateInfo: { updateTimestamp: 1792285828683 },
  },
  calendar: { selectDate: '2026-10-18' },
};

test('票房：分转万元、排名与大盘字段', () => {
  const r = parseBoxOffice(RAW);
  assert.equal(r.date, '2026-10-18');
  assert.equal(r.totalBox, 947.9);
  assert.equal(r.totalBoxUnit, '万');
  assert.equal(r.splitTotalBox, 843.6);
  assert.match(r.serverTime, /^2026-10-18 \d{2}:\d{2}:\d{2}$/, '时间戳按北京时间格式化');
  assert.match(r.updateInfo, /^北京时间 \d{2}:\d{2}:\d{2} 更新$/);

  const [first, second] = r.list;
  assert.equal(first.rank, 1);
  assert.equal(first.name, '生化危机：爆发夜');
  assert.equal(first.box, 295.24, '295242755 分 = 295.24 万元');
  assert.equal(first.splitBox, 261.94);
  assert.equal(first.showCount, 106557);
  assert.equal(first.showRate, '25.1%');
  assert.equal(first.avgShowView, 0.7);
  assert.equal(first.avgSeatView, '0.4%');
  assert.equal(first.url, 'https://piaofang.maoyan.com/movie/1586199');

  assert.equal(second.rank, 2);
  assert.equal(second.box, null, '"--" 视为 null');
  assert.equal(second.showCount, null);
  assert.equal(second.movieId, null);
  assert.equal(second.url, null, '没有 movieId 时不拼链接');
});

test('票房：结构不对时报 502，而不是静默返回空数据', () => {
  assert.throws(() => parseBoxOffice({}), (e) => e.status === 502);
  assert.throws(() => parseBoxOffice({ movieList: { list: null } }), (e) => e.status === 502);
});

test('票房：有统计日期和零大盘的合法空榜仍返回0，不把0当缺失', () => {
  const r = parseBoxOffice({ movieList: { list: [], nationBoxInfo: { nationBoxSplitUnit: { num: '0', unit: '万' } } }, calendar: { selectDate: '2026-10-18' } });
  assert.deepEqual(r.list, []);
  assert.equal(r.totalBox, 0);
  assert.equal(r.serverTime, null);
});

test('票房：空壳、错误标记与损坏条目拒绝为502', () => {
  for (const raw of [
    { movieList: { list: [], nationBoxInfo: {}, updateInfo: {} }, calendar: {} },
    { ...RAW, success: false },
    { ...RAW, movieList: { ...RAW.movieList, list: [null] } },
    { movieList: { list: [], nationBoxInfo: { nationBoxSplitUnit: { num: '0' } } } },
  ]) assert.throws(() => parseBoxOffice(raw), (e) => e.status === 502);
});

test('票房：金额异常类型为空，合法零值不丢失', () => {
  for (const value of [false, true, ' ', [], {}, '--', Infinity]) {
    const raw = structuredClone(RAW); raw.movieList.list[0].box = value; raw.movieList.list[0].splitBox = value;
    raw.movieList.nationBoxInfo.nationBoxSplitUnit.num = value;
    const r = parseBoxOffice(raw);
    assert.equal(r.list[0].box, null); assert.equal(r.list[0].splitBox, null); assert.equal(r.totalBox, null);
  }
  const raw = structuredClone(RAW); raw.movieList.list[0].box = 0; raw.movieList.list[0].splitBox = '0';
  assert.equal(parseBoxOffice(raw).list[0].box, 0); assert.equal(parseBoxOffice(raw).list[0].splitBox, 0);
  raw.movieList.list[0].box = -12300000;
  assert.equal(parseBoxOffice(raw).list[0].box, -12.3, '保持数值金额的换算，不把可能的净退票金额误作类型错误');
});

test('票房：非法日期/时间戳/单位报502，午夜按北京时间且可从时间戳补日期', () => {
  for (const timestamp of [false, ' ', {}, 1e20, -1, 1.5]) {
    const raw = structuredClone(RAW); raw.movieList.updateInfo.updateTimestamp = timestamp;
    assert.throws(() => parseBoxOffice(raw), (e) => e.status === 502);
  }
  for (const date of [false, {}, '2026-02-30', '2026-1-1']) {
    const raw = structuredClone(RAW); raw.calendar.selectDate = date;
    assert.throws(() => parseBoxOffice(raw), (e) => e.status === 502);
  }
  const raw = structuredClone(RAW); raw.calendar = {}; raw.movieList.updateInfo.updateTimestamp = Date.parse('2026-10-17T16:00:00Z');
  assert.equal(parseBoxOffice(raw).date, '2026-10-18'); assert.equal(parseBoxOffice(raw).serverTime, '2026-10-18 00:00:00');
  raw.movieList.nationBoxInfo.nationBoxSplitUnit.unit = {};
  assert.throws(() => parseBoxOffice(raw), (e) => e.status === 502);
});

test('票房：空壳刷新不能覆盖有效缓存；limit不截断共享缓存', async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; return Response.json(RAW); };
  const call = (query = '') => module.routes[0].handler({ query: new URLSearchParams(query) });
  assert.equal((await call('limit=1')).data.list.length, 1);
  assert.equal((await call('limit=50')).data.list.length, 2); assert.equal(requests, 1);
  cache.store.get('maoyan:box').expiresAt = Date.now() - 120_001;
  globalThis.fetch = async () => Response.json({ movieList: { list: [], nationBoxInfo: {}, updateInfo: {} } });
  const old = await call(); assert.equal(old.stale, true); assert.equal(old.data.totalBox, 947.9); assert.equal(old.data.list.length, 2);
  assert.equal(cache.store.get('maoyan:box').value.list.length, 2);
  cache.store.clear();
  await assert.rejects(call(), (e) => e.status === 502);
});

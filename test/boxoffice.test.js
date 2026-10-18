import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseBoxOffice } = await import('../src/apis/fun/boxoffice.js');

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

test('票房：列表为空时允许返回空榜，不报错', () => {
  const r = parseBoxOffice({ movieList: { list: [], nationBoxInfo: {}, updateInfo: {} }, calendar: {} });
  assert.deepEqual(r.list, []);
  assert.equal(r.totalBox, null);
  assert.equal(r.serverTime, null);
});

import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError, param } from '../../lib/http.js';

// 猫眼专业版实时票房（猫眼 App 内使用的旧接口，无需签名，数字未做字体加密）
// piaofang.maoyan.com/dashboard-ajax 需 signKey 且数字经字体混淆，这里不用。
const UPSTREAM = 'https://box.maoyan.com/promovie/api/box/second.json';
const TTL_MS = 2 * 60_000;

const numOrNull = (s) => {
  if (s == null || s === '') return null;
  const n = Number(String(s).replace(/[,%]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// 响应：{ success, data: { list: [{ movieId, movieName, releaseInfo, boxInfo, boxRate, sumBoxInfo, showInfo, showRate, seatRate, avgSeatView, avgShowView, splitBoxInfo, splitSumBoxInfo }], totalBox, totalBoxUnit, queryDate, updateInfo, serverTime } }
export function parseBoxOffice(raw) {
  const d = raw?.data;
  if (!d || !Array.isArray(d.list)) throw new HttpError(502, '猫眼票房返回的数据格式无法识别');
  return {
    date: d.queryDate ?? null,
    updateInfo: d.updateInfo ?? null,
    serverTime: d.serverTime ?? null,
    totalBox: d.totalBoxInfo ?? d.totalBox ?? null,
    totalBoxUnit: d.totalBoxUnitInfo ?? d.totalBoxUnit ?? '万',
    splitTotalBox: d.splitTotalBoxInfo ?? d.splitTotalBox ?? null,
    list: d.list.map((m, i) => ({
      rank: i + 1,
      movieId: m.movieId ?? null,
      name: m.movieName,
      releaseInfo: m.releaseInfo || null,
      box: numOrNull(m.boxInfo), // 当日综合票房（万元）
      boxRate: m.boxRate ?? null,
      splitBox: numOrNull(m.splitBoxInfo), // 当日分账票房（万元）
      sumBox: m.sumBoxInfo ?? null, // 累计票房，带单位文本，如 "2.67亿"
      splitSumBox: m.splitSumBoxInfo ?? null,
      showCount: numOrNull(m.showInfo),
      showRate: m.showRate ?? null,
      seatRate: m.seatRate ?? null,
      avgShowView: numOrNull(m.avgShowView),
      avgSeatView: m.avgSeatView ?? null,
      url: m.movieId ? `https://piaofang.maoyan.com/movie/${m.movieId}` : null,
    })),
  };
}

export async function loadBoxOffice() {
  return parseBoxOffice(await fetchJSON(UPSTREAM, { headers: { referer: 'https://piaofang.maoyan.com/' } }));
}

export default {
  name: 'boxoffice',
  category: 'fun',
  title: '实时票房',
  description: '全国电影实时票房榜（综合/分账、排片占比、上座率）',
  source: '猫眼专业版（非官方接口 box.maoyan.com/promovie/api/box/second.json）',
  unofficial: true,
  routes: [
    {
      method: 'GET',
      path: '/api/boxoffice',
      summary: '今日全国实时票房排行',
      params: [{ name: 'limit', default: 20, desc: '返回条数 1~50', example: '10' }],
      async handler({ query }) {
        const limit = param(query, 'limit', { default: 20, int: true, min: 1, max: 50 });
        const res = await cache.wrap('maoyan:box', TTL_MS, loadBoxOffice);
        return { ...res, data: { ...res.data, list: res.data.list.slice(0, limit) } };
      },
    },
  ],
};

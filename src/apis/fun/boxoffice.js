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
    totalBox: numOrNull(d.totalBoxInfo ?? d.totalBox),
    totalBoxUnit: d.totalBoxUnitInfo ?? d.totalBoxUnit ?? '万',
    splitTotalBox: numOrNull(d.splitTotalBoxInfo ?? d.splitTotalBox),
    // 分账总票房有自己的单位：综合已过亿时分账可能仍以"万"计
    splitTotalBoxUnit: d.splitTotalBoxUnitInfo ?? d.splitTotalBoxUnit ?? '万',
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

// 猫眼已改为「每次请求都要浏览器端生成的动态签名（mtgsig）+ 数字用随机字体加密」，
// 旧的免签名接口 box.maoyan.com 也已下线（域名无法解析）。没有可正当使用的公开数据源，接口暂停服务，保留代码以便日后恢复
export const SUSPENDED = '猫眼已停止提供公开的票房数据（旧接口下线，新接口需要浏览器端动态签名且数字经字体加密），暂时找不到可用的数据源';

export default {
  suspended: SUSPENDED,
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
      fields: [
        { name: 'date', type: 'string|null', desc: '票房日期（YYYY-MM-DD，北京时间），即统计的"今日"' },
        { name: 'updateInfo', type: 'string|null', desc: '猫眼给出的更新说明，如 "北京时间 15:32:10 更新"；缺失时为 null' },
        { name: 'serverTime', type: 'string|null', desc: '猫眼服务器时间，即数据统计时刻（"YYYY-MM-DD HH:mm:ss"，北京时间 UTC+8）；缺失时为 null' },
        { name: 'totalBox', type: 'number|null', desc: '今日全国大盘综合票房（含服务费），单位见 totalBoxUnit，如 3370.88；缺失时为 null' },
        { name: 'totalBoxUnit', type: 'string', desc: 'totalBox 的单位："万"=万元，"亿"=亿元；上游未给出时为 "万"' },
        { name: 'splitTotalBox', type: 'number|null', desc: '今日全国大盘分账票房（扣除服务费），单位见 splitTotalBoxUnit；缺失时为 null' },
        { name: 'splitTotalBoxUnit', type: 'string', desc: 'splitTotalBox 的单位："万"=万元，"亿"=亿元，可能与 totalBoxUnit 不同；上游未给出时为 "万"' },
        { name: 'list', type: 'array', desc: '影片实时票房榜，按当日综合票房从高到低，最多 limit 条' },
        { name: 'list[].rank', type: 'number', desc: '排名，从 1 开始' },
        { name: 'list[].movieId', type: 'number|null', desc: '猫眼电影 ID；缺失时为 null' },
        { name: 'list[].name', type: 'string', desc: '片名' },
        { name: 'list[].releaseInfo', type: 'string|null', desc: '上映状态，如 "上映6天"、"点映"；为空时为 null' },
        { name: 'list[].box', type: 'number|null', desc: '当日综合票房，单位万元（1523.67 即 1523.67 万元）；上游为 "--" 等非数字时为 null' },
        { name: 'list[].boxRate', type: 'string|null', desc: '综合票房占比（占当日大盘），带百分号的字符串，如 "45.2%"；缺失时为 null' },
        { name: 'list[].splitBox', type: 'number|null', desc: '当日分账票房（扣除服务费），单位万元；上游为非数字时为 null' },
        { name: 'list[].sumBox', type: 'string|null', desc: '上映以来累计综合票房，带单位的文本，如 "4.55亿"（亿元）、"5570.9万"（万元）；缺失时为 null' },
        { name: 'list[].splitSumBox', type: 'string|null', desc: '上映以来累计分账票房，带单位的文本，如 "4.02亿"；缺失时为 null' },
        { name: 'list[].showCount', type: 'number|null', desc: '当日排片场次；上游为非数字时为 null' },
        { name: 'list[].showRate', type: 'string|null', desc: '排片占比（该片场次占全国总场次），带百分号的字符串，如 "33.6%"；缺失时为 null' },
        { name: 'list[].seatRate', type: 'string|null', desc: '排座占比（该片座位数占全国总座位数），带百分号的字符串，如 "18.3%"；缺失时为 null' },
        { name: 'list[].avgShowView', type: 'number|null', desc: '场均人次（平均每场观影人数）；上游为非数字时为 null' },
        { name: 'list[].avgSeatView', type: 'string|null', desc: '上座率（观影人次占座位数的比例），上游原样返回的字符串，一般带百分号，如 "9.8%"；缺失时为 null' },
        { name: 'list[].url', type: 'string|null', desc: '猫眼专业版影片页（https://piaofang.maoyan.com/movie/{movieId}）；没有 movieId 时为 null' },
      ],
      async handler({ query }) {
        const limit = param(query, 'limit', { default: 20, int: true, min: 1, max: 50 });
        const res = await cache.wrap('maoyan:box', TTL_MS, loadBoxOffice);
        return { ...res, data: { ...res.data, list: res.data.list.slice(0, limit) } };
      },
    },
  ],
};

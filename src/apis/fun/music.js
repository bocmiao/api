// 网易云音乐官方榜单：通过公开的歌单详情接口获取（榜单本身就是一个歌单）
import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError, param } from '../../lib/http.js';

const TTL_MS = 30 * 60_000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const HEADERS = { 'user-agent': UA, referer: 'https://music.163.com/', origin: 'https://music.163.com' };

// 榜单 -> 网易云歌单 id
export const TOPLISTS = {
  hot: { id: 3778678, title: '热歌榜' },
  soaring: { id: 19723756, title: '飙升榜' },
  new: { id: 3779629, title: '新歌榜' },
  original: { id: 2884035, title: '原创榜' },
};

const https = (u) => (typeof u === 'string' && /^https?:\/\//.test(u) ? u.replace(/^http:/, 'https:') : null);
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const time = (ms) => {
  const n = num(ms);
  return n && n > 0 ? new Date(n).toISOString() : null;
};

// 兼容两种返回：
//   旧版 /api/playlist/detail：{ code: 200, result: { name, updateTime, tracks: [{ id, name, artists, album: { picUrl }, duration }] } }
//   v6 /api/v6/playlist/detail：{ code: 200, playlist: { name, updateTime, tracks: [{ id, name, ar, al: { picUrl }, dt }] } }
export function parsePlaylist(raw) {
  if (raw?.code != null && raw.code !== 200) {
    throw new HttpError(502, `网易云音乐接口返回错误：${raw.msg || raw.message || raw.code}`);
  }
  const pl = raw?.playlist ?? raw?.result;
  if (!pl || typeof pl !== 'object' || !Array.isArray(pl.tracks)) throw new HttpError(502, '网易云音乐返回的数据格式无法识别');
  const tracks = [];
  for (const t of pl.tracks) {
    const id = num(t?.id);
    if (!id || !t?.name) continue;
    const album = t.al ?? t.album ?? {};
    tracks.push({
      rank: tracks.length + 1,
      id,
      name: String(t.name),
      artists: (t.ar ?? t.artists ?? []).map((a) => a?.name).filter((n) => typeof n === 'string' && n),
      album: album.name || null,
      durationMs: num(t.dt ?? t.duration),
      cover: https(album.picUrl),
      url: `https://music.163.com/#/song?id=${id}`,
    });
  }
  return {
    name: pl.name || null,
    updatedAt: time(pl.updateTime),
    trackCount: num(pl.trackCount) ?? tracks.length,
    tracks,
  };
}

async function loadToplist(list) {
  const { id, title } = TOPLISTS[list];
  let parsed;
  try {
    parsed = parsePlaylist(await fetchJSON(`https://music.163.com/api/playlist/detail?id=${id}`, { headers: HEADERS }));
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
  }
  // 旧接口失效或不返回歌曲时改用 v6 接口
  if (!parsed?.tracks.length) {
    parsed = parsePlaylist(await fetchJSON(`https://music.163.com/api/v6/playlist/detail?id=${id}&n=1000`, { headers: HEADERS }));
  }
  if (!parsed.tracks.length) throw new HttpError(502, '网易云音乐榜单暂无歌曲数据');
  return { list, id, title, ...parsed, name: parsed.name ?? title };
}

export default {
  name: 'music',
  category: 'fun',
  title: '网易云音乐榜单',
  description: '网易云音乐热歌榜、飙升榜、新歌榜、原创榜的歌曲排行',
  source: '网易云音乐',
  unofficial: true,
  routes: [
    {
      method: 'GET',
      path: '/api/music/toplist',
      summary: '获取网易云音乐官方榜单歌曲',
      params: [
        { name: 'list', required: false, default: 'hot', desc: '榜单：hot 热歌榜 / soaring 飙升榜 / new 新歌榜 / original 原创榜', example: 'soaring' },
        { name: 'limit', required: false, default: '20', desc: '返回歌曲数（1~100）', example: '10' },
      ],
      fields: [
        { name: 'list', type: 'string', desc: '榜单参数，与请求参数 list 相同：hot / soaring / new / original' },
        { name: 'id', type: 'number', desc: '榜单在网易云音乐中的歌单 ID' },
        { name: 'title', type: 'string', desc: '榜单简称：热歌榜 / 飙升榜 / 新歌榜 / 原创榜' },
        { name: 'name', type: 'string', desc: '上游给出的榜单全名，如「云音乐热歌榜」；上游缺失时同 title' },
        { name: 'updatedAt', type: 'string|null', desc: '榜单更新时间（上游 updateTime），ISO 8601 格式，UTC 时区；上游未提供时为 null' },
        { name: 'trackCount', type: 'number', desc: '榜单歌曲总数（上游 trackCount；缺失时为实际解析到的歌曲数）' },
        { name: 'tracks', type: 'array', desc: '歌曲列表，按榜单排名排列，最多 limit 条（已跳过缺少 ID 或歌名的条目）' },
        { name: 'tracks[].rank', type: 'number', desc: '排名，从 1 开始连续编号' },
        { name: 'tracks[].id', type: 'number', desc: '歌曲 ID' },
        { name: 'tracks[].name', type: 'string', desc: '歌名' },
        { name: 'tracks[].artists', type: 'array', desc: '歌手名列表，多位歌手按上游顺序排列；上游缺失时为空数组' },
        { name: 'tracks[].artists[]', type: 'string', desc: '歌手名' },
        { name: 'tracks[].album', type: 'string|null', desc: '专辑名；上游缺失时为 null' },
        { name: 'tracks[].durationMs', type: 'number|null', desc: '歌曲时长（毫秒）；上游缺失时为 null' },
        { name: 'tracks[].cover', type: 'string|null', desc: '专辑封面图链接（https）；上游缺失时为 null' },
        { name: 'tracks[].url', type: 'string', desc: '网易云音乐歌曲页链接 https://music.163.com/#/song?id=歌曲ID' },
      ],
      async handler({ query }) {
        const list = param(query, 'list', { default: 'hot', oneOf: Object.keys(TOPLISTS) });
        const limit = param(query, 'limit', { default: 20, int: true, min: 1, max: 100 });
        const res = await cache.wrap(`music:toplist:${list}`, TTL_MS, () => loadToplist(list));
        return { ...res, data: { ...res.data, tracks: res.data.tracks.slice(0, limit) } };
      },
    },
  ],
};

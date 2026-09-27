// 网易云音乐搜索与播放：搜索歌曲、歌曲详情、歌词，以及官方外链播放地址和可嵌入网页的播放器。
// 播放使用网易云官方提供的外链（music.163.com/song/media/outer/url），只能播放免费歌曲；
// 会员歌曲、付费专辑无法外链播放，这里如实标出，不做任何绕过。
import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError, param } from '../../lib/http.js';
import { siteOrigin } from '../../lib/origin.js';
import { outerUrl } from './music.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const HEADERS = { 'user-agent': UA, referer: 'https://music.163.com/', origin: 'https://music.163.com' };
const ID_RE = /^\d{1,12}$/;

const num = (v) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const https = (u) => (typeof u === 'string' && /^https?:\/\//.test(u) ? u.replace(/^http:/, 'https:') : null);

// fee：0 免费、8 免费（非会员为标准音质）、1 会员专享、4 购买专辑；其他值按不确定处理
export function feeInfo(fee) {
  const f = num(fee);
  if (f === 0 || f === 8) return { fee: f, playable: true, feeText: '免费' };
  if (f === 1) return { fee: f, playable: false, feeText: '会员专享' };
  if (f === 4) return { fee: f, playable: false, feeText: '付费专辑' };
  return { fee: f, playable: null, feeText: '未知' };
}

// 兼容新旧两种歌曲结构：新版字段 ar / al / dt，旧版 artists / album / duration
export function parseSong(t) {
  const id = num(t?.id);
  if (!id || !t?.name) return null;
  const album = t.al ?? t.album ?? {};
  return {
    id,
    name: String(t.name),
    artists: (t.ar ?? t.artists ?? []).map((a) => a?.name).filter((n) => typeof n === 'string' && n),
    album: album.name || null,
    cover: https(album.picUrl),
    durationMs: num(t.dt ?? t.duration),
    ...feeInfo(t.fee),
    url: `https://music.163.com/#/song?id=${id}`,
    playUrl: outerUrl(id),
  };
}

// 搜索结果：{ code: 200, result: { songs: [...], songCount } }
export function parseSearch(raw) {
  if (raw?.code != null && raw.code !== 200) throw new HttpError(502, `网易云音乐接口返回错误：${raw.msg || raw.message || raw.code}`);
  const r = raw?.result;
  if (!r || typeof r !== 'object') throw new HttpError(502, '网易云音乐返回的数据格式无法识别');
  const songs = (Array.isArray(r.songs) ? r.songs : []).map(parseSong).filter(Boolean);
  return { total: num(r.songCount) ?? songs.length, songs };
}

async function search(keyword, limit, offset) {
  const qs = new URLSearchParams({ s: keyword, type: '1', limit: String(limit), offset: String(offset) });
  // 新接口带封面和收费信息；失败时退回旧的网页搜索接口
  try {
    return parseSearch(await fetchJSON(`https://music.163.com/api/cloudsearch/pc?${qs}`, { headers: HEADERS }));
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return parseSearch(await fetchJSON(`https://music.163.com/api/search/get/web?${qs}`, { headers: HEADERS }));
  }
}

// 歌曲详情：{ code: 200, songs: [...] }
export function parseDetail(raw, id) {
  if (raw?.code != null && raw.code !== 200) throw new HttpError(502, `网易云音乐接口返回错误：${raw.msg || raw.message || raw.code}`);
  if (!Array.isArray(raw?.songs)) throw new HttpError(502, '网易云音乐返回的数据格式无法识别');
  const song = raw.songs.map(parseSong).find((s) => s?.id === id);
  if (!song) throw new HttpError(404, '没有找到这首歌，请检查歌曲 ID');
  return song;
}

async function songDetail(id) {
  const res = await cache.wrap(`music:song:${id}`, 6 * 3600_000, async () =>
    parseDetail(await fetchJSON(`https://music.163.com/api/song/detail/?id=${id}&ids=%5B${id}%5D`, { headers: HEADERS }), id));
  return res;
}

// LRC 歌词：[mm:ss.xx]文字，一行可以有多个时间标签；[ar:] 这类标签和新版的 JSON 署名行跳过
export function parseLrc(text) {
  const lines = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!tags.length) continue;
    const words = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of tags) {
      const frac = m[3] ? Number(m[3].padEnd(3, '0')) : 0;
      lines.push({ time: Number(m[1]) * 60_000 + Number(m[2]) * 1000 + frac, text: words });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

// 歌词：{ code: 200, lrc: { lyric }, tlyric: { lyric }, nolyric?, uncollected? }
export function parseLyric(raw) {
  if (raw?.code != null && raw.code !== 200) throw new HttpError(502, `网易云音乐接口返回错误：${raw.msg || raw.message || raw.code}`);
  const lrc = raw?.lrc?.lyric ?? '';
  const tlrc = raw?.tlyric?.lyric ?? '';
  const lines = parseLrc(lrc);
  const trans = new Map(parseLrc(tlrc).filter((l) => l.text).map((l) => [l.time, l.text]));
  return {
    instrumental: Boolean(raw?.nolyric),
    hasLyric: lines.some((l) => l.text),
    hasTranslation: trans.size > 0,
    lines: lines.map((l) => ({ ...l, translation: trans.get(l.time) ?? null })),
    lrc: lrc || null,
  };
}

async function lyric(id) {
  return cache.wrap(`music:lyric:${id}`, 24 * 3600_000, async () =>
    parseLyric(await fetchJSON(`https://music.163.com/api/song/lyric?id=${id}&lv=1&tv=-1`, { headers: HEADERS })));
}

const songFields = (prefix) => [
  { name: `${prefix}id`, type: 'number', desc: '歌曲 ID' },
  { name: `${prefix}name`, type: 'string', desc: '歌名' },
  { name: `${prefix}artists`, type: 'array', desc: '歌手名列表；上游缺失时为空数组' },
  { name: `${prefix}artists[]`, type: 'string', desc: '歌手名' },
  { name: `${prefix}album`, type: 'string|null', desc: '专辑名；上游缺失时为 null' },
  { name: `${prefix}cover`, type: 'string|null', desc: '专辑封面图链接（https）；上游缺失时为 null' },
  { name: `${prefix}durationMs`, type: 'number|null', desc: '时长（毫秒）；上游缺失时为 null' },
  { name: `${prefix}fee`, type: 'number|null', desc: '网易云收费类型（上游 fee）：0 / 8 免费，1 会员专享，4 付费专辑；上游缺失时为 null' },
  { name: `${prefix}playable`, type: 'boolean|null', desc: '能否通过外链播放：true 免费歌曲可以播放，false 会员或付费歌曲无法外链播放，null 无法判断' },
  { name: `${prefix}feeText`, type: 'string', desc: '收费类型的中文说明：免费 / 会员专享 / 付费专辑 / 未知' },
  { name: `${prefix}url`, type: 'string', desc: '网易云音乐歌曲页链接' },
  { name: `${prefix}playUrl`, type: 'string', desc: '网易云官方外链播放地址，打开后跳转到 MP3 文件，可放进 <audio src>（网易云的音频有防盗链，请同时加上 referrerpolicy="no-referrer"）；会员或付费歌曲无法播放' },
];

// ---------- 播放器页面 ----------
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function playerHtml(song, lyricData, { theme = 'auto', autoplay = false } = {}) {
  // 数据以 JSON 放进页面，</ 转义，防止提前结束 <script>；页面脚本只用 textContent 写入文字
  const data = JSON.stringify({
    playable: song.playable,
    lines: (lyricData?.lines ?? []).filter((l) => l.text).map((l) => [l.time, l.text, l.translation]),
  }).replace(/</g, '\\u003c');
  const title = `${song.name} - ${song.artists.join(' / ') || '未知歌手'}`;
  return `<!doctype html>
<html lang="zh-CN"${theme === 'auto' ? '' : ` data-theme="${theme}"`}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)} · Miao API 播放器</title>
<style>
:root { --bg: #ffffff; --text: #16161a; --sub: #6b6b76; --line: #e6e6ec; --brand: #4f46e5; --hl: #eef0ff; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #16171b; --text: #ececf1; --sub: #9a9aa6; --line: #2a2b31; --brand: #818cf8; --hl: #1f2140; } }
:root[data-theme="dark"] { --bg: #16171b; --text: #ececf1; --sub: #9a9aa6; --line: #2a2b31; --brand: #818cf8; --hl: #1f2140; }
* { box-sizing: border-box; margin: 0; }
html, body { height: 100%; }
body { background: var(--bg); color: var(--text); font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; display: flex; flex-direction: column; }
.top { display: flex; gap: 14px; align-items: center; padding: 14px; border-bottom: 1px solid var(--line); }
.cover { width: 64px; height: 64px; border-radius: 10px; object-fit: cover; background: var(--line); flex: none; }
.meta { min-width: 0; flex: 1; }
.name { font-size: 16px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.artist { color: var(--sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
audio { width: 100%; margin-top: 6px; height: 36px; }
.tip { margin-top: 6px; color: #c62828; font-size: 13px; }
.tip a, .foot a { color: var(--brand); text-decoration: none; }
.lyric { flex: 1; overflow-y: auto; padding: 18px 14px 40vh; text-align: center; scroll-behavior: smooth; }
.lyric p { padding: 5px 8px; border-radius: 8px; color: var(--sub); transition: color .2s, background .2s; }
.lyric p small { display: block; font-size: 12px; opacity: .85; }
.lyric p.on { color: var(--text); background: var(--hl); font-weight: 600; }
.empty { color: var(--sub); padding: 30px 0; }
.foot { padding: 6px 14px; border-top: 1px solid var(--line); color: var(--sub); font-size: 12px; display: flex; justify-content: space-between; }
</style>
</head>
<body>
<div class="top">
  ${song.cover ? `<img class="cover" src="${escHtml(song.cover)}?param=128y128" alt="">` : '<div class="cover"></div>'}
  <div class="meta">
    <div class="name">${escHtml(song.name)}</div>
    <div class="artist">${escHtml(song.artists.join(' / ') || '未知歌手')}${song.album ? ` · ${escHtml(song.album)}` : ''}</div>
    ${song.playable === false
    ? `<div class="tip">这首歌是${escHtml(song.feeText)}歌曲，网易云不提供外链播放，<a href="${escHtml(song.url)}" target="_blank" rel="noopener">去网易云收听</a></div>`
    : `<audio id="audio" controls preload="metadata"${autoplay ? ' autoplay' : ''} src="${escHtml(song.playUrl)}"></audio>`}
  </div>
</div>
<div class="lyric" id="lyric"></div>
<div class="foot"><a href="${escHtml(song.url)}" target="_blank" rel="noopener">在网易云音乐打开</a><span>Miao API 播放器</span></div>
<script id="data" type="application/json">${data}</script>
<script>
(function () {
  var d = JSON.parse(document.getElementById('data').textContent);
  var box = document.getElementById('lyric');
  var audio = document.getElementById('audio');
  if (!d.lines.length) {
    var e = document.createElement('div'); e.className = 'empty'; e.textContent = '暂无歌词'; box.appendChild(e);
    return;
  }
  var els = d.lines.map(function (l) {
    var p = document.createElement('p'); p.textContent = l[1];
    if (l[2]) { var s = document.createElement('small'); s.textContent = l[2]; p.appendChild(s); }
    box.appendChild(p); return p;
  });
  if (!audio) return;
  var cur = -1;
  audio.addEventListener('error', function () {
    var t = document.createElement('div'); t.className = 'tip';
    t.textContent = '播放失败：这首歌可能需要会员，或暂时无法外链播放';
    audio.replaceWith(t);
  });
  audio.addEventListener('timeupdate', function () {
    var ms = audio.currentTime * 1000, i = -1;
    for (var k = 0; k < d.lines.length && d.lines[k][0] <= ms + 200; k++) i = k;
    if (i === cur) return;
    if (cur >= 0) els[cur].classList.remove('on');
    cur = i;
    if (i >= 0) { els[i].classList.add('on'); box.scrollTop = els[i].offsetTop - box.clientHeight / 3; }
  });
  els.forEach(function (p, i) { p.style.cursor = 'pointer'; p.onclick = function () { audio.currentTime = d.lines[i][0] / 1000; audio.play(); }; });
})();
</script>
</body>
</html>`;
}

// 播放器页面只允许加载网易云的封面、音频和页面自带的样式脚本；允许被任意网站用 iframe 嵌入
const PLAYER_CSP = "default-src 'none'; img-src https: data:; media-src https: http:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

const idParam = (query) => {
  const id = param(query, 'id', { required: true, max: 12 });
  if (!ID_RE.test(id)) throw new HttpError(400, 'id 须为网易云音乐的歌曲 ID（纯数字）');
  return Number(id);
};

export default {
  name: 'music-play',
  category: 'fun',
  title: '网易云音乐播放',
  description: '搜索网易云音乐歌曲，获取歌词和播放地址，还有可以嵌入网页的播放器（仅支持免费歌曲外链播放）',
  source: '网易云音乐',
  unofficial: true,
  routes: [
    {
      method: 'GET',
      path: '/api/music/search',
      summary: '搜索歌曲，返回播放地址和播放器链接',
      params: [
        { name: 'keyword', required: true, desc: '歌名、歌手或专辑名', example: '晴天 周杰伦' },
        { name: 'limit', required: false, default: '20', desc: '每页条数（1~50）', example: '5' },
        { name: 'page', required: false, default: '1', desc: '页码，从 1 开始', example: '1' },
      ],
      fields: [
        { name: 'keyword', type: 'string', desc: '搜索关键词' },
        { name: 'page', type: 'number', desc: '当前页码' },
        { name: 'total', type: 'number', desc: '匹配的歌曲总数（上游 songCount）' },
        { name: 'songs', type: 'array', desc: '本页歌曲' },
        ...songFields('songs[].'),
        { name: 'songs[].player', type: 'string', desc: '本站播放器页面地址（带歌词滚动），可直接打开或用 <iframe> 嵌入网页' },
      ],
      async handler({ query, req }) {
        const keyword = param(query, 'keyword', { required: true, max: 100 }).trim();
        if (!keyword) throw new HttpError(400, '缺少参数 keyword');
        const limit = param(query, 'limit', { default: 20, int: true, min: 1, max: 50 });
        const page = param(query, 'page', { default: 1, int: true, min: 1, max: 50 });
        const res = await cache.wrap(`music:search:${keyword}:${limit}:${page}`, 30 * 60_000, () => search(keyword, limit, (page - 1) * limit));
        const origin = siteOrigin(req);
        return { ...res, data: { keyword, page, ...res.data, songs: res.data.songs.map((s) => ({ ...s, player: `${origin}/api/music/player?id=${s.id}` })) } };
      },
    },
    {
      method: 'GET',
      path: '/api/music/song',
      summary: '歌曲详情（含播放地址和播放器链接）',
      params: [{ name: 'id', required: true, desc: '网易云音乐歌曲 ID（歌曲页网址 song?id= 后面的数字）', example: '186016' }],
      fields: [
        ...songFields(''),
        { name: 'player', type: 'string', desc: '本站播放器页面地址（带歌词滚动），可直接打开或用 <iframe> 嵌入网页' },
      ],
      async handler({ query, req }) {
        const id = idParam(query);
        const res = await songDetail(id);
        return { ...res, data: { ...res.data, player: `${siteOrigin(req)}/api/music/player?id=${id}` } };
      },
    },
    {
      method: 'GET',
      path: '/api/music/lyric',
      summary: '歌词（按时间逐行，含翻译）',
      params: [{ name: 'id', required: true, desc: '网易云音乐歌曲 ID', example: '186016' }],
      fields: [
        { name: 'id', type: 'number', desc: '歌曲 ID' },
        { name: 'instrumental', type: 'boolean', desc: '是否为纯音乐（上游标记无歌词）' },
        { name: 'hasLyric', type: 'boolean', desc: '是否有带时间的歌词' },
        { name: 'hasTranslation', type: 'boolean', desc: '是否有翻译歌词（外文歌常见）' },
        { name: 'lines', type: 'array', desc: '歌词行，按时间排序；空行（间奏）保留，text 为空字符串' },
        { name: 'lines[].time', type: 'number', desc: '这一行开始的时间（毫秒）' },
        { name: 'lines[].text', type: 'string', desc: '歌词文字' },
        { name: 'lines[].translation', type: 'string|null', desc: '同一时间的翻译歌词；没有翻译时为 null' },
        { name: 'lrc', type: 'string|null', desc: '原始 LRC 格式歌词，可直接交给播放器；没有歌词时为 null' },
      ],
      async handler({ query }) {
        const id = idParam(query);
        const res = await lyric(id);
        return { ...res, data: { id, ...res.data } };
      },
    },
    {
      method: 'GET',
      path: '/api/music/url',
      summary: '播放地址（跳转到网易云官方外链）',
      raw: true,
      returns: 'HTTP 302 跳转到网易云官方外链 https://music.163.com/song/media/outer/url?id=歌曲ID.mp3，再由网易云跳转到 MP3 文件，可直接用作 <audio src>。只能播放免费歌曲，会员或付费歌曲会跳到网易云的 404 页面',
      params: [{ name: 'id', required: true, desc: '网易云音乐歌曲 ID', example: '186016' }],
      async handler({ query }) {
        const id = idParam(query);
        return { status: 302, headers: { location: outerUrl(id), 'cache-control': 'public, max-age=86400' }, body: '' };
      },
    },
    {
      method: 'GET',
      path: '/api/music/player',
      summary: '网页播放器（带歌词滚动，可用 iframe 嵌入）',
      raw: true,
      returns: 'HTML 网页播放器：显示封面、歌名歌手、播放控件和随播放滚动的歌词（点击歌词可跳转），自动适应浅色 / 深色模式。可直接打开，或用 <iframe src="…" width="100%" height="420"> 嵌入网页。会员或付费歌曲无法外链播放，页面会给出提示和网易云链接',
      params: [
        { name: 'id', required: false, desc: '网易云音乐歌曲 ID；与 keyword 二选一', example: '186016' },
        { name: 'keyword', required: false, desc: '不知道 ID 时直接搜索，播放第一首可以外链播放的歌曲', example: '晴天 周杰伦' },
        { name: 'theme', required: false, default: 'auto', desc: '配色：auto 跟随系统 / light 浅色 / dark 深色', example: 'dark' },
        { name: 'autoplay', required: false, default: '0', desc: '1 自动播放（浏览器可能要求用户先点击页面才允许有声音的自动播放）', example: '0' },
      ],
      async handler({ query }) {
        const theme = param(query, 'theme', { default: 'auto', oneOf: ['auto', 'light', 'dark'] });
        const autoplay = param(query, 'autoplay', { default: '0', oneOf: ['0', '1'] }) === '1';
        let song;
        if (query.get('id')) {
          song = (await songDetail(idParam(query))).data;
        } else {
          const keyword = param(query, 'keyword', { max: 100 })?.trim();
          if (!keyword) throw new HttpError(400, '请传入歌曲 id 或搜索关键词 keyword');
          const res = await cache.wrap(`music:search:${keyword}:10:1`, 30 * 60_000, () => search(keyword, 10, 0));
          song = res.data.songs.find((s) => s.playable) ?? res.data.songs[0];
          if (!song) throw new HttpError(404, '没有搜到相关歌曲');
        }
        let lyricData = null;
        try {
          lyricData = (await lyric(song.id)).data;
        } catch { /* 歌词取不到时照常播放 */ }
        return {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PLAYER_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' },
          body: playerHtml(song, lyricData, { theme, autoplay }),
        };
      },
    },
  ],
};

import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError, param } from '../../lib/http.js';

const UPSTREAM = 'https://open.iciba.com/dsapi/';

const https = (u) => (typeof u === 'string' && u ? u.replace(/^http:\/\//, 'https://') : null);

export function todayCN(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

// dsapi 响应：{ sid, tts, content, note, love, translation, picture, picture2, caption, dateline, fenxiang_img, picture3, picture4, tags }
export function parseIciba(raw) {
  if (!raw || typeof raw.content !== 'string' || !raw.content) throw new HttpError(502, '金山词霸返回的数据格式无法识别');
  return {
    date: raw.dateline ?? null,
    content: raw.content.trim(),
    // note 才是中文翻译；translation 字段通常是"新版每日一句"或"小编的话：…"
    translation: raw.note?.trim() || null,
    editorNote: /^小编的话/.test(raw.translation ?? '') ? raw.translation.replace(/^小编的话[:：]\s*/, '') : null,
    audio: https(raw.tts),
    picture: https(raw.picture2 || raw.picture),
    pictureSmall: https(raw.picture),
    shareImage: https(raw.fenxiang_img),
    sid: raw.sid ?? null,
    url: raw.sid ? `https://news.iciba.com/views/dailysentence/daily.html#!/detail/sid/${raw.sid}` : null,
  };
}

export async function loadEnglishDaily(date) {
  const url = date ? `${UPSTREAM}?date=${encodeURIComponent(date)}` : UPSTREAM;
  return parseIciba(await fetchJSON(url));
}

export default {
  name: 'english-daily',
  category: 'fun',
  title: '每日一句英语',
  description: '金山词霸每日一句：英文原句、中文翻译、配图与朗读音频',
  source: '金山词霸 open.iciba.com',
  routes: [
    {
      method: 'GET',
      path: '/api/english/daily',
      summary: '获取某天的每日一句英语',
      params: [{ name: 'date', desc: '日期 YYYY-MM-DD，留空为今天', example: '2026-09-01' }],
      async handler({ query }) {
        const date = param(query, 'date', { pattern: /^\d{4}-\d{2}-\d{2}$/ }) ?? todayCN();
        if (Number.isNaN(Date.parse(date)) || date < '2010-01-01' || date > todayCN()) {
          throw new HttpError(400, 'date 须为 2010-01-01 至今天之间的日期');
        }
        const ttl = date === todayCN() ? 60 * 60_000 : 7 * 24 * 3600_000;
        return cache.wrap(`iciba:${date}`, ttl, () => loadEnglishDaily(date));
      },
    },
  ],
};

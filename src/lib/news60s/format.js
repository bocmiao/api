// Original implementation. No upstream parser, AI client or credentials are embedded.
import { HttpError, stripTags } from '../http.js';
import { checkUrl } from '../netguard.js';

export const MAX_JSON_BYTES = 256 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const today = (now = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now);
const bad = (message) => new HttpError(400, message, 'NEWS60S_INVALID_INPUT');

export function editionDate(value, { now = new Date(), future = false } = {}) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) throw bad('日期须为 YYYY-MM-DD（2000—2099）');
  const d = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw bad('日期不存在');
  if (!future && value > today(now)) throw bad('不能发布未来日期的简报');
  return value;
}

// URLs are public, credential-free inputs, never a place to pass an API key.
export function publicSourceUrl(raw, base) {
  if (typeof raw !== 'string' || !raw || raw.length > 4000) throw bad('来源网址不合法');
  let u;
  try { u = base ? new URL(raw, base) : new URL(raw); } catch { throw bad('来源网址不合法'); }
  checkUrl(u.href);
  for (const key of u.searchParams.keys()) {
    if (/^(?:key|token|access_token|api[_-]?key|secret|password|authorization)$/i.test(key)) throw bad('来源网址不能携带密钥或令牌');
  }
  u.hash = '';
  return u.href;
}

function text(value, name, max, nullable = true) {
  if (value == null || value === '') {
    if (nullable) return null;
    throw bad(`${name}不能为空`);
  }
  if (typeof value !== 'string' || value.length > max || /\0/.test(value)) throw bad(`${name}格式或长度不合法`);
  const clean = stripTags(value).trim();
  if (!clean && !nullable) throw bad(`${name}不能为空`);
  return clean || null;
}

export function normalizeEdition(raw, { expectedDate, sourceUrl = null, method = 'manual-json', now = new Date() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('须提供结构化 JSON');
  const d = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : raw;
  const date = editionDate(d.date, { now });
  if (expectedDate != null && editionDate(expectedDate, { now }) !== date) throw bad('来源日期与指定日期不一致，未发布');
  if (!Array.isArray(d.news) || !d.news.length || d.news.length > 60) throw bad('news 须为 1—60 条新闻字符串');
  const news = d.news.map((s) => text(s, '新闻条目', 2000, false).replace(/^\d+[、.．]\s*/, '').replace(/[；;]$/, '').trim());
  if (news.some((s) => !s) || new Set(news).size !== news.length) throw bad('新闻条目为空或重复');
  const asset = (value) => {
    if (value == null || value === '') return null;
    if (typeof value === 'string' && value.startsWith('data:')) return value;
    return publicSourceUrl(value, sourceUrl || undefined);
  };
  const image = asset(d.image);
  const cover = asset(d.cover);
  return {
    date,
    weekday: text(d.weekday ?? d.day_of_week, '星期', 30) ?? `星期${'日一二三四五六'[new Date(date + 'T00:00:00Z').getUTCDay()]}`,
    lunarDate: text(d.lunarDate ?? d.lunar_date, '农历', 60),
    news, tip: text(d.tip, '微语', 2000), image, cover,
    link: d.link ? publicSourceUrl(d.link, sourceUrl || undefined) : null,
    source: text(d.source, '来源归属', 200) ?? (sourceUrl ? new URL(sourceUrl).hostname : '人工录入'),
    provenance: {
      method, url: sourceUrl ? publicSourceUrl(sourceUrl) : null,
      image: image?.startsWith('data:') ? null : image,
      cover: cover?.startsWith('data:') ? null : cover,
      dateBasis: method === 'wechat-url' ? 'article-visible-date' : 'supplied-date',
    },
  };
}

export function imageFormat(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) throw bad('图片为空或超过 5 MiB');
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { ext: 'png', mime: 'image/png' };
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { ext: 'jpg', mime: 'image/jpeg' };
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  if (bytes.length >= 13 && /GIF8[79]a/.test(bytes.toString('ascii', 0, 6))) return { ext: 'gif', mime: 'image/gif' };
  throw bad('仅接受带正确文件头的 PNG/JPEG/WebP/GIF，拒绝 SVG/HTML');
}

export function inlineImage(value) {
  const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!m || m[2].length % 4 || m[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw bad('内嵌图片须为受限大小的 raster base64 data URL');
  const bytes = Buffer.from(m[2], 'base64');
  const format = imageFormat(bytes);
  if (format.mime !== `image/${m[1]}`) throw bad('图片声明格式与文件头不一致');
  return { bytes, ...format };
}

const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [m[1].toLowerCase(), m[2] ?? m[3]]));

function articleBody(html) {
  const tokens = [...html.matchAll(/<\/?div\b[^>]*>/gi)];
  const start = tokens.findIndex((m) => attrs(m[0]).id === 'js_content');
  if (start < 0) throw bad('未找到微信文章正文，可能是验证页；请改用结构化 JSON');
  let depth = 1;
  for (let i = start + 1; i < tokens.length; i++) {
    depth += /^<\//.test(tokens[i][0]) ? -1 : 1;
    if (!depth) return html.slice(tokens[start].index + tokens[start][0].length, tokens[i].index);
  }
  throw bad('文章正文结构不完整，请改用结构化 JSON');
}

// Conservative deterministic parser: no script execution, AI or inferred publication date.
export function parseWechatArticle(html, { url, date, image, cover, now = new Date() } = {}) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 2 * 1024 * 1024) throw bad('文章大小或格式不合法');
  const source = new URL(publicSourceUrl(url));
  if (source.protocol !== 'https:' || source.hostname !== 'mp.weixin.qq.com') throw bad('文章入口仅支持公开 HTTPS 微信文章');
  const safe = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const body = articleBody(safe);
  const meta = [...safe.matchAll(/<meta\b[^>]*>/gi)].map((m) => attrs(m[0]));
  const title = meta.find((m) => m.property === 'og:title')?.content ?? '';
  const lines = body.replace(/<br\s*\/?\s*>|<\/(?:p|section|div|li|h[1-6])\s*>/gi, '\n').split('\n').map((s) => stripTags(s).trim()).filter(Boolean);
  const first = lines.findIndex((s) => /^1[、.．]\s*\S/.test(s));
  if (first < 0) throw bad('未识别到从 1 开始的新闻列表，请改用结构化 JSON');
  const header = title + '\n' + lines.slice(0, first).join('\n');
  const dates = new Set([...header.matchAll(/(20\d{2})\s*(?:年|[-/])\s*(\d{1,2})\s*(?:月|[-/])\s*(\d{1,2})(?:日)?/g)]
    .map((m) => `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`));
  if (dates.size !== 1) throw bad('文章缺少唯一、完整的年月日；不使用服务器当天日期代替，请改用结构化 JSON');
  const parsedDate = editionDate([...dates][0], { now });
  const numbered = lines.slice(first).map((s) => /^(\d{1,2})[、.．]\s*(.+)$/.exec(s)).filter(Boolean);
  if (!numbered.length || numbered.some((m, i) => Number(m[1]) !== i + 1)) throw bad('新闻编号不连续，无法确定性解析');
  const tipLine = lines.find((s) => s.includes('【微语】'));
  const images = [...body.matchAll(/<img\b[^>]*>/gi)].map((m) => attrs(m[0])).map((a) => a['data-src'] || a.src).filter(Boolean);
  const candidate = images.length === 1 ? images[0] : null;
  return normalizeEdition({
    date: parsedDate, news: numbered.map((m) => m[2]), tip: tipLine?.replace(/^.*?【微语】\s*/, '') || null,
    image: image ?? candidate, cover: cover ?? meta.find((m) => m.property === 'og:image')?.content ?? null,
    link: source.href, source: '每天60秒读懂世界（微信文章，人工指定 URL）',
  }, { expectedDate: date, sourceUrl: source.href, method: 'wechat-url', now });
}

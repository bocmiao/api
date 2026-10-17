import { HttpError } from '../http.js';
import { downloadPublic } from './download.js';
import { normalizeEdition, parseWechatArticle, editionDate, publicSourceUrl, imageFormat, inlineImage, MAX_JSON_BYTES, MAX_IMAGE_BYTES } from './format.js';
import { news60sStore } from './store.js';

const utf8 = (bytes) => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new HttpError(502, '来源不是合法 UTF-8 文本'); }
};

export function sourceTemplate(value) {
  if (typeof value !== 'string' || value.length > 4000 || (value.match(/\{date\}/g)?.length ?? 0) > 1 || /[{}]/.test(value.replace('{date}', ''))) throw new HttpError(400, '来源须为完整 JSON URL，可包含一个 {date}');
  publicSourceUrl(value.replace('{date}', 'latest'));
  return value;
}

export function configuredSource(date, value = process.env.NEWS_60S_SOURCE_URL) {
  if (!value) throw new HttpError(503, '未配置 NEWS_60S_SOURCE_URL，请指定 JSON 文件、JSON URL 或微信文章 URL', 'NEWS60S_SOURCE_REQUIRED');
  sourceTemplate(value);
  if (value.includes('{date}')) return publicSourceUrl(value.replace('{date}', date ?? 'latest'));
  const u = new URL(publicSourceUrl(value));
  if (date) u.searchParams.set('date', date);
  return u.href;
}

// No scheduler or public GET calls this automatically. Only an admin session or
// the local operator CLI can initiate a source fetch and publication.
export async function updateNews60s(input = {}, { store = news60sStore(), download = downloadPublic, beforeCommit } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '更新输入须为 JSON 对象');
  const allowed = new Set(['data', 'url', 'articleUrl', 'date', 'image', 'cover']);
  if (Object.keys(input).some((k) => !allowed.has(k))) throw new HttpError(400, '未知更新字段');
  const modes = ['data', 'url', 'articleUrl'].filter((k) => input[k] != null);
  if (modes.length > 1) throw new HttpError(400, 'data、url、articleUrl 只能选择一种');
  if (input.date != null) editionDate(input.date);
  if (!input.articleUrl && (input.image != null || input.cover != null)) throw new HttpError(400, 'image/cover 覆盖仅用于文章 URL 模式；JSON 请放入 data 中');
  const snapshot = store.snapshot();
  let data;
  if (input.data != null) {
    if (Buffer.byteLength(JSON.stringify(input.data)) > MAX_JSON_BYTES) throw new HttpError(413, 'JSON 输入超过 256 KiB');
    data = normalizeEdition(input.data, { expectedDate: input.date });
  } else if (input.articleUrl != null) {
    const result = await download(publicSourceUrl(input.articleUrl), { maxBytes: 2 * 1024 * 1024, hosts: ['mp.weixin.qq.com'] });
    if (result.contentType !== 'text/html') throw new HttpError(502, '文章来源未返回 HTML');
    data = parseWechatArticle(utf8(result.bytes), { url: result.url, date: input.date, image: input.image, cover: input.cover });
  } else {
    let url;
    if (input.url != null) {
      url = sourceTemplate(input.url);
      url = configuredSource(input.date, url);
    } else url = configuredSource(input.date);
    const result = await download(url, { maxBytes: MAX_JSON_BYTES });
    if (!['application/json', 'text/json'].includes(result.contentType)) throw new HttpError(502, 'JSON 来源未返回 application/json');
    let raw;
    try { raw = JSON.parse(utf8(result.bytes)); } catch { throw new HttpError(502, '来源 JSON 无法解析'); }
    data = normalizeEdition(raw, { expectedDate: input.date, sourceUrl: result.url, method: 'json-url' });
  }
  const images = {};
  const downloaded = new Map();
  for (const slot of ['image', 'cover']) {
    const raw = data[slot];
    if (!raw) continue;
    if (!downloaded.has(raw)) {
      if (raw.startsWith('data:')) downloaded.set(raw, inlineImage(raw));
      else {
        const result = await download(raw, { maxBytes: MAX_IMAGE_BYTES });
        const image = imageFormat(result.bytes);
        if (result.contentType !== image.mime) throw new HttpError(502, '图片 Content-Type 与文件头不一致');
        downloaded.set(raw, { bytes: result.bytes, ...image });
      }
    }
    images[slot] = downloaded.get(raw);
  }
  return store.publish(data, images, { expectedRevision: snapshot.get(data.date) ?? null, beforeCommit });
}

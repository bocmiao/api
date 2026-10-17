import { HttpError, param, stripTags } from '../../lib/http.js';
import { todayBeijing } from './lunar.js';
import { news60sStore } from '../../lib/news60s/store.js';
import { config } from '../../config.js';

const cleanItem = (s) => stripTags(s).replace(/^\d+[、.．]\s*/, '').replace(/[；;]$/, '').trim();

export function parseViki60s(raw) {
  const d = raw?.data;
  if (!d || !Array.isArray(d.news) || !d.news.length) throw new HttpError(502, '60s 数据格式无法识别');
  return {
    date: d.date ?? null,
    weekday: d.day_of_week ?? null,
    lunarDate: d.lunar_date ?? null,
    news: d.news.map(cleanItem).filter(Boolean),
    tip: d.tip ? stripTags(d.tip) : null,
    image: d.image ?? null,
    cover: d.cover ?? null,
    link: d.link ?? null,
    source: '60s.viki.moe',
  };
}

// 知乎专栏文章正文：<p>1、xxx；</p>... <p>【微语】xxx</p>
export function parseZhihu60s(raw) {
  const item = raw?.data?.[0];
  if (!item?.content) throw new HttpError(502, '知乎专栏数据格式无法识别');
  const paras = [...item.content.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => stripTags(m[1])).filter(Boolean);
  const news = paras.filter((p) => /^\d+[、.．]/.test(p)).map(cleanItem);
  const tipPara = paras.find((p) => p.includes('【微语】'));
  if (!news.length) throw new HttpError(502, '知乎专栏数据格式无法识别');
  const created = item.created ?? item.updated;
  return {
    date: created ? todayBeijing(created * 1000) : null,
    weekday: null,
    lunarDate: null,
    news,
    tip: tipPara ? tipPara.replace(/^.*?【微语】\s*/, '') : null,
    image: item.image_url || null,
    cover: item.image_url || null,
    link: item.url ?? null,
    source: 'zhihu.com',
  };
}

// 供推送复用
export async function loadDaily60s(date) {
  const result = await news60sStore().read(date);
  const data = { ...result.data };
  for (const key of ['image', 'cover']) if (data[key] && config.publicUrl) data[key] = config.publicUrl + data[key];
  return { ...result, data };
}

export default {
  name: 'news-60s',
  category: 'life',
  title: '60 秒读懂世界',
  description: '已发布的自有新闻简报与微语；按日期查询，更新失败保留旧版',
  source: '本站持久数据（结构化导入、自有 JSON 源或人工指定微信文章）',
  unofficial: true,
  routes: [
    {
      method: 'GET',
      path: '/api/news/60s',
      summary: '获取每日 60 秒新闻简报',
      params: [{ name: 'date', desc: '日期 YYYY-MM-DD，留空取最新一期', example: '2026-09-24' }],
      fields: [
        { name: 'date', type: 'string', desc: '已校验的来源日期 YYYY-MM-DD；历史日期缺失返回 404，不回退最新' },
        { name: 'weekday', type: 'string|null', desc: '星期几，如 星期四；未提供时按日期计算' },
        { name: 'lunarDate', type: 'string|null', desc: '原来源提供的农历日期，未提供时为 null' },
        { name: 'news', type: 'array', desc: '新闻条目（字符串数组，通常 15 条），已去掉序号、HTML 标签和末尾分号' },
        { name: 'tip', type: 'string|null', desc: '微语（每日一句）；上游没有时为 null' },
        { name: 'image', type: 'string|null', desc: '已镜像到本站的图片地址；配置 PUBLIC_URL 时为绝对地址，否则为本站相对路径。没有时为 null' },
        { name: 'cover', type: 'string|null', desc: '已镜像到本站的封面地址；没有时为 null' },
        { name: 'link', type: 'string|null', desc: '原文公开链接；没有时为 null' },
        { name: 'source', type: 'string', desc: '原始内容来源归属；人工输入且未声明时为 人工录入' },
        { name: 'provenance', type: 'object', desc: '导入方法、来源网址与原图归属；自有存储不代表自有内容生产' },
        { name: 'provenance.method', type: 'string', desc: 'manual-json / json-url / wechat-url' },
        { name: 'provenance.url', type: 'string|null', desc: '实际读取的公开 JSON 或文章 URL；人工 JSON 为 null' },
        { name: 'provenance.image', type: 'string|null', desc: '镜像前的原图公开地址；内嵌图片或无图片时为 null' },
        { name: 'provenance.cover', type: 'string|null', desc: '镜像前的封面公开地址；内嵌图片或无封面时为 null' },
        { name: 'provenance.dateBasis', type: 'string', desc: 'supplied-date（结构化输入）或 article-visible-date（文章明确年月日）' },
      ],
      async handler({ query }) {
        const date = param(query, 'date', { pattern: /^\d{4}-\d{2}-\d{2}$/ });
        return loadDaily60s(date);
      },
    },
    {
      method: 'GET', path: '/api/news/60s/assets/:revision/:file', raw: true,
      summary: '读取已发布版本的本地镜像图片',
      params: [
        { name: 'revision', in: 'path', desc: '发布版本 UUID', required: true },
        { name: 'file', in: 'path', desc: 'SHA-256 文件名及 raster 图片扩展名', required: true },
      ],
      returns: '本地 PNG/JPEG/WebP/GIF；不可变版本地址，带 ETag、nosniff 和长期缓存；不存在返回 404',
      async handler({ params, req }) {
        const asset = await news60sStore().asset(params.revision, params.file);
        const unchanged = req?.headers?.['if-none-match'] === asset.etag;
        return { status: unchanged ? 304 : 200, body: unchanged ? '' : asset.bytes,
          headers: { 'content-type': asset.mime, etag: asset.etag, 'cache-control': 'public, max-age=31536000, immutable' } };
      },
    },
  ],
};

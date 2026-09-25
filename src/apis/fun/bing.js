import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError, param } from '../../lib/http.js';

const TTL_MS = 30 * 60_000;
const MKT_RE = /^[a-z]{2}-[A-Z]{2}$/;

const hostFor = (mkt) => (mkt === 'zh-CN' ? 'https://cn.bing.com' : 'https://www.bing.com');

const abs = (host, u) => (!u ? null : /^https?:\/\//.test(u) ? u : `${host}${u.startsWith('/') ? '' : '/'}${u}`);

const fmtDate = (s) => (/^\d{8}$/.test(s ?? '') ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null);

// HPImageArchive.aspx?format=js 响应：{ images: [{ startdate, enddate, url, urlbase, copyright, copyrightlink, title, hsh }] }
export function parseBing(raw, { mkt = 'zh-CN' } = {}) {
  const images = raw?.images;
  if (!Array.isArray(images)) throw new HttpError(502, 'Bing 返回的数据格式无法识别');
  const host = hostFor(mkt);
  return images.map((img) => {
    // copyright 形如 "标题说明 (© 作者/图库)"
    const m = /^(.*?)\s*[（(]\s*(©.*?)\s*[)）]\s*$/.exec(img.copyright ?? '');
    return {
      date: fmtDate(img.startdate),
      title: img.title || (m ? m[1] : null),
      description: m ? m[1] : img.copyright ?? null,
      copyright: img.copyright ?? null,
      author: m ? m[2] : null,
      url: abs(host, img.url),
      urlUHD: img.urlbase ? abs(host, `${img.urlbase}_UHD.jpg`) : null,
      url1080: img.urlbase ? abs(host, `${img.urlbase}_1920x1080.jpg`) : null,
      urlMobile: img.urlbase ? abs(host, `${img.urlbase}_1080x1920.jpg`) : null,
      urlbase: abs(host, img.urlbase),
      copyrightLink: img.copyrightlink && !/^javascript:/i.test(img.copyrightlink) ? abs(host, img.copyrightlink) : null,
      hash: img.hsh ?? null,
    };
  });
}

export function buildBingUrl({ idx = 0, n = 1, mkt = 'zh-CN' } = {}) {
  const qs = new URLSearchParams({ format: 'js', idx: String(idx), n: String(n), mkt });
  return `${hostFor(mkt)}/HPImageArchive.aspx?${qs}`;
}

export async function loadBing({ idx = 0, n = 1, mkt = 'zh-CN' } = {}) {
  return parseBing(await fetchJSON(buildBingUrl({ idx, n, mkt })), { mkt });
}

const bingCached = (opts) =>
  cache.wrap(`bing:${opts.mkt}:${opts.idx}:${opts.n}`, TTL_MS, () => loadBing(opts));

function readOpts(query) {
  return {
    idx: param(query, 'idx', { default: 0, int: true, min: 0, max: 7 }),
    n: param(query, 'n', { default: 1, int: true, min: 1, max: 8 }),
    mkt: param(query, 'mkt', { default: 'zh-CN', pattern: MKT_RE }),
  };
}

export default {
  name: 'bing',
  category: 'fun',
  title: 'Bing 每日壁纸',
  description: '必应首页每日一图，含 UHD 原图、版权与日期',
  source: 'Microsoft Bing',
  routes: [
    {
      method: 'GET',
      path: '/api/bing',
      summary: '获取 Bing 每日壁纸（最多往前 7 天）',
      params: [
        { name: 'idx', default: 0, desc: '往前偏移天数，0=今天，最大 7', example: '0' },
        { name: 'n', default: 1, desc: '返回张数 1~8', example: '3' },
        { name: 'mkt', default: 'zh-CN', desc: '市场/语言，例如 zh-CN、en-US、ja-JP', example: 'zh-CN' },
      ],
      fields: [
        {
          name: '[].date',
          type: 'string|null',
          desc: 'data 为壁纸数组，从 idx 那天起按日期从新到旧排列。本字段为壁纸日期（YYYY-MM-DD，按 mkt 市场的当地日期，zh-CN 即北京时间）；上游日期格式异常时为 null',
        },
        { name: '[].title', type: 'string|null', desc: '壁纸标题；上游标题为空时取 copyright 中 "(©…)" 之前的说明文字，两者都没有时为 null' },
        {
          name: '[].description',
          type: 'string|null',
          desc: '图片说明，即 copyright 去掉末尾 "(© 作者/图库)" 后的部分，如 "瑞士恩加丁山谷中的落叶松林"；copyright 不是这种格式时为完整 copyright，没有 copyright 时为 null',
        },
        { name: '[].copyright', type: 'string|null', desc: '上游原始版权文本，如 "瑞士恩加丁山谷中的落叶松林 (© Jane Doe/Getty Images)"；缺失时为 null' },
        { name: '[].author', type: 'string|null', desc: '版权归属（摄影师/图库），含 © 符号，如 "© Jane Doe/Getty Images"；copyright 中解析不到时为 null' },
        { name: '[].url', type: 'string|null', desc: 'Bing 默认尺寸图片的完整链接（1920×1080 横版 JPG）；缺失时为 null' },
        { name: '[].urlUHD', type: 'string|null', desc: 'UHD 超清原图链接（通常为 3840×2160，文件较大）；上游没有 urlbase 时为 null' },
        { name: '[].url1080', type: 'string|null', desc: '1920×1080 横版图片链接；上游没有 urlbase 时为 null' },
        { name: '[].urlMobile', type: 'string|null', desc: '1080×1920 竖版（手机壁纸）图片链接；上游没有 urlbase 时为 null' },
        {
          name: '[].urlbase',
          type: 'string|null',
          desc: '图片基础链接（不含尺寸后缀），后面拼接 "_宽x高.jpg" 可取其他尺寸，如 "_1366x768.jpg"、"_UHD.jpg"；缺失时为 null',
        },
        { name: '[].copyrightLink', type: 'string|null', desc: 'Bing 上介绍该图片的搜索页链接；上游未提供或为 javascript: 占位链接时为 null' },
        { name: '[].hash', type: 'string|null', desc: 'Bing 提供的图片哈希（32 位十六进制字符串），可用于去重；缺失时为 null' },
      ],
      async handler({ query }) {
        return bingCached(readOpts(query));
      },
    },
    {
      method: 'GET',
      path: '/api/bing/image',
      raw: true,
      summary: '302 跳转到 Bing 壁纸图片，可直接用作 <img> 地址',
      params: [
        { name: 'idx', default: 0, desc: '往前偏移天数，0=今天，最大 7', example: '0' },
        { name: 'mkt', default: 'zh-CN', desc: '市场/语言', example: 'zh-CN' },
        { name: 'uhd', default: 0, desc: '1=跳转 UHD 超清原图', example: '1' },
      ],
      returns:
        '302 跳转到 Bing 壁纸图片地址：默认为 1920×1080 横版 JPG，uhd=1 时为 UHD 超清原图（通常 3840×2160）。' +
        '响应头 Cache-Control: private, max-age=1800（30 分钟）；上游没有图片时返回 502 JSON 错误',
      async handler({ query }) {
        const { idx, mkt } = readOpts(query);
        const uhd = param(query, 'uhd', { default: '0', oneOf: ['0', '1'] }) === '1';
        const { data } = await bingCached({ idx, n: 1, mkt });
        const img = data[0];
        const location = (uhd ? img?.urlUHD : img?.url) ?? img?.url;
        if (!location) throw new HttpError(502, 'Bing 未返回图片');
        return { status: 302, headers: { location, 'cache-control': 'private, max-age=1800' }, body: '' };
      },
    },
  ],
};

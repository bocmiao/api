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
      async handler({ query }) {
        const { idx, mkt } = readOpts(query);
        const uhd = param(query, 'uhd', { default: '0', oneOf: ['0', '1'] }) === '1';
        const { data } = await bingCached({ idx, n: 1, mkt });
        const img = data[0];
        const location = (uhd ? img?.urlUHD : img?.url) ?? img?.url;
        if (!location) throw new HttpError(502, 'Bing 未返回图片');
        return { status: 302, headers: { location, 'cache-control': 'public, max-age=1800' }, body: '' };
      },
    },
  ],
};

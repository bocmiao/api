import { randomInt } from 'node:crypto';
import { sql } from '../../db.js';
import { HttpError, param } from '../../lib/http.js';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const CODE_LEN = 6;
const CODE_RE = /^[0-9A-Za-z]{1,16}$/;
const MAX_URL = 2048;

export function randomCode(len = CODE_LEN) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

// 校验并规范化目标网址，只允许 http/https
export function normalizeTarget(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new HttpError(400, '缺少参数 url');
  const input = raw.trim();
  if (input.length > MAX_URL) throw new HttpError(400, `url 过长（最多 ${MAX_URL} 个字符）`);
  let u;
  try {
    u = new URL(input);
  } catch {
    throw new HttpError(400, 'url 不是合法的网址');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, '只支持 http / https 网址');
  if (!u.hostname) throw new HttpError(400, 'url 不是合法的网址');
  if (u.href.length > MAX_URL) throw new HttpError(400, `url 过长（最多 ${MAX_URL} 个字符）`);
  return u.href;
}

// 优先 PUBLIC_URL，否则根据请求的 Host 推断
export function publicOrigin(req) {
  const env = process.env.PUBLIC_URL;
  if (env) return env.replace(/\/+$/, '');
  const headers = req?.headers ?? {};
  const host = String(headers['x-forwarded-host'] ?? headers.host ?? '').split(',')[0].trim();
  const safeHost = /^[A-Za-z0-9.\-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/.test(host) ? host : 'localhost';
  const fwdProto = String(headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const proto = fwdProto === 'https' || fwdProto === 'http' ? fwdProto : req?.socket?.encrypted ? 'https' : 'http';
  return `${proto}://${safeHost}`;
}

export function createShortLink(rawUrl, userId = null) {
  const url = normalizeTarget(rawUrl);
  const existing = sql('SELECT code FROM short_links WHERE url = ? ORDER BY created_at LIMIT 1').get(url);
  if (existing) return { code: existing.code, url, created: false };
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomCode();
    try {
      sql('INSERT INTO short_links (code, url, user_id) VALUES (?, ?, ?)').run(code, url, userId);
      return { code, url, created: true };
    } catch (err) {
      if (!/UNIQUE|constraint/i.test(String(err.message))) throw err;
    }
  }
  throw new HttpError(500, '生成短链失败，请重试');
}

export function resolveShortLink(code) {
  if (!CODE_RE.test(code ?? '')) return null;
  const row = sql('SELECT url FROM short_links WHERE code = ?').get(code);
  if (!row) return null;
  sql('UPDATE short_links SET hits = hits + 1 WHERE code = ?').run(code);
  return row.url;
}

const notFoundPage = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>短链接不存在</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding:4rem 1rem;color:#333">
<h1>404</h1><p>短链接不存在或已失效。</p><p><a href="/">返回首页</a></p></body></html>`;

export default {
  name: 'shorturl',
  category: 'tools',
  title: '短链接',
  description: '把长网址转换成短链接，并统计访问次数',
  source: '本站',
  routes: [
    {
      method: 'POST',
      path: '/api/shorturl',
      summary: '生成短链接（相同网址返回同一个短码）',
      params: [
        { name: 'url', in: 'body', required: true, desc: '目标网址，仅支持 http / https，最多 2048 个字符', example: 'https://github.com/nodejs/node' },
      ],
      fields: [
        { name: 'code', type: 'string', desc: '短码。新建时随机生成 6 位（0-9、A-Z、a-z）；该网址以前生成过短链时直接返回已有短码（同一网址始终对应最早生成的那个）' },
        { name: 'short', type: 'string', desc: '完整短链接，格式为 {站点地址}/s/{code}。站点地址取服务端配置的 PUBLIC_URL，未配置时按请求头 X-Forwarded-Proto / X-Forwarded-Host / Host 推断' },
        { name: 'url', type: 'string', desc: '规范化后的目标网址（按 URL 标准处理：域名转小写、中文域名转 punycode、空格等字符做百分号编码、只有域名时补 /，如 https://Example.com → https://example.com/）' },
      ],
      async handler({ body, user, req }) {
        const { code, url } = createShortLink(body?.url, user?.id ?? null);
        return { data: { code, short: `${publicOrigin(req)}/s/${code}`, url } };
      },
    },
    {
      method: 'GET',
      path: '/api/shorturl/stats',
      summary: '查询短链接的目标网址与访问次数',
      params: [{ name: 'code', required: true, desc: '短码', example: 'aB3dE9' }],
      fields: [
        { name: 'code', type: 'string', desc: '短码' },
        { name: 'short', type: 'string', desc: '完整短链接，格式为 {站点地址}/s/{code}，站点地址的取法同生成短链接口' },
        { name: 'url', type: 'string', desc: '目标网址（创建时规范化后的形式）' },
        { name: 'hits', type: 'number', desc: '累计跳转次数：每次通过 /s/{code} 成功跳转加 1，不去重（重复访问、爬虫、聊天软件的链接预览都会计入）；调用本接口不计入' },
        { name: 'createdAt', type: 'string', desc: '创建时间，ISO 8601 格式的 UTC 时间，精确到秒，如 2026-09-24T08:00:00Z' },
      ],
      async handler({ query, req }) {
        const code = param(query, 'code', { required: true, pattern: CODE_RE });
        const row = sql('SELECT code, url, hits, created_at FROM short_links WHERE code = ?').get(code);
        if (!row) throw new HttpError(404, '短链接不存在');
        return {
          data: {
            code: row.code,
            short: `${publicOrigin(req)}/s/${row.code}`,
            url: row.url,
            hits: row.hits,
            createdAt: `${row.created_at.replace(' ', 'T')}Z`,
          },
        };
      },
    },
    {
      method: 'GET',
      path: '/s/:code',
      summary: '短链接跳转（302 重定向到目标网址）',
      raw: true,
      returns: '短码存在时返回 HTTP 302 重定向：Location 头为目标网址，响应体为纯文本 Redirecting to {目标网址}（Content-Type: text/plain; charset=utf-8），'
        + '带 Cache-Control: no-store（浏览器不缓存，每次访问都经过本站），每次跳转访问次数加 1。'
        + '短码不存在或格式不合法（不是 1~16 位字母数字）时返回 HTTP 404 的 HTML 页面（Content-Type: text/html; charset=utf-8），'
        + '提示“短链接不存在或已失效”并附返回首页的链接。公开访问，不限流，也不记入调用日志。',
      public: true,
      params: [{ name: 'code', in: 'path', required: true, desc: '短码', example: 'aB3dE9' }],
      async handler({ params }) {
        const url = resolveShortLink(params?.code);
        if (!url) {
          return { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' }, body: notFoundPage };
        }
        return {
          status: 302,
          headers: { location: url, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
          body: `Redirecting to ${url}`,
        };
      },
    },
  ],
};

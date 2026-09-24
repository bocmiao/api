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

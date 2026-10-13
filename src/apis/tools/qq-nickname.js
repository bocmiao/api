import { cache } from '../../lib/cache.js';
import { HttpError, param } from '../../lib/http.js';
import { QQ_RE } from './qq-avatar.js';

const UPSTREAM = 'https://users.qzone.qq.com/fcg-bin/cgi_get_portrait.fcg';
const MAX_BYTES = 16 * 1024;

// 只记录结构类别，绝不记录响应正文、QQ 号或昵称。
export function portraitShape(raw) {
  const head = raw.trimStart();
  if (!head) return 'empty';
  if (/^<!doctype\s+html|^<html\b/i.test(head)) return 'html';
  if (head.startsWith('<')) return 'markup';
  if (/^portraitCallBack\s*\(/.test(head)) return 'portrait-callback';
  if (/^_Callback\s*\(/.test(head)) return 'error-callback';
  if (/^[a-z_$][\w$]*\s*\(/i.test(head)) return 'other-callback';
  if (head.startsWith('{') || head.startsWith('[')) return 'json-like';
  return 'other';
}

export function parsePortrait(raw, qq) {
  const match = /^\s*portraitCallBack\s*\(\s*(\{[\s\S]*\})\s*\)\s*;?\s*$/.exec(raw);
  if (!match) throw new HttpError(502, `QQ 昵称上游响应格式不可识别（结构：${portraitShape(raw)}）`);
  let data;
  try { data = JSON.parse(match[1]); } catch { throw new HttpError(502, 'QQ 昵称上游数据无效'); }
  const keys = data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data) : [];
  if (keys.length !== 1 || keys[0] !== qq || !Array.isArray(data[qq])) {
    throw new HttpError(502, 'QQ 昵称上游数据不匹配');
  }
  const nickname = data[qq][6];
  if (typeof nickname !== 'string' || !nickname.trim() || nickname.length > 100 || /[\u0000-\u001f\u007f\ufffd]/u.test(nickname)) {
    throw new HttpError(502, 'QQ 昵称暂不可确认');
  }
  return { qq, nickname: nickname.trim() };
}

export async function loadNickname(qq, fetcher = fetch) {
  if (!QQ_RE.test(qq)) throw new HttpError(400, 'qq 须为 5~12 位数字');
  const url = new URL(UPSTREAM);
  url.searchParams.set('get_nick', '1');
  url.searchParams.set('uins', qq);
  let response;
  try {
    response = await fetcher(url.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(4000),
      headers: { accept: 'text/plain,*/*;q=0.1' },
    });
  } catch (err) {
    throw new HttpError(err?.name === 'TimeoutError' ? 504 : 502, 'QQ 昵称上游连接失败或超时');
  }
  if (response.status >= 300 && response.status < 400) throw new HttpError(502, 'QQ 昵称上游发生重定向');
  if (response.status === 429) throw new HttpError(503, 'QQ 昵称上游请求受限');
  if (!response.ok) throw new HttpError(502, `QQ 昵称上游返回 HTTP ${response.status}`);
  const type = response.headers.get('content-type') ?? '';
  if (type && !/^(text\/|application\/(?:json|javascript|x-javascript))/i.test(type)) throw new HttpError(502, 'QQ 昵称上游内容类型错误');
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new HttpError(502, 'QQ 昵称上游响应过大');
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) {
        throw new HttpError(502, 'QQ 昵称上游响应过大');
      }
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(err?.name === 'TimeoutError' ? 504 : 502, 'QQ 昵称上游读取失败');
  }
  let raw;
  try {
    const bytes = Buffer.concat(chunks);
    const declared = /(?:^|;)\s*charset\s*=\s*["']?([^\s;"']+)/i.exec(type)?.[1]?.toLowerCase();
    const encodings = { 'utf-8': 'utf-8', utf8: 'utf-8', gbk: 'gbk', gb2312: 'gbk', gb18030: 'gb18030' };
    if (declared && !encodings[declared]) throw new Error('unknown charset');
    const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    if (bom && declared && encodings[declared] !== 'utf-8') throw new Error('charset conflicts with BOM');
    const encoding = bom ? 'utf-8' : (encodings[declared] ?? 'gbk');
    raw = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    // Without a charset, a valid UTF-8 body that decodes differently as GBK is ambiguous.
    if (!declared && !bom) {
      let utf8;
      try { utf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {}
      if (utf8 != null && utf8 !== raw) throw new Error('ambiguous charset');
    }
  }
  catch { throw new HttpError(502, 'QQ 昵称上游编码无效'); }
  try { return parsePortrait(raw, qq); }
  catch (err) {
    // 请求日志会保存错误信息；只附固定类别和状态，不附正文或个人资料。
    if (err instanceof HttpError) {
      const contentType = /^text\/html/i.test(type) ? 'html' : /^text\/plain/i.test(type) ? 'text' : /^application\/json/i.test(type) ? 'json' : 'other';
      err.message += `（HTTP ${response.status}，类型：${contentType}）`;
    }
    throw err;
  }
}

export default {
  name: 'qq-nickname',
  category: 'tools',
  title: 'QQ 昵称',
  description: '按 QQ 号尝试查询公开昵称；腾讯公开端点无稳定服务承诺，查询失败不代表账号不存在',
  source: '腾讯 Qzone 公开 portrait 端点（非正式、可能失效）',
  unofficial: true,
  routes: [{
    method: 'GET',
    path: '/api/qq/nickname',
    summary: '按 QQ 号查询公开昵称',
    params: [{ name: 'qq', required: true, desc: 'QQ 号，5~12 位数字', example: '10001' }],
    fields: [
      { name: 'qq', type: 'string', desc: 'QQ 号' },
      { name: 'nickname', type: 'string', desc: '上游返回的非空 QQ 空间昵称' },
    ],
    handler({ query }) {
      const qq = param(query, 'qq', { required: true, pattern: QQ_RE });
      return cache.wrap(`qq-nickname:${qq}`, 30 * 60_000, () => loadNickname(qq), { maxStaleMs: 0 });
    },
  }],
};

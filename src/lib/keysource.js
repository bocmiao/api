// API Key 来源限制：Key 写在网页里难免被人看到，限制只能从指定网站或服务器 IP 调用后，别人拿去也用不了。
// 每行一条规则：
//   example.com      该域名（不含子域名）的网页
//   *.example.com    所有子域名（不含 example.com 本身）
//   1.2.3.4 / 1.2.3.0/24 / 2408:8000::/32   服务器 IP 或 IP 段
// 规则为空时不限制。网页调用按 Origin / Referer 的域名匹配，服务器调用按请求 IP 匹配，满足任意一条即可。
import net from 'node:net';
import { HttpError } from './http.js';
import { parseIPv6 } from './netguard.js';

export const MAX_RULES = 20;
const DOMAIN_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const v4Int = (ip) => ip.split('.').reduce((n, x) => ((n << 8) | Number(x)) >>> 0, 0);

// 解析一条规则；不合法返回 null
export function parseRule(raw) {
  let s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  // 允许直接粘贴网址：https://www.example.com/path → www.example.com
  if (/^https?:\/\//.test(s)) {
    try { s = new URL(s).hostname; } catch { return null; }
  }
  const [addr, bitsRaw] = s.split('/');
  if (net.isIPv4(addr)) {
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 8 || bits > 32) return null;
    return { type: 'ip4', text: bits === 32 ? addr : `${addr}/${bits}`, base: v4Int(addr), bits };
  }
  if (net.isIPv6(addr)) {
    const bits = bitsRaw === undefined ? 128 : Number(bitsRaw);
    if (!Number.isInteger(bits) || bits < 16 || bits > 128) return null;
    return { type: 'ip6', text: bits === 128 ? addr : `${addr}/${bits}`, words: parseIPv6(addr), bits };
  }
  if (bitsRaw !== undefined || s.length > 253 || !DOMAIN_RE.test(s) || !s.replace(/^\*\./, '').includes('.')) return null;
  return { type: 'domain', text: s };
}

// 保存前校验并规范化：返回去重后的规则文本（每行一条），为空返回 null
export function normalizeRules(input) {
  const lines = (Array.isArray(input) ? input : String(input ?? '').split(/[\s,，;；]+/)).map((x) => String(x).trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const r = parseRule(line);
    if (!r) throw new HttpError(400, `来源限制「${line.slice(0, 60)}」格式不正确：请填写域名（如 example.com、*.example.com）或 IP（如 1.2.3.4、1.2.3.0/24）`);
    if (!out.includes(r.text)) out.push(r.text);
  }
  if (out.length > MAX_RULES) throw new HttpError(400, `来源限制最多 ${MAX_RULES} 条`);
  return out.length ? out.join('\n') : null;
}

function ipMatches(rule, ip) {
  const addr = String(ip ?? '').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
  if (rule.type === 'ip4') {
    if (!net.isIPv4(addr)) return false;
    const shift = 32 - rule.bits;
    return shift === 32 || (v4Int(addr) >>> shift) === (rule.base >>> shift);
  }
  const w = parseIPv6(addr);
  if (!w || !net.isIPv6(addr)) return false;
  for (let i = 0, left = rule.bits; left > 0; i++, left -= 16) {
    const mask = left >= 16 ? 0xffff : (0xffff << (16 - left)) & 0xffff;
    if ((w[i] & mask) !== (rule.words[i] & mask)) return false;
  }
  return true;
}

function hostMatches(rule, host) {
  if (!host) return false;
  if (rule.text.startsWith('*.')) return host.endsWith(rule.text.slice(1));
  return host === rule.text;
}

// 请求来自哪个网站：优先 Origin，其次 Referer
export function sourceHost(headers = {}) {
  for (const h of [headers.origin, headers.referer]) {
    if (!h || h === 'null') continue;
    try { return new URL(h).hostname.toLowerCase(); } catch { /* 忽略格式不对的头 */ }
  }
  return null;
}

// 不满足来源限制时抛 403
export function checkKeySource(allow, { ip, headers }) {
  if (!allow) return;
  const rules = String(allow).split('\n').map(parseRule).filter(Boolean);
  if (!rules.length) return;
  const host = sourceHost(headers);
  if (rules.some((r) => (r.type === 'domain' ? hostMatches(r, host) : ipMatches(r, ip)))) return;
  const err = new HttpError(403, host
    ? `该 API Key 设置了来源限制，不允许从 ${host} 调用`
    : `该 API Key 设置了来源限制，不允许从当前 IP（${ip}）调用`);
  err.code = 'KEY_SOURCE_DENIED';
  throw err;
}

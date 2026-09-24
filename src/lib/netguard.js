// 防 SSRF：只允许访问公网地址。
// 地址检查放在 DNS lookup 钩子里（连接时校验），避免"先解析检查、再请求"之间的 DNS 重绑定。
import dns from 'node:dns';
import net from 'node:net';
import https from 'node:https';
import http from 'node:http';
import { HttpError } from './http.js';

// ---------- IP 地址段检查 ----------

function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

const V4_BLOCKED = [
  ['0.0.0.0', 8], // 本网络
  ['10.0.0.0', 8], // 私有
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // 回环
  ['169.254.0.0', 16], // 链路本地
  ['172.16.0.0', 12], // 私有
  ['192.0.0.0', 24], // IETF 协议分配
  ['192.0.2.0', 24], // 文档
  ['192.88.99.0', 24], // 6to4 中继
  ['192.168.0.0', 16], // 私有
  ['198.18.0.0', 15], // 基准测试
  ['198.51.100.0', 24], // 文档
  ['203.0.113.0', 24], // 文档
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4], // 保留 + 广播
].map(([base, bits]) => [ipv4ToInt(base), bits]);

function isBlockedV4(ip) {
  const n = ipv4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)));
}

// 解析为 8 个 16 位整数；不合法返回 null
export function parseIPv6(ip) {
  let s = String(ip).replace(/^\[|\]$/g, '').split('%')[0];
  if (!net.isIPv6(s)) return null;
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    s = s.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const parts = (x) => (x ? x.split(':').map((h) => parseInt(h, 16)) : []);
  if (!s.includes('::')) return parts(s);
  const [a, b] = s.split('::');
  const h = parts(a);
  const r = parts(b);
  return [...h, ...new Array(8 - h.length - r.length).fill(0), ...r];
}

const wordsToV4 = (hi, lo) => `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;

function isBlockedV6(ip) {
  const w = parseIPv6(ip);
  if (!w) return true;
  const zeros = (a, b) => w.slice(a, b).every((x) => x === 0);
  // ::ffff:a.b.c.d 映射地址、::a.b.c.d 兼容地址
  if (zeros(0, 5) && w[5] === 0xffff) return isBlockedV4(wordsToV4(w[6], w[7]));
  if (zeros(0, 6)) return true; // :: 、::1 、IPv4 兼容地址
  if (zeros(0, 4) && w[4] === 0xffff && w[5] === 0) return true; // ::ffff:0:a.b.c.d (SIIT)
  // NAT64 64:ff9b::/96 看内嵌的 IPv4
  if (w[0] === 0x64 && w[1] === 0xff9b && zeros(2, 6)) return isBlockedV4(wordsToV4(w[6], w[7]));
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) return true; // 64:ff9b:1::/48 本地
  // 6to4 2002::/16 看内嵌的 IPv4
  if (w[0] === 0x2002) return isBlockedV4(wordsToV4(w[1], w[2]));
  // 只允许全球单播 2000::/3
  if ((w[0] & 0xe000) !== 0x2000) return true;
  if (w[0] === 0x2001 && w[1] < 0x0200) return true; // 2001::/23 IETF 协议分配（含 Teredo）
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true; // 文档
  if (w[0] === 0x3fff && (w[1] & 0xf000) === 0) return true; // 3fff::/20 文档
  return false;
}

// 是否为不允许访问的地址（私有、回环、链路本地、CGNAT、组播、保留等）；非法 IP 也视为不允许
export function isBlockedIP(ip) {
  const v = net.isIP(String(ip).replace(/^\[|\]$/g, '').split('%')[0]);
  if (v === 4) return isBlockedV4(ip);
  if (v === 6) return isBlockedV6(ip);
  return true;
}

// ---------- 安全请求 ----------

// 在建立连接时校验解析结果，避免 DNS rebinding 绕过预检查
export const makeLookup = (blocked) => function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addrs) => {
    if (err) return callback(err);
    if (!addrs.length || addrs.some((a) => blocked(a.address))) {
      const e = new Error('blocked address');
      e.code = 'EBLOCKED';
      return callback(e);
    }
    if (options.all) return callback(null, addrs);
    return callback(null, addrs[0].address, addrs[0].family);
  });
};

export function checkUrl(raw, blocked = isBlockedIP) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, 'url 不是合法的网址');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, '只支持 http / https 网址');
  if (u.username || u.password) throw new HttpError(400, '网址中不能包含用户名或密码');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && blocked(host)) throw new HttpError(400, '不允许访问内网或保留地址');
  if (!net.isIP(host) && (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.'))) {
    throw new HttpError(400, '不允许访问内网或保留地址');
  }
  u.hash = '';
  return u;
}

// 以安全方式 POST JSON（用于用户自定义的 Webhook / Bark 服务器），不跟随跳转
export function safePostJson(rawUrl, payload, { timeoutMs = 10_000 } = {}) {
  const u = checkUrl(rawUrl);
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method: 'POST',
      lookup: makeLookup(isBlockedIP),
      agent: false,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', 'content-length': body.length, 'user-agent': 'api-hub-notify/1.0' },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size <= 64_000) chunks.push(c); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode} ${text.slice(0, 200)}`));
        try { resolve(JSON.parse(text)); } catch { resolve(null); }
      });
    });
    req.on('error', (e) => reject(e.code === 'EBLOCKED' ? new HttpError(400, '不允许访问内网或保留地址') : e));
    req.end(body);
  });
}

// 仅做静态校验（配置保存时）：协议、凭据、IP 字面量与 localhost
export async function assertPublicUrl(raw) {
  return checkUrl(raw);
}

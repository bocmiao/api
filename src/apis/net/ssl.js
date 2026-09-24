import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { HttpError, param } from '../../lib/http.js';
import { createGate, requireHost, isBlockedIP, makeLookup, BLOCKED_MSG, reasonOf, since } from './common.js';

const TIMEOUT_MS = 5000;
const DAY_MS = 86_400_000;
const gate = createGate(20);

// ---------- DER：读取证书的签名算法 ----------

const SIG_ALGS = {
  '1.2.840.113549.1.1.4': 'md5WithRSAEncryption',
  '1.2.840.113549.1.1.5': 'sha1WithRSAEncryption',
  '1.2.840.113549.1.1.10': 'RSASSA-PSS',
  '1.2.840.113549.1.1.11': 'sha256WithRSAEncryption',
  '1.2.840.113549.1.1.12': 'sha384WithRSAEncryption',
  '1.2.840.113549.1.1.13': 'sha512WithRSAEncryption',
  '1.2.840.10045.4.1': 'ecdsa-with-SHA1',
  '1.2.840.10045.4.3.2': 'ecdsa-with-SHA256',
  '1.2.840.10045.4.3.3': 'ecdsa-with-SHA384',
  '1.2.840.10045.4.3.4': 'ecdsa-with-SHA512',
  '1.3.101.112': 'Ed25519',
  '1.3.101.113': 'Ed448',
  '1.2.156.10197.1.501': 'SM2-with-SM3',
};

function readTLV(buf, off) {
  if (off + 2 > buf.length) return null;
  const tag = buf[off];
  let len = buf[off + 1];
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4 || off + 2 + n > buf.length) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[off + 2 + i];
    hdr += n;
  }
  const start = off + hdr;
  const end = start + len;
  return end > buf.length ? null : { tag, start, end };
}

export function decodeOid(bytes) {
  const parts = [];
  let v = 0;
  for (const b of bytes) {
    v = v * 128 + (b & 0x7f);
    if (b & 0x80) continue;
    if (parts.length) parts.push(v);
    else parts.push(v < 80 ? Math.floor(v / 40) : 2, v < 80 ? v % 40 : v - 80);
    v = 0;
  }
  return parts.join('.');
}

// Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm AlgorithmIdentifier, signature }
// 返回常见算法名（如 sha256WithRSAEncryption、ecdsa-with-SHA256），不认识的返回点分 OID，结构异常返回 null
export function signatureAlgorithmOf(der) {
  if (!Buffer.isBuffer(der)) return null;
  const outer = readTLV(der, 0);
  if (outer?.tag !== 0x30) return null;
  const tbs = readTLV(der, outer.start);
  if (tbs?.tag !== 0x30) return null;
  const alg = readTLV(der, tbs.end);
  if (alg?.tag !== 0x30) return null;
  const oid = readTLV(der, alg.start);
  if (oid?.tag !== 0x06) return null;
  const dotted = decodeOid(der.subarray(oid.start, oid.end));
  return SIG_ALGS[dotted] ?? dotted;
}

// ---------- 证书信息整理 ----------

// "DNS:a.com, DNS:*.a.com, IP Address:1.2.3.4" → { dns: [...], ip: [...] }；含逗号等特殊字符的值 Node 会用 JSON 字符串加引号。
// 证书内容由对方服务器控制，这里手写线性扫描，不用可能回溯的正则
export function parseSan(s) {
  const out = { dns: [], ip: [] };
  if (!s) return out;
  const str = String(s);
  let i = 0;
  while (i < str.length) {
    while (str[i] === ' ' || str[i] === ',') i++;
    const colon = str.indexOf(':', i);
    if (colon === -1) break;
    const type = str.slice(i, colon);
    i = colon + 1;
    let value;
    if (str[i] === '"') {
      let j = i + 1;
      while (j < str.length && str[j] !== '"') j += str[j] === '\\' ? 2 : 1;
      try {
        value = JSON.parse(str.slice(i, j + 1));
      } catch {
        value = str.slice(i + 1, j);
      }
      i = j + 1;
    } else {
      const comma = str.indexOf(',', i);
      const end = comma === -1 ? str.length : comma;
      value = str.slice(i, end).trim();
      i = end;
    }
    if (type === 'DNS') out.dns.push(value);
    else if (type === 'IP Address') out.ip.push(value);
  }
  return out;
}

const pick = (v) => (Array.isArray(v) ? v.join(', ') : v ?? null);
const nameOf = (n = {}) => ({ cn: pick(n.CN), o: pick(n.O), c: pick(n.C) });

const CURVES = { prime256v1: 'P-256', secp384r1: 'P-384', secp521r1: 'P-521' };
function describeKey(x) {
  try {
    const k = x.publicKey;
    const d = k.asymmetricKeyDetails ?? {};
    if (k.asymmetricKeyType === 'rsa' || k.asymmetricKeyType === 'rsa-pss') return `RSA ${d.modulusLength}`;
    if (k.asymmetricKeyType === 'ec') return `EC ${CURVES[d.namedCurve] ?? d.namedCurve}`;
    if (k.asymmetricKeyType === 'ed25519') return 'Ed25519';
    if (k.asymmetricKeyType === 'ed448') return 'Ed448';
    return k.asymmetricKeyType ?? null;
  } catch {
    return null;
  }
}

const dateOf = (x, which) => x[`${which}Date`] ?? new Date(x[which]);
const daysLeft = (to, now) => Math.floor((to.getTime() - now) / DAY_MS);

// 从叶子证书沿 issuerCertificate 逐级向上，根证书的 issuerCertificate 指向自己
function walkChain(peer) {
  const chain = [];
  const seen = new Set();
  for (let c = peer; c?.raw && chain.length < 10; c = c.issuerCertificate) {
    if (seen.has(c.fingerprint256)) break;
    seen.add(c.fingerprint256);
    chain.push(c);
  }
  return chain;
}

// peer：socket.getPeerCertificate(true) 的结果；host：要校验覆盖的域名或 IP
export function summarizeCertificate(peer, { host, now = Date.now() }) {
  const x = new X509Certificate(peer.raw);
  const from = dateOf(x, 'validFrom');
  const to = dateOf(x, 'validTo');
  const san = parseSan(peer.subjectaltname);
  return {
    hostMatch: tls.checkServerIdentity(host, peer) === undefined,
    subject: nameOf(peer.subject),
    issuer: nameOf(peer.issuer),
    validFrom: from.toISOString(),
    validTo: to.toISOString(),
    daysRemaining: daysLeft(to, now),
    expired: to.getTime() < now,
    san: san.dns,
    sanIps: san.ip,
    serialNumber: String(peer.serialNumber ?? x.serialNumber).toUpperCase(),
    fingerprint256: peer.fingerprint256 ?? x.fingerprint256,
    signatureAlgorithm: signatureAlgorithmOf(peer.raw),
    publicKey: describeKey(x),
    chain: walkChain(peer).map((c) => {
      const cx = new X509Certificate(c.raw);
      const cTo = dateOf(cx, 'validTo');
      const n = nameOf(c.subject);
      return {
        cn: n.cn,
        o: n.o,
        issuer: nameOf(c.issuer).cn ?? nameOf(c.issuer).o,
        validTo: cTo.toISOString(),
        daysRemaining: daysLeft(cTo, now),
        selfSigned: cx.subject === cx.issuer,
      };
    }),
  };
}

// ---------- 连接 ----------

function handshake(h, port, { blocked, timeoutMs, ca }) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const socket = tls.connect({
      host: h.ip ?? h.host,
      port,
      servername: h.ip ? undefined : h.host,
      lookup: makeLookup(blocked),
      rejectUnauthorized: false,
      ALPNProtocols: ['h2', 'http/1.1'],
      ...(ca ? { ca } : {}),
    });
    socket.on('error', () => {}); // 兜底：销毁后的迟到错误不会变成未处理的 error 事件
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new HttpError(504, `TLS 连接超时（${timeoutMs / 1000} 秒）`));
    }, timeoutMs);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      try {
        const cipher = socket.getCipher();
        resolve({
          peer: socket.getPeerCertificate(true),
          protocol: socket.getProtocol() ?? null,
          cipher: cipher?.standardName ?? cipher?.name ?? null,
          authorized: socket.authorized === true,
          authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
          alpn: socket.alpnProtocol || null,
          ip: socket.remoteAddress ?? null,
          ms: since(t0),
        });
      } catch (err) {
        reject(err);
      } finally {
        socket.destroy();
      }
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      socket.destroy();
      if (err.code === 'EBLOCKED') return reject(new HttpError(400, BLOCKED_MSG));
      if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') return reject(new HttpError(400, '无法解析该域名'));
      return reject(new HttpError(502, `无法建立 TLS 连接：${reasonOf(err)}`));
    });
  });
}

// blocked、ca 仅供测试替换
export async function inspectCert(hostInput, port = 443, { blocked = isBlockedIP, timeoutMs = TIMEOUT_MS, ca, now = Date.now() } = {}) {
  const h = requireHost(hostInput, blocked);
  const r = await handshake(h, port, { blocked, timeoutMs, ca });
  if (!r.peer?.raw) throw new HttpError(502, '对方没有提供证书');
  return {
    host: h.host,
    port,
    ip: r.ip,
    servername: h.ip ? null : h.host,
    ms: r.ms,
    protocol: r.protocol,
    cipher: r.cipher,
    alpn: r.alpn,
    authorized: r.authorized,
    authorizationError: r.authorizationError,
    authorizationErrorText: r.authorizationError ? reasonOf({ code: r.authorizationError }) : null,
    ...summarizeCertificate(r.peer, { host: h.host, now }),
  };
}

export default {
  name: 'ssl-cert',
  category: 'net',
  title: 'SSL 证书查询',
  description: '连接目标 HTTPS 服务读取证书：颁发者、有效期、SAN、指纹、证书链、协议版本与是否可信',
  source: '目标服务器 TLS 握手',
  routes: [
    {
      method: 'GET',
      path: '/api/ssl',
      summary: '查询网站 SSL/TLS 证书信息',
      params: [
        { name: 'host', required: true, desc: '域名或公网 IP（也可直接粘贴网址，只取其中的域名）；不允许内网和保留地址', example: 'github.com' },
        { name: 'port', required: false, default: 443, desc: '端口，1~65535', example: 443 },
      ],
      fields: [
        { name: 'host', type: 'string', desc: '查询的主机（ASCII 形式，中文域名为 punycode）或 IP' },
        { name: 'port', type: 'number', desc: '连接的端口' },
        { name: 'ip', type: 'string|null', desc: '实际连接的服务器 IP；取不到时为 null' },
        { name: 'servername', type: 'string|null', desc: 'TLS 握手时发送的 SNI 主机名（即 host）；host 为 IP 时不发送 SNI，为 null' },
        { name: 'ms', type: 'number', desc: '从发起连接到 TLS 握手完成的耗时（毫秒，含 DNS 解析与 TCP 建连，保留两位小数）' },
        { name: 'protocol', type: 'string|null', desc: '协商的 TLS 协议版本，如 TLSv1.3、TLSv1.2；取不到时为 null' },
        { name: 'cipher', type: 'string|null', desc: '协商的加密套件（IANA 标准名，如 TLS_AES_128_GCM_SHA256、TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256）；取不到时为 null' },
        { name: 'alpn', type: 'string|null', desc: 'ALPN 协商结果：h2 表示支持 HTTP/2，http/1.1 表示只支持 HTTP/1.1；服务器不支持 ALPN 时为 null' },
        { name: 'authorized', type: 'boolean', desc: '证书是否可信：证书链能验证到系统信任的根证书、在有效期内且与 host 匹配时为 true' },
        { name: 'authorizationError', type: 'string|null', desc: '不可信的原因代码（OpenSSL / Node 错误码，如 CERT_HAS_EXPIRED、DEPTH_ZERO_SELF_SIGNED_CERT、UNABLE_TO_VERIFY_LEAF_SIGNATURE、ERR_TLS_CERT_ALTNAME_INVALID）；authorized 为 true 时为 null' },
        { name: 'authorizationErrorText', type: 'string|null', desc: '不可信原因的中文说明（如"证书已过期""自签名证书""证书与域名不匹配"）；authorized 为 true 时为 null' },
        { name: 'hostMatch', type: 'boolean', desc: '证书是否覆盖所查的 host：按 SAN 中的域名（支持 *.example.com 通配一级子域）或 IP 匹配，证书没有 SAN 时才看 subject CN' },
        { name: 'subject', type: 'object', desc: '证书主体（证书颁发给谁）' },
        { name: 'subject.cn', type: 'string|null', desc: '通用名称 CN（通常是主域名）；证书没有 CN 时为 null（新式证书可能只写 SAN）' },
        { name: 'subject.o', type: 'string|null', desc: '组织 O（OV / EV 证书才有，DV 证书通常为 null）' },
        { name: 'subject.c', type: 'string|null', desc: '国家代码 C（两位字母，如 US、CN）；没有时为 null' },
        { name: 'issuer', type: 'object', desc: '颁发者（签发这张证书的 CA）' },
        { name: 'issuer.cn', type: 'string|null', desc: '颁发者通用名称 CN（如 R11、Sectigo RSA Domain Validation Secure Server CA）；没有时为 null' },
        { name: 'issuer.o', type: 'string|null', desc: '颁发者组织 O（如 Let\'s Encrypt、DigiCert Inc）；没有时为 null' },
        { name: 'issuer.c', type: 'string|null', desc: '颁发者国家代码 C（两位字母）；没有时为 null' },
        { name: 'validFrom', type: 'string', desc: '生效时间，ISO 8601 UTC 格式（如 2026-01-01T00:00:00.000Z）' },
        { name: 'validTo', type: 'string', desc: '到期时间，ISO 8601 UTC 格式' },
        { name: 'daysRemaining', type: 'number', desc: '距到期的剩余天数（整数，向下取整）；已过期时为负数' },
        { name: 'expired', type: 'boolean', desc: '是否已过期（当前时间晚于 validTo）' },
        { name: 'san', type: 'array', desc: '证书 SAN（主体备用名称）中的域名列表，可能含通配符（如 *.github.com）；没有域名时为空数组' },
        { name: 'san[]', type: 'string', desc: '单个域名' },
        { name: 'sanIps', type: 'array', desc: 'SAN 中的 IP 地址列表（为 IP 签发的证书才有，如 1.1.1.1）；没有时为空数组' },
        { name: 'sanIps[]', type: 'string', desc: '单个 IP 地址' },
        { name: 'serialNumber', type: 'string', desc: '证书序列号（大写十六进制，不带分隔符）' },
        { name: 'fingerprint256', type: 'string', desc: '证书 SHA-256 指纹（大写十六进制，每字节用冒号分隔，共 32 字节）' },
        { name: 'signatureAlgorithm', type: 'string|null', desc: '证书签名算法（如 sha256WithRSAEncryption、ecdsa-with-SHA384）；不认识的算法为点分 OID；无法解析时为 null' },
        { name: 'publicKey', type: 'string|null', desc: '证书公钥类型与长度（如 RSA 2048、EC P-256、Ed25519）；无法识别时为 null' },
        { name: 'chain', type: 'array', desc: '证书链，从叶子证书（第一项）逐级到根证书；只包含服务器发送的证书和本机信任库中找到的根证书，服务器缺少中间证书时链会不完整' },
        { name: 'chain[].cn', type: 'string|null', desc: '该级证书的通用名称 CN；没有 CN 时为 null' },
        { name: 'chain[].o', type: 'string|null', desc: '该级证书的组织 O；没有时为 null' },
        { name: 'chain[].issuer', type: 'string|null', desc: '该级证书的颁发者 CN（没有 CN 时取颁发者 O）；都没有时为 null' },
        { name: 'chain[].validTo', type: 'string', desc: '该级证书的到期时间，ISO 8601 UTC 格式' },
        { name: 'chain[].daysRemaining', type: 'number', desc: '该级证书的剩余天数（整数，已过期为负数）' },
        { name: 'chain[].selfSigned', type: 'boolean', desc: '是否自签名（主体与颁发者相同），根证书为 true' },
      ],
      async handler({ query }) {
        const host = param(query, 'host', { required: true, max: 300 });
        const port = param(query, 'port', { default: 443, int: true, min: 1, max: 65535 });
        return { data: await gate(() => inspectCert(host, port)) };
      },
    },
  ],
};

// Minecraft Java 版服务器状态：从零实现 Server List Ping 协议（1.7+）。
// 流程：TCP 连接 → Handshake（next state = 1）→ Status Request → 读 Status Response（JSON）→ Ping → Pong 测延迟。
// 所有包的格式都是 [VarInt 包长][VarInt 包 id][数据]，字符串是 [VarInt 字节数][UTF-8]。
//
// SSRF 防护：host 为 IP 字面量时直接检查；域名先查 SRV（_minecraft._tcp.host），SRV 指向的目标同样要检查；
// 最后把目标域名解析成 IP（resolvePublic：解析结果只要有一个内网 / 保留地址就整体拒绝），之后只连这个 IP，不再二次解析。
// 端口只允许 1024~65535；单次查询总时长 5 秒，最多读 64KB。
import dns from 'node:dns';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { HttpError, param } from '../../lib/http.js';
import {
  createGate, parseHost, requireHost, resolvePublic, isBlockedIP, reasonOf, since, BLOCKED_MSG,
} from '../net/common.js';

export const DEFAULT_PORT = 25565;
export const MIN_PORT = 1024;
export const MAX_PORT = 65535;
export const TIMEOUT_MS = 5000;
export const MAX_BYTES = 64 * 1024;
// 协议号 -1：约定用于“只查状态、还不知道该用哪个版本”的场景，服务器会照常返回自己的版本
const STATUS_PROTOCOL = -1;
const MAX_SAMPLE = 20;
const MAX_MOTD_DEPTH = 32;

const gate = createGate(20);

// ---------- VarInt / 包编解码 ----------

export class McProtocolError extends Error {
  constructor(message) {
    super(message);
    this.code = 'EMCPROTO';
  }
}

// 32 位有符号整数 → VarInt（负数按补码处理，固定 5 字节）
export function encodeVarInt(value) {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw new RangeError('VarInt 超出 32 位整数范围');
  let v = value >>> 0;
  const out = [];
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

// 从 buf 的 offset 处读一个 VarInt。数据不完整返回 null；超过 5 字节抛 McProtocolError。
// 返回 { value, size }，value 为 32 位有符号整数
export function decodeVarInt(buf, offset = 0) {
  let result = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buf.length) return null;
    const b = buf[offset + i];
    result |= (b & 0x7f) << (7 * i);
    if (!(b & 0x80)) return { value: result | 0, size: i + 1 };
  }
  throw new McProtocolError('VarInt 超过 5 字节');
}

const encodeString = (s) => {
  const bytes = Buffer.from(s, 'utf8');
  return Buffer.concat([encodeVarInt(bytes.length), bytes]);
};

export function encodePacket(id, ...parts) {
  const body = Buffer.concat([encodeVarInt(id), ...parts]);
  return Buffer.concat([encodeVarInt(body.length), body]);
}

export function buildHandshake(host, port, protocol = STATUS_PROTOCOL) {
  const p = Buffer.alloc(2);
  p.writeUInt16BE(port);
  return encodePacket(0x00, encodeVarInt(protocol), encodeString(host), p, encodeVarInt(1));
}

export const buildStatusRequest = () => encodePacket(0x00);
export const buildPing = (payload) => encodePacket(0x01, payload);

// 从缓冲区头部取一个完整的包：不完整返回 null；包长不合法抛错。返回 { id, data, size }
export function readPacket(buf, maxBytes = MAX_BYTES) {
  const len = decodeVarInt(buf, 0);
  if (!len) return null;
  if (len.value < 1 || len.value > maxBytes) throw new McProtocolError('服务器返回的数据包长度不合法');
  if (buf.length < len.size + len.value) return null;
  const body = buf.subarray(len.size, len.size + len.value);
  const id = decodeVarInt(body, 0);
  if (!id) throw new McProtocolError('服务器返回的数据包不完整');
  return { id: id.value, data: body.subarray(id.size), size: len.size + len.value };
}

// Status Response 的数据部分：[VarInt 字节数][UTF-8 JSON]
export function parseStatusPacket(data) {
  const len = decodeVarInt(data, 0);
  if (!len || len.value < 0 || len.size + len.value > data.length) throw new McProtocolError('服务器返回的状态数据不完整');
  const text = data.subarray(len.size, len.size + len.value).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new McProtocolError('服务器返回的状态信息不是合法的 JSON');
  }
}

// ---------- MOTD / 状态解析 ----------

// 去掉 § 格式代码（颜色 §0-§f、样式 §k-§o、重置 §r，以及 1.16+ 十六进制颜色 §x§r§r§g§g§b§b）
export const stripFormatting = (s) => String(s ?? '').replace(/§[\s\S]?/g, '');

// JSON chat 组件 → 文本（保留组件里的 § 代码，由 stripFormatting 统一去掉）。
// 组件可以是字符串、数组（依次拼接）或对象（text / translate + with / extra）
export function chatToText(component, depth = 0) {
  if (component == null || depth > MAX_MOTD_DEPTH) return '';
  if (typeof component === 'string') return component;
  if (typeof component === 'number' || typeof component === 'boolean') return String(component);
  if (Array.isArray(component)) return component.map((c) => chatToText(c, depth + 1)).join('');
  if (typeof component !== 'object') return '';
  let s = '';
  if (component.text != null) s += chatToText(component.text, depth + 1);
  else if (typeof component.translate === 'string') {
    // 服务器很少用 translate；没有语言文件可查，用 fallback 或键名 + 参数兜底
    s += component.fallback ?? [component.translate, ...(component.with ?? []).map((w) => chatToText(w, depth + 1))].join(' ');
  }
  if (Array.isArray(component.extra)) s += component.extra.map((c) => chatToText(c, depth + 1)).join('');
  return s;
}

const tidy = (s) => s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).join('\n').trim();

// 返回 { text: 纯文本, raw: 原始内容（字符串原样保留 § 代码；JSON 组件序列化为 JSON 字符串） }
export function parseMotd(description) {
  const raw = typeof description === 'string' ? description : JSON.stringify(description ?? '');
  return { text: tidy(stripFormatting(chatToText(description))), raw };
}

const toInt = (v) => (Number.isFinite(v) ? Math.trunc(v) : null);

export function normalizeStatus(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) throw new McProtocolError('服务器返回的状态信息格式不对');
  const v = status.version ?? {};
  const p = status.players ?? {};
  const sample = Array.isArray(p.sample) ? p.sample : [];
  const favicon = typeof status.favicon === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=\s]+$/.test(status.favicon)
    ? status.favicon.replace(/\s+/g, '')
    : null;
  return {
    version: { name: stripFormatting(v.name ?? '').trim(), protocol: toInt(v.protocol) },
    players: {
      online: toInt(p.online) ?? 0,
      max: toInt(p.max) ?? 0,
      sample: sample.slice(0, MAX_SAMPLE)
        .filter((x) => x && typeof x === 'object')
        .map((x) => ({ name: stripFormatting(x.name ?? '').trim(), id: typeof x.id === 'string' ? x.id : null })),
    },
    motd: parseMotd(status.description ?? ''),
    favicon,
  };
}

// ---------- 连接 ----------

// 对一个已检查过的 IP 做一次状态查询。成功返回 { status（原始 JSON）, latency（毫秒，Pong 没回来时为 null） }，
// 失败抛错（连接错误 / 超时 / 协议错误 / 超过读取上限）。
// handshakeHost 是写进握手包的主机名（服务器端的虚拟主机、代理分流会用到），不参与连接。
export function queryStatus(ip, port, { handshakeHost = ip, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: ip, port });
    let buf = Buffer.alloc(0);
    let received = 0;
    let status = null;
    let pingPayload = null;
    let pingAt = 0;
    let finished = false;
    const done = (err, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    // 状态已经拿到、只是等不到 Pong 时，照常返回，延迟记为 null
    const giveUp = (err) => (status ? done(null, { status, latency: null }) : done(err));
    const timer = setTimeout(
      () => giveUp(Object.assign(new Error('timeout'), { code: 'EMCTIMEOUT' })),
      timeoutMs,
    );
    socket.on('connect', () => {
      socket.write(Buffer.concat([buildHandshake(handshakeHost, port), buildStatusRequest()]));
    });
    socket.on('data', (chunk) => {
      if (finished) return;
      received += chunk.length;
      if (received > maxBytes) return giveUp(Object.assign(new McProtocolError(`服务器返回的数据超过 ${Math.round(maxBytes / 1024)}KB 上限`), { code: 'EMCTOOLARGE' }));
      buf = Buffer.concat([buf, chunk]);
      try {
        for (;;) {
          const pkt = readPacket(buf, maxBytes);
          if (!pkt) return;
          buf = buf.subarray(pkt.size);
          if (!status) {
            if (pkt.id !== 0x00) throw new McProtocolError('服务器没有返回状态信息');
            status = parseStatusPacket(pkt.data);
            pingPayload = randomBytes(8);
            pingAt = performance.now();
            socket.write(buildPing(pingPayload));
          } else if (pkt.id === 0x01 && pkt.data.length === 8 && pkt.data.equals(pingPayload)) {
            return done(null, { status, latency: Math.max(0, Math.round(since(pingAt))) });
          }
        }
      } catch (err) {
        return giveUp(err);
      }
    });
    socket.on('error', (err) => giveUp(err));
    socket.on('close', () => giveUp(Object.assign(new Error('closed'), { code: 'EMCCLOSED' })));
  });
}

// 失败原因的中文说明
export function offlineReason(err, timeoutMs = TIMEOUT_MS) {
  if (err?.code === 'EMCTIMEOUT') return `查询超时（${timeoutMs / 1000} 秒内没有收到完整的状态信息）`;
  if (err?.code === 'EMCCLOSED') return '连接被服务器关闭，没有返回状态信息（可能不是 Minecraft Java 版服务器，或版本低于 1.7）';
  if (err?.code === 'EMCTOOLARGE') return err.message;
  if (err instanceof McProtocolError) return `${err.message}（可能不是 Minecraft Java 版服务器）`;
  return reasonOf(err);
}

// ---------- 主机 / 端口 / SRV ----------

// 支持 host:port、[IPv6]:port 写法。返回 { host, port }，port 未写时为 null
export function splitHostPort(input) {
  const s = String(input ?? '').trim();
  const v6 = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6) return { host: v6[1], port: v6[2] != null ? Number(v6[2]) : null };
  const m = s.match(/^([^:]+):(\d+)$/);
  if (m) return { host: m[1], port: Number(m[2]) };
  return { host: s, port: null };
}

export function checkPort(port, what = 'port') {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new HttpError(400, `${what} 须为 ${MIN_PORT}~${MAX_PORT} 之间的整数`);
  }
  return port;
}

const defaultResolveSrv = (name) => dns.promises.resolveSrv(name);

// 查 SRV 记录：取 priority 最小、weight 最大的一条；没有记录或查询失败返回 null（按原主机和默认端口连接）
export async function lookupSrv(host, { resolveSrv = defaultResolveSrv, timeoutMs = TIMEOUT_MS } = {}) {
  let timer;
  try {
    const records = await Promise.race([
      resolveSrv(`_minecraft._tcp.${host}`),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    if (!Array.isArray(records) || !records.length) return null;
    const best = [...records].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || (b.weight ?? 0) - (a.weight ?? 0))[0];
    const name = String(best.name ?? '').replace(/\.$/, '');
    if (!name) return null; // 目标为 "." 表示该域名不提供此服务
    return { name, port: best.port };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 对外入口 ----------

// hostInput 可带端口（host:port）；port 显式指定时不查 SRV（与游戏客户端一致）。
// blocked / resolveSrv 仅供测试替换。内网目标抛 400；连不上、超时、协议不对都返回 online: false。
export async function mcStatus(hostInput, {
  port = null, blocked = isBlockedIP, resolveSrv = defaultResolveSrv, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES,
} = {}) {
  const split = splitHostPort(hostInput);
  const h = requireHost(split.host, blocked);
  const explicitPort = port ?? split.port;
  if (explicitPort != null) checkPort(explicitPort);
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(1, deadline - Date.now());

  let target = h;
  let targetPort = explicitPort ?? DEFAULT_PORT;
  let srv = null;
  if (explicitPort == null && !h.ip) {
    const rec = await lookupSrv(h.host, { resolveSrv, timeoutMs: left() });
    if (rec) {
      const t = parseHost(rec.name);
      if (!t) throw new HttpError(400, `SRV 记录指向的主机不合法：${rec.name}`);
      if (t.local || (t.ip && blocked(t.ip))) throw new HttpError(400, BLOCKED_MSG);
      checkPort(rec.port, 'SRV 记录指向的端口');
      target = t;
      targetPort = rec.port;
      srv = { target: t.host, port: rec.port };
    }
  }

  const base = { host: h.host, port: targetPort, ip: null, srv };
  const offline = (error) => ({
    ...base, online: false, error, version: null, players: null, motd: null, favicon: null, latency: null,
  });

  let addr;
  try {
    addr = await resolvePublic(target, { blocked, timeoutMs: left() });
  } catch (err) {
    if (err instanceof HttpError && err.message === BLOCKED_MSG) throw err;
    return offline(err.message);
  }
  base.ip = addr.address;

  try {
    const { status, latency } = await queryStatus(addr.address, targetPort, { handshakeHost: h.host, timeoutMs: left(), maxBytes });
    return { ...base, online: true, error: null, ...normalizeStatus(status), latency };
  } catch (err) {
    return offline(offlineReason(err, timeoutMs));
  }
}

export default {
  name: 'mc-server',
  category: 'games',
  title: 'Minecraft 服务器状态',
  description: '查询 Minecraft Java 版服务器是否在线、版本、在线人数、玩家样例、MOTD、服务器图标和延迟；支持 SRV 记录，连不上时返回 online: false',
  source: '本服务器直接连接（Server List Ping 协议）',
  routes: [
    {
      method: 'GET',
      path: '/api/mc/server',
      summary: '查询 Minecraft Java 版服务器状态',
      params: [
        { name: 'host', required: true, desc: '服务器地址（域名或公网 IP，可写成 host:port）；不允许内网和保留地址', example: 'mc.hypixel.net' },
        { name: 'port', required: false, default: DEFAULT_PORT, desc: `端口，${MIN_PORT}~${MAX_PORT}。不传且 host 是域名时先查 SRV 记录（_minecraft._tcp.host），没有 SRV 再用 ${DEFAULT_PORT}；传了就不查 SRV`, example: '25565' },
      ],
      fields: [
        { name: 'host', type: 'string', desc: '查询的主机（ASCII 形式，中文域名为 punycode）或 IP' },
        { name: 'port', type: 'number', desc: '实际连接的端口（用了 SRV 记录时为 SRV 指向的端口）' },
        { name: 'ip', type: 'string|null', desc: '实际连接的 IP；域名解析失败时为 null' },
        { name: 'srv', type: 'object|null', desc: '使用的 SRV 记录；没有 SRV 记录或显式指定了端口时为 null' },
        { name: 'srv.target', type: 'string', desc: 'SRV 记录指向的主机' },
        { name: 'srv.port', type: 'number', desc: 'SRV 记录指向的端口' },
        { name: 'online', type: 'boolean', desc: '是否在线（成功拿到状态信息）' },
        { name: 'error', type: 'string|null', desc: '离线原因的中文说明（如“连接被拒绝（端口未开放或服务未启动）”“查询超时”）；在线时为 null' },
        { name: 'version', type: 'object|null', desc: '服务器版本；离线时为 null' },
        { name: 'version.name', type: 'string', desc: '版本名（已去掉 § 格式代码），如“1.21.4”或代理服务器自定义的名称' },
        { name: 'version.protocol', type: 'number|null', desc: '协议号，如 769；服务器没给时为 null' },
        { name: 'players', type: 'object|null', desc: '玩家信息；离线时为 null' },
        { name: 'players.online', type: 'number', desc: '在线人数' },
        { name: 'players.max', type: 'number', desc: '人数上限' },
        { name: 'players.sample', type: 'array', desc: `服务器提供的在线玩家样例（最多 ${MAX_SAMPLE} 个）；很多服务器不提供或用它显示自定义文字` },
        { name: 'players.sample[].name', type: 'string', desc: '玩家名（已去掉 § 格式代码）' },
        { name: 'players.sample[].id', type: 'string|null', desc: '玩家 UUID；没给时为 null' },
        { name: 'motd', type: 'object|null', desc: '服务器描述（MOTD）；离线时为 null' },
        { name: 'motd.text', type: 'string', desc: '纯文本：JSON 聊天组件已展开拼接，§ 颜色 / 格式代码已去掉，每行首尾空白已去掉，多行用 \\n 分隔' },
        { name: 'motd.raw', type: 'string', desc: '原始内容：服务器返回字符串时原样保留（含 § 代码）；返回 JSON 聊天组件时为该组件的 JSON 字符串' },
        { name: 'favicon', type: 'string|null', desc: '服务器图标（64×64 PNG 的 data URI，可直接用作 img 的 src）；没有图标时为 null' },
        { name: 'latency', type: 'number|null', desc: 'Ping/Pong 往返延迟（毫秒，本服务器到目标服务器）；服务器不响应 Ping 或离线时为 null' },
      ],
      async handler({ query }) {
        const host = param(query, 'host', { required: true, max: 300 });
        const raw = query.get('port');
        const port = raw == null || raw === '' ? null : param(query, 'port', { int: true, min: MIN_PORT, max: MAX_PORT });
        return { data: await gate(() => mcStatus(host, { port })) };
      },
    },
  ],
};

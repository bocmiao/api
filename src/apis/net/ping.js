import net from 'node:net';
import { execFile } from 'node:child_process';
import { HttpError, param } from '../../lib/http.js';
import { createGate, requireHost, resolvePublic, isBlockedIP, BLOCKED_MSG, round2 } from './common.js';
import { connectOnce, summarize } from './tcping.js';

// 每个 ping 都是一个子进程，并发上限比其他接口更低
export const gate = createGate(5);
export const UNSUPPORTED_MSG = '服务器不支持 ICMP Ping，可改用 /api/tcping';

const num = (s) => (s == null ? null : Number(s));

// 解析 Linux ping 的输出，兼容 iputils 和 busybox 两种格式：
//   iputils: 64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=1.52 ms
//            4 packets transmitted, 4 received, 0% packet loss, time 3004ms
//            rtt min/avg/max/mdev = 1.380/1.487/1.610/0.086 ms
//   busybox: 64 bytes from 1.1.1.1: seq=0 ttl=57 time=1.523 ms   （seq 从 0 开始）
//            4 packets transmitted, 3 packets received, 25% packet loss
//            round-trip min/avg/max = 1.380/1.504/1.610 ms
// 没有统计行时返回 null。results 按 seq（从 1 开始）列出每一次，没有收到回复的记为失败。
export function parsePing(output) {
  const text = String(output ?? '');
  const sent = /(\d+) packets transmitted/.exec(text);
  if (!sent) return null;
  const busybox = /packets received/.test(text) || /round-trip/.test(text) || /: seq=\d+/.test(text);
  const transmitted = Number(sent[1]);
  const received = Number(/(\d+) (?:packets )?received/.exec(text)?.[1] ?? 0);
  const loss = /([\d.]+)% packet loss/.exec(text);

  const replies = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (/\(DUP!\)/.test(line)) continue;
    const m = /bytes from (.+?): (?:icmp_)?seq=(\d+) ttl=(\d+) time[=<]([\d.]+) ?ms/.exec(line);
    if (!m) continue;
    const seq = Number(m[2]) + (busybox ? 1 : 0);
    if (!replies.has(seq)) replies.set(seq, { ttl: Number(m[3]), ms: Number(m[4]) });
  }

  const results = [];
  for (let seq = 1; seq <= transmitted; seq++) {
    const r = replies.get(seq);
    results.push(r ? { seq, ok: true, ttl: r.ttl, ms: r.ms } : { seq, ok: false, ttl: null, ms: null });
  }
  const times = results.filter((r) => r.ok).map((r) => r.ms);
  const rtt = /(?:rtt|round-trip) min\/avg\/max(?:\/(?:mdev|stddev))? = ([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(text);
  return {
    format: busybox ? 'busybox' : 'iputils',
    sent: transmitted,
    received,
    lossRate: loss ? round2(Number(loss[1])) : transmitted ? round2(((transmitted - received) / transmitted) * 100) : 0,
    min: rtt ? num(rtt[1]) : times.length ? Math.min(...times) : null,
    avg: rtt ? num(rtt[2]) : times.length ? round2(times.reduce((a, b) => a + b, 0) / times.length) : null,
    max: rtt ? num(rtt[3]) : times.length ? Math.max(...times) : null,
    results,
  };
}

// 用 execFile（不经过 shell）调用系统 ping，参数是固定数组，ip 只能是校验过的 IP 字面量。
// execFileImpl 仅供测试替换
export function runPing(ip, count, { execFileImpl = execFile } = {}) {
  if (!net.isIP(ip)) return Promise.reject(new HttpError(400, 'ip 不合法'));
  return new Promise((resolve, reject) => {
    execFileImpl('ping', ['-c', String(count), '-W', '2', ip], {
      timeout: (count + 3) * 1000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      env: { PATH: process.env.PATH ?? '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C', LANG: 'C' },
    }, (err, stdout = '', stderr = '') => {
      const out = String(stdout);
      // iputils 在全部丢包时退出码为 1，但仍有统计输出，照常解析
      if (/packets transmitted/.test(out)) return resolve(out);
      if (err && (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM')) return reject(new HttpError(503, UNSUPPORTED_MSG));
      const msg = `${stderr}\n${out}`;
      if (/permission denied|not permitted|operation not permitted|are you root|socket:|raw socket|icmp open socket/i.test(msg)) {
        return reject(new HttpError(503, UNSUPPORTED_MSG));
      }
      if (err?.killed) return reject(new HttpError(504, 'Ping 超时'));
      return reject(new HttpError(502, 'Ping 执行失败'));
    });
  });
}

// 服务器不能发 ICMP（Docker 精简镜像没有 ping 命令、容器没有 NET_RAW 权限）时，改用 TCP 连接测延迟：
// 先试 443 端口，连不上再试 80。结果字段相同，format 为 tcp，ttl 为 null
export async function tcpFallback(ip, count, { connect = connectOnce } = {}) {
  let results = [];
  let port = 443;
  for (const p of [443, 80]) {
    port = p;
    results = [];
    for (let seq = 1; seq <= count; seq++) {
      const r = await connect(ip, p, 2000);
      results.push({ seq, ok: r.ok, ttl: null, ms: r.ok ? r.ms : null });
    }
    if (results.some((r) => r.ok)) break;
  }
  return { format: 'tcp', port, ...summarize(results), results };
}

// blocked、execFileImpl、connect 仅供测试替换
export async function ping(hostInput, { count = 4, blocked = isBlockedIP, execFileImpl, connect } = {}) {
  const h = requireHost(hostInput, blocked);
  const target = await resolvePublic(h, { blocked });
  if (!net.isIP(target.address) || blocked(target.address)) throw new HttpError(400, BLOCKED_MSG);
  let out;
  try {
    out = await runPing(target.address, count, { execFileImpl });
  } catch (err) {
    if (err.status !== 503) throw err;
    const { format, port, ...rest } = await tcpFallback(target.address, count, { connect });
    return { host: h.host, ip: target.address, count, format, port, ...rest };
  }
  const parsed = parsePing(out);
  if (!parsed) throw new HttpError(502, '无法解析 ping 的输出');
  const { format, ...rest } = parsed;
  return { host: h.host, ip: target.address, count, format, port: null, ...rest };
}

export default {
  name: 'ping',
  category: 'net',
  title: 'Ping',
  description: '从本服务器对目标发送 ICMP Ping，返回每次的 TTL、延迟与丢包率；服务器不支持 ICMP 时自动改用 TCP 连接测延迟',
  source: '本服务器系统 ping 命令',
  routes: [
    {
      method: 'GET',
      path: '/api/ping',
      summary: 'ICMP Ping 延迟与丢包测试',
      params: [
        { name: 'host', required: true, desc: '域名或公网 IP；域名先解析为 IP 并检查，只 ping 公网地址', example: '1.1.1.1' },
        { name: 'count', required: false, default: 4, desc: '发送次数，1~4', example: 4 },
      ],
      fields: [
        { name: 'host', type: 'string', desc: '目标主机（ASCII 形式，中文域名为 punycode）或 IP' },
        { name: 'ip', type: 'string', desc: '实际 ping 的 IP（域名解析后的第一个地址）' },
        { name: 'count', type: 'number', desc: '请求的发送次数' },
        { name: 'format', type: 'string', desc: '测量方式：iputils（常见 Linux 发行版的 ping）、busybox（Alpine 等精简系统的 ping）；tcp 表示服务器不支持 ICMP（如 Docker 精简镜像），改用 TCP 连接测的延迟，此时没有 TTL' },
        { name: 'port', type: 'number|null', desc: 'format 为 tcp 时连接的端口（先试 443，连不上再试 80）；ICMP Ping 时为 null' },
        { name: 'sent', type: 'number', desc: '实际发送的包数' },
        { name: 'received', type: 'number', desc: '收到回复的包数（不含重复包）' },
        { name: 'lossRate', type: 'number', desc: '丢包率（百分比，0~100，保留两位小数）' },
        { name: 'min', type: 'number|null', desc: '最小往返时间（毫秒）；全部丢包时为 null' },
        { name: 'avg', type: 'number|null', desc: '平均往返时间（毫秒）；全部丢包时为 null' },
        { name: 'max', type: 'number|null', desc: '最大往返时间（毫秒）；全部丢包时为 null' },
        { name: 'results', type: 'array', desc: '每个包的结果，按序号排列；超时 2 秒未收到回复的记为失败' },
        { name: 'results[].seq', type: 'number', desc: '序号（从 1 开始；busybox 原始输出从 0 开始，已加 1）' },
        { name: 'results[].ok', type: 'boolean', desc: '是否收到回复' },
        { name: 'results[].ttl', type: 'number|null', desc: '回复包的 TTL（剩余跳数，可粗略估计经过的路由数）；未收到回复或 format 为 tcp 时为 null' },
        { name: 'results[].ms', type: 'number|null', desc: '往返时间（毫秒）；未收到回复时为 null' },
      ],
      async handler({ query }) {
        const host = param(query, 'host', { required: true, max: 300 });
        const count = param(query, 'count', { default: 4, int: true, min: 1, max: 4 });
        return { data: await gate(() => ping(host, { count })) };
      },
    },
  ],
};

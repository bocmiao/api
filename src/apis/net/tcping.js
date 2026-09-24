import net from 'node:net';
import { param } from '../../lib/http.js';
import { createGate, requireHost, resolvePublic, isBlockedIP, reasonOf, since, round2 } from './common.js';

const TIMEOUT_MS = 3000;
const gate = createGate(20);

// 建立一次 TCP 连接并测量耗时，连上后立即断开。ip 必须是已经检查过的 IP 字面量（不会再触发 DNS 解析）
export function connectOnce(ip, port, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const socket = net.connect({ host: ip, port });
    socket.on('error', () => {});
    let finished = false;
    const done = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, ms: null, error: `连接超时（${timeoutMs / 1000} 秒）` }), timeoutMs);
    socket.once('connect', () => done({ ok: true, ms: since(t0), error: null }));
    socket.once('error', (err) => done({ ok: false, ms: null, error: reasonOf(err) }));
  });
}

// 按成功的耗时计算最小 / 最大 / 平均值与丢失率（百分比）
export function summarize(results) {
  const times = results.filter((r) => r.ok).map((r) => r.ms);
  const sent = results.length;
  const received = times.length;
  return {
    sent,
    received,
    lossRate: sent ? round2(((sent - received) / sent) * 100) : 0,
    min: received ? Math.min(...times) : null,
    max: received ? Math.max(...times) : null,
    avg: received ? round2(times.reduce((a, b) => a + b, 0) / received) : null,
  };
}

// blocked 仅供测试替换
export async function tcping(hostInput, { port = 443, count = 4, blocked = isBlockedIP, timeoutMs = TIMEOUT_MS } = {}) {
  const h = requireHost(hostInput, blocked);
  const target = await resolvePublic(h, { blocked });
  const results = [];
  for (let seq = 1; seq <= count; seq++) {
    results.push({ seq, ...(await connectOnce(target.address, port, timeoutMs)) });
  }
  return { host: h.host, ip: target.address, port, count, results, ...summarize(results) };
}

export default {
  name: 'tcping',
  category: 'net',
  title: 'TCPing',
  description: '对指定主机的一个端口建立 TCP 连接测延迟与丢包，适合不响应 ICMP 的服务器',
  source: '本服务器发起的 TCP 连接',
  routes: [
    {
      method: 'GET',
      path: '/api/tcping',
      summary: 'TCP 端口连通性与延迟测试（每次只测一个端口）',
      params: [
        { name: 'host', required: true, desc: '域名或公网 IP；不允许内网和保留地址', example: 'github.com' },
        { name: 'port', required: false, default: 443, desc: '端口，1~65535', example: 443 },
        { name: 'count', required: false, default: 4, desc: '测试次数，1~4', example: 4 },
      ],
      fields: [
        { name: 'host', type: 'string', desc: '测试的主机（ASCII 形式，中文域名为 punycode）或 IP' },
        { name: 'ip', type: 'string', desc: '实际连接的 IP（域名解析后的第一个地址，所有测试都连这个 IP）' },
        { name: 'port', type: 'number', desc: '测试的端口' },
        { name: 'count', type: 'number', desc: '测试次数' },
        { name: 'results', type: 'array', desc: '每次测试的结果，按顺序排列；每次都新建连接，连上后立即断开，单次超时 3 秒' },
        { name: 'results[].seq', type: 'number', desc: '第几次测试（从 1 开始）' },
        { name: 'results[].ok', type: 'boolean', desc: '是否成功建立连接' },
        { name: 'results[].ms', type: 'number|null', desc: 'TCP 建连耗时（毫秒，保留两位小数）；失败时为 null' },
        { name: 'results[].error', type: 'string|null', desc: '失败原因的中文说明（如"连接被拒绝（端口未开放或服务未启动）""连接超时（3 秒）"）；成功时为 null' },
        { name: 'sent', type: 'number', desc: '发起的连接次数（等于 count）' },
        { name: 'received', type: 'number', desc: '成功的次数' },
        { name: 'lossRate', type: 'number', desc: '丢失率（百分比，0~100，保留两位小数）：失败次数 / 总次数 × 100' },
        { name: 'min', type: 'number|null', desc: '成功连接中的最小耗时（毫秒）；全部失败时为 null' },
        { name: 'max', type: 'number|null', desc: '成功连接中的最大耗时（毫秒）；全部失败时为 null' },
        { name: 'avg', type: 'number|null', desc: '成功连接的平均耗时（毫秒，保留两位小数）；全部失败时为 null' },
      ],
      async handler({ query }) {
        const host = param(query, 'host', { required: true, max: 300 });
        const port = param(query, 'port', { default: 443, int: true, min: 1, max: 65535 });
        const count = param(query, 'count', { default: 4, int: true, min: 1, max: 4 });
        return { data: await gate(() => tcping(host, { port, count })) };
      },
    },
  ],
};

import { isIPv4, isIPv6 } from 'node:net';
import { HttpError, param } from '../../lib/http.js';

// ---------------- 地址 ↔ BigInt ----------------

export function v4ToBig(ip) {
  return ip.split('.').reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
}

export function bigToV4(n) {
  return [24n, 16n, 8n, 0n].map((s) => String((n >> s) & 255n)).join('.');
}

export function v6ToBig(input) {
  let text = input.split('%')[0].toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const n = v4ToBig(v4[1]);
    text = `${text.slice(0, v4.index)}${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`;
  }
  const [head, tail = ''] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = text.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

// compress=true 时按 RFC 5952 把最长的一段（≥ 2 组）连续 0 压缩成 ::
export function bigToV6(value, compress = true) {
  const groups = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((value >> BigInt(16 * i)) & 0xffffn).toString(16));
  if (!compress) return groups.map((g) => g.padStart(4, '0')).join(':');
  let best = { start: -1, len: 0 };
  for (let i = 0; i < 8;) {
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i >= 2 && j - i > best.len) best = { start: i, len: j - i };
    i = j > i ? j : i + 1;
  }
  if (best.start < 0) return groups.join(':');
  return `${groups.slice(0, best.start).join(':')}::${groups.slice(best.start + best.len).join(':')}`;
}

const groupBits = (n, bits, size, sep) => n.toString(2).padStart(bits, '0').match(new RegExp(`.{${size}}`, 'g')).join(sep);

// ---------------- 子网计算 ----------------

const V4_TYPES = [
  ['0.0.0.0', 8, '本网络地址'], ['10.0.0.0', 8, '私有地址'], ['100.64.0.0', 10, '运营商级 NAT 共享地址'],
  ['127.0.0.0', 8, '本机回环地址'], ['169.254.0.0', 16, '链路本地地址'], ['172.16.0.0', 12, '私有地址'],
  ['192.0.2.0', 24, '文档示例地址'], ['192.168.0.0', 16, '私有地址'], ['198.18.0.0', 15, '网络测试地址'],
  ['198.51.100.0', 24, '文档示例地址'], ['203.0.113.0', 24, '文档示例地址'], ['224.0.0.0', 4, '组播地址'],
  ['255.255.255.255', 32, '受限广播地址'], ['240.0.0.0', 4, '保留地址'],
];
const V6_TYPES = [
  ['::', 128, '未指定地址'], ['::1', 128, '本机回环地址'], ['::ffff:0:0', 96, 'IPv4 映射地址'], ['64:ff9b::', 96, 'NAT64 地址'],
  ['2001:db8::', 32, '文档示例地址'], ['2002::', 16, '6to4 地址'], ['fc00::', 7, '唯一本地地址（私有）'],
  ['fe80::', 10, '链路本地地址'], ['ff00::', 8, '组播地址'], ['2000::', 3, '全球单播地址（公网）'],
];

function addressType(n, version) {
  const bits = version === 4 ? 32 : 128;
  const table = version === 4 ? V4_TYPES : V6_TYPES;
  const hit = table.find(([base, prefix]) => {
    const shift = BigInt(bits - prefix);
    return (n >> shift) === ((version === 4 ? v4ToBig(base) : v6ToBig(base)) >> shift);
  });
  return hit ? hit[2] : version === 4 ? '公网地址' : '其他地址';
}

function v4Class(n) {
  const first = Number(n >> 24n);
  return first < 128 ? 'A' : first < 192 ? 'B' : first < 224 ? 'C' : first < 240 ? 'D' : 'E';
}

function maskToPrefix(mask) {
  if (!isIPv4(mask)) return null;
  const bits = v4ToBig(mask).toString(2).padStart(32, '0');
  return /^1*0*$/.test(bits) ? bits.indexOf('0') === -1 ? 32 : bits.indexOf('0') : null;
}

export function parseCidr(text) {
  const s = String(text ?? '').trim();
  const m = /^([0-9a-fA-F:.]+(?:%[0-9A-Za-z._-]+)?)(?:\s*\/\s*(\d{1,3}|\d+\.\d+\.\d+\.\d+)|\s+(\d+\.\d+\.\d+\.\d+))?$/.exec(s);
  if (!m) throw new HttpError(400, 'cidr 格式应为 “IP/前缀长度” 或 “IP 子网掩码”，如 192.168.1.0/24');
  const [, ip, a, b] = m;
  const version = isIPv4(ip) ? 4 : isIPv6(ip) ? 6 : 0;
  if (!version) throw new HttpError(400, `无效的 IP 地址：${ip}`);
  const bits = version === 4 ? 32 : 128;
  const maskText = b ?? (a?.includes('.') ? a : undefined);
  let prefix;
  if (maskText !== undefined) {
    prefix = version === 4 ? maskToPrefix(maskText) : null;
    if (prefix === null) throw new HttpError(400, `无效的子网掩码：${maskText}（须为连续的 1 后跟连续的 0，仅 IPv4 可用）`);
  } else {
    prefix = a === undefined ? bits : Number(a);
  }
  if (prefix > bits) throw new HttpError(400, `IPv${version} 的前缀长度须为 0~${bits}`);
  return { ip, version, prefix };
}

export function calcCidr(text, testIp) {
  const { ip, version, prefix } = parseCidr(text);
  const bits = version === 4 ? 32 : 128;
  const addr = version === 4 ? v4ToBig(ip) : v6ToBig(ip);
  const size = 1n << BigInt(bits - prefix);
  const full = (1n << BigInt(bits)) - 1n;
  const network = addr & (full ^ (size - 1n));
  const last = network + size - 1n;
  const fmt = version === 4 ? bigToV4 : (n) => bigToV6(n);

  let contains = null;
  if (testIp) {
    const t = testIp.trim();
    const ok = version === 4 ? isIPv4(t) : isIPv6(t);
    if (!ok) throw new HttpError(400, `ip 须为 IPv${version} 地址，与网段类型一致`);
    const n = version === 4 ? v4ToBig(t) : v6ToBig(t);
    contains = n >= network && n <= last;
  }

  const base = {
    version,
    ip: fmt(addr),
    prefix,
    cidr: `${fmt(network)}/${prefix}`,
    network: fmt(network),
    totalAddresses: size.toString(),
    type: addressType(network, version),
    contains,
  };
  if (version === 6) {
    return {
      ...base,
      netmask: bigToV6(full ^ (size - 1n)),
      networkExpanded: bigToV6(network, false),
      firstAddress: fmt(network),
      lastAddress: fmt(last),
    };
  }
  const mask = full ^ (size - 1n);
  const [first, lastHost] = prefix >= 31 ? [network, last] : [network + 1n, last - 1n];
  return {
    ...base,
    netmask: bigToV4(mask),
    wildcard: bigToV4(size - 1n),
    broadcast: bigToV4(last),
    firstHost: bigToV4(first),
    lastHost: bigToV4(lastHost),
    usableHosts: (prefix >= 31 ? size : size - 2n).toString(),
    ipClass: v4Class(network),
    binaryNetmask: groupBits(mask, 32, 8, '.'),
  };
}

// ---------------- IP ↔ 整数 ----------------

const MAX_V4 = (1n << 32n) - 1n;
const MAX_V6 = (1n << 128n) - 1n;

export function ipIntConvert(value, forceVersion) {
  const v = String(value ?? '').trim();
  let n;
  let version;
  if (isIPv4(v)) {
    [n, version] = [v4ToBig(v), 4];
  } else if (isIPv6(v)) {
    [n, version] = [v6ToBig(v), 6];
  } else if (/^(\d{1,39}|0x[0-9a-fA-F]{1,32})$/.test(v)) {
    n = BigInt(v);
    version = forceVersion ?? (n > MAX_V4 ? 6 : 4);
    if (n > (version === 4 ? MAX_V4 : MAX_V6)) {
      throw new HttpError(400, version === 4 ? '整数超出 IPv4 范围（0~4294967295）' : '整数超出 IPv6 范围（0~2^128-1）');
    }
  } else {
    throw new HttpError(400, 'value 须为 IPv4 / IPv6 地址，或十进制（也可 0x 开头的十六进制）整数');
  }
  if (forceVersion && forceVersion !== version) throw new HttpError(400, `value 是 IPv${version} 地址，与 version=${forceVersion} 不一致`);
  if (version === 4) {
    return {
      version, ip: bigToV4(n), int: Number(n), hex: `0x${n.toString(16).padStart(8, '0')}`, binary: groupBits(n, 32, 8, '.'),
    };
  }
  return {
    version,
    ip: bigToV6(n),
    expanded: bigToV6(n, false),
    int: n.toString(),
    hex: `0x${n.toString(16).padStart(32, '0')}`,
    binary: groupBits(n, 128, 16, ':'),
  };
}

export default {
  name: 'netcalc',
  category: 'tools',
  title: '子网与 IP 计算',
  description: 'CIDR 子网计算（IPv4 / IPv6），IP 地址与整数互转',
  source: '本地计算',
  routes: [
    {
      method: 'GET',
      path: '/api/tools/cidr',
      summary: '子网计算：网络地址、广播地址、掩码、可用主机范围，判断 IP 是否在网段内',
      params: [
        { name: 'cidr', required: true, desc: '网段：IP/前缀长度（192.168.1.0/24、2001:db8::/48），或 IP 加子网掩码（10.0.0.5 255.255.0.0、10.0.0.5/255.255.0.0）；只写 IP 时按单个地址（/32 或 /128）计算', example: '192.168.10.130/26' },
        { name: 'ip', required: false, desc: '可选：判断这个 IP 是否在网段内，须与网段同为 IPv4 或 IPv6', example: '192.168.10.190' },
      ],
      fields: [
        { name: 'version', type: 'number', desc: 'IP 版本：4 或 6' },
        { name: 'ip', type: 'string', desc: '输入的 IP 地址（规范化写法，IPv6 为 RFC 5952 压缩形式）' },
        { name: 'prefix', type: 'number', desc: '前缀长度（IPv4 为 0~32，IPv6 为 0~128）；用子网掩码输入时为换算出的前缀长度' },
        { name: 'cidr', type: 'string', desc: '规范化后的网段：网络地址/前缀长度，如 192.168.10.128/26' },
        { name: 'network', type: 'string', desc: '网络地址（主机位全部置 0）' },
        { name: 'netmask', type: 'string', desc: '子网掩码：IPv4 为点分十进制（如 255.255.255.192），IPv6 为压缩写法（如 ffff:ffff:ffff::）' },
        { name: 'totalAddresses', type: 'string', desc: '网段内地址总数（十进制字符串，IPv6 可能非常大，统一用字符串避免精度丢失）' },
        { name: 'type', type: 'string', desc: '网络地址所属的特殊用途类别，如 私有地址、本机回环地址、链路本地地址、组播地址、文档示例地址；都不属于时 IPv4 为 公网地址、IPv6 为 其他地址' },
        { name: 'contains', type: 'boolean|null', desc: '参数 ip 是否在网段内；没传 ip 时为 null' },
        { name: 'wildcard', type: 'string', desc: '仅 IPv4：反掩码（通配符掩码），即子网掩码按位取反，常用于 ACL 与 OSPF 配置' },
        { name: 'broadcast', type: 'string', desc: '仅 IPv4：广播地址（主机位全部置 1）' },
        { name: 'firstHost', type: 'string', desc: '仅 IPv4：第一个可用主机地址（网络地址 + 1；/31、/32 时为网络地址本身）' },
        { name: 'lastHost', type: 'string', desc: '仅 IPv4：最后一个可用主机地址（广播地址 − 1；/31、/32 时为最后一个地址）' },
        { name: 'usableHosts', type: 'string', desc: '仅 IPv4：可用主机数（十进制字符串），一般为地址总数 − 2；/31（RFC 3021 点对点链路）为 2，/32 为 1' },
        { name: 'ipClass', type: 'string', desc: '仅 IPv4：传统分类地址类别 A / B / C / D（组播）/ E（保留），按网络地址的第一个字节判断' },
        { name: 'binaryNetmask', type: 'string', desc: '仅 IPv4：子网掩码的二进制形式，每 8 位用 . 分隔' },
        { name: 'networkExpanded', type: 'string', desc: '仅 IPv6：网络地址的完整写法（8 组、每组 4 位十六进制，不压缩）' },
        { name: 'firstAddress', type: 'string', desc: '仅 IPv6：网段内第一个地址（即网络地址，IPv6 没有广播地址）' },
        { name: 'lastAddress', type: 'string', desc: '仅 IPv6：网段内最后一个地址' },
      ],
      async handler({ query }) {
        const cidr = param(query, 'cidr', { required: true, max: 100 });
        const ip = param(query, 'ip', { max: 64 });
        return { data: calcCidr(cidr, ip) };
      },
    },
    {
      method: 'GET',
      path: '/api/tools/ip-int',
      summary: 'IP 地址与整数互转（IPv4 / IPv6），同时给出十六进制和二进制',
      params: [
        { name: 'value', required: true, desc: 'IP 地址（如 192.168.1.1、2001:db8::1）或整数（如 3232235777，也可写 0x 开头的十六进制）', example: '192.168.1.1' },
        { name: 'version', required: false, desc: '整数按哪个版本解释：4 或 6；不传时 ≤ 4294967295 按 IPv4，更大的按 IPv6', example: '6' },
      ],
      fields: [
        { name: 'version', type: 'number', desc: 'IP 版本：4 或 6' },
        { name: 'ip', type: 'string', desc: 'IP 地址（IPv4 点分十进制；IPv6 为 RFC 5952 压缩写法）' },
        { name: 'int', type: 'number|string', desc: '对应的无符号整数：IPv4 为数字（0~4294967295）；IPv6 超出 JavaScript 安全整数范围，为十进制字符串' },
        { name: 'hex', type: 'string', desc: '十六进制，0x 开头，IPv4 补足 8 位、IPv6 补足 32 位，小写' },
        { name: 'binary', type: 'string', desc: '二进制：IPv4 每 8 位用 . 分隔（共 4 段）；IPv6 每 16 位用 : 分隔（共 8 段）' },
        { name: 'expanded', type: 'string', desc: '仅 IPv6：完整写法（8 组、每组 4 位十六进制，不压缩）' },
      ],
      async handler({ query }) {
        const value = param(query, 'value', { required: true, max: 64 });
        const version = param(query, 'version', { oneOf: ['4', '6'] });
        return { data: ipIntConvert(value, version && Number(version)) };
      },
    },
  ],
};

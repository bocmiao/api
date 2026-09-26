// 本地离线库：IP（ip2region xdb）与手机号段（phone.dat）。零依赖解析，首次查询时把整个文件读入内存。
// 数据来源与许可见 ./data/README.md。
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

const DATA_DIR = new URL('./data/', import.meta.url);

// 读文件失败（数据文件缺失/损坏）时记住失败，之后直接返回 null，由调用方回落到在线接口
function lazyFile(name, validate) {
  let buf;
  return () => {
    if (buf === undefined) {
      try {
        buf = readFileSync(new URL(name, DATA_DIR));
        validate(buf);
      } catch {
        buf = null;
      }
    }
    return buf;
  };
}

// ---------- ip2region xdb（IPv4） ----------
// 格式（见 ip2region 仓库 maker/golang/README 与 binding/javascript/searcher.js）：
//   header        256 字节：u16 版本(2/3) | u16 索引策略 | u32 生成时间 | u32 首个段索引偏移 | u32 末个段索引偏移
//                 | (v3) u16 IP 版本(4/6) | u16 运行时指针字节数
//   vector index  256×256×8 字节：按 IP 前两个字节定位，每项 u32 段索引起始偏移 + u32 结束偏移（小端）
//   region data   地域字符串（UTF-8），被段索引引用
//   segment index 每项 14 字节：u32 起始 IP | u32 结束 IP | u16 地域长度 | u32 地域偏移（均小端）
const XDB_HEADER = 256;
const XDB_VECTOR_COLS = 256;
const XDB_VECTOR_SIZE = 8;
const XDB_V4_INDEX = 14;

const xdbBuffer = lazyFile('ip2region_v4.xdb', (b) => {
  const ver = b.readUInt16LE(0);
  if (ver !== 2 && ver !== 3) throw new Error(`不支持的 xdb 版本 ${ver}`);
  if (ver === 3 && b.readUInt16LE(16) !== 4) throw new Error('不是 IPv4 xdb');
});

/**
 * 在 ip2region 中查 IPv4，返回原始 region 字符串（如 "中国|广东省|深圳市|电信|CN"）；查不到或数据不可用时返回 null
 * @param {string} ip
 * @param {Buffer|null} [buf] 仅供测试替换
 */
export function searchXdb(ip, buf = xdbBuffer()) {
  if (!buf || isIP(ip) !== 4) return null;
  const p = ip.split('.').map(Number);
  const n = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  const vi = XDB_HEADER + p[0] * XDB_VECTOR_COLS * XDB_VECTOR_SIZE + p[1] * XDB_VECTOR_SIZE;
  const sPtr = buf.readUInt32LE(vi);
  const ePtr = buf.readUInt32LE(vi + 4);
  if (!sPtr || !ePtr) return null;
  let lo = 0;
  let hi = (ePtr - sPtr) / XDB_V4_INDEX;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const off = sPtr + mid * XDB_V4_INDEX;
    if (n < buf.readUInt32LE(off)) hi = mid - 1;
    else if (n > buf.readUInt32LE(off + 4)) lo = mid + 1;
    else {
      const len = buf.readUInt16LE(off + 8);
      const ptr = buf.readUInt32LE(off + 10);
      return len ? buf.toString('utf8', ptr, ptr + len) : null;
    }
  }
  return null;
}

const clean = (s) => (s && s !== '0' ? s.trim() || null : null);

/**
 * 解析 region 字符串。xdb 结构版本 3（2025 起的新版数据）格式为 国家|省份|城市|ISP|ISO 两位代码；
 * 结构版本 2（旧版 ip2region.xdb）为 国家|区域|省份|城市|ISP（区域恒为 0）。0 或空转为 null。
 */
export function parseXdbRegion(region, structure = 3) {
  if (!region) return null;
  const parts = region.split('|');
  let country, province, city, isp, code = null;
  if (structure >= 3) [country, province, city, isp, code] = parts;
  else [country, , province, city, isp] = parts;
  country = clean(country);
  if (!country || country === 'Reserved') return null;
  return { country, countryCode: clean(code), province: clean(province), city: clean(city), isp: clean(isp) };
}

export function lookupIpOffline(ip, buf = xdbBuffer()) {
  return buf ? parseXdbRegion(searchXdb(ip, buf), buf.readUInt16LE(0)) : null;
}

// ---------- phone.dat（手机号段） ----------
// 格式（见 lovedboy/phone README）：
//   header  8 字节：4 字节版本号（ASCII，如 "2312"）| u32 首条索引偏移（小端）
//   记录区  "省份|城市|邮编|区号\0" 依次排列
//   索引区  每条 9 字节：u32 号段（前 7 位）| u32 记录偏移 | u8 卡类型；按号段升序
const PHONE_INDEX = 9;
export const CARD_TYPES = {
  1: { carrier: '中国移动', virtual: false },
  2: { carrier: '中国联通', virtual: false },
  3: { carrier: '中国电信', virtual: false },
  4: { carrier: '中国电信', virtual: true },
  5: { carrier: '中国联通', virtual: true },
  6: { carrier: '中国移动', virtual: true },
  7: { carrier: '中国广电', virtual: false },
  8: { carrier: '中国广电', virtual: true },
};

const phoneBuffer = lazyFile('phone.dat', (b) => {
  const first = b.readUInt32LE(4);
  if (first < 8 || first > b.length || (b.length - first) % PHONE_INDEX) throw new Error('phone.dat 格式不对');
});

export function phoneDatVersion(buf = phoneBuffer()) {
  return buf ? buf.toString('latin1', 0, 4) : null;
}

/**
 * 按号段（前 7 位）查 phone.dat；查不到或数据不可用时返回 null
 * @returns {{ province: string|null, city: string|null, zip: string|null, areaCode: string|null, carrier: string|null, virtual: boolean|null } | null}
 */
export function lookupPhoneOffline(number, buf = phoneBuffer()) {
  if (!buf || !/^\d{7}/.test(number)) return null;
  const seg = Number(number.slice(0, 7));
  const first = buf.readUInt32LE(4);
  let lo = 0;
  let hi = (buf.length - first) / PHONE_INDEX - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const off = first + mid * PHONE_INDEX;
    const cur = buf.readUInt32LE(off);
    if (cur < seg) lo = mid + 1;
    else if (cur > seg) hi = mid - 1;
    else {
      const rec = buf.readUInt32LE(off + 4);
      const end = buf.indexOf(0, rec);
      const [province, city, zip, areaCode] = buf.toString('utf8', rec, end < 0 ? undefined : end).split('|').map(clean);
      const card = CARD_TYPES[buf[off + 8]];
      // 数据里部分以 0 开头的邮编丢了前导 0（如河北唐山 "63000"），补足 6 位
      return { province, city, zip: zip && /^\d{5}$/.test(zip) ? `0${zip}` : zip, areaCode, carrier: card?.carrier ?? null, virtual: card ? card.virtual : null };
    }
  }
  return null;
}

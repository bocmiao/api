// 最小 zip 解析（只读中央目录，支持「不压缩」和「deflate」两种方式），用于解开 GitHub 的「Download ZIP」源码包。
// 返回与 tar.js 相同的结构：{ entries: [{ path, type: 'file'|'dir', data }], comment }
import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export function isZip(buf) {
  return buf.length > 4 && buf.readUInt32LE(0) === LOC_SIG;
}

export function extractZip(buf, { maxTotal = 200 * 1024 * 1024 } = {}) {
  // 中央目录结束记录在文件末尾，后面最多跟 64KB 注释
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');
  const count = buf.readUInt16LE(eocd + 10);
  // GitHub / git archive 生成的 zip 把提交 SHA 写在压缩包注释里
  const comment = buf.subarray(eocd + 22, eocd + 22 + buf.readUInt16LE(eocd + 20)).toString('utf8').trim();
  const cenOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cenOffset === 0xffffffff) throw new Error('不支持 zip64 格式');

  const entries = [];
  let total = 0;
  let p = cenOffset;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) throw new Error('zip 目录损坏');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw new Error('不支持加密的 zip');
    if (name.endsWith('/')) { entries.push({ path: name, type: 'dir', data: null }); continue; }
    total += size;
    if (total > maxTotal) throw new Error('解压后内容过大');

    if (buf.readUInt32LE(localOffset) !== LOC_SIG) throw new Error('zip 文件损坏');
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
    else throw new Error(`不支持的压缩方式 ${method}`);
    if (data.length !== size) throw new Error(`zip 文件损坏：${name}`);
    entries.push({ path: name, type: 'file', data });
  }
  return { entries, comment };
}

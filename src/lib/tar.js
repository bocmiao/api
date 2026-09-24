// 最小 tar 解析（支持 ustar、pax 扩展头与 GNU 长文件名），用于解开 GitHub 的源码包
const str = (buf, start, len) => {
  const s = buf.subarray(start, start + len);
  const end = s.indexOf(0);
  return s.subarray(0, end === -1 ? s.length : end).toString('utf8');
};
const octal = (buf, start, len) => parseInt(str(buf, start, len).trim() || '0', 8);

function parsePax(data) {
  const out = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) break;
    const len = Number(data.subarray(i, sp).toString());
    if (!len) break;
    const rec = data.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

// 返回 { entries: [{ path, type: 'file'|'dir', data }], comment }；GitHub 源码包的 comment 是提交 SHA
export function extractTar(buf) {
  const entries = [];
  let global = {};
  let next = {};
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const dataStart = off + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;

    if (type === 'g') { global = { ...global, ...parsePax(data) }; continue; }
    if (type === 'x') { next = parsePax(data); continue; }
    if (type === 'L') { next = { path: str(data, 0, data.length) }; continue; }

    const magic = str(h, 257, 6);
    const prefix = magic.startsWith('ustar') ? str(h, 345, 155) : '';
    const name = next.path ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
    next = {};
    if (type === '0' || type === '\0' || type === '7') entries.push({ path: name, type: 'file', data: Buffer.from(data) });
    else if (type === '5') entries.push({ path: name, type: 'dir' });
    // 符号链接、硬链接、设备文件等一律忽略
  }
  return { entries, comment: global.comment ?? null };
}

// 纯计算类接口（个税、单位换算、健康指标等）共用的小工具
import { HttpError, param } from '../../lib/http.js';

export const round = (n, digits = 2) => {
  const p = 10 ** digits;
  // 加一个极小量抵消 1.005 这类二进制浮点误差
  return Math.round((n + Math.sign(n) * Number.EPSILON * Math.abs(n)) * p) / p;
};

const NUM_RE = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;

// 读取数字参数：支持小数、负数、科学计数法；可限制范围和小数位数
export function num(query, name, { required = false, default: def, min = -Infinity, max = Infinity, unit = '', decimals } = {}) {
  const raw = param(query, name, { required, max: 32 });
  if (raw == null) return def;
  const s = String(raw).trim().replace(/,/g, '');
  const n = Number(s);
  const range = `${Number.isFinite(min) ? min : ''}~${Number.isFinite(max) ? max : ''}`;
  if (!NUM_RE.test(s) || !Number.isFinite(n) || n < min || n > max) {
    throw new HttpError(400, `${name} 须为 ${range} 之间的数字${unit ? `（${unit}）` : ''}`);
  }
  if (decimals != null && !Number.isInteger(Math.round(n * 10 ** decimals * 1e6) / 1e6)) {
    throw new HttpError(400, `${name} 最多保留 ${decimals} 位小数`);
  }
  return n;
}

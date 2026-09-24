// 娱乐类本地接口共用的小工具：可复现的伪随机数、抽样、北京时间。
// 不是接口模块，fun/index.js 不注册它。
import { createHash, randomBytes } from 'node:crypto';

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

export const sha256 = (s) => createHash('sha256').update(String(s), 'utf8').digest();

// mulberry32：32 位种子的小型 PRNG，返回 [0, 1) 的函数
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 同一个 key 永远得到同一串随机数（key 先做 SHA-256，取前 4 字节作种子）
export const seededRandom = (key) => mulberry32(sha256(key).readUInt32BE(0));

export const randomSeed = () => randomBytes(8).toString('hex');

export const pick = (list, rand = Math.random) => list[Math.floor(rand() * list.length)];

export const randInt = (min, max, rand = Math.random) => min + Math.floor(rand() * (max - min + 1));

// 不放回抽 n 个
export function sample(list, n, rand = Math.random) {
  const pool = [...list];
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return out;
}

// 北京时间（UTC+8，无夏令时）
export function beijingClock(now = Date.now()) {
  const d = new Date(now + 8 * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: d.toISOString().slice(0, 10),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    weekdayIndex: d.getUTCDay(),
    weekday: WEEKDAYS[d.getUTCDay()],
  };
}

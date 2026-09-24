// 随机取条目的小工具（歇后语、脑筋急转弯、冷知识、彩虹屁、笑话共用）。不是接口模块，fun/index.js 不注册它。
import { HttpError, param } from '../../lib/http.js';
import { sample } from './seeded.js';

export const MAX_COUNT = 10;

export const COUNT_PARAM = {
  name: 'count', required: false, default: '1', desc: `条数，1~${MAX_COUNT} 的整数；同一次返回的条目互不重复`, example: '3',
};

export const readCount = (query) => param(query, 'count', { default: 1, int: true, min: 1, max: MAX_COUNT });

// 给数据加上稳定的 id（在数据数组中的序号，从 1 开始）
export const withIds = (list, map) => list.map((x, i) => ({ id: i + 1, ...map(x) }));

// 不放回随机抽 count 条；池子不够时有多少返回多少
export function pickItems(pool, count = 1, rand = Math.random) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) throw new HttpError(400, `count 须为 1~${MAX_COUNT} 之间的整数`);
  return sample(pool, count, rand).map((x) => ({ ...x }));
}

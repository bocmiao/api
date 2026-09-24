import { HttpError } from '../../lib/http.js';
import { loadEpicFree } from './epic.js';
import { loadSteamFree } from './steam.js';
import { loadGogFree } from './gog.js';

// 统一格式：{ id, platform, title, url, image, originalPrice, endDate }，id 全局唯一，便于推送去重
export function normalizeEpic({ current }) {
  return current.map((g) => ({
    id: `epic:${g.id}`,
    platform: 'epic',
    title: g.title,
    url: g.url,
    image: g.image?.wide ?? g.image?.tall ?? null,
    originalPrice: g.originalPrice,
    endDate: g.endDate ?? null,
  }));
}

export function normalizeSteam(items) {
  return items.map((g) => ({
    id: `steam:${g.type}:${g.id}`,
    platform: 'steam',
    title: g.title,
    url: g.url,
    image: g.image,
    originalPrice: g.originalPrice,
    endDate: g.endDate ?? null,
  }));
}

export function normalizeGog(items) {
  return items.map((g) => ({
    id: `gog:${g.id}`,
    platform: 'gog',
    title: g.title,
    url: g.url,
    image: g.image,
    originalPrice: g.originalPrice,
    endDate: null,
  }));
}

export const PLATFORMS = {
  epic: async () => normalizeEpic(await loadEpicFree()),
  steam: async () => normalizeSteam((await loadSteamFree()).data),
  gog: async () => normalizeGog((await loadGogFree()).data),
};

// 纯函数：合并 Promise.allSettled 的结果，失败的平台记入 errors
export function mergeSettled(names, results) {
  const items = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value);
    else errors.push({ platform: names[i], status: r.reason?.status ?? 500, message: r.reason?.message ?? '未知错误' });
  });
  return { items, errors };
}

// 各平台当前可免费领取的游戏；单个平台失败时返回部分数据 + errors
export async function loadFreeGamesAll(platforms = Object.keys(PLATFORMS), loaders = PLATFORMS) {
  const results = await Promise.allSettled(platforms.map((p) => loaders[p]()));
  return mergeSettled(platforms, results);
}

export default {
  name: 'games-free',
  category: 'games',
  title: '游戏限免汇总',
  description: '汇总 Epic、Steam、GOG 当前可免费领取的游戏',
  source: 'Epic / Steam / GOG',
  unofficial: true,
  routes: [
    {
      method: 'GET',
      path: '/api/games/free',
      summary: '汇总各平台当前限免游戏（某个平台失败时返回其余平台数据，并在 errors 中说明）',
      params: [
        { name: 'platform', desc: '只看指定平台，逗号分隔：epic,steam,gog；不填为全部', example: 'epic,steam' },
      ],
      fields: [
        { name: 'items', type: 'array', desc: '各平台当前可免费领取的游戏。按 platform 参数的平台顺序拼接（默认 epic、steam、gog），同一平台内保持该平台接口的原顺序。某个平台失败时不含该平台的条目' },
        { name: 'items[].id', type: 'string', desc: '全局唯一 ID，可用于推送去重。格式：Epic 为 epic:<商品 ID>，Steam 为 steam:<app|sub|bundle>:<数字 ID>（如 steam:app:1172470），GOG 为 gog:<商品 ID>' },
        { name: 'items[].platform', type: 'string', desc: '来源平台：epic 表示 Epic Games Store，steam 表示 Steam，gog 表示 GOG' },
        { name: 'items[].title', type: 'string|null', desc: '游戏名称（各平台均按简体中文获取，没有中文名的游戏为原名）；Steam 搜索结果里缺少标题时为 null' },
        { name: 'items[].url', type: 'string', desc: '该平台的商店页面链接' },
        { name: 'items[].image', type: 'string|null', desc: '封面图链接。Epic 优先横版、没有则竖版；Steam 游戏为 460×215 头图，礼包为 120×45 小图；GOG 优先横版、没有则竖版。平台没有提供图片时为 null' },
        { name: 'items[].originalPrice', type: 'string|null', desc: '原价，平台格式化好的字符串，带货币符号。本接口固定按中国区人民币查询，各平台写法略有不同：Epic 如 ¥88.00，Steam 如 ¥ 58.00（符号后有空格），GOG 如 ¥68.00。平台没有给出原价时为 null' },
        { name: 'items[].endDate', type: 'string|null', desc: '免费截止时间，ISO 8601，UTC（如 2026-09-24T15:00:00.000Z）。Epic 总是有值；Steam 只有同时出现在首页精选特惠里的条目才有值，否则为 null；GOG 不提供截止时间，始终为 null' },
        { name: 'errors', type: 'array', desc: '获取失败的平台，全部成功时为空数组。只要还有平台成功就返回 200；所有平台都失败时整个接口返回 502' },
        { name: 'errors[].platform', type: 'string', desc: '失败的平台：epic / steam / gog' },
        { name: 'errors[].status', type: 'number', desc: '失败原因对应的 HTTP 状态码：502 表示上游请求失败或返回格式无法识别，504 表示上游响应超时，500 表示其他未知错误' },
        { name: 'errors[].message', type: 'string', desc: '中文错误说明，如"上游返回 HTTP 503"' },
      ],
      async handler({ query }) {
        const raw = query.get('platform');
        const platforms = raw ? [...new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))] : Object.keys(PLATFORMS);
        const bad = platforms.find((p) => !PLATFORMS[p]);
        if (bad || !platforms.length) throw new HttpError(400, `platform 只能是 ${Object.keys(PLATFORMS).join(' / ')}`);
        const data = await loadFreeGamesAll(platforms);
        if (!data.items.length && data.errors.length === platforms.length) throw new HttpError(502, '所有平台均获取失败');
        return { data };
      },
    },
  ],
};

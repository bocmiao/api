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

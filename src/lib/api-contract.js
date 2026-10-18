// 接口契约自检：命令行（npm run api:check）和测试（test/api-contract.test.js）共用同一份规则。
// 只依赖接口模块和 api-sources 表，不初始化 registry / 数据库，避免检查本身引入副作用。
import { moduleSourceInfo } from './api-sources.js';

// 接口清单快照：新增、删除、改名都会让快照变化，必须在 diff 里显式确认
export function buildSurface(modules) {
  return {
    generatedBy: 'npm run api:sync',
    modules: modules.map((m) => ({
      name: m.name,
      category: m.category,
      routes: m.routes.map((r) => ({ method: r.method, path: r.path })),
    })),
  };
}

export const surfaceJson = (modules) => `${JSON.stringify(buildSurface(modules), null, 2)}\n`;

// 返回 { errors, warnings, routeTotal }；errors 非空即失败
export function checkContract({ modules, categories, readmeText = '', surfaceText = '', sync = false }) {
  const errors = [];
  const warnings = [];
  const routeTotal = modules.reduce((n, m) => n + m.routes.length, 0);
  const categoryIds = new Set(categories.map((c) => c.id));
  const names = new Set();
  const paths = new Map();

  for (const mod of modules) {
    if (names.has(mod.name)) errors.push(`模块名重复：${mod.name}`);
    names.add(mod.name);
    if (!/^[a-z][a-z0-9-]+$/.test(mod.name)) errors.push(`模块名不合法（小写字母、数字、-）：${mod.name}`);
    if (!categoryIds.has(mod.category)) errors.push(`${mod.name} 的分类不存在：${mod.category}`);
    if (moduleSourceInfo(mod.name).kind === 'unknown') errors.push(`${mod.name} 没有在 src/lib/api-sources.js 登记数据来源`);
    if (!Array.isArray(mod.routes) || !mod.routes.length) errors.push(`${mod.name} 没有路由`);
    for (const route of mod.routes ?? []) {
      const key = `${route.method} ${route.path}`;
      if (paths.has(key)) errors.push(`地址重复：${key}（${paths.get(key)} / ${mod.name}）`);
      paths.set(key, mod.name);
      if (!/^\/(api|s)\//.test(route.path)) errors.push(`${key} 的路径必须以 /api/ 或 /s/ 开头`);
      if (!route.summary) warnings.push(`${key} 缺少 summary（接口说明）`);
      const paramNames = new Set();
      for (const p of route.params ?? []) {
        if (paramNames.has(p.name)) errors.push(`${key} 的参数名重复：${p.name}`);
        paramNames.add(p.name);
        if (!p.desc) warnings.push(`${key} 的参数 ${p.name} 缺少说明`);
      }
      if (!route.raw && !route.returns && !(route.fields ?? []).length) warnings.push(`${key} 缺少字段说明（fields）`);
    }
  }

  const countRe = /(\d+) 个常用接口（(\d+) 个调用地址）/;
  const found = readmeText.match(countRe);
  if (!found) errors.push('README.md 里找不到「N 个常用接口（M 个调用地址）」');
  else if (!sync && (Number(found[1]) !== modules.length || Number(found[2]) !== routeTotal)) {
    errors.push(`README 数量过期：写着 ${found[1]} 个接口/${found[2]} 个地址，实际 ${modules.length}/${routeTotal}；运行 npm run api:sync`);
  }

  if (!sync && surfaceText !== surfaceJson(modules)) {
    errors.push('接口清单快照和代码不一致（新增/删除/改名了接口）；确认后运行 npm run api:sync 并提交 docs/api-surface.json');
  }

  return { errors, warnings, routeTotal };
}

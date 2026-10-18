#!/usr/bin/env node
// 接口契约自检：路径/名称唯一、来源已登记、README 数量与快照一致。
// 用法：
//   node scripts/api-check.mjs          # 只检查，CI 用
//   node scripts/api-check.mjs --sync   # 同步 README 数量和 docs/api-surface.json
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.DB_FILE = ':memory:';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const sync = process.argv.includes('--sync');

const { modules, categories } = await import('../src/apis/index.js');
const { moduleSourceInfo } = await import('../src/lib/api-sources.js');

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
  const info = moduleSourceInfo(mod.name);
  if (info.kind === 'unknown') errors.push(`${mod.name} 没有在 src/lib/api-sources.js 登记数据来源`);
  if (!Array.isArray(mod.routes) || !mod.routes.length) errors.push(`${mod.name} 没有路由`);
  for (const route of mod.routes ?? []) {
    const key = `${route.method} ${route.path}`;
    if (paths.has(key)) errors.push(`地址重复：${key}（${paths.get(key)} / ${mod.name}）`);
    paths.set(key, mod.name);
    if (!/^\/(api|s)\//.test(route.path)) errors.push(`${key} 的路径必须以 /api/ 或 /s/ 开头`);
    if (!route.summary) warnings.push(`${key} 缺少 summary（接口说明）`);
    const params = route.params ?? [];
    const paramNames = new Set();
    for (const p of params) {
      if (paramNames.has(p.name)) errors.push(`${key} 的参数名重复：${p.name}`);
      paramNames.add(p.name);
      if (!p.desc) warnings.push(`${key} 的参数 ${p.name} 缺少说明`);
    }
    if (!route.raw && !route.returns && !(route.fields ?? []).length) warnings.push(`${key} 缺少字段说明（fields）`);
  }
}

const readmePath = join(root, 'README.md');
const readme = readFileSync(readmePath, 'utf8');
const countRe = /(\d+) 个常用接口（(\d+) 个调用地址）/;
const found = readme.match(countRe);
if (!found) errors.push('README.md 里找不到「N 个常用接口（M 个调用地址）」');
else if (!sync && (Number(found[1]) !== modules.length || Number(found[2]) !== routeTotal)) {
  errors.push(`README 数量过期：写着 ${found[1]} 个接口/${found[2]} 个地址，实际 ${modules.length}/${routeTotal}；运行 npm run api:sync`);
}

const surface = {
  generatedBy: 'npm run api:sync',
  modules: modules.map((m) => ({
    name: m.name,
    category: m.category,
    routes: m.routes.map((r) => ({ method: r.method, path: r.path })),
  })),
};
const surfacePath = join(root, 'docs', 'api-surface.json');
const surfaceJson = `${JSON.stringify(surface, null, 2)}\n`;

if (sync) {
  const nextReadme = found ? readme.replace(countRe, `${modules.length} 个常用接口（${routeTotal} 个调用地址）`) : readme;
  if (nextReadme !== readme) writeFileSync(readmePath, nextReadme);
  writeFileSync(surfacePath, surfaceJson);
  console.log(`已同步：README ${modules.length} 个接口 / ${routeTotal} 个地址，docs/api-surface.json`);
} else {
  const current = existsSync(surfacePath) ? readFileSync(surfacePath, 'utf8') : '';
  if (current !== surfaceJson) {
    errors.push('接口清单快照和代码不一致（新增/删除/改名了接口）；确认后运行 npm run api:sync 并提交 docs/api-surface.json');
  }
}

for (const w of warnings) console.warn(`[提醒] ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`[错误] ${e}`);
  console.error(`\n共 ${errors.length} 个错误。`);
  process.exit(1);
}
console.log(`接口契约检查通过：${modules.length} 个接口，${routeTotal} 个调用地址${warnings.length ? `，${warnings.length} 条提醒` : ''}。`);

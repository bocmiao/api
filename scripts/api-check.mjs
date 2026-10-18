#!/usr/bin/env node
// 接口契约自检：路径/名称唯一、来源已登记、README 数量与快照一致。
// 用法：
//   node scripts/api-check.mjs          # 只检查，CI/本地用
//   node scripts/api-check.mjs --sync   # 同步 README 数量和 docs/api-surface.json
// 同一份规则也在 test/api-contract.test.js 里跑，所以 CI 的 node --test 会拦住过期快照。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.DB_FILE = ':memory:';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const sync = process.argv.includes('--sync');

const { modules, categories } = await import('../src/apis/index.js');
const { checkContract, surfaceJson } = await import('../src/lib/api-contract.js');

const readmePath = join(root, 'README.md');
const surfacePath = join(root, 'docs', 'api-surface.json');
const readmeText = readFileSync(readmePath, 'utf8');
const surfaceText = existsSync(surfacePath) ? readFileSync(surfacePath, 'utf8') : '';
const routeTotal = modules.reduce((n, m) => n + m.routes.length, 0);
const result = checkContract({ modules, categories, readmeText, surfaceText, sync });

if (sync && !result.errors.length) {
  const countRe = /(\d+) 个常用接口（(\d+) 个调用地址）/;
  const nextReadme = countRe.test(readmeText)
    ? readmeText.replace(countRe, `${modules.length} 个常用接口（${routeTotal} 个调用地址）`)
    : readmeText;
  if (nextReadme !== readmeText) writeFileSync(readmePath, nextReadme);
  writeFileSync(surfacePath, surfaceJson(modules));
  console.log(`已同步：README ${modules.length} 个接口 / ${routeTotal} 个地址，docs/api-surface.json`);
}

for (const w of result.warnings) console.warn(`[提醒] ${w}`);
if (result.errors.length) {
  for (const e of result.errors) console.error(`[错误] ${e}`);
  console.error(`\n共 ${result.errors.length} 个错误。`);
  process.exit(1);
}
console.log(`接口契约检查通过：${modules.length} 个接口，${routeTotal} 个调用地址${result.warnings.length ? `，${result.warnings.length} 条提醒` : ''}。`);

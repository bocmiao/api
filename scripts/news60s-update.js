#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const HELP = `用法：node scripts/news60s-update.js [--json 文件|- | --url JSON_URL | --article-url 微信URL] [--date YYYY-MM-DD]
  --image-url URL / --cover-url URL  文章图片明确选择（仅 article-url）
  --status                         读取发布状态
  不传来源时读取 NEWS_60S_SOURCE_URL；没有默认公共来源。失败不会替换已发布版本。`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(HELP); return; }
  const flags = new Map();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--json', '--url', '--article-url', '--date', '--image-url', '--cover-url', '--status'].includes(key) || flags.has(key)) throw new Error('未知或重复参数；使用 --help');
    if (key === '--status') flags.set(key, true);
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('参数缺少值；使用 --help');
      flags.set(key, value);
    }
  }
  if (flags.has('--status') && flags.size !== 1) throw new Error('--status 不能与更新参数组合');
  const envFile = fileURLToPath(new URL('../.env', import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const { applySettings } = await import('../src/lib/settings.js');
  applySettings();
  const { news60sStore } = await import('../src/lib/news60s/store.js');
  const { updateNews60s } = await import('../src/lib/news60s/update.js');
  const { MAX_JSON_BYTES } = await import('../src/lib/news60s/format.js');
  if (flags.has('--status')) { console.log(JSON.stringify(news60sStore().status())); return; }
  const input = {};
  for (const [flag, key] of [['--url', 'url'], ['--article-url', 'articleUrl'], ['--date', 'date'], ['--image-url', 'image'], ['--cover-url', 'cover']]) {
    if (flags.has(flag)) input[key] = flags.get(flag);
  }
  if (flags.has('--json')) {
    let bytes;
    if (flags.get('--json') === '-') {
      const chunks = [];
      let total = 0;
      for await (const chunk of process.stdin) {
        total += chunk.length;
        if (total > MAX_JSON_BYTES) throw new Error('JSON 输入超过 256 KiB');
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks);
    } else {
      if ((await stat(flags.get('--json'))).size > MAX_JSON_BYTES) throw new Error('JSON 输入超过 256 KiB');
      bytes = await readFile(flags.get('--json'));
    }
    if (bytes.length > MAX_JSON_BYTES) throw new Error('JSON 输入超过 256 KiB');
    try { input.data = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('JSON 文件无法解析'); }
  }
  console.log(JSON.stringify(await updateNews60s(input)));
}

main().catch((error) => {
  // Never dump source bodies, request objects, environment or credentials.
  console.error(JSON.stringify({ error: error.code ?? 'NEWS60S_UPDATE_FAILED', message: error.message }));
  process.exitCode = error.status === 409 ? 75 : 1;
});

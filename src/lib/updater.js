// 在线更新：从 GitHub 拉取指定分支的最新代码，校验后替换本地代码，由守护进程重启服务。
import { gunzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { HttpError } from './http.js';
import { extractTar } from './tar.js';
import { ROOT, KEEP, dataDir } from './paths.js';
import { STAGING, BACKUPS, swapIn, writePending } from './swap.js';

const API = 'https://api.github.com';
const MAX_DOWNLOAD = 50 * 1024 * 1024;
const MAX_UNPACKED = 200 * 1024 * 1024;
const KEEP_BACKUPS = 3;

export const updateConfig = () => ({
  repo: process.env.UPDATE_REPO || 'bocmiao/api',
  branch: process.env.UPDATE_BRANCH || '',
  token: process.env.GITHUB_TOKEN || '',
});

async function gh(path, { accept = 'application/vnd.github+json', raw = false } = {}) {
  const { token } = updateConfig();
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      headers: { accept, 'user-agent': 'miao-api-updater', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(raw ? 120_000 : 15_000),
    });
  } catch {
    throw new HttpError(502, '无法连接 GitHub，请检查服务器网络');
  }
  if (res.status === 404) throw new HttpError(502, '找不到仓库或分支；私有仓库需要配置 GITHUB_TOKEN');
  if (res.status === 403 || res.status === 429) throw new HttpError(502, 'GitHub 接口请求过于频繁，请稍后再试或配置 GITHUB_TOKEN');
  if (!res.ok) throw new HttpError(502, `GitHub 返回 HTTP ${res.status}`);
  if (!raw) return res.json();
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_DOWNLOAD) throw new HttpError(502, '更新包过大');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD) throw new HttpError(502, '更新包过大');
  return buf;
}

const versionFile = () => join(dataDir(), 'version.json');
export function currentVersion() {
  try {
    return JSON.parse(readFileSync(versionFile(), 'utf8'));
  } catch {
    return null;
  }
}

function lastRollback() {
  try {
    return JSON.parse(readFileSync(join(dataDir(), 'update-rollback.json'), 'utf8'));
  } catch {
    return null;
  }
}

const commitInfo = (c) => ({
  sha: c.sha,
  shortSha: c.sha.slice(0, 7),
  message: c.commit.message.split('\n')[0],
  author: c.commit.author?.name ?? null,
  date: c.commit.committer?.date ?? c.commit.author?.date ?? null,
});

// 检查更新：返回当前版本、最新版本以及两者之间的提交列表
export async function checkUpdate() {
  const cfg = updateConfig();
  const branch = cfg.branch || (await gh(`/repos/${cfg.repo}`)).default_branch;
  const latest = commitInfo(await gh(`/repos/${cfg.repo}/commits/${encodeURIComponent(branch)}`));
  const current = currentVersion();
  let commits = [];
  let behind = null;
  if (current?.sha && current.sha !== latest.sha) {
    try {
      const cmp = await gh(`/repos/${cfg.repo}/compare/${current.sha}...${latest.sha}`);
      behind = cmp.ahead_by;
      commits = cmp.commits.map(commitInfo).reverse().slice(0, 50);
    } catch {
      // 当前版本不在该分支历史里（比如切换过分支），只显示最新提交
    }
  } else if (current?.sha === latest.sha) {
    behind = 0;
  }
  if (!current?.sha) commits = [latest];
  return {
    repo: cfg.repo,
    branch,
    current,
    latest,
    behind,
    upToDate: current?.sha === latest.sha,
    commits,
    managed: process.env.MIAO_LAUNCHER === '1',
    lastRollback: lastRollback(),
  };
}

// 解包到临时目录：去掉第一层目录，拒绝越界路径，跳过需保留的顶层条目
export function unpackTo(tarGz, dest) {
  let tar;
  try {
    tar = gunzipSync(tarGz, { maxOutputLength: MAX_UNPACKED });
  } catch {
    throw new HttpError(502, '更新包解压失败');
  }
  const { entries, comment } = extractTar(tar);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  let files = 0;
  for (const e of entries) {
    const rel = e.path.split('/').slice(1).join('/');
    if (!rel) continue;
    const clean = normalize(rel);
    if (clean.startsWith('..') || clean.startsWith(sep) || /^[a-zA-Z]:/.test(clean) || clean.split(sep).includes('..')) {
      throw new HttpError(502, `更新包包含非法路径：${e.path}`);
    }
    if (KEEP.has(clean.split(sep)[0])) continue;
    const target = join(dest, clean);
    if (e.type === 'dir') mkdirSync(target, { recursive: true });
    else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, e.data);
      files++;
    }
  }
  return { files, sha: comment };
}

// 在独立进程中加载新代码，确认没有语法错误或缺失模块
function verifyStaging(dir) {
  for (const f of ['package.json', 'src/server.js', 'src/app.js', 'src/launcher.js', 'public/index.html']) {
    if (!existsSync(join(dir, f))) throw new HttpError(502, `更新包缺少 ${f}，已取消更新`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(join(dir, 'src/app.js'))});`], {
      env: { ...process.env, NODE_ENV: 'test', DB_FILE: ':memory:', MIAO_LAUNCHER: '' },
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 30_000,
    });
    let err = '';
    child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new HttpError(502, `新版本加载失败，已取消更新：${err.trim().split('\n').slice(-3).join(' ') || `退出码 ${code}`}`));
    });
  });
}

function pruneBackups() {
  if (!existsSync(BACKUPS)) return;
  const dirs = readdirSync(BACKUPS).map((n) => join(BACKUPS, n)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const d of dirs.slice(KEEP_BACKUPS)) rmSync(d, { recursive: true, force: true });
}

let running = false;

// 执行更新：下载 → 解包 → 校验 → 备份并替换 → 记录版本 → 标记待确认
export async function applyUpdate({ sha: expectedSha } = {}) {
  if (running) throw new HttpError(409, '已有更新正在进行');
  running = true;
  try {
    const cfg = updateConfig();
    const info = await checkUpdate();
    const target = info.latest;
    if (expectedSha && expectedSha !== target.sha) throw new HttpError(409, '远端已有更新的提交，请重新检查更新后再试');
    const tarGz = await gh(`/repos/${cfg.repo}/tarball/${target.sha}`, { raw: true });
    const { files } = unpackTo(tarGz, STAGING);
    await verifyStaging(STAGING);

    const previousVersion = currentVersion();
    const backup = join(BACKUPS, new Date().toISOString().replace(/[:.]/g, '-'));
    swapIn(backup);
    rmSync(STAGING, { recursive: true, force: true });

    const version = { sha: target.sha, message: target.message, date: target.date, branch: info.branch, repo: cfg.repo, updatedAt: new Date().toISOString() };
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(versionFile(), JSON.stringify(version, null, 2));
    rmSync(join(dataDir(), 'update-rollback.json'), { force: true });
    writePending({ backup, sha: target.sha, previousVersion, at: version.updatedAt });
    pruneBackups();
    return { version, files, restart: info.managed };
  } finally {
    rmSync(STAGING, { recursive: true, force: true });
    running = false;
  }
}


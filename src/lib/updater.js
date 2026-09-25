// 在线更新：从 GitHub 拉取指定分支的最新代码，校验后替换本地代码，由守护进程重启服务。
import { gunzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { HttpError } from './http.js';
import { extractTar } from './tar.js';
import { ROOT, KEEP, dataDir } from './paths.js';
import { STAGING, BACKUPS, swapIn, writePending } from './swap.js';

const API = 'https://api.github.com';
const MAX_DOWNLOAD = 50 * 1024 * 1024;
const MAX_UNPACKED = 200 * 1024 * 1024;
const KEEP_BACKUPS = 3;
const DOWNLOAD_TIMEOUT = 300_000;

export const updateConfig = () => ({
  repo: process.env.UPDATE_REPO || 'bocmiao/api',
  branch: process.env.UPDATE_BRANCH || '',
  token: process.env.GITHUB_TOKEN || '',
  mirror: (process.env.UPDATE_MIRROR || '').trim(),
});

async function gh(path, { accept = 'application/vnd.github+json', raw = false, onBytes } = {}) {
  const { token } = updateConfig();
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      headers: { accept, 'user-agent': 'miao-api-updater', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(raw ? DOWNLOAD_TIMEOUT : 15_000),
    });
  } catch {
    throw new HttpError(502, '无法连接 GitHub，请检查服务器网络');
  }
  if (res.status === 404) throw new HttpError(502, '找不到仓库或分支；私有仓库需要配置 GITHUB_TOKEN');
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
    const when = reset > Date.now() ? `，约 ${Math.ceil((reset - Date.now()) / 60_000)} 分钟后恢复` : '';
    throw new HttpError(502, token
      ? `GitHub 接口次数已用完${when}`
      : `GitHub 接口次数已用完（未填写 Token 时每小时只有 60 次）${when}。在「系统设置 → 在线更新」填写 GitHub Token 后每小时 5000 次`);
  }
  if (!res.ok) throw new HttpError(502, `GitHub 返回 HTTP ${res.status}`);
  if (!raw) return res.json();
  return readBody(res, onBytes);
}

// 边下载边汇报进度（不一定有总大小，此时只报已下载字节数）
async function readBody(res, onBytes) {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_DOWNLOAD) throw new HttpError(502, '更新包过大');
  const chunks = [];
  let got = 0;
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      if (got > MAX_DOWNLOAD) throw new HttpError(502, '更新包过大');
      chunks.push(chunk);
      onBytes?.(got, len || null);
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, err.name === 'TimeoutError' ? '下载超时' : '下载更新包时连接中断');
  }
  return Buffer.concat(chunks);
}

// 通过加速地址下载 GitHub 源码包：地址形如 https://ghfast.top/ + https://github.com/owner/repo/archive/<sha>.tar.gz
export function mirrorUrl(mirror, repo, sha) {
  return `${mirror.replace(/\/+$/, '')}/https://github.com/${repo}/archive/${sha}.tar.gz`;
}

async function downloadViaMirror(mirror, repo, sha, onBytes) {
  let res;
  try {
    res = await fetch(mirrorUrl(mirror, repo, sha), { headers: { 'user-agent': 'miao-api-updater' }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT) });
  } catch {
    throw new HttpError(502, '无法连接下载加速地址');
  }
  if (!res.ok) throw new HttpError(502, `下载加速地址返回 HTTP ${res.status}`);
  return readBody(res, onBytes);
}

// 加速地址是第三方服务，下载到的每个文件都要和 GitHub 官方记录的文件指纹（git blob SHA-1）逐一核对，
// 有任何文件被改动、缺失或多出，都拒绝更新
const blobSha = (data) => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');

export async function verifyAgainstGitHub(tarGz, repo, sha, fetchTree = (path) => gh(path)) {
  const tree = await fetchTree(`/repos/${repo}/git/trees/${sha}?recursive=1`);
  if (!Array.isArray(tree?.tree) || tree.truncated) throw new HttpError(502, '无法从 GitHub 获取文件清单，不能校验加速下载的更新包');
  const expected = new Map(tree.tree.filter((t) => t.type === 'blob' && t.mode !== '120000').map((t) => [t.path, t.sha]));
  let tar;
  try {
    tar = gunzipSync(tarGz, { maxOutputLength: MAX_UNPACKED });
  } catch {
    throw new HttpError(502, '更新包解压失败');
  }
  const seen = new Set();
  for (const e of extractTar(tar).entries) {
    if (e.type !== 'file') continue;
    const rel = e.path.split('/').slice(1).join('/');
    if (!rel) continue;
    if (expected.get(rel) !== blobSha(e.data)) throw new HttpError(502, `加速下载的文件与 GitHub 官方不一致（${rel}），已拒绝更新`);
    seen.add(rel);
  }
  for (const path of expected.keys()) if (!seen.has(path)) throw new HttpError(502, `加速下载的更新包缺少文件 ${path}，已拒绝更新`);
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

// ---------- 版本号与更新日志 ----------

export function compareVersions(a, b) {
  const pa = String(a ?? '0').replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b ?? '0').replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// 进程启动时加载的版本：硬盘上的代码被替换后，只有重启服务才会生效
export const RUNNING_VERSION = localVersion();

export function localVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

// 本地版本信息：正在运行的版本、硬盘上的代码版本、最近一次在线更新的记录
export function versionInfo() {
  const disk = localVersion();
  const deployed = currentVersion();
  const valid = deployed && (!deployed.version || deployed.version === disk);
  return {
    running: RUNNING_VERSION,
    disk,
    restartNeeded: Boolean(RUNNING_VERSION && disk && RUNNING_VERSION !== disk),
    updatedAt: valid ? deployed.updatedAt ?? null : null,
    sha: valid ? deployed.sha ?? null : null,
  };
}

// 本地 CHANGELOG.md 的全部版本记录（新的在前）
export function localChangelog() {
  try {
    return parseChangelog(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'));
  } catch {
    return [];
  }
}

// 解析 CHANGELOG.md：## v0.3.0 · 2026-09-25 下面的 "- " 列表
export function parseChangelog(md) {
  const out = [];
  let cur = null;
  for (const line of String(md ?? '').split(/\r?\n/)) {
    const h = line.match(/^##\s+v?(\d+(?:\.\d+)*)\s*(?:[·\-–—|]\s*(.+))?$/);
    if (h) {
      cur = { version: h[1], date: h[2]?.trim() || null, items: [] };
      out.push(cur);
    } else if (cur && /^\s*[-*]\s+/.test(line)) {
      cur.items.push(line.replace(/^\s*[-*]\s+/, '').trim());
    }
  }
  return out;
}

// 读取仓库里的单个文件：公开仓库优先走 raw.githubusercontent.com（不占用 GitHub 接口的每小时次数），失败再走接口
async function remoteFile(repo, sha, path) {
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/${sha}/${path}`, { headers: { 'user-agent': 'miao-api-updater' }, signal: AbortSignal.timeout(15_000) });
    if (res.ok) return await res.text();
  } catch { /* 改走接口 */ }
  try {
    const buf = await gh(`/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${sha}`, { accept: 'application/vnd.github.raw', raw: true });
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

// 检查结果缓存 1 分钟：反复点「检查更新」和紧接着的「立即更新」不重复消耗 GitHub 接口次数
let lastCheck = null;

// 检查更新：按版本号比较，并附上中文更新日志
export async function checkUpdate({ maxAgeMs = 60_000 } = {}) {
  const cfg = updateConfig();
  const key = `${cfg.repo}#${cfg.branch}#${localVersion()}`;
  if (lastCheck && lastCheck.key === key && Date.now() - lastCheck.at < maxAgeMs) return { ...lastCheck.value, lastRollback: lastRollback() };
  const value = await checkUpdateFresh(cfg);
  lastCheck = { key, at: Date.now(), value };
  return value;
}

async function checkUpdateFresh(cfg) {
  const branch = cfg.branch || (await gh(`/repos/${cfg.repo}`)).default_branch;
  const latestCommit = commitInfo(await gh(`/repos/${cfg.repo}/commits/${encodeURIComponent(branch)}`));
  const [pkgText, changelogText] = await Promise.all([
    remoteFile(cfg.repo, latestCommit.sha, 'package.json'),
    remoteFile(cfg.repo, latestCommit.sha, 'CHANGELOG.md'),
  ]);
  let remoteVersion = null;
  try { remoteVersion = JSON.parse(pkgText).version ?? null; } catch {}

  const deployed = currentVersion();
  // 版本记录是在线更新时写的；之后手动上传了别的版本时记录已过期，提交号当作未知
  const recordValid = deployed && (!deployed.version || deployed.version === localVersion());
  const current = { version: localVersion(), running: RUNNING_VERSION, sha: recordValid ? deployed.sha ?? null : null, updatedAt: recordValid ? deployed.updatedAt ?? null : null };
  const cmp = remoteVersion && current.version ? compareVersions(remoteVersion, current.version) : 0;
  const sameCode = current.sha === latestCommit.sha;
  // 版本号更高 → 新版本；版本号相同但代码不同 → 小修复；版本号更低 → 分支落后，不提示更新
  const hasUpdate = cmp > 0 || (cmp === 0 && Boolean(current.sha) && !sameCode) || (!remoteVersion && !sameCode);
  const changelog = parseChangelog(changelogText);
  const changes = cmp > 0 ? changelog.filter((e) => compareVersions(e.version, current.version) > 0) : [];

  // 技术细节：两个版本之间的提交（仅当部署过的提交已知）
  let commits = [];
  if (hasUpdate && current.sha && !sameCode) {
    try {
      const c = await gh(`/repos/${cfg.repo}/compare/${current.sha}...${latestCommit.sha}`);
      commits = c.commits.map(commitInfo).reverse().slice(0, 50);
    } catch {}
  }

  return {
    repo: cfg.repo,
    branch,
    current,
    latest: { ...latestCommit, version: remoteVersion },
    hasUpdate,
    upToDate: !hasUpdate,
    patch: hasUpdate && cmp === 0,
    remoteOlder: cmp < 0,
    changes,
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

// ---------- 增量更新 ----------
// 用 GitHub 的文件清单（每个文件的 git blob 指纹）和本地文件逐个比对：没变的直接复制，只下载有改动的文件，
// 下载到的每个文件都核对指纹，所以走加速地址也不会被篡改。拼出的临时目录和整包解压的结果完全一致。
const MAX_INCREMENTAL_RATIO = 0.6;
const INCREMENTAL_CONCURRENCY = 8;

function localBlobSha(file) {
  try {
    if (!statSync(file).isFile()) return null;
    return blobSha(readFileSync(file));
  } catch {
    return null;
  }
}

const rawUrl = (repo, sha, path) => `https://raw.githubusercontent.com/${repo}/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`;

async function fetchRawFile(cfg, sha, path) {
  const direct = rawUrl(cfg.repo, sha, path);
  const urls = cfg.mirror ? [`${cfg.mirror.replace(/\/+$/, '')}/${direct}`, direct] : [direct];
  let lastErr;
  for (const url of urls) {
    try {
      const auth = cfg.token && url === direct ? { authorization: `Bearer ${cfg.token}` } : {};
      const res = await fetch(url, { headers: { 'user-agent': 'miao-api-updater', ...auth }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
    }
  }
  throw new HttpError(502, `下载 ${path} 失败：${lastErr?.message ?? '未知错误'}`);
}

// 返回 { files, downloaded, reused }；不适合增量时返回 null
export async function buildStagingIncremental(cfg, sha, onProgress, { root = ROOT, staging = STAGING, fetchTree = (p) => gh(p), fetchFile = (path) => fetchRawFile(cfg, sha, path) } = {}) {
  const tree = await fetchTree(`/repos/${cfg.repo}/git/trees/${sha}?recursive=1`);
  if (!Array.isArray(tree?.tree) || tree.truncated) return null;
  const blobs = tree.tree.filter((t) => t.type === 'blob' && t.mode !== '120000' && !KEEP.has(t.path.split('/')[0]));
  const totalBytes = blobs.reduce((n, b) => n + (b.size ?? 0), 0);
  const changed = blobs.filter((b) => localBlobSha(join(root, b.path)) !== b.sha);
  const changedBytes = changed.reduce((n, b) => n + (b.size ?? 0), 0);
  if (changed.length > 300 || (totalBytes && changedBytes / totalBytes > MAX_INCREMENTAL_RATIO)) return null;

  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const changedSet = new Set(changed);
  for (const b of blobs) {
    if (changedSet.has(b)) continue;
    const dest = join(staging, b.path);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(root, b.path), dest);
  }
  const reused = blobs.length - changed.length;
  let done = 0;
  onProgress?.(0, changed.length, reused);
  const queue = [...changed];
  const worker = async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      const data = await fetchFile(b.path);
      if (blobSha(data) !== b.sha) throw new HttpError(502, `下载的 ${b.path} 与 GitHub 官方不一致，已拒绝`);
      const dest = join(staging, b.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, data);
      onProgress?.(++done, changed.length, reused);
    }
  };
  await Promise.all(Array.from({ length: INCREMENTAL_CONCURRENCY }, worker));
  return { files: blobs.length, downloaded: changed.length, reused };
}

// 整包下载（首次、改动很多或增量失败时）：先走加速地址并核对，失败再直连 GitHub
async function downloadFull(cfg, target, onBytes) {
  let tarGz = null;
  if (cfg.mirror) {
    // 先走加速地址，失败或校验不通过再直连 GitHub
    try {
      tarGz = await downloadViaMirror(cfg.mirror, cfg.repo, target.sha, onBytes('加速下载'));
      report({ stage: '正在核对文件是否与 GitHub 官方一致', percent: 56, detail: '' });
      await verifyAgainstGitHub(tarGz, cfg.repo, target.sha);
    } catch (err) {
      report({ stage: '加速下载失败，改为直连 GitHub', percent: 5, detail: err.message });
      tarGz = null;
    }
  }
  tarGz ??= await gh(`/repos/${cfg.repo}/tarball/${target.sha}`, { raw: true, onBytes: onBytes('直连 GitHub') });
  report({ stage: '正在解压', percent: 58, detail: mb(tarGz.length) });
  const { files } = unpackTo(tarGz, STAGING);
  return { files };
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

// 更新进度：供后台轮询显示。percent 为 0~100；stage 为当前步骤的中文说明
const idle = () => ({ state: 'idle', stage: '', percent: 0, detail: '', error: null, result: null, startedAt: null });
let progress = idle();
export const updateProgress = () => ({ ...progress });
function report(patch) { progress = { ...progress, ...patch }; }
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

// 后台启动更新，立即返回；进度通过 updateProgress() 查询。onDone(result) 在成功后调用（用于重启）
export function startUpdate(opts = {}, onDone) {
  if (running) throw new HttpError(409, '已有更新正在进行');
  progress = { ...idle(), state: 'running', stage: '正在检查新版本', percent: 2, startedAt: new Date().toISOString() };
  applyUpdate(opts)
    .then((result) => {
      report({ state: 'done', stage: result.restart ? '更新完成，正在重启服务' : '更新完成，需要手动重启服务', percent: 100, result });
      onDone?.(result);
    })
    .catch((err) => report({ state: 'error', stage: '更新失败', error: err.message || String(err) }));
  return updateProgress();
}

export async function applyUpdate({ sha: expectedSha } = {}) {
  if (running) throw new HttpError(409, '已有更新正在进行');
  running = true;
  try {
    const cfg = updateConfig();
    report({ stage: '正在检查新版本', percent: 3 });
    const info = await checkUpdate({ maxAgeMs: 5 * 60_000 });
    if (!info.hasUpdate) throw new HttpError(409, info.remoteOlder ? '仓库中的版本比当前版本旧，已取消更新' : '已是最新版本');
    const target = info.latest;
    if (expectedSha && expectedSha !== target.sha) throw new HttpError(409, '远端已有更新的提交，请重新检查更新后再试');
    report({ stage: '正在下载新版本', percent: 5, target: { version: target.version, sha: target.sha } });
    const onBytes = (via) => (got, total) => report({
      percent: total ? 5 + Math.round((got / total) * 50) : Math.min(50, 5 + Math.round(got / 200_000)),
      detail: `${via} · ${total ? `${mb(got)} / ${mb(total)}` : `已下载 ${mb(got)}`}`,
    });
    // 优先增量更新：只下载有改动的文件；清单取不到、改动太多或下载出错时退回整包下载
    let files = null;
    let mode = '增量更新';
    try {
      const inc = await buildStagingIncremental(cfg, target.sha, (done, total, reused) => report({
        stage: '正在下载有改动的文件', percent: 5 + Math.round((done / Math.max(total, 1)) * 50),
        detail: `增量更新 · 已下载 ${done} / ${total} 个改动文件（${reused} 个文件没有变化，直接复用）`,
      }));
      if (inc) files = inc.files;
    } catch (err) {
      report({ stage: '增量更新失败，改为下载完整更新包', percent: 5, detail: err.message });
    }
    if (files == null) {
      mode = '完整更新';
      files = (await downloadFull(cfg, target, onBytes)).files;
    }
    report({ stage: '正在检查新版本能否正常启动', percent: 65, detail: `${mode} · 共 ${files} 个文件` });
    // 试启动一般要几秒到十几秒，期间进度缓慢前进，让页面看得出没有卡住
    const tick = setInterval(() => report({ percent: Math.min(90, progress.percent + 1) }), 800);
    try { await verifyStaging(STAGING); } finally { clearInterval(tick); }

    report({ stage: '正在备份并替换文件', percent: 92, detail: '' });
    const previousVersion = currentVersion();
    const backup = join(BACKUPS, new Date().toISOString().replace(/[:.]/g, '-'));
    swapIn(backup);
    rmSync(STAGING, { recursive: true, force: true });

    const version = { version: target.version, sha: target.sha, message: target.message, date: target.date, branch: info.branch, repo: cfg.repo, updatedAt: new Date().toISOString() };
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(versionFile(), JSON.stringify(version, null, 2));
    rmSync(join(dataDir(), 'update-rollback.json'), { force: true });
    writePending({ backup, sha: target.sha, previousVersion, at: version.updatedAt });
    pruneBackups();
    report({ percent: 97 });
    return { version, files, restart: info.managed };
  } finally {
    rmSync(STAGING, { recursive: true, force: true });
    running = false;
  }
}


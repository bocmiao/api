// 代码目录的替换与回滚。守护进程也会用到，所以这里只依赖 node 内置模块。
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, KEEP, dataDir } from './paths.js';

export const STAGING = join(ROOT, '.update-staging');
export const BACKUPS = join(ROOT, '.update-backup');
export const pendingFile = () => join(dataDir(), 'update-pending.json');

const movable = (dir) => readdirSync(dir).filter((n) => !KEEP.has(n));

// 把 ROOT 下的代码移到 backupDir，再把 STAGING 下的新代码移进 ROOT。中途失败会原样恢复。
export function swapIn(backupDir, { root = ROOT, staging = STAGING } = {}) {
  mkdirSync(backupDir, { recursive: true });
  const moved = [];
  const placed = [];
  try {
    for (const name of movable(root)) {
      renameSync(join(root, name), join(backupDir, name));
      moved.push(name);
    }
    for (const name of movable(staging)) {
      renameSync(join(staging, name), join(root, name));
      placed.push(name);
    }
  } catch (err) {
    for (const name of placed) rmSync(join(root, name), { recursive: true, force: true });
    for (const name of moved) renameSync(join(backupDir, name), join(root, name));
    throw err;
  }
}

// 用备份替换当前代码（当前代码移到 .update-failed 以便排查）
export function restoreBackup(backupDir, { root = ROOT } = {}) {
  const failed = join(root, '.update-failed');
  rmSync(failed, { recursive: true, force: true });
  mkdirSync(failed, { recursive: true });
  for (const name of movable(root)) renameSync(join(root, name), join(failed, name));
  for (const name of readdirSync(backupDir)) renameSync(join(backupDir, name), join(root, name));
  rmSync(backupDir, { recursive: true, force: true });
}

// 更新后新版本尚未确认健康时存在该标记；守护进程据此决定崩溃时是否回滚
export function readPending() {
  try {
    return JSON.parse(readFileSync(pendingFile(), 'utf8'));
  } catch {
    return null;
  }
}
export function writePending(info) {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(pendingFile(), JSON.stringify(info));
}
export function clearPending() {
  rmSync(pendingFile(), { force: true });
}

// 新版本启动失败时由守护进程调用：恢复备份并还原版本记录
export function rollbackPending({ root = ROOT } = {}) {
  const p = readPending();
  if (!p?.backup || !existsSync(p.backup)) {
    clearPending();
    return false;
  }
  restoreBackup(p.backup, { root });
  if (p.previousVersion !== undefined) {
    const file = join(dataDir(), 'version.json');
    if (p.previousVersion) writeFileSync(file, JSON.stringify(p.previousVersion, null, 2));
    else rmSync(file, { force: true });
  }
  writeFileSync(join(dataDir(), 'update-rollback.json'), JSON.stringify({ at: new Date().toISOString(), failedSha: p.sha ?? null }));
  clearPending();
  return true;
}

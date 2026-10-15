// 代码身份来自实际文件。version.json 是安装记录，不能单凭版本号证明代码或进程身份。
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT, KEEP, dataDir } from './paths.js';

export const isCommitSha = (sha) => /^[0-9a-f]{40}$/.test(sha ?? '');
const isInstallationId = (id) => typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);

export function readInstallation(dir = dataDir()) {
  try { return JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8')); } catch { return null; }
}

export function packageVersion(root = ROOT) {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? null; } catch { return null; }
}

// 不跟随符号链接，不读取 data/.env/.git；指纹也覆盖增加和删除的程序文件。
function codeFiles(root) {
  const files = new Map();
  const walk = (dir, prefix = '') => {
    for (const name of readdirSync(dir).sort()) {
      if (!prefix && KEEP.has(name)) continue;
      const path = prefix + name, full = join(dir, name);
      if (resolve(full) === resolve(dataDir())) continue;
      const stat = lstatSync(full);
      if (stat.isDirectory()) walk(full, path + '/');
      else if (stat.isFile()) {
        const data = readFileSync(full);
        files.set(path, createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex'));
      } else throw new Error('无法确认代码文件身份');
    }
  };
  walk(root);
  return files;
}

const digestFiles = (files) => createHash('sha256').update(JSON.stringify([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex');

export function codeDigest(root = ROOT) {
  try { return digestFiles(codeFiles(root)); } catch { return null; }
}

// Git 是可选的。保留的 .git 可能仍指向更新前提交，必须逐文件核验，不能只读 HEAD。
function gitIdentity(root, files) {
  if (!existsSync(join(root, '.git'))) return null;
  try {
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const [sha, commitDate] = git('show', '-s', '--format=%H%x00%cI', 'HEAD').trim().split('\0');
    if (!isCommitSha(sha)) return null;
    const entries = git('ls-tree', '-rz', '--full-tree', sha).split('\0').filter(Boolean).map((line) => {
      const [meta, path] = line.split('\t');
      return { path, meta: meta.split(' ') };
    }).filter((e) => !KEEP.has(e.path.split('/')[0]));
    if (entries.length !== files.size || entries.some((e) => e.meta[1] !== 'blob' || e.meta[0] === '120000' || files.get(e.path) !== e.meta[2])) return null;
    return { sha, commitDate };
  } catch { return null; }
}

export function diskIdentity({ root = ROOT, record = readInstallation() } = {}) {
  const version = packageVersion(root);
  let files;
  try { files = codeFiles(root); } catch { /* 无法读取时保持未知 */ }
  const digest = files ? digestFiles(files) : null;
  const valid = Boolean(digest && record?.schema === 2 && record.codeDigest === digest
    && record.version === version && isInstallationId(record.installationId));
  const git = !valid && files ? gitIdentity(root, files) : null;
  return {
    version,
    sha: valid ? (isCommitSha(record.sha) ? record.sha : null) : git?.sha ?? null,
    codeDigest: digest,
    installationId: valid ? record.installationId : null,
    installedAt: valid ? record.updatedAt ?? null : null,
    commitDate: valid ? record.commitDate ?? null : git?.commitDate ?? null,
    source: valid ? record.source ?? 'online' : git ? 'git' : 'unknown',
  };
}

export function captureRunningIdentity(options) {
  return Object.freeze({ ...diskIdentity(options), instanceId: randomUUID(), startedAt: new Date().toISOString() });
}

export const RUNNING_IDENTITY = captureRunningIdentity();

export function restartState(running, disk) {
  const known = Boolean(running.codeDigest && disk.codeDigest);
  return {
    restartNeeded: Boolean((running.version && disk.version && running.version !== disk.version)
      || (known && running.codeDigest !== disk.codeDigest)
      || (running.installationId !== disk.installationId && disk.installationId)),
    restartUnknown: !known,
  };
}

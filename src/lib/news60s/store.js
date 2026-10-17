import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from '../http.js';
import { dataDir } from '../paths.js';
import { editionDate, today, MAX_IMAGE_BYTES } from './format.js';

export const ASSET_PREFIX = '/api/news/60s/assets';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const REVISION = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ASSET = /^([a-f0-9]{64})\.(png|jpg|webp|gif)$/;
const MIMES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

async function writeDurable(path, bytes) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}

async function syncDir(path) {
  const file = await open(path, 'r');
  try { await file.sync(); } finally { await file.close(); }
}

// Files are immutable generations. The FULL-synchronous SQLite transaction is the
// only publication point, after JSON/images and their directory entries are durable.
// SQLite also serializes separate CLI/server processes and releases locks on crash.
export class News60sStore {
  constructor(root = join(dataDir(), 'news60s')) {
    this.root = resolve(root);
    this.revisions = join(this.root, 'revisions');
    mkdirSync(this.revisions, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(this.root, 'index.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS revisions (
        id TEXT PRIMARY KEY, date TEXT NOT NULL, record_sha TEXT NOT NULL, content_sha TEXT NOT NULL, published_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS editions (
        date TEXT PRIMARY KEY, revision TEXT NOT NULL REFERENCES revisions(id)
      );`);
  }

  close() { this.db.close(); }
  snapshot() { return new Map(this.db.prepare('SELECT date, revision FROM editions').all().map((r) => [r.date, r.revision])); }
  status() {
    const dates = this.db.prepare('SELECT date FROM editions WHERE date<=? ORDER BY date DESC').all(today()).map((r) => r.date);
    return { latestDate: dates[0] ?? null, editions: dates.length, dates: dates.slice(0, 90),
      stale: Boolean(dates[0] && dates[0] < today()), sourceConfigured: Boolean(process.env.NEWS_60S_SOURCE_URL),
      discovery: 'manual-url-or-json', automaticArticleDiscovery: false };
  }

  async publish(data, images, { expectedRevision = null, beforeCommit } = {}) {
    editionDate(data.date);
    const contentSha = digest(JSON.stringify({ data: { ...data, image: null, cover: null },
      images: Object.fromEntries(Object.entries(images).map(([slot, image]) => [slot, digest(image.bytes)])) }));
    const previous = this.db.prepare('SELECT r.* FROM editions e JOIN revisions r ON e.revision=r.id WHERE e.date=?').get(data.date);
    if ((previous?.id ?? null) !== expectedRevision) throw new HttpError(409, '该日期已被其他更新修改，请重新提交', 'NEWS60S_CONFLICT');
    if (previous?.content_sha === contentSha) return { date: data.date, revision: previous.id, publishedAt: previous.published_at, latestDate: this.status().latestDate, unchanged: true };
    const revision = randomUUID();
    const staging = join(this.root, '.staging-' + revision);
    const destination = join(this.revisions, revision);
    const publishedAt = new Date().toISOString();
    let moved = false;
    let transaction = false;
    await mkdir(staging, { mode: 0o700 });
    try {
      const names = new Set();
      const stored = { ...data };
      for (const slot of ['image', 'cover']) {
        const image = images[slot];
        if (!image) { stored[slot] = null; continue; }
        const name = digest(image.bytes) + '.' + image.ext;
        if (!names.has(name)) { await writeDurable(join(staging, name), image.bytes); names.add(name); }
        stored[slot] = `${ASSET_PREFIX}/${revision}/${name}`;
      }
      const record = { schema: 1, revision, publishedAt, data: stored, assets: [...names] };
      const bytes = Buffer.from(JSON.stringify(record) + '\n');
      await writeDurable(join(staging, 'record.json'), bytes);
      await syncDir(staging);
      await rename(staging, destination);
      moved = true;
      await syncDir(this.revisions);
      await beforeCommit?.(); // deterministic failure/concurrency injection in tests only
      this.db.exec('BEGIN IMMEDIATE');
      transaction = true;
      const current = this.db.prepare('SELECT revision FROM editions WHERE date=?').get(data.date)?.revision ?? null;
      if (current !== expectedRevision) throw new HttpError(409, '同一天的数据已被其他更新修改，请读取后重新提交', 'NEWS60S_CONFLICT');
      this.db.prepare('INSERT INTO revisions(id,date,record_sha,content_sha,published_at) VALUES(?,?,?,?,?)').run(revision, data.date, digest(bytes), contentSha, publishedAt);
      this.db.prepare('INSERT INTO editions(date,revision) VALUES(?,?) ON CONFLICT(date) DO UPDATE SET revision=excluded.revision').run(data.date, revision);
      this.db.exec('COMMIT');
      transaction = false;
      return { date: data.date, revision, publishedAt, latestDate: this.status().latestDate };
    } catch (err) {
      if (transaction) { try { this.db.exec('ROLLBACK'); } catch {} }
      // An uncertain COMMIT must never cause removal of a published generation.
      const published = this.db.prepare('SELECT 1 FROM revisions WHERE id=?').get(revision);
      if (!published) await rm(moved ? destination : staging, { recursive: true, force: true });
      throw err;
    }
  }

  async read(date, { now = new Date() } = {}) {
    if (date != null) editionDate(date, { now });
    const row = date != null
      ? this.db.prepare('SELECT r.* FROM editions e JOIN revisions r ON r.id=e.revision WHERE e.date=?').get(date)
      : this.db.prepare('SELECT r.* FROM editions e JOIN revisions r ON r.id=e.revision WHERE e.date<=? ORDER BY e.date DESC LIMIT 1').get(today(now));
    if (!row) throw new HttpError(date ? 404 : 503, date ? '该日期尚未发布简报，不回退到最新一期' : '尚未发布自有简报，请管理员导入 JSON 或文章 URL', date ? 'NEWS60S_DATE_NOT_FOUND' : 'NEWS60S_NOT_READY');
    let raw;
    try { raw = await readFile(join(this.revisions, row.id, 'record.json')); }
    catch { throw new HttpError(503, '已发布简报文件不可读，请恢复数据备份', 'NEWS60S_STORAGE_ERROR'); }
    if (digest(raw) !== row.record_sha) throw new HttpError(503, '简报文件完整性校验失败', 'NEWS60S_STORAGE_ERROR');
    const record = JSON.parse(raw);
    if (record.schema !== 1 || record.revision !== row.id || record.data?.date !== row.date) throw new HttpError(503, '简报索引与版本不一致', 'NEWS60S_STORAGE_ERROR');
    return { data: record.data, cached: true, updatedAt: row.published_at, ...(!date && row.date < today(now) ? { stale: true } : {}) };
  }

  async asset(revision, name) {
    const match = typeof name === 'string' && ASSET.exec(name);
    if (!REVISION.test(String(revision)) || !match || !this.db.prepare('SELECT 1 FROM revisions WHERE id=?').get(revision)) throw new HttpError(404, '图片不存在');
    const file = join(this.revisions, revision, name);
    let bytes;
    try {
      if ((await stat(file)).size > MAX_IMAGE_BYTES) throw new Error('oversized');
      bytes = await readFile(file);
    } catch { throw new HttpError(404, '图片不存在'); }
    if (digest(bytes) !== match[1]) throw new HttpError(503, '图片完整性校验失败', 'NEWS60S_STORAGE_ERROR');
    return { bytes, mime: MIMES[match[2]], etag: `"${match[1]}"` };
  }
}

let singleton;
export function news60sStore() {
  const root = resolve(join(dataDir(), 'news60s'));
  if (!singleton || singleton.root !== root) {
    singleton?.close();
    singleton = new News60sStore(root);
  }
  return singleton;
}

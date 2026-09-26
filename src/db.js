import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './lib/paths.js';

// node:sqlite 仍标记为实验特性，屏蔽其启动警告
const emit = process.emitWarning;
process.emitWarning = (w, ...a) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...a));
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = emit;

const dir = dataDir();
const file = process.env.DB_FILE || (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT ? ':memory:' : join(dir, 'miao-api.db'));
if (file !== ':memory:') mkdirSync(dir, { recursive: true });

export const db = new DatabaseSync(file);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    daily_limit INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  );
  CREATE TABLE IF NOT EXISTS usage_daily (
    day TEXT NOT NULL,
    subject TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, subject)
  );
  CREATE TABLE IF NOT EXISTS request_log (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    user_id INTEGER,
    key_id INTEGER,
    ip TEXT,
    path TEXT NOT NULL,
    status INTEGER NOT NULL,
    ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS request_log_ts ON request_log(ts);
  CREATE INDEX IF NOT EXISTS request_log_user ON request_log(user_id, ts);
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    config TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    topic TEXT NOT NULL,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    PRIMARY KEY (topic, channel_id)
  );
  CREATE TABLE IF NOT EXISTS topic_state (
    topic TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS email_codes (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    purpose TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    ip TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    used INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS email_codes_email ON email_codes(email, purpose, id);
  CREATE INDEX IF NOT EXISTS email_codes_ip ON email_codes(ip, created_at);
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS module_settings (
    name TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS short_links (
    code TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    user_id INTEGER,
    hits INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// 老数据库补列：调用日志记录失败原因（供管理员排查、AI 分析）
const hasColumn = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
if (!hasColumn('request_log', 'error')) db.exec('ALTER TABLE request_log ADD COLUMN error TEXT');

// 每个接口地址的累计调用次数（不随调用日志清理而减少）；首次建表时用现有日志初始化
const hasTable = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
if (!hasTable('api_calls')) {
  db.exec('CREATE TABLE api_calls (path TEXT PRIMARY KEY, total INTEGER NOT NULL DEFAULT 0)');
  db.exec("INSERT INTO api_calls (path, total) SELECT path, COUNT(*) FROM request_log WHERE path LIKE '/api/%' GROUP BY path");
}

// 小工具：db.prepare 的缓存版
const stmts = new Map();
export function sql(text) {
  let s = stmts.get(text);
  if (!s) stmts.set(text, (s = db.prepare(text)));
  return s;
}

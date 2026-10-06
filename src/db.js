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

// ---------- 统计 ----------
// 调用日志补充的维度：是否命中缓存（0 未命中 / 1 命中 / 2 上游故障时返回的旧数据）、返回字节数、
// 调用方式（anon 未登录 / session 网页登录 / apikey）、来源网站域名、客户端类型、IP 属地与运营商
for (const [col, type] of [['cached', 'INTEGER'], ['bytes', 'INTEGER'], ['via', 'TEXT'], ['referer', 'TEXT'], ['client', 'TEXT'], ['region', 'TEXT'], ['isp', 'TEXT']]) {
  if (!hasColumn('request_log', col)) db.exec(`ALTER TABLE request_log ADD COLUMN ${col} ${type}`);
}
db.exec('CREATE INDEX IF NOT EXISTS request_log_path ON request_log(path, ts)');

// 按小时 / 按天的汇总：统计页面只读汇总表，数据再多也能很快打开。
// l0~l9 为耗时分桶（毫秒）：≤50、≤100、≤200、≤300、≤500、≤800、≤1200、≤2000、≤5000、>5000，用来估算 P50 / P95
export const STAT_COLS = ['calls', 'ok', 'e4xx', 'e5xx', 'limited', 'cached', 'stale', 'bytes', 'ms_sum', 'ms_max', 'anon', 'session', 'apikey',
  'l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9'];
const statCols = STAT_COLS.map((c) => `${c} INTEGER NOT NULL DEFAULT 0`).join(', ');
const newStats = !hasTable('stats_hourly');
db.exec(`
  CREATE TABLE IF NOT EXISTS stats_hourly (hour INTEGER NOT NULL, path TEXT NOT NULL, ${statCols}, PRIMARY KEY (hour, path));
  CREATE TABLE IF NOT EXISTS stats_daily (day TEXT NOT NULL, path TEXT NOT NULL, ${statCols}, PRIMARY KEY (day, path));
  CREATE TABLE IF NOT EXISTS stats_limited (day TEXT NOT NULL, subject TEXT NOT NULL, path TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, subject, path));
  CREATE TABLE IF NOT EXISTS stats_day_meta (day TEXT PRIMARY KEY, ips INTEGER NOT NULL DEFAULT 0, users INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS health_checks (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, module TEXT NOT NULL, path TEXT NOT NULL, ok INTEGER NOT NULL, status INTEGER, ms INTEGER, error TEXT);
  CREATE INDEX IF NOT EXISTS health_checks_path ON health_checks(path, ts);
  CREATE INDEX IF NOT EXISTS health_checks_ts ON health_checks(ts);
  CREATE TABLE IF NOT EXISTS health_daily (day TEXT NOT NULL, path TEXT NOT NULL, checks INTEGER NOT NULL DEFAULT 0, fails INTEGER NOT NULL DEFAULT 0, ms_sum INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, path));
  CREATE TABLE IF NOT EXISTS incidents (id INTEGER PRIMARY KEY, module TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, source TEXT NOT NULL, reason TEXT);
  CREATE INDEX IF NOT EXISTS incidents_started ON incidents(started_at);
`);
// 首次建表：用现有调用日志补齐汇总，新页面一上线就有历史数据
if (newStats) {
  const bucket = (i, lo, hi) => `SUM(CASE WHEN ms > ${lo} ${hi == null ? '' : `AND ms <= ${hi}`} THEN 1 ELSE 0 END) AS l${i}`;
  const edges = [-1, 50, 100, 200, 300, 500, 800, 1200, 2000, 5000, null];
  const agg = `COUNT(*) AS calls, SUM(CASE WHEN status < 400 THEN 1 ELSE 0 END) AS ok,
    SUM(CASE WHEN status >= 400 AND status < 500 THEN 1 ELSE 0 END) AS e4xx, SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS e5xx,
    0 AS limited, 0 AS cached, 0 AS stale, 0 AS bytes, SUM(ms) AS ms_sum, MAX(ms) AS ms_max,
    SUM(CASE WHEN user_id IS NULL THEN 1 ELSE 0 END) AS anon, SUM(CASE WHEN user_id IS NOT NULL AND key_id IS NULL THEN 1 ELSE 0 END) AS session,
    SUM(CASE WHEN key_id IS NOT NULL THEN 1 ELSE 0 END) AS apikey,
    ${edges.slice(0, 10).map((lo, i) => bucket(i, lo, edges[i + 1])).join(', ')}`;
  db.exec(`INSERT INTO stats_hourly (hour, path, ${STAT_COLS.join(', ')}) SELECT CAST(ts / 3600000 AS INTEGER) * 3600000, path, ${agg} FROM request_log GROUP BY 1, 2`);
  db.exec(`INSERT INTO stats_daily (day, path, ${STAT_COLS.join(', ')}) SELECT date(ts / 1000 + 28800, 'unixepoch'), path, ${agg} FROM request_log GROUP BY 1, 2`);
  db.exec(`INSERT INTO stats_day_meta (day, ips, users) SELECT date(ts / 1000 + 28800, 'unixepoch'), COUNT(DISTINCT ip), COUNT(DISTINCT user_id) FROM request_log GROUP BY 1`);
}

// ---------- v0.11 ----------
// 请求 ID：每次调用都有一个，返回在响应头 X-Request-Id 里，用户报错时凭它在后台查到这次调用
if (!hasColumn('request_log', 'rid')) db.exec('ALTER TABLE request_log ADD COLUMN rid TEXT');
db.exec('CREATE INDEX IF NOT EXISTS request_log_rid ON request_log(rid)');
// API Key 来源限制：每行一条，域名（example.com、*.example.com）或 IP / IP 段；为空不限制
if (!hasColumn('api_keys', 'allow')) db.exec('ALTER TABLE api_keys ADD COLUMN allow TEXT');
// Key 停用（保留 Key 和设置，随时可以重新启用）、可调用的接口范围（模块名，每行一个；为空不限制）
if (!hasColumn('api_keys', 'disabled')) db.exec('ALTER TABLE api_keys ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
if (!hasColumn('api_keys', 'scopes')) db.exec('ALTER TABLE api_keys ADD COLUMN scopes TEXT');
// 兑换码送的额外次数：当天额度用完后再从这里扣，用完为止
if (!hasColumn('users', 'bonus_calls')) db.exec('ALTER TABLE users ADD COLUMN bonus_calls INTEGER NOT NULL DEFAULT 0');
db.exec(`
  CREATE TABLE IF NOT EXISTS route_cache (path TEXT PRIMARY KEY, ttl_ms INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    level TEXT NOT NULL DEFAULT 'info',
    mode TEXT NOT NULL DEFAULT 'bar',
    frequency TEXT NOT NULL DEFAULT 'once',
    priority INTEGER NOT NULL DEFAULT 0,
    audience TEXT NOT NULL DEFAULT 'all',
    enabled INTEGER NOT NULL DEFAULT 1,
    starts_at INTEGER,
    ends_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS friend_links (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    sort INTEGER NOT NULL DEFAULT 0,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    note TEXT,
    created_at INTEGER NOT NULL,
    reviewed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS friend_links_status ON friend_links(status, sort);
  -- 每个接口模块的运行参数：置顶、推荐、缓存时长、每分钟限流（为空用接口自带的设置）
  CREATE TABLE IF NOT EXISTS module_options (
    name TEXT PRIMARY KEY,
    pinned INTEGER NOT NULL DEFAULT 0,
    featured INTEGER NOT NULL DEFAULT 0,
    cache_ttl_ms INTEGER,
    minute_limit INTEGER,
    updated_at INTEGER NOT NULL
  );
  -- 管理操作记录：只增不改，调整额度、停用用户等必须填原因
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    admin_id INTEGER,
    admin_email TEXT,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT,
    reason TEXT,
    ip TEXT
  );
  CREATE INDEX IF NOT EXISTS audit_log_ts ON audit_log(ts);
  CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  CREATE TABLE IF NOT EXISTS login_log (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    user_id INTEGER,
    email TEXT,
    ip TEXT,
    region TEXT,
    client TEXT,
    ok INTEGER NOT NULL,
    reason TEXT
  );
  CREATE INDEX IF NOT EXISTS login_log_user ON login_log(user_id, ts);
  CREATE INDEX IF NOT EXISTS login_log_ts ON login_log(ts);
  CREATE TABLE IF NOT EXISTS redeem_codes (
    code TEXT PRIMARY KEY,
    calls INTEGER NOT NULL,
    max_uses INTEGER NOT NULL DEFAULT 1,
    used INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    note TEXT,
    created_by INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS redemptions (
    code TEXT NOT NULL REFERENCES redeem_codes(code) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    calls INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (code, user_id)
  );
`);

// 小工具：db.prepare 的缓存版
const stmts = new Map();
export function sql(text) {
  let s = stmts.get(text);
  if (!s) stmts.set(text, (s = db.prepare(text)));
  return s;
}

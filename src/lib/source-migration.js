import { legacySource } from './source.js';

// One transaction installs the backfill, marker and insert trigger. Raw-log deletion
// never subtracts aggregates; a repeated migration never adds the backfill again.
export function migrateSources(db, now = Date.now()) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(request_log)').all().map(c => c.name));
    for (const [name, type] of [['source_basis', "TEXT NOT NULL DEFAULT 'legacy'"],
      ['source_state', "TEXT NOT NULL DEFAULT 'legacy'"], ['origin_host', 'TEXT'], ['referer_host', 'TEXT']]) {
      if (!columns.has(name)) db.exec(`ALTER TABLE request_log ADD COLUMN ${name} ${type}`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS source_daily (
      day TEXT NOT NULL, host TEXT NOT NULL, basis TEXT NOT NULL, state TEXT NOT NULL,
      user_id INTEGER NOT NULL, key_id INTEGER NOT NULL, path TEXT NOT NULL,
      calls INTEGER NOT NULL, errors INTEGER NOT NULL, last_at INTEGER NOT NULL,
      PRIMARY KEY(day, host, basis, state, user_id, key_id, path)
    );
    CREATE INDEX IF NOT EXISTS source_daily_host ON source_daily(host, day);
    CREATE INDEX IF NOT EXISTS source_daily_user ON source_daily(user_id, day);
    CREATE INDEX IF NOT EXISTS source_daily_key ON source_daily(key_id, day);
    CREATE INDEX IF NOT EXISTS request_log_source ON request_log(referer, ts);
    CREATE TABLE IF NOT EXISTS source_meta (
      id INTEGER PRIMARY KEY CHECK(id = 1), started_at INTEGER NOT NULL,
      backfilled_from INTEGER, backfilled_to INTEGER
    );`);
    if (!db.prepare('SELECT 1 FROM source_meta WHERE id = 1').get()) {
      const update = db.prepare("UPDATE request_log SET referer = ?, source_basis = 'legacy', source_state = ? WHERE referer IS ?");
      for (const { referer } of db.prepare('SELECT DISTINCT referer FROM request_log ORDER BY referer').all()) {
        const r = legacySource(referer);
        update.run(r.host, r.state, referer);
      }
      db.exec(`INSERT INTO source_daily
        SELECT date(ts / 1000.0, 'unixepoch', '+8 hours'), COALESCE(referer, ''), source_basis, source_state,
          COALESCE(user_id, 0), COALESCE(key_id, 0), path, COUNT(*), SUM(status >= 400), MAX(ts)
        FROM request_log GROUP BY 1,2,3,4,5,6,7`);
      const span = db.prepare('SELECT MIN(ts) AS lo, MAX(ts) AS hi FROM request_log').get();
      db.prepare('INSERT INTO source_meta VALUES (1, ?, ?, ?)').run(now, span.lo, span.hi);
    }
    db.exec(`CREATE TRIGGER IF NOT EXISTS source_log_insert AFTER INSERT ON request_log BEGIN
      INSERT INTO source_daily VALUES (
        date(NEW.ts / 1000.0, 'unixepoch', '+8 hours'), COALESCE(NEW.referer, ''), NEW.source_basis, NEW.source_state,
        COALESCE(NEW.user_id, 0), COALESCE(NEW.key_id, 0), NEW.path, 1, NEW.status >= 400, NEW.ts)
      ON CONFLICT(day, host, basis, state, user_id, key_id, path) DO UPDATE SET
        calls = calls + 1, errors = errors + excluded.errors, last_at = MAX(last_at, excluded.last_at);
    END`);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

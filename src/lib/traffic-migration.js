// Old totals have no trusted test marker: preserve them as legacy, included in
// business and all. Never infer identity from an address, header or admin role.
export function migrateTraffic(db, cols, now = Date.now()) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const has = (t,c) => db.prepare(`PRAGMA table_info(${t})`).all().some(x=>x.name===c);
    if (!has('request_log','traffic')) db.exec("ALTER TABLE request_log ADD COLUMN traffic TEXT NOT NULL DEFAULT 'legacy'");
    if (!has('request_log','traffic_basis')) db.exec("ALTER TABLE request_log ADD COLUMN traffic_basis TEXT NOT NULL DEFAULT 'legacy_unclassified'");
    const fields=cols.map(c=>`${c} INTEGER NOT NULL DEFAULT 0`).join(',');
    db.exec(`CREATE TABLE IF NOT EXISTS traffic_meta(id INTEGER PRIMARY KEY CHECK(id=1),started_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS traffic_hourly(hour INTEGER NOT NULL,path TEXT NOT NULL,traffic TEXT NOT NULL,${fields},PRIMARY KEY(hour,path,traffic));
      CREATE TABLE IF NOT EXISTS traffic_daily(day TEXT NOT NULL,path TEXT NOT NULL,traffic TEXT NOT NULL,${fields},PRIMARY KEY(day,path,traffic));
      CREATE TABLE IF NOT EXISTS traffic_limited(day TEXT NOT NULL,subject TEXT NOT NULL,path TEXT NOT NULL,traffic TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(day,subject,path,traffic));
      CREATE TABLE IF NOT EXISTS traffic_day_meta(day TEXT NOT NULL,traffic TEXT NOT NULL,ips INTEGER NOT NULL,users INTEGER NOT NULL,PRIMARY KEY(day,traffic));
      CREATE TABLE IF NOT EXISTS traffic_internal_calls(path TEXT PRIMARY KEY,total INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS traffic_internal_user_calls(user_id INTEGER NOT NULL,day TEXT NOT NULL,path TEXT NOT NULL,calls INTEGER NOT NULL,ok INTEGER NOT NULL,e4xx INTEGER NOT NULL,e5xx INTEGER NOT NULL,PRIMARY KEY(user_id,day,path));
      CREATE TABLE IF NOT EXISTS traffic_key_bindings(key_id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS traffic_config_users(user_id INTEGER PRIMARY KEY);
      CREATE INDEX IF NOT EXISTS request_log_traffic ON request_log(traffic,ts);`);
    if (!db.prepare('SELECT 1 FROM traffic_meta WHERE id=1').get()) {
      for(const [table,key] of [['hourly','hour'],['daily','day']]) db.exec(`INSERT INTO traffic_${table}(${key},path,traffic,${cols.join(',')}) SELECT ${key},path,'legacy',${cols.join(',')} FROM stats_${table}`);
      db.exec("INSERT INTO traffic_limited SELECT day,subject,path,'legacy',count FROM stats_limited");
      db.exec("INSERT INTO traffic_day_meta SELECT day,'business',ips,users FROM stats_day_meta");
      db.exec(`DROP TRIGGER IF EXISTS source_log_insert;
        ALTER TABLE source_daily RENAME TO source_daily_before_traffic;
        CREATE TABLE source_daily(day TEXT NOT NULL,host TEXT NOT NULL,basis TEXT NOT NULL,state TEXT NOT NULL,user_id INTEGER NOT NULL,key_id INTEGER NOT NULL,path TEXT NOT NULL,calls INTEGER NOT NULL,errors INTEGER NOT NULL,last_at INTEGER NOT NULL,traffic TEXT NOT NULL DEFAULT 'legacy',PRIMARY KEY(day,host,basis,state,user_id,key_id,path,traffic));
        INSERT INTO source_daily SELECT *, 'legacy' FROM source_daily_before_traffic;
        DROP TABLE source_daily_before_traffic;
        CREATE INDEX source_daily_host ON source_daily(host,day);
        CREATE INDEX source_daily_user ON source_daily(user_id,day);
        CREATE INDEX source_daily_key ON source_daily(key_id,day);`);
      db.prepare('INSERT INTO traffic_meta VALUES(1,?)').run(now);
    }
    db.exec(`CREATE TRIGGER IF NOT EXISTS source_log_insert AFTER INSERT ON request_log BEGIN
      INSERT INTO source_daily VALUES(date(NEW.ts/1000.0,'unixepoch','+8 hours'),COALESCE(NEW.referer,''),NEW.source_basis,NEW.source_state,COALESCE(NEW.user_id,0),COALESCE(NEW.key_id,0),NEW.path,1,NEW.status>=400,NEW.ts,NEW.traffic)
      ON CONFLICT(day,host,basis,state,user_id,key_id,path,traffic) DO UPDATE SET calls=calls+1,errors=errors+excluded.errors,last_at=MAX(last_at,excluded.last_at);
    END;
    CREATE TRIGGER IF NOT EXISTS traffic_internal_log AFTER INSERT ON request_log WHEN NEW.traffic='internal' BEGIN
      INSERT INTO traffic_internal_calls(path,total) SELECT NEW.path,1 WHERE NEW.path LIKE '/api/%' AND NEW.status!=404
      ON CONFLICT(path) DO UPDATE SET total=total+1;
      INSERT INTO traffic_internal_user_calls SELECT NEW.user_id,date(NEW.ts/1000.0,'unixepoch','+8 hours'),NEW.path,1,NEW.status<400,NEW.status>=400 AND NEW.status<500,NEW.status>=500
      WHERE NEW.user_id IS NOT NULL AND NEW.status NOT IN(404,405,429)
      ON CONFLICT(user_id,day,path) DO UPDATE SET calls=calls+1,ok=ok+excluded.ok,e4xx=e4xx+excluded.e4xx,e5xx=e5xx+excluded.e5xx;
    END;`);
    for(const scope of ['business','internal']) {
      const predicate=scope==='internal'?"traffic='internal'":"traffic!='internal'";
      for(const table of ['request_log','source_daily']) db.exec(`CREATE VIEW IF NOT EXISTS traffic_${scope}_${table} AS SELECT * FROM ${table} WHERE ${predicate}`);
      for(const [table,keys] of [['hourly',['hour','path']],['daily',['day','path']]]) {
        const sums=cols.map(c=>`${c==='ms_max'?'MAX':'SUM'}(${c}) AS ${c}`).join(',');
        db.exec(`CREATE VIEW IF NOT EXISTS traffic_${scope}_stats_${table} AS SELECT ${keys.join(',')},${sums} FROM traffic_${table} WHERE ${predicate} GROUP BY ${keys.join(',')}`);
      }
      db.exec(`CREATE VIEW IF NOT EXISTS traffic_${scope}_stats_limited AS SELECT day,subject,path,SUM(count) AS count FROM traffic_limited WHERE ${predicate} GROUP BY day,subject,path;
        CREATE VIEW IF NOT EXISTS traffic_${scope}_stats_day_meta AS SELECT day,ips,users FROM traffic_day_meta WHERE traffic='${scope}';`);
    }
    db.exec(`CREATE VIEW IF NOT EXISTS traffic_internal_api_calls AS SELECT * FROM traffic_internal_calls;
      CREATE VIEW IF NOT EXISTS traffic_business_api_calls AS SELECT a.path,MAX(0,a.total-COALESCE(i.total,0)) AS total FROM api_calls a LEFT JOIN traffic_internal_calls i ON i.path=a.path;
      CREATE VIEW IF NOT EXISTS traffic_internal_user_calls_daily AS SELECT * FROM traffic_internal_user_calls;
      CREATE VIEW IF NOT EXISTS traffic_business_user_calls_daily AS SELECT a.user_id,a.day,a.path,MAX(0,a.calls-COALESCE(i.calls,0)) AS calls,MAX(0,a.ok-COALESCE(i.ok,0)) AS ok,MAX(0,a.e4xx-COALESCE(i.e4xx,0)) AS e4xx,MAX(0,a.e5xx-COALESCE(i.e5xx,0)) AS e5xx FROM user_calls_daily a LEFT JOIN traffic_internal_user_calls i USING(user_id,day,path);`);
    db.exec('COMMIT');
  } catch(err) {db.exec('ROLLBACK');throw err;}
}

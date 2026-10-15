import { sql } from '../db.js';
import { config } from '../config.js';
import { today } from './day.js';
import { HttpError } from './http.js';
import { websiteHost } from './source.js';
import { domainToASCII } from 'node:url';

const DAY = 86400_000;
const midnight = ts => Date.parse(`${today(new Date(ts))}T00:00:00+08:00`);
const bases = ['origin', 'referer', 'unknown', 'legacy'];
const states = ['matched', 'conflict', 'single', 'fallback', 'missing', 'opaque', 'invalid', 'legacy', 'legacy_unverifiable'];
const integer = (q, key, fallback, max = Number.MAX_SAFE_INTEGER, min = 0) => {
  const v = q.get(key);
  if (v == null || v === '') return fallback;
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) < min || Number(v) > max) throw new HttpError(400, `${key} 参数不正确`);
  return Number(v);
};
const text = (q, key, max) => {
  const v = (q.get(key) ?? '').trim();
  if (v.length > max || /[\u0000-\u001f\u007f]/.test(v)) throw new HttpError(400, `${key} 参数不正确`);
  return v;
};

function filters(q) {
  const terms = [], args = [];
  let search = text(q, 'q', 253).toLowerCase();
  if (/[^\x00-\x7f]/.test(search)) search = domainToASCII(search) || search;
  if (search) { terms.push("host LIKE ? ESCAPE '\\'"); args.push(`%${search.replace(/[\\%_]/g, c => `\\${c}`)}%`); }
  if (q.has('host')) {
    const h = text(q, 'host', 253);
    const host = h ? websiteHost(`https://${h}`) : '';
    if (h && (!host || /[/#?@:]/.test(h.replace(/^\[[\da-f:]+\]$/i, '')))) throw new HttpError(400, 'host 需要完整域名');
    terms.push('host = ?'); args.push(host);
  }
  for (const [key, col] of [['user', 'user_id'], ['key', 'key_id']]) {
    const id = integer(q, key, null);
    if (id != null) { terms.push(`${col} = ?`); args.push(id); }
  }
  const path = text(q, 'path', 250);
  if (path) {
    if (!path.startsWith('/') || /[?#]/.test(path)) throw new HttpError(400, 'path 只接受接口路径');
    terms.push('path = ?'); args.push(path);
  }
  for (const [key, allowed] of [['basis', bases], ['state', states]]) {
    const v = q.get(key);
    if (!v) continue;
    if (!allowed.includes(v)) throw new HttpError(400, `${key} 参数不正确`);
    terms.push(`${key} = ?`); args.push(v);
  }
  const page = integer(q, 'page', 1, 1_000_000, 1), size = integer(q, 'size', 20, 100, 1);
  const sorts = { calls: 'calls DESC', errors: 'errors DESC', lastAt: 'lastAt DESC' };
  const sort = q.get('sort') || 'calls';
  if (!sorts[sort]) throw new HttpError(400, 'sort 参数不正确');
  return { where: terms.length ? terms.join(' AND ') : '1', args, page, size, order: sorts[sort] };
}

// Entire Beijing days use durable aggregates; partial days use retained raw logs.
// Never round a requested boundary into extra calls or silently treat a gap as zero.
function dataset(range, now = Date.now()) {
  const retainedFrom = midnight(now) - (config.sourceRetentionDays - 1) * DAY;
  const rawFrom = now - config.logRetentionDays * DAY;
  const from = Math.max(range.from, retainedFrom), to = range.to;
  const fullFrom = midnight(from) === from ? from : midnight(from) + DAY;
  const fullTo = midnight(to);
  const args = [today(new Date(fullFrom)), today(new Date(fullTo))];
  const queries = ['SELECT host, basis, state, user_id, key_id, path, calls, errors, last_at FROM source_daily WHERE day >= ? AND day < ?'];
  const missing = range.from < retainedFrom ? [{ from: range.from, to: Math.min(to, retainedFrom), reason: 'retention' }] : [];
  const partials = fullFrom >= to ? [[from, to]] : [[from, fullFrom], [Math.max(fullFrom, fullTo), to]];
  for (const [lo, hi] of partials) {
    if (lo >= hi) continue;
    if (lo < rawFrom) missing.push({ from: lo, to: Math.min(rawFrom, hi), reason: 'raw_boundary_expired' });
    if (Math.max(lo, rawFrom) >= hi) continue;
    queries.push(`SELECT COALESCE(referer, '') AS host, source_basis AS basis, source_state AS state,
      COALESCE(user_id, 0) AS user_id, COALESCE(key_id, 0) AS key_id, path, 1 AS calls, status >= 400 AS errors, ts AS last_at
      FROM request_log WHERE ts >= ? AND ts < ?`);
    args.push(Math.max(lo, rawFrom), hi);
  }
  const meta = sql('SELECT started_at, backfilled_from, backfilled_to FROM source_meta WHERE id = 1').get();
  const backfillStart = Math.min(meta.started_at, meta.backfilled_from ?? meta.started_at);
  if (from < Math.min(to, backfillStart)) missing.push({ from, to: Math.min(to, backfillStart), reason: 'before_backfill' });
  return { cte: `WITH source_rows AS (${queries.join(' UNION ALL ')}), filtered AS (SELECT * FROM source_rows WHERE `,
    args, coverage: { startedAt: meta.started_at, backfilledFrom: meta.backfilled_from, backfilledTo: meta.backfilled_to,
      historicalPartialBefore: meta.started_at, retainedFrom, rawFrom, missing,
      complete: range.from >= meta.started_at && !missing.length, retentionDays: config.sourceRetentionDays } };
}

const sums = `COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(errors), 0) AS errors, MAX(last_at) AS lastAt,
  COALESCE(SUM(CASE WHEN state = 'conflict' THEN calls ELSE 0 END), 0) AS conflicts,
  COALESCE(SUM(CASE WHEN basis = 'legacy' THEN calls ELSE 0 END), 0) AS legacy`;

export function sources(range, q = new URLSearchParams()) {
  const f = filters(q), d = dataset(range);
  const cte = `${d.cte}${f.where})`, args = [...d.args, ...f.args];
  const totals = sql(`${cte} SELECT ${sums}, COUNT(DISTINCT host) AS websites,
    COALESCE(SUM(CASE WHEN host = '' THEN calls ELSE 0 END), 0) AS unknown FROM filtered`).get(...args);
  const total = totals.websites;
  const pages = Math.max(1, Math.ceil(total / f.size)), page = Math.min(f.page, pages);
  const items = sql(`${cte} SELECT NULLIF(host, '') AS host, ${sums},
    COUNT(DISTINCT NULLIF(user_id, 0)) AS users, COUNT(DISTINCT NULLIF(key_id, 0)) AS keys
    FROM filtered GROUP BY host ORDER BY ${f.order}, host ASC LIMIT ? OFFSET ?`).all(...args, f.size, (page - 1) * f.size)
    .map(r => ({ ...r, share: totals.calls ? +(r.calls / totals.calls * 100).toFixed(2) : 0 }));
  return { total, page, size: f.size, pages, totals, items,
    otherCalls: totals.calls - items.reduce((n, r) => n + r.calls, 0), coverage: d.coverage,
    basis: sql(`${cte} SELECT basis, state, SUM(calls) AS calls FROM filtered GROUP BY basis, state ORDER BY calls DESC`).all(...args) };
}

export function sourceAttribution(range, q) {
  const f = filters(q), d = dataset(range);
  const cte = `${d.cte}${f.where})`, args = [...d.args, ...f.args];
  const total = sql(`${cte} SELECT COUNT(*) AS n FROM (SELECT 1 FROM filtered GROUP BY user_id, key_id, path)`).get(...args).n;
  const pages = Math.max(1, Math.ceil(total / f.size)), page = Math.min(f.page, pages);
  const items = sql(`${cte}, grouped AS (SELECT user_id, key_id, path, ${sums} FROM filtered GROUP BY user_id, key_id, path)
    SELECT g.*, u.email, k.name AS keyName FROM grouped g LEFT JOIN users u ON u.id = g.user_id LEFT JOIN api_keys k ON k.id = g.key_id AND k.user_id = g.user_id
    ORDER BY ${f.order}, g.user_id, g.key_id, path LIMIT ? OFFSET ?`).all(...args, f.size, (page - 1) * f.size);
  return { total, page, pages, size: f.size, items, coverage: d.coverage };
}

export function sourceRequests(range, q) {
  const f = filters(q), rawFrom = Date.now() - config.logRetentionDays * DAY;
  const cte = `WITH raw AS (SELECT id, ts, rid, path, status, ms, COALESCE(referer, '') AS host,
    source_basis AS basis, source_state AS state, origin_host, referer_host,
    COALESCE(user_id, 0) AS user_id, COALESCE(key_id, 0) AS key_id FROM request_log WHERE ts >= ? AND ts < ?),
    filtered AS (SELECT * FROM raw WHERE ${f.where})`;
  const args = [Math.max(range.from, rawFrom), range.to, ...f.args];
  const total = sql(`${cte} SELECT COUNT(*) AS n FROM filtered`).get(...args).n;
  const pages = Math.max(1, Math.ceil(total / f.size)), page = Math.min(f.page, pages);
  const items = sql(`${cte} SELECT l.*, u.email, k.name AS keyName FROM filtered l
    LEFT JOIN users u ON u.id = l.user_id LEFT JOIN api_keys k ON k.id = l.key_id AND k.user_id = l.user_id
    ORDER BY l.ts DESC, l.id DESC LIMIT ? OFFSET ?`).all(...args, f.size, (page - 1) * f.size);
  return { total, page, pages, size: f.size, items, from: Math.max(range.from, rawFrom), capped: range.from < rawFrom };
}

// 接口自动检测：定时用示例参数把接口轻量调用一遍（复用一键巡检的逻辑，不计额度、不进调用统计），
// 结果写入 health_checks / health_daily，供运行状态页显示真实可用性；没人调用的接口也有状态。
// 同时根据检测结果和实际调用的失败率自动记录故障（incidents）：连续两次检测失败即开始，恢复后自动结束。
import { sql, db } from '../db.js';
import { config } from '../config.js';
import { today } from './limits.js';
import { planTargets, callTarget } from './inspect.js';
import { apiRouter } from '../registry.js';

export const moduleOfPath = (p) => (apiRouter.match('GET', p) ?? apiRouter.match('POST', p))?.route?.module?.name ?? null;

const CONCURRENCY = 3;
let running = false;
let lastRun = null;
const failStreak = new Map(); // 模块 -> 连续失败次数

export const healthStatus = () => ({ running, lastRun, intervalMin: config.healthCheckMinutes });

// 一次检测：ok / param（示例参数不适用，接口本身正常）算通过，fail / timeout 算失败
export const passed = (status) => status === 'ok' || status === 'param';

function saveResults(ts, results) {
  const day = today(new Date(ts));
  db.exec('BEGIN');
  try {
    for (const r of results) {
      sql('INSERT INTO health_checks (ts, module, path, ok, status, ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(ts, r.module, r.path, r.ok ? 1 : 0, r.httpStatus ?? null, r.ms ?? null, r.ok ? null : String(r.error ?? '').slice(0, 300));
      sql(`INSERT INTO health_daily (day, path, checks, fails, ms_sum) VALUES (?, ?, 1, ?, ?)
           ON CONFLICT(day, path) DO UPDATE SET checks = checks + 1, fails = fails + excluded.fails, ms_sum = ms_sum + excluded.ms_sum`)
        .run(day, r.path, r.ok ? 0 : 1, r.ms ?? 0);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// 最近 30 分钟实际调用里 5xx 占一半以上（且至少 10 次）的模块，也视为故障
function trafficFailing(now) {
  const rows = sql(`SELECT path, COUNT(*) AS calls, SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS e5xx
                    FROM request_log WHERE ts >= ? GROUP BY path`).all(now - 30 * 60_000);
  return rows;
}

export function updateIncidents(now, results, moduleOfPath) {
  const byModule = new Map();
  for (const r of results) {
    const m = byModule.get(r.module) ?? { checked: 0, failed: 0, error: null };
    m.checked++;
    if (!r.ok) { m.failed++; m.error ??= `${r.path}：${r.error ?? '检测失败'}`; }
    byModule.set(r.module, m);
  }
  const traffic = new Map();
  for (const t of trafficFailing(now)) {
    const mod = moduleOfPath(t.path);
    if (!mod) continue;
    const m = traffic.get(mod) ?? { calls: 0, e5xx: 0 };
    m.calls += t.calls;
    m.e5xx += t.e5xx;
    traffic.set(mod, m);
  }
  const modules = new Set([...byModule.keys(), ...traffic.keys()]);
  for (const mod of modules) {
    const c = byModule.get(mod);
    const t = traffic.get(mod);
    const checkFail = c ? c.failed > 0 && c.failed * 2 >= c.checked : false;
    const trafficFail = t ? t.calls >= 10 && t.e5xx * 2 >= t.calls : false;
    const open = sql('SELECT id FROM incidents WHERE module = ? AND ended_at IS NULL').get(mod);
    if (checkFail || trafficFail) {
      const streak = (failStreak.get(mod) ?? 0) + 1;
      failStreak.set(mod, streak);
      // 检测连续两次失败，或实际调用大面积失败，才记为故障，避免偶发抖动
      if (!open && (streak >= 2 || trafficFail)) {
        const reason = checkFail ? c.error : `最近 30 分钟 ${t.calls} 次调用中 ${t.e5xx} 次失败`;
        sql('INSERT INTO incidents (module, started_at, source, reason) VALUES (?, ?, ?, ?)')
          .run(mod, now, checkFail ? 'check' : 'traffic', String(reason).slice(0, 300));
      }
    } else {
      failStreak.set(mod, 0);
      // 这次检测通过（或没有检测、实际调用恢复正常）就结束故障
      if (open && (c || (t && t.calls >= 3))) sql('UPDATE incidents SET ended_at = ? WHERE id = ?').run(now, open.id);
    }
  }
}

export async function runHealthCheck({ targets } = {}) {
  if (running) return null;
  running = true;
  const started = Date.now();
  try {
    const plan = (targets ?? planTargets({ includeCostly: false })).filter((t) => !t.skip);
    const results = [];
    const queue = [...plan];
    const worker = async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        const r = await callTarget(t, null);
        results.push({ module: t.module, path: t.path, ok: passed(r.status), httpStatus: r.httpStatus, ms: r.ms, error: r.error });
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    saveResults(started, results);
    updateIncidents(started, results, moduleOfPath);
    lastRun = { at: new Date(started).toISOString(), ms: Date.now() - started, total: results.length, failed: results.filter((r) => !r.ok).length };
    return lastRun;
  } finally {
    running = false;
  }
}

export function pruneHealth() {
  sql('DELETE FROM health_checks WHERE ts < ?').run(Date.now() - 30 * 86400_000);
  sql('DELETE FROM incidents WHERE started_at < ?').run(Date.now() - 365 * 86400_000);
}

// 定时检测：启动 3 分钟后第一次，之后按设置的间隔；间隔为 0 时关闭（每 5 分钟看一次设置是否改了）
export function startHealthChecks() {
  const loop = async () => {
    const min = config.healthCheckMinutes;
    if (min > 0) {
      try { await runHealthCheck(); } catch (err) { console.error('[health] 自动检测失败：', err.message); }
    }
    setTimeout(loop, (min > 0 ? min : 5) * 60_000).unref();
  };
  setTimeout(loop, 3 * 60_000).unref();
}

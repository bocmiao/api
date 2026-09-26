// AI 分析接口失败原因：汇总这个接口最近的调用记录、失败原因、所需密钥的配置情况，
// 再实际调用一次，把这些材料交给大模型，给出中文的原因判断和处理建议。仅管理员可用。
import { sql } from '../db.js';
import { apiRouter, invoke } from '../registry.js';
import { isModuleEnabled } from './modules.js';
import { HttpError } from './http.js';
import { RUNNING_VERSION } from './updater.js';
import { completeJSON, isConfigured } from '../apis/ai/llm.js';

// 实际调用一次会产生数据、消耗第三方额度或耗时很长的模块，不做实时测试
const NO_LIVE_TEST = new Set(['crawl', 'probe', 'batch-check', 'ai', 'shorturl', 'captcha']);
const CATEGORIES = ['上游故障', '网络不通', '密钥或配置', '调用参数', '限流', '程序问题', '正常', '其他'];

// 找到路由：先按 GET 匹配，再按 POST
function findRoute(path) {
  const hit = apiRouter.match('GET', path) ?? apiRouter.match('POST', path);
  if (!hit?.route || hit.methodNotAllowed) throw new HttpError(404, '没有这个接口');
  return hit.route;
}

// 用参数示例实际调用一次（只对 GET、且必填参数都有示例的接口）
async function liveTest(path, route, module) {
  if (route.method !== 'GET' || route.raw || NO_LIVE_TEST.has(module.name) || /:/.test(route.path)) return { skipped: '该接口不适合自动测试' };
  const query = {};
  for (const p of route.params ?? []) {
    if (p.in === 'body') continue;
    if (p.example != null && p.example !== '') query[p.name] = String(p.example);
    else if (p.required) return { skipped: `缺少参数 ${p.name} 的示例，无法自动测试` };
  }
  const started = Date.now();
  try {
    await invoke(path, query);
    return { ok: true, ms: Date.now() - started, query };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, query, status: err.status ?? 500, error: err.message };
  }
}

export async function gatherEvidence(path) {
  const { route, module } = findRoute(path);
  const since = Date.now() - 7 * 86400_000;
  const stats = sql(`SELECT COUNT(*) AS calls, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS failed,
                            SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS serverErrors, CAST(AVG(ms) AS INTEGER) AS avgMs,
                            MAX(CASE WHEN status < 400 THEN ts END) AS lastOkAt, MAX(CASE WHEN status >= 400 THEN ts END) AS lastFailAt
                     FROM request_log WHERE path = ? AND ts >= ?`).get(path, since);
  const errors = sql(`SELECT status, error, COUNT(*) AS n, MAX(ts) AS lastAt, CAST(AVG(ms) AS INTEGER) AS avgMs
                      FROM request_log WHERE path = ? AND ts >= ? AND status >= 400
                      GROUP BY status, error ORDER BY n DESC LIMIT 10`).all(path, since);
  const iso = (t) => (t ? new Date(t).toISOString() : null);
  return {
    path,
    method: route.method,
    module: {
      name: module.name, title: module.title, description: module.description ?? '', source: module.source ?? null,
      unofficial: Boolean(module.unofficial), enabled: isModuleEnabled(module.name),
      // 只给出是否已配置，不给出密钥内容
      env: (module.env ?? []).map((e) => (typeof e === 'string' ? { name: e, optional: false } : e))
        .map((e) => ({ name: e.name, optional: Boolean(e.optional), configured: Boolean(process.env[e.name]) })),
    },
    summary: route.summary ?? '',
    params: (route.params ?? []).map((p) => ({ name: p.name, required: Boolean(p.required), desc: p.desc ?? '' })),
    last7d: { ...stats, lastOkAt: iso(stats.lastOkAt), lastFailAt: iso(stats.lastFailAt) },
    errors: errors.map((e) => ({ ...e, lastAt: iso(e.lastAt) })),
    liveTest: await liveTest(path, route, module),
    server: { version: RUNNING_VERSION, node: process.version, trustProxy: process.env.TRUST_PROXY === '1' },
  };
}

const SYSTEM = `你是 Miao API（一个聚合 API 平台，运行在中国大陆的腾讯云服务器上）的运维助手。
管理员会给你某个接口最近 7 天的调用统计、失败原因、所需密钥的配置情况，以及刚刚实际调用一次的结果。
请判断接口失败的最可能原因，并给出管理员能直接操作的处理建议。注意：
- 状态码含义：400 参数错误，401 Key 无效，403 被管理员关闭，404 不存在，429 超额或限流，502 上游返回错误，503 未配置密钥或服务不可用，504 上游超时。
- 服务器在中国大陆：访问境外网站（GitHub、Steam、Epic 等）可能很慢或被阻断；「非官方」来源可能因对方改版失效。
- 400 类失败通常是调用者传错参数，不是接口故障。
- 只根据给出的材料判断，不确定就说明不确定，不要编造。建议要具体，例如去「设置 → 第三方接口密钥」填写哪一项。
只输出 JSON：{"status":"正常|部分失败|故障","category":"${CATEGORIES.join('|')}","summary":"一两句话结论","causes":["可能原因，按可能性排序，最多 4 条"],"suggestions":["处理建议，最多 5 条"],"confidence":"高|中|低"}`;

const strList = (v, max) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, max) : []);

export function normalizeDiagnosis(o) {
  if (!o || typeof o.summary !== 'string' || !o.summary.trim()) return null;
  return {
    status: ['正常', '部分失败', '故障'].includes(o.status) ? o.status : '部分失败',
    category: CATEGORIES.includes(o.category) ? o.category : '其他',
    summary: o.summary.trim().slice(0, 500),
    causes: strList(o.causes, 4),
    suggestions: strList(o.suggestions, 5),
    confidence: ['高', '中', '低'].includes(o.confidence) ? o.confidence : '中',
  };
}

export async function diagnose(path) {
  if (!isConfigured()) throw new HttpError(503, '还没有配置 AI：请到「设置 → AI」填写大模型 API Key 后再使用 AI 分析');
  const evidence = await gatherEvidence(path);
  const { data, model } = await completeJSON([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `接口材料（JSON）：\n${JSON.stringify(evidence, null, 1)}` },
  ], normalizeDiagnosis, { maxTokens: 900, temperature: 0.2 });
  return { path, diagnosis: data, evidence, model, at: new Date().toISOString() };
}

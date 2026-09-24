// 大模型调用（OpenAI 兼容接口）与 AI 接口的防刷费：登录校验、每日次数、输入长度。
// 配置一律在调用时从 process.env 读取，后台「系统设置」保存后即时生效。
import { db, sql } from '../../db.js';
import { HttpError } from '../../lib/http.js';
import { today } from '../../lib/limits.js';

export const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_MODEL = 'deepseek-chat';
export const TIMEOUT_MS = 60_000;

// AI 调用次数单独计数，不混进 usage_daily，避免后台「调用统计」重复计算
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_usage_daily (
    day TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, user_id)
  );
`);

const intEnv = (name, def) => {
  const v = process.env[name];
  const n = Number(v);
  return v != null && v !== '' && Number.isInteger(n) && n >= 0 ? n : def;
};

export function llmConfig() {
  const base = (process.env.LLM_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  // 管理员填成完整地址时也能用
  const endpoint = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  return {
    endpoint,
    key: (process.env.LLM_API_KEY || '').trim(),
    model: (process.env.LLM_MODEL || '').trim() || DEFAULT_MODEL,
    dailyLimit: intEnv('AI_DAILY_LIMIT', 20),
    maxChars: intEnv('AI_MAX_CHARS', 3000) || 3000,
  };
}

export const isConfigured = () => Boolean((process.env.LLM_API_KEY || '').trim());

// 按 Unicode 字符计数，emoji、生僻字都算 1 个字
export const charCount = (s) => [...String(s)].length;

// ---------------- 访问控制 ----------------

// 顺序：未登录 401 → 未配置 503。输入校验（400）由各路由在 reserve 之前完成，不消耗次数
export function requireAccess(user) {
  if (!user?.id) throw new HttpError(401, 'AI 接口需要登录后使用');
  if (!isConfigured()) throw new HttpError(503, '管理员尚未配置 AI 接口');
}

export function assertLength(total) {
  const { maxChars } = llmConfig();
  if (total > maxChars) throw new HttpError(400, `输入过长：最多 ${maxChars} 字，当前 ${total} 字`);
}

let lastPruned = '';
function prune(day) {
  if (lastPruned === day) return;
  lastPruned = day;
  const cutoff = new Date(Date.now() - 7 * 86400_000);
  sql('DELETE FROM ai_usage_daily WHERE day < ?').run(today(cutoff));
}

export function aiQuota(userId) {
  const { dailyLimit } = llmConfig();
  const used = sql('SELECT count FROM ai_usage_daily WHERE day = ? AND user_id = ?').get(today(), userId)?.count ?? 0;
  return { limit: dailyLimit, used, remaining: Math.max(0, dailyLimit - used) };
}

// 先占一次额度再调上游：单条 UPSERT 带条件，并发请求也不会超过上限
export function reserve(userId) {
  const { dailyLimit } = llmConfig();
  const day = today();
  prune(day);
  const { changes } = sql(`INSERT INTO ai_usage_daily (day, user_id, count) SELECT ?, ?, 1 WHERE ? > 0
       ON CONFLICT(day, user_id) DO UPDATE SET count = count + 1 WHERE count < ?`).run(day, userId, dailyLimit, dailyLimit);
  if (!changes) {
    throw new HttpError(429, `AI 接口每天最多调用 ${dailyLimit} 次，今日已用完，额度将于北京时间 0 点重置`);
  }
  return day;
}

// 上游明确没有产生费用（连不上、返回 HTTP 错误）时退回额度
export function refund(userId, day) {
  sql('UPDATE ai_usage_daily SET count = count - 1 WHERE day = ? AND user_id = ? AND count > 0').run(day, userId);
}

// ---------------- 上游调用 ----------------

// 上游错误统一转中文，不透传原始报错（可能含 Key 片段）
export function upstreamError(status) {
  if (status === 401 || status === 403) return new HttpError(502, 'AI 服务鉴权失败，请联系管理员检查 API Key');
  if (status === 402) return new HttpError(502, 'AI 服务账户余额不足，请联系管理员');
  if (status === 429) return new HttpError(503, 'AI 服务繁忙，请稍后再试');
  if (status === 404) return new HttpError(502, 'AI 服务地址或模型名称配置有误，请联系管理员');
  if (status >= 400 && status < 500) return new HttpError(502, 'AI 服务拒绝了本次请求，请调整输入后重试');
  return new HttpError(502, 'AI 服务暂时不可用，请稍后再试');
}

class Refundable extends HttpError {}

async function post(body) {
  const c = llmConfig();
  let res;
  try {
    res = await fetch(c.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${c.key}` },
      body: JSON.stringify({ model: c.model, ...body }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new HttpError(504, 'AI 服务响应超时，请稍后再试');
    throw new Refundable(502, '无法连接 AI 服务');
  }
  if (!res.ok) {
    // 只记状态码，不记响应体
    console.error(`[ai] 上游返回 HTTP ${res.status}`);
    res.body?.cancel().catch(() => {});
    const e = upstreamError(res.status);
    throw new Refundable(e.status, e.message);
  }
  let json;
  try {
    json = await res.json();
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new HttpError(504, 'AI 服务响应超时，请稍后再试');
    throw new HttpError(502, 'AI 服务返回的数据无法解析');
  }
  const content = json?.choices?.[0]?.message?.content;
  const u = json?.usage ?? {};
  const num = (v) => (Number.isFinite(v) ? v : null);
  return {
    content: typeof content === 'string' ? content : '',
    model: typeof json?.model === 'string' && json.model ? json.model : c.model,
    usage: { promptTokens: num(u.prompt_tokens), completionTokens: num(u.completion_tokens), totalTokens: num(u.total_tokens) },
  };
}

const addUsage = (a, b) => {
  const s = (x, y) => (x == null && y == null ? null : (x ?? 0) + (y ?? 0));
  return { promptTokens: s(a.promptTokens, b.promptTokens), completionTokens: s(a.completionTokens, b.completionTokens), totalTokens: s(a.totalTokens, b.totalTokens) };
};

// 从模型输出里取 JSON 对象；兼容 ```json 代码块包裹
export function parseJSONObject(text) {
  const s = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * 让模型输出 JSON，并用 validate 规范化；解析或校验失败重试一次，再失败 502。
 * validate(obj) 返回规范化后的数据，不合格返回 null。
 */
export async function completeJSON(messages, validate, { maxTokens = 1024, temperature = 0.3 } = {}) {
  let usage = { promptTokens: null, completionTokens: null, totalTokens: null };
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await post({ messages, temperature, max_tokens: maxTokens, response_format: { type: 'json_object' } });
    usage = addUsage(usage, r.usage);
    const obj = parseJSONObject(r.content);
    const data = obj && validate(obj);
    if (data) return { data, model: r.model, usage };
  }
  throw new HttpError(502, 'AI 返回的内容格式不正确，请稍后重试');
}

export async function completeText(messages, { maxTokens = 2048, temperature = 0.7 } = {}) {
  const r = await post({ messages, temperature, max_tokens: maxTokens });
  const text = r.content.trim();
  if (!text) throw new HttpError(502, 'AI 没有返回内容，请稍后重试');
  return { text, model: r.model, usage: r.usage };
}

// 包装一次 AI 调用：登录 → 配置 → 占额度 → 调用；上游确定未计费时退回额度
export async function withQuota(user, fn) {
  const day = reserve(user.id);
  try {
    const out = await fn();
    return { ...out, quota: aiQuota(user.id) };
  } catch (err) {
    if (err instanceof Refundable) refund(user.id, day);
    throw err;
  }
}

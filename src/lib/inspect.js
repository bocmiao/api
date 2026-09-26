// 一键巡检：用每个接口的示例参数依次实际调用一次，检查是否畅通。仅管理员可用。
// 直接调用接口处理函数，不经过限流和调用日志，所以不计入额度、不影响调用统计。
import { apiRouter } from '../registry.js';
import { modules } from '../apis/index.js';
import { isModuleEnabled } from './modules.js';
import { HttpError } from './http.js';

// 会消耗第三方额度、产生费用或留下数据的模块：默认跳过，管理员可以选择一起巡检
export const COSTLY = {
  probe: '会消耗 Globalping 额度',
  ai: '会调用大模型，产生费用并占用 AI 额度',
  crawl: '会创建整站抓取任务',
  'batch-check': '会一次检测多个目标',
  shorturl: '会生成短链接数据',
};
const TIMEOUT_MS = 20_000;
const CONCURRENCY = 6;

const idle = () => ({ state: 'idle', total: 0, done: 0, startedAt: null, finishedAt: null, includeCostly: false, results: [] });
let job = idle();
let stopRequested = false;

export const inspectStatus = () => ({ ...job, results: job.results.map((r) => ({ ...r })) });

function available(m) {
  if (m.isAvailable) return Boolean(m.isAvailable());
  return (m.env ?? []).every((e) => (typeof e === 'string' ? Boolean(process.env[e]) : e.optional || Boolean(process.env[e.name])));
}

// 列出要巡检的调用地址；不能自动测的给出跳过原因
export function planTargets({ includeCostly = false } = {}) {
  const list = [];
  for (const m of modules) {
    if (!isModuleEnabled(m.name)) continue;
    for (const route of m.routes) {
      const t = { module: m.name, title: m.title, method: route.method, path: route.path, summary: route.summary ?? '' };
      const required = (route.params ?? []).filter((p) => p.required);
      const missing = required.find((p) => p.example == null || p.example === '');
      if (m.suspended) t.skip = '接口已暂停服务';
      else if (/\/:/.test(route.path)) t.skip = '地址里带参数，无法自动测试';
      else if (COSTLY[m.name] && !includeCostly) t.skip = `默认跳过：${COSTLY[m.name]}`;
      else if (route.inspectSkip) t.skip = route.inspectSkip;
      else if (!available(m)) t.skip = '需要填写的密钥还没有配置';
      else if (missing) t.skip = `缺少参数 ${missing.name} 的示例`;
      else {
        // 先只带必填参数；参数错误时再带上全部示例参数重试（有的接口是「几个参数任选其一」）；
        // 还不行就每次去掉一个可选参数再试（有的接口是「两个参数只能传一个」，如 end 与 days）
        const build = (params) => {
          const q = {};
          const b = {};
          for (const p of params) if (p.example != null && p.example !== '') (p.in === 'body' ? b : q)[p.name] = p.example;
          return { query: q, body: b };
        };
        const all = route.params ?? [];
        const optional = all.filter((p) => !p.required && p.example != null && p.example !== '');
        t.attempts = [build(required), build(all), ...optional.slice(0, 6).map((skip) => build(all.filter((p) => p !== skip)))];
      }
      list.push(t);
    }
  }
  return list;
}

function withTimeout(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`超过 ${TIMEOUT_MS / 1000} 秒没有响应`), { timeout: true })), TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
}

async function callOnce(hit, method, { query: q, body: b }, user) {
  const query = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]));
  const body = method === 'GET' ? undefined : b;
  const started = Date.now();
  try {
    const res = await withTimeout(Promise.resolve(hit.route.handler({
      query, params: hit.params, body, ip: '127.0.0.1', user, req: { headers: {} }, charge: () => {},
    })));
    const ms = Date.now() - started;
    const code = res?.status ?? 200;
    if (code >= 400) return { status: 'fail', httpStatus: code, ms, error: `返回 HTTP ${code}` };
    return { status: 'ok', httpStatus: code, ms };
  } catch (err) {
    const ms = Date.now() - started;
    if (err.timeout) return { status: 'timeout', httpStatus: 504, ms, error: err.message };
    const code = err instanceof HttpError ? err.status : 500;
    return { status: 'fail', httpStatus: code, ms, error: err instanceof HttpError ? err.message : `程序错误：${err.message}` };
  }
}

// 返回 status：ok 正常 / fail 失败 / timeout 超时 / param 示例参数不适用（多半不是接口故障）
export async function callTarget(t, user) {
  const hit = apiRouter.match(t.method, t.path);
  if (!hit?.route) return { status: 'fail', httpStatus: 404, ms: 0, error: '接口不存在' };
  const attempts = t.attempts ?? [{ query: t.query ?? {}, body: t.body ?? {} }];
  let r;
  const tried = new Set();
  for (let i = 0; i < attempts.length; i++) {
    const sig = JSON.stringify(attempts[i]);
    if (tried.has(sig)) continue;
    tried.add(sig);
    r = await callOnce(hit, t.method, attempts[i], user);
    if (r.httpStatus !== 400) return r;
  }
  return { ...r, status: 'param', error: `${r.error}（用文档里的示例参数调用时参数不合适，接口本身多半正常）` };
}

export function startInspect({ includeCostly = false, user = null } = {}) {
  if (job.state === 'running') throw new HttpError(409, '巡检正在进行中');
  stopRequested = false;
  const targets = planTargets({ includeCostly });
  job = {
    state: 'running', total: targets.length, done: 0, startedAt: new Date().toISOString(), finishedAt: null, includeCostly,
    results: targets.map(({ module, title, method, path, summary, skip }) => ({ module, title, method, path, summary, status: skip ? 'skipped' : 'pending', error: skip ?? null })),
  };
  const current = job;
  const queue = targets.map((t, i) => ({ t, i })).filter(({ t }) => !t.skip);
  current.done = targets.length - queue.length;
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      if (stopRequested) break;
      current.results[item.i].status = 'running';
      Object.assign(current.results[item.i], await callTarget(item.t, user));
      current.done++;
    }
  };
  Promise.all(Array.from({ length: CONCURRENCY }, worker)).finally(() => {
    for (const r of current.results) if (r.status === 'pending' || r.status === 'running') { r.status = 'skipped'; r.error = '巡检已停止'; }
    current.state = stopRequested ? 'stopped' : 'done';
    current.finishedAt = new Date().toISOString();
  });
  return inspectStatus();
}

export function stopInspect() {
  if (job.state === 'running') stopRequested = true;
  return inspectStatus();
}

import { Worker } from 'node:worker_threads';
import { HttpError, param } from '../../lib/http.js';
import { getAndPost } from './inputs.js';

// 防 ReDoS：用户的正则不在主线程执行。
// 1. 放到常驻的 worker 线程里跑，主线程的事件循环不会被灾难性回溯卡住；
// 2. worker 内再用 vm 的 timeout（TIMEOUT_MS）中断单次执行，超时的 worker 继续可用；
// 3. 主线程另设兜底计时器，worker 迟迟不回（或崩溃、内存超限）时直接 terminate 并重建；
// 4. 限制 pattern / text / replacement 长度、返回的匹配条数和输出大小，排队的任务数也有上限。

export const TIMEOUT_MS = 100;
const HARD_TIMEOUT_MS = 3000;
const MAX_PENDING = 8;
const MAX_MATCHES = 200;
const MAX_OUTPUT = 100_000;
const MAX_TEXT = 20_000;

const RUNNER = `(() => {
  const re = new RegExp(pattern, flags);
  if (action === 'replace') {
    const out = text.replace(re, replacement);
    return JSON.stringify({ result: out.slice(0, maxOutput), truncated: out.length > maxOutput });
  }
  if (action === 'split') {
    const parts = text.split(re, maxMatches + 1);
    return JSON.stringify({ parts: parts.slice(0, maxMatches).map((p) => p ?? null), truncated: parts.length > maxMatches });
  }
  const item = (m) => ({
    match: m[0],
    index: m.index,
    end: m.index + m[0].length,
    groups: Array.from(m).slice(1).map((g) => g ?? null),
    named: m.groups ? Object.fromEntries(Object.entries(m.groups).map(([k, v]) => [k, v ?? null])) : null,
  });
  const matches = [];
  let total = 0;
  if (re.global) {
    for (const m of text.matchAll(re)) {
      total++;
      if (matches.length < maxMatches) matches.push(item(m));
    }
  } else {
    const m = re.exec(text);
    if (m) { total = 1; matches.push(item(m)); }
  }
  return JSON.stringify({ matched: total > 0, total, matches, truncated: total > matches.length });
})()`;

const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const script = new vm.Script(workerData.runner);
parentPort.on('message', ({ id, job }) => {
  const t0 = performance.now();
  try {
    const out = script.runInNewContext(job, { timeout: workerData.timeout });
    parentPort.postMessage({ id, ok: true, out, ms: performance.now() - t0 });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, code: e && e.code, name: e && e.name, message: String(e && e.message) });
  }
});`;

let worker = null;
let seq = 0;
const pending = new Map();

function failAll(err) {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(err);
  }
  pending.clear();
}

function resetWorker(err) {
  const w = worker;
  worker = null;
  if (w) w.terminate().catch(() => {});
  failAll(err);
}

function getWorker() {
  if (worker) return worker;
  const w = new Worker(WORKER_SRC, {
    eval: true,
    workerData: { runner: RUNNER, timeout: TIMEOUT_MS },
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  });
  w.unref(); // 空闲的 worker 不阻止进程退出
  w.on('message', ({ id, ...res }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(res);
  });
  w.on('error', () => { if (worker === w) resetWorker(new HttpError(503, '正则执行线程异常，请稍后重试')); });
  w.on('exit', () => { if (worker === w) resetWorker(new HttpError(503, '正则执行线程已退出，请稍后重试')); });
  worker = w;
  return w;
}

function runInWorker(job) {
  if (pending.size >= MAX_PENDING) return Promise.reject(new HttpError(503, '正则测试请求过多，请稍后再试'));
  const w = getWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // worker 没在兜底时间内回复：直接终止并重建
      resetWorker(new HttpError(422, `正则执行超时（超过 ${TIMEOUT_MS} 毫秒）被中断，表达式可能存在灾难性回溯，请优化后再试`));
    }, HARD_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    w.postMessage({ id, job });
  });
}

// 测试用：关闭 worker
export async function shutdownRegexWorker() {
  if (worker) await worker.terminate();
  worker = null;
}

export async function runRegex({ pattern, flags = 'g', text, action = 'match', replacement = '' }) {
  if (!/^[dgimsuvy]*$/.test(flags) || new Set(flags).size !== flags.length || (flags.includes('u') && flags.includes('v'))) {
    throw new HttpError(400, 'flags 只能由 d g i m s u v y 组成，不能重复，u 和 v 不能同时使用');
  }
  const res = await runInWorker({ pattern, flags, text, action, replacement, maxMatches: MAX_MATCHES, maxOutput: MAX_OUTPUT });
  if (!res.ok) {
    if (res.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw new HttpError(422, `正则执行超过 ${TIMEOUT_MS} 毫秒被中断，表达式可能存在灾难性回溯（如 (a+)+$），请优化后再试`);
    }
    if (res.name === 'SyntaxError') throw new HttpError(400, `正则表达式语法错误：${res.message.replace(/^Invalid regular expression: /, '')}`);
    if (res.name === 'RangeError') throw new HttpError(422, '结果过大，无法处理');
    throw new HttpError(500, '正则执行失败');
  }
  return { pattern, flags, action, ...JSON.parse(res.out), tookMs: Math.round(res.ms * 100) / 100 };
}

export default {
  name: 'regex',
  category: 'tools',
  title: '正则表达式测试',
  description: `测试 JavaScript 正则：匹配详情、替换、分割；在隔离线程中带 ${TIMEOUT_MS} 毫秒超时执行，防止 ReDoS`,
  source: '本地计算',
  routes: getAndPost({
    path: '/api/tools/regex',
    summary: `正则测试（JavaScript / V8 语法）：返回匹配位置与分组，或执行替换、分割；单次执行超过 ${TIMEOUT_MS} 毫秒会被中断`,
    params: [
      { name: 'pattern', required: true, desc: '正则表达式，不写两边的斜杠，最多 1000 个字符', example: '(?<year>\\d{4})-(?<month>\\d{2})' },
      { name: 'text', required: true, desc: `要匹配的文本，最多 ${MAX_TEXT} 个字符`, example: '开始于 2026-09，结束于 2027-01。' },
      { name: 'flags', default: 'g', desc: '修饰符（传空字符串表示不加修饰符）：g 全局、i 忽略大小写、m 多行、s 点号匹配换行、u Unicode、v Unicode 集合、y 粘性、d 生成索引', example: 'gi' },
      { name: 'action', default: 'match', desc: 'match 匹配详情 / replace 替换 / split 分割', example: 'match' },
      { name: 'replacement', required: false, desc: '替换内容（action=replace 时使用），支持 $1、$<name>、$&，最多 1000 个字符', example: '$<month>/$<year>' },
    ],
    fields: [
      { name: 'pattern', type: 'string', desc: '正则表达式，与请求参数相同' },
      { name: 'flags', type: 'string', desc: '修饰符，与请求参数相同' },
      { name: 'action', type: 'string', desc: '执行的操作：match / replace / split' },
      { name: 'matched', type: 'boolean', desc: '仅 match：是否至少匹配到一处' },
      { name: 'total', type: 'number', desc: '仅 match：匹配总数（没有 g 修饰符时最多为 1）' },
      { name: 'matches', type: 'array', desc: `仅 match：匹配详情，最多 ${MAX_MATCHES} 条` },
      { name: 'matches[].match', type: 'string', desc: '匹配到的文本' },
      { name: 'matches[].index', type: 'number', desc: '起始位置（UTF-16 下标，从 0 开始）' },
      { name: 'matches[].end', type: 'number', desc: '结束位置（不含），等于 index + 匹配文本的 UTF-16 长度' },
      { name: 'matches[].groups', type: 'array', desc: '捕获分组，按左括号顺序；没有分组时为空数组' },
      { name: 'matches[].groups[]', type: 'string|null', desc: '一个分组捕获的文本；该分组没参与匹配时为 null' },
      { name: 'matches[].named', type: 'object|null', desc: '命名分组（?<name>...），键为分组名；没有命名分组时为 null' },
      { name: 'matches[].named.*', type: 'string|null', desc: '命名分组捕获的文本；没参与匹配时为 null' },
      { name: 'result', type: 'string', desc: `仅 replace：替换后的文本（没有 g 修饰符时只替换第一处），超过 ${MAX_OUTPUT} 个字符时截断` },
      { name: 'parts', type: 'array', desc: `仅 split：分割结果，最多 ${MAX_MATCHES} 段；正则里的捕获分组也会出现在结果中` },
      { name: 'parts[]', type: 'string|null', desc: '一段文本；未参与匹配的捕获分组为 null' },
      { name: 'truncated', type: 'boolean', desc: '结果是否因超过上限被截断（match 超过条数上限、replace 超过长度上限、split 超过段数上限）' },
      { name: 'tookMs', type: 'number', desc: '正则执行耗时（毫秒，保留 2 位小数，不含排队和线程通信时间）' },
    ],
  }, async (input) => {
    const pattern = param(input, 'pattern', { required: true, max: 1000 });
    const text = param(input, 'text', { default: '', max: MAX_TEXT });
    if (input.get('text') == null) throw new HttpError(400, '缺少参数 text');
    // 显式传空字符串表示不加任何修饰符
    const flags = input.get('flags') === '' ? '' : param(input, 'flags', { default: 'g', max: 8 });
    const action = param(input, 'action', { default: 'match', oneOf: ['match', 'replace', 'split'] });
    const replacement = param(input, 'replacement', { default: '', max: 1000 });
    return { data: await runRegex({ pattern, flags, text, action, replacement }) };
  }),
};

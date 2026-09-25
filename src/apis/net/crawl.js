// 整站文字抓取：从一个网址开始，沿站内链接广度优先抓取多个页面的正文文字。任务在后台执行，结果只存内存。
// 安全与礼貌：
// - 每个请求（含每一跳重定向）都先 checkTarget 静态检查，连接时再由 lookup 钩子检查解析出的 IP（防 SSRF / DNS 重绑定）；
//   重定向不自动跟随，逐跳检查是否仍在范围内、是否被 robots.txt 允许，站外跳转直接跳过、不发请求。
// - 遵守 robots.txt（按本爬虫的 User-agent：MiaoApiBot 匹配规则）与其中的 Crawl-delay；同一任务串行请求，两次请求至少间隔 500ms。
// - 限制：页面数、单页 / 总文字量、单页大小、任务总时长、每个用户 / IP 同时运行的任务数、全局同时运行的任务数。
import { randomUUID } from 'node:crypto';
import { HttpError, param } from '../../lib/http.js';
import { parseMeta } from '../tools/webmeta.js';
import {
  createGate, httpRequest, readLimited, checkTarget, isBlockedIP, reasonOf, statusText, REDIRECT_CODES, BLOCKED_MSG,
} from './common.js';
import { analyzeRobots, isAllowed, selectGroups } from './robots.js';
import { extractLinks } from './links.js';
import { extractText } from './readable.js';
import { decodeText } from './page.js';

export const AGENT = 'MiaoApiBot';
const UA = `Mozilla/5.0 (compatible; ${AGENT}/1.0)`;
const HARD_MAX_PAGES = 50;
const ANON_MAX_PAGES = 20;
const DEFAULT_PAGES = 20;
const PAGE_TEXT_LIMIT = 100_000;
const TOTAL_TEXT_LIMIT = 5_000_000;
const PAGE_MAX_BYTES = 2 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 10_000;
const MIN_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;
const TASK_MAX_MS = 10 * 60_000;
const TTL_MS = 30 * 60_000;
const MAX_REDIRECTS = 5;
const MAX_QUEUE = 5000;
const MAX_LINKS_PER_PAGE = 500;
const MAX_TASKS_STORED = 500;
const PER_USER = 2;
const PER_IP = 1;
const gate = createGate(5); // 全局同时运行的任务数

const SKIP_EXT = /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|pdf|zip|rar|7z|gz|tgz|bz2|xz|tar|exe|msi|dmg|pkg|apk|ipa|iso|bin|mp3|wav|flac|aac|ogg|m4a|mp4|m4v|avi|mov|wmv|flv|mkv|webm|woff2?|ttf|otf|eot|css|js|mjs|json|xml|rss|atom|txt|csv|docx?|xlsx?|pptx?|psd)$/i;

// 管理后台「系统设置 → 其他」或环境变量 CRAWL_MAX_PAGES 可调整单任务页面数上限（1~50）
function maxPagesLimit(user) {
  const env = Number.parseInt(process.env.CRAWL_MAX_PAGES ?? '', 10);
  const cap = Number.isInteger(env) && env >= 1 ? Math.min(env, HARD_MAX_PAGES) : HARD_MAX_PAGES;
  return user?.id ? cap : Math.min(cap, ANON_MAX_PAGES);
}

// ---------- 任务存储 ----------

const tasks = new Map();
const running = new Map(); // owner -> 正在运行的任务数

function sweep(now = Date.now()) {
  for (const [id, t] of tasks) if (t.expiresAt <= now && t.status !== 'running') tasks.delete(id);
  if (tasks.size > MAX_TASKS_STORED) {
    const done = [...tasks.values()].filter((t) => t.status !== 'running').sort((a, b) => a.createdAt - b.createdAt);
    for (const t of done.slice(0, tasks.size - MAX_TASKS_STORED)) tasks.delete(t.id);
  }
}
setInterval(sweep, 60_000).unref();

// 仅供测试
export function _resetCrawlTasks() {
  tasks.clear();
  running.clear();
}
export const _crawlTaskCount = () => tasks.size;
export { sweep as _sweepCrawlTasks };

// ---------- 范围 ----------

const bareHost = (h) => h.replace(/^www\./, '');

export function scopeOf(start, scope) {
  const dir = start.pathname.slice(0, start.pathname.lastIndexOf('/') + 1) || '/';
  return (u) => {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (bareHost(u.hostname) !== bareHost(start.hostname) || u.port !== start.port) return false;
    return scope !== 'path' || u.pathname.startsWith(dir);
  };
}

// ---------- 抓取 ----------

const sleep = (ms, signal) => new Promise((resolve) => {
  if (ms <= 0) return resolve();
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

class Crawler {
  constructor(task, { blocked, minDelayMs }) {
    this.task = task;
    this.blocked = blocked;
    this.minDelayMs = minDelayMs;
    this.lastAt = 0;
    this.robots = new Map(); // origin -> { allow(path), delayMs }
    this.start = new URL(task.startUrl);
    this.inScope = scopeOf(this.start, task.options.scope);
    this.seen = new Set([task.startUrl]);
    this.queue = [{ url: task.startUrl, depth: 0 }];
    this.head = 0;
    this.requests = 0;
    this.abort = new AbortController();
  }

  delayFor(origin) {
    return Math.max(this.minDelayMs, this.robots.get(origin)?.delayMs ?? 0);
  }

  // 串行节流：距上次请求不足间隔时等待
  async pace(origin) {
    const wait = this.lastAt + this.delayFor(origin) - Date.now();
    await sleep(wait, this.abort.signal);
    this.lastAt = Date.now();
    this.requests++;
  }

  async robotsFor(u) {
    const { origin } = u;
    if (this.robots.has(origin)) return this.robots.get(origin);
    await this.pace(origin);
    let rules;
    try {
      const r = await analyzeRobots(origin, { blocked: this.blocked });
      if (r.policy === 'rules') {
        const delays = selectGroups(r.groups, AGENT).groups.map((g) => g.crawlDelay).filter((x) => x != null);
        const delay = delays.length ? Math.max(...delays) : 0;
        rules = { allow: (path) => isAllowed(r, AGENT, path).allowed, delayMs: Math.min(MAX_DELAY_MS, delay * 1000), policy: 'rules' };
      } else {
        rules = { allow: () => r.policy === 'allow-all', delayMs: 0, policy: r.policy };
      }
    } catch (err) {
      if (origin === this.start.origin) {
        throw new HttpError(err.status === 400 ? 400 : 502, `无法读取 robots.txt（${err.message ?? reasonOf(err)}），为遵守 robots 协议已停止`);
      }
      rules = { allow: () => false, delayMs: 0, policy: 'error' };
    }
    this.robots.set(origin, rules);
    return rules;
  }

  async allowed(u) {
    return (await this.robotsFor(u)).allow(u.pathname + u.search);
  }

  enqueue(href, depth) {
    if (this.seen.has(href) || this.seen.size >= MAX_QUEUE) return;
    this.seen.add(href);
    this.queue.push({ url: href, depth });
  }

  record(page) {
    const t = this.task;
    t.pages.push(page);
    if (page.error) t.progress.failed++;
    else t.progress.success++;
    t.progress.crawled = t.pages.length;
  }

  skip() {
    this.task.progress.skipped++;
  }

  // 抓取一个页面：手动处理重定向，每一跳都检查范围、robots 与 SSRF
  async fetchOne(item) {
    let u = checkTarget(item.url, this.blocked);
    for (let hop = 0; ; hop++) {
      if (!(await this.allowed(u))) return { skipped: 'robots.txt 禁止抓取' };
      await this.pace(u.origin);
      const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(PAGE_TIMEOUT_MS)]);
      const r = await httpRequest(u, {
        method: 'GET',
        blocked: this.blocked,
        signal,
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', 'accept-encoding': 'gzip, deflate, br', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      });
      const { res } = r;
      const status = res.statusCode;
      const loc = res.headers.location;
      if (REDIRECT_CODES.has(status) && loc) {
        res.destroy();
        if (hop >= MAX_REDIRECTS) return { error: `重定向次数超过 ${MAX_REDIRECTS} 次`, status };
        let next;
        try {
          next = new URL(loc, u);
        } catch {
          return { error: '返回了无效的重定向地址', status };
        }
        next.hash = '';
        if (!this.inScope(next)) return { skipped: `跳转到抓取范围之外（${next.href.slice(0, 200)}）` };
        if (this.seen.has(next.href)) return { skipped: '跳转到已在队列或已抓取过的页面' };
        this.seen.add(next.href);
        u = checkTarget(next.href, this.blocked);
        continue;
      }
      if (status < 200 || status >= 300) {
        res.destroy();
        return { error: `HTTP ${status} ${statusText(status)}`, status, url: u.href };
      }
      const type = String(res.headers['content-type'] ?? '').toLowerCase();
      const mime = type.split(';')[0].trim();
      if (mime && mime !== 'text/html' && mime !== 'application/xhtml+xml') {
        res.destroy();
        return { skipped: `不是 HTML 网页（${mime}）` };
      }
      const body = await readLimited(res, { maxBytes: PAGE_MAX_BYTES, decompress: true, signal });
      return { url: u.href, status, html: decodeText(body.body, type) };
    }
  }

  async run() {
    const t = this.task;
    const { maxPages, maxDepth, mode } = t.options;
    const deadline = t.createdAt + TASK_MAX_MS;
    // 起始网址的 robots.txt 读不到时整个任务失败
    await this.robotsFor(this.start);
    while (this.head < this.queue.length && t.pages.length < maxPages && this.requests < maxPages * 3 + 10) {
      if (Date.now() > deadline) {
        t.note = `任务运行超过 ${TASK_MAX_MS / 60_000} 分钟，已提前结束`;
        break;
      }
      if (t.totalChars >= TOTAL_TEXT_LIMIT) {
        t.truncated = true;
        t.note = `文字总量超过 ${TOTAL_TEXT_LIMIT} 字符，已提前结束`;
        break;
      }
      const item = this.queue[this.head++];
      t.progress.queued = this.queue.length - this.head;
      let u;
      try {
        u = new URL(item.url);
      } catch {
        this.skip();
        continue;
      }
      if (SKIP_EXT.test(u.pathname)) {
        this.skip();
        continue;
      }
      let r;
      try {
        r = await this.fetchOne(item);
      } catch (err) {
        if (err instanceof HttpError && item.depth === 0 && err.status === 400) throw err;
        const blocked = err.blocked || err.code === 'EBLOCKED';
        if (blocked) {
          if (item.depth === 0) throw new HttpError(400, BLOCKED_MSG);
          this.skip();
          continue;
        }
        this.record({ url: item.url, depth: item.depth, status: null, title: null, length: 0, truncated: false, text: '', error: reasonOf(err) });
        continue;
      }
      if (r.skipped) {
        this.skip();
        if (item.depth === 0) t.note = `起始页面被跳过：${r.skipped}`;
        continue;
      }
      if (r.error) {
        this.record({ url: r.url ?? item.url, depth: item.depth, status: r.status ?? null, title: null, length: 0, truncated: false, text: '', error: r.error });
        continue;
      }
      const { text } = extractText(r.html, { mode });
      const room = Math.max(0, TOTAL_TEXT_LIMIT - t.totalChars);
      const limit = Math.min(PAGE_TEXT_LIMIT, room);
      const cut = text.length > limit;
      const kept = cut ? text.slice(0, limit) : text;
      t.totalChars += kept.length;
      if (cut && limit < PAGE_TEXT_LIMIT) t.truncated = true;
      this.record({
        url: r.url, depth: item.depth, status: r.status, title: parseMeta(r.html, r.url).title, length: text.length, truncated: cut, text: kept, error: null,
      });
      if (item.depth < maxDepth) {
        for (const link of extractLinks(r.html, r.url).slice(0, MAX_LINKS_PER_PAGE)) {
          let lu;
          try {
            lu = new URL(link.url);
          } catch {
            continue;
          }
          if (this.inScope(lu) && !SKIP_EXT.test(lu.pathname)) this.enqueue(lu.href, item.depth + 1);
        }
      }
    }
    t.progress.queued = this.queue.length - this.head;
  }
}

// ---------- 对外接口 ----------

function ownerOf({ user, ip }) {
  return user?.id ? `u:${user.id}` : `ip:${ip ?? 'unknown'}`;
}

// 创建任务并在后台运行；返回任务的公开信息。blocked、minDelayMs 仅供测试替换，onDone 在任务结束后调用（测试用）
export function startCrawl({
  url, maxPages, maxDepth = 3, scope = 'site', mode = 'main',
}, { user = null, ip = null, blocked = isBlockedIP, minDelayMs = MIN_DELAY_MS, onDone } = {}) {
  let start;
  try {
    start = checkTarget(url, blocked);
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  const limit = maxPagesLimit(user);
  const pages = maxPages ?? Math.min(DEFAULT_PAGES, limit);
  if (!Number.isInteger(pages) || pages < 1 || pages > limit) {
    throw new HttpError(400, `max_pages 须为 1~${limit} 之间的整数${user?.id ? '' : '（未登录用户最多 20，登录后最多 50）'}`);
  }
  const owner = ownerOf({ user, ip });
  const perOwner = user?.id ? PER_USER : PER_IP;
  if ((running.get(owner) ?? 0) >= perOwner) {
    throw new HttpError(429, `同时运行的抓取任务不能超过 ${perOwner} 个${user?.id ? '' : '（未登录按 IP 计算，登录后可同时运行 2 个）'}，请等待之前的任务完成`);
  }
  if (gate.active() >= gate.max) throw new HttpError(503, '当前抓取任务过多，请稍后再试');
  sweep();

  const now = Date.now();
  const task = {
    id: randomUUID(),
    owner,
    status: 'running',
    startUrl: start.href,
    options: { maxPages: pages, maxDepth, scope, mode },
    createdAt: now,
    finishedAt: null,
    expiresAt: now + TTL_MS,
    error: null,
    note: null,
    progress: { crawled: 0, success: 0, failed: 0, skipped: 0, queued: 1 },
    truncated: false,
    totalChars: 0,
    pages: [],
  };
  tasks.set(task.id, task);
  running.set(owner, (running.get(owner) ?? 0) + 1);

  const crawler = new Crawler(task, { blocked, minDelayMs });
  const finish = () => {
    task.finishedAt = Date.now();
    task.expiresAt = task.finishedAt + TTL_MS;
    const n = (running.get(owner) ?? 1) - 1;
    if (n > 0) running.set(owner, n);
    else running.delete(owner);
    onDone?.(task);
  };
  gate(() => crawler.run())
    .then(() => { task.status = 'done'; })
    .catch((err) => {
      task.status = 'failed';
      task.error = err instanceof HttpError ? err.message : `抓取失败：${reasonOf(err)}`;
    })
    .finally(finish);
  return summary(task);
}

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

function summary(t) {
  return {
    taskId: t.id,
    status: t.status,
    startUrl: t.startUrl,
    options: { ...t.options },
    createdAt: iso(t.createdAt),
    expiresAt: iso(t.expiresAt),
  };
}

export function getCrawlResult(taskId, { offset = 0, limit = 20, includeText = true } = {}) {
  const t = tasks.get(String(taskId ?? ''));
  if (!t || (t.expiresAt <= Date.now() && t.status !== 'running')) throw new HttpError(404, '任务不存在或已过期（结果保留 30 分钟）');
  const pages = t.pages.slice(offset, offset + limit).map((p) => {
    const { text, ...rest } = p;
    return includeText ? { ...rest, text } : rest;
  });
  return {
    ...summary(t),
    finishedAt: iso(t.finishedAt),
    error: t.error,
    note: t.note,
    progress: { ...t.progress, maxPages: t.options.maxPages },
    truncated: t.truncated,
    totalChars: t.totalChars,
    total: t.pages.length,
    offset,
    limit,
    pages,
  };
}

// 参数：POST 时从 JSON 请求体读取，也兼容查询字符串
function bodyParams(body, query) {
  const q = new URLSearchParams(query);
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const [k, v] of Object.entries(body)) if (v != null && typeof v !== 'object') q.set(k, String(v));
  }
  return q;
}

const TASK_FIELDS = [
  { name: 'taskId', type: 'string', desc: '任务 ID（随机 UUID，不可猜测），用于 /api/crawl/result 查询' },
  { name: 'status', type: 'string', desc: '任务状态：running 抓取中 / done 已完成 / failed 失败' },
  { name: 'startUrl', type: 'string', desc: '起始网址（规范化后）' },
  { name: 'options', type: 'object', desc: '本次任务实际使用的参数' },
  { name: 'options.maxPages', type: 'number', desc: '最多抓取的页面数（含抓取失败的页面，不含跳过的）' },
  { name: 'options.maxDepth', type: 'number', desc: '最大链接深度（0 只抓起始页）' },
  { name: 'options.scope', type: 'string', desc: '抓取范围：site 同一站点 / path 起始网址所在目录' },
  { name: 'options.mode', type: 'string', desc: '文字提取模式：main 只保留正文 / all 全部可见文字' },
  { name: 'createdAt', type: 'string', desc: '创建时间（ISO 8601）' },
  { name: 'expiresAt', type: 'string', desc: '结果过期时间（ISO 8601）：任务结束后保留 30 分钟，运行中为创建后 30 分钟（结束时顺延）' },
];

export default {
  name: 'crawl',
  category: 'net',
  title: '整站文字抓取',
  description: '从一个网址开始，沿站内链接抓取多个页面的正文文字（后台任务）；遵守 robots.txt 与 Crawl-delay，单站串行、至少间隔 500ms，只抓 HTML',
  source: '目标网站',
  routes: [
    {
      method: 'POST',
      path: '/api/crawl',
      summary: '创建整站文字抓取任务，返回 taskId',
      params: [
        { name: 'url', in: 'body', required: true, desc: '起始网址（http / https），只允许公网地址', example: 'https://example.com' },
        { name: 'max_pages', in: 'body', required: false, default: DEFAULT_PAGES, desc: `最多抓取的页面数：未登录 1~${ANON_MAX_PAGES}，登录后 1~${HARD_MAX_PAGES}（管理员可在系统设置里调低上限）`, example: 10 },
        { name: 'max_depth', in: 'body', required: false, default: 3, desc: '链接深度 0~10：0 只抓起始页，1 再抓起始页上的链接，以此类推', example: 2 },
        { name: 'scope', in: 'body', required: false, default: 'site', desc: 'site 同一站点（同域名，www 与否视为同一站点）；path 只抓起始网址所在目录下的页面', example: 'path' },
        { name: 'mode', in: 'body', required: false, default: 'main', desc: 'main 尽量只保留正文；all 提取全部可见文字', example: 'all' },
      ],
      fields: TASK_FIELDS,
      async handler({ body, query, user, ip }) {
        const q = bodyParams(body, query);
        const url = param(q, 'url', { required: true, max: 2048 });
        const maxPages = param(q, 'max_pages', { int: true, min: 1, max: HARD_MAX_PAGES });
        const maxDepth = param(q, 'max_depth', { default: 3, int: true, min: 0, max: 10 });
        const scope = param(q, 'scope', { default: 'site', oneOf: ['site', 'path'] });
        const mode = param(q, 'mode', { default: 'main', oneOf: ['main', 'all'] });
        return { data: startCrawl({ url, maxPages, maxDepth, scope, mode }, { user, ip }) };
      },
    },
    {
      method: 'GET',
      path: '/api/crawl/result',
      summary: '查询抓取任务的进度与分页结果（不计调用次数）',
      public: true,
      params: [
        { name: 'task_id', required: true, desc: '/api/crawl 返回的 taskId', example: '3f2b8c1e-6a7d-4e59-9b1a-0c2d4e6f8a9b' },
        { name: 'offset', required: false, default: 0, desc: '从第几个页面开始返回（0 起）', example: 0 },
        { name: 'limit', required: false, default: 20, desc: '本次最多返回的页面数，1~50', example: 10 },
        { name: 'include_text', required: false, default: 'true', desc: '是否返回每个页面的文字：true / false（只看进度时设为 false）', example: 'false' },
      ],
      fields: [
        ...TASK_FIELDS,
        { name: 'finishedAt', type: 'string|null', desc: '结束时间（ISO 8601）；运行中为 null' },
        { name: 'error', type: 'string|null', desc: '任务失败的原因（如起始网址指向内网、robots.txt 无法读取）；未失败时为 null' },
        { name: 'note', type: 'string|null', desc: '补充说明（如起始页被 robots.txt 禁止、超过总文字量提前结束）；没有时为 null' },
        { name: 'progress', type: 'object', desc: '进度' },
        { name: 'progress.crawled', type: 'number', desc: '已抓取的页面数（= success + failed）' },
        { name: 'progress.success', type: 'number', desc: '成功提取文字的页面数' },
        { name: 'progress.failed', type: 'number', desc: '抓取失败的页面数（4xx / 5xx / 连接失败 / 超时）' },
        { name: 'progress.skipped', type: 'number', desc: '跳过的链接数（robots.txt 禁止、非 HTML、跳转到站外、指向内网、图片 / PDF 等文件）' },
        { name: 'progress.queued', type: 'number', desc: '队列中尚未处理的链接数' },
        { name: 'progress.maxPages', type: 'number', desc: '页面数上限' },
        { name: 'truncated', type: 'boolean', desc: '是否因文字总量超过 500 万字符而提前结束' },
        { name: 'totalChars', type: 'number', desc: '已保存的文字总字符数' },
        { name: 'total', type: 'number', desc: '已抓取的页面总数（分页用）' },
        { name: 'offset', type: 'number', desc: '本次返回的起始位置' },
        { name: 'limit', type: 'number', desc: '本次最多返回的页面数' },
        { name: 'pages', type: 'array', desc: '页面列表，按抓取顺序（广度优先）' },
        { name: 'pages[].url', type: 'string', desc: '页面网址（跟随站内跳转后的地址）' },
        { name: 'pages[].depth', type: 'number', desc: '链接深度（起始页为 0）' },
        { name: 'pages[].status', type: 'number|null', desc: 'HTTP 状态码；连接失败、超时时为 null' },
        { name: 'pages[].title', type: 'string|null', desc: '页面标题；失败或没有标题时为 null' },
        { name: 'pages[].length', type: 'number', desc: '页面文字字符数（截断前）；失败时为 0' },
        { name: 'pages[].truncated', type: 'boolean', desc: '单页文字是否超过 10 万字符（或总量上限）被截断' },
        { name: 'pages[].text', type: 'string', desc: '页面正文文字（段落之间空一行）；失败时为空字符串。include_text=false 时不返回' },
        { name: 'pages[].error', type: 'string|null', desc: '抓取失败的原因（如"HTTP 404 未找到""连接超时"）；成功时为 null' },
      ],
      async handler({ query }) {
        const taskId = param(query, 'task_id', { required: true, max: 64 });
        const offset = param(query, 'offset', { default: 0, int: true, min: 0, max: 100_000 });
        const limit = param(query, 'limit', { default: 20, int: true, min: 1, max: 50 });
        const inc = param(query, 'include_text', { default: 'true', oneOf: ['true', 'false', '1', '0'] });
        return { data: getCrawlResult(taskId, { offset, limit, includeText: inc === 'true' || inc === '1' }) };
      },
    },
  ],
};

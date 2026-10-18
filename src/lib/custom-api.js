// 后台新增的接口：声明式配置（GET/POST + 取值 + 字段映射），不执行任意代码。
// 配置存在 SQLite 里，跨在线更新存活；发布后由 registry 合并进路由表，无需重启。
import { sql, db } from '../db.js';
import { HttpError, fetchJSON, fetchText, param } from './http.js';
import { cache } from './cache.js';
import { SOURCE_TYPES } from './api-sources.js';
import { coreModules, categories } from '../apis/index.js';

const NAME_RE = /^[a-z][a-z0-9-]{2,39}$/;
const PATH_RE = /^\/api\/[a-z0-9][a-z0-9/_-]{0,80}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{2,40}$/;
const PARAM_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,30}$/;
const MAP_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const PATH_EXPR_RE = /^[A-Za-z0-9_$@]+(\.[A-Za-z0-9_$]+|\[\d+\])*$/;
const FIELD_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array', 'null']);
const NETWORKS = new Set(['none', 'required', 'conditional', 'optional', 'target', 'client']);
const CATEGORY_IDS = new Set(categories.map((c) => c.id));

const fail = (message) => { throw new HttpError(400, message); };
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const str = (v, label, min, max) => {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  if (s.length < min) fail(`${label}不能为空`);
  if (s.length > max) fail(`${label}最多 ${max} 个字`);
  return s;
};

function normalizeParam(raw, routePath, index) {
  const at = `${routePath} 的第 ${index + 1} 个参数`;
  if (!isObject(raw)) fail(`${at}必须是对象`);
  const name = String(raw.name ?? '');
  if (!PARAM_RE.test(name)) fail(`${at}的名字不合法（字母开头，可含数字和下划线）`);
  const type = raw.type === 'int' || raw.int === true ? 'int' : 'string';
  if (raw.type != null && !['string', 'int'].includes(raw.type)) fail(`${at}的 type 只能是 string 或 int`);
  const out = {
    name,
    required: Boolean(raw.required),
    type,
    desc: str(raw.desc, `${at}的说明`, 1, 300),
  };
  if (raw.in === 'body') out.in = 'body';
  if (raw.default !== undefined && raw.default !== null) {
    if (type === 'int' && !Number.isInteger(Number(raw.default))) fail(`${at}的默认值必须是整数`);
    out.default = type === 'int' ? Number(raw.default) : String(raw.default);
  }
  if (raw.min !== undefined) {
    if (type !== 'int' || !Number.isInteger(raw.min)) fail(`${at}的 min 只适用于整数参数`);
    out.min = raw.min;
  }
  if (raw.max !== undefined) {
    if (type !== 'int' || !Number.isInteger(raw.max)) fail(`${at}的 max 只适用于整数参数`);
    out.max = raw.max;
  }
  if (raw.maxLength !== undefined) {
    if (type !== 'string' || !Number.isInteger(raw.maxLength) || raw.maxLength < 1 || raw.maxLength > 2000) fail(`${at}的 maxLength 须为 1~2000 的整数`);
    out.maxLength = raw.maxLength;
  }
  if (raw.oneOf !== undefined) {
    if (!Array.isArray(raw.oneOf) || !raw.oneOf.length || raw.oneOf.length > 50) fail(`${at}的 oneOf 必须是 1~50 个可选值`);
    out.oneOf = raw.oneOf.map((v) => String(v));
  }
  if (raw.pattern !== undefined) {
    if (type !== 'string') fail(`${at}的 pattern 只适用于字符串参数`);
    try { new RegExp(raw.pattern); } catch { fail(`${at}的 pattern 不是合法正则`); }
    out.pattern = String(raw.pattern);
  }
  if (raw.example !== undefined && raw.example !== null && raw.example !== '') {
    out.example = String(raw.example).slice(0, 200);
  } else if (out.required) {
    fail(`${at}是必填参数，请填写示例值（自动检测和巡检会用它）`);
  }
  return out;
}

function checkTemplate(text, params, env, where) {
  for (const m of String(text).matchAll(/\{([^}]*)\}/g)) {
    const token = m[1];
    if (token.startsWith('env:')) {
      if (!ENV_RE.test(token.slice(4))) fail(`${where}里的环境变量占位符不合法：{${token}}`);
      if (env.length && !env.includes(token.slice(4))) fail(`${where}用到了未声明的环境变量 ${token.slice(4)}`);
      continue;
    }
    if (!params.includes(token)) fail(`${where}引用了未声明的参数 {${token}}`);
  }
  if (/\{[^}]*$/.test(String(text))) fail(`${where}里的占位符没有闭合`);
}

function checkDeep(value, params, env, where) {
  if (typeof value === 'string') return checkTemplate(value, params, env, where);
  if (Array.isArray(value)) { for (const v of value) checkDeep(v, params, env, where); return; }
  if (isObject(value)) { for (const v of Object.values(value)) checkDeep(v, params, env, where); }
}

function normalizeRoute(raw, config, index) {
  if (!isObject(raw)) fail(`第 ${index + 1} 个路由必须是对象`);
  const method = String(raw.method ?? 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(method)) fail('method 只能是 GET 或 POST');
  const path = String(raw.path ?? '');
  if (!PATH_RE.test(path)) fail(`路径 ${path || '(空)'} 不合法：必须以 /api/ 开头，只含小写字母、数字、/ _ -`);
  const summary = str(raw.summary, `路由 ${path} 的说明`, 1, 120);
  const params = Array.isArray(raw.params) ? raw.params.map((p, i) => normalizeParam(p, path, i)) : [];
  const names = params.map((p) => p.name);
  if (new Set(names).size !== names.length) fail(`${path} 的参数名重复`);
  const env = config.env;
  const url = String(raw.url ?? '').trim();
  if (!/^https?:\/\//i.test(url)) fail(`${path} 的 url 必须是 http(s) 地址`);
  try { new URL(url.replace(/\{[^}]*\}/g, 'x')); } catch { fail(`${path} 的 url 不是合法地址`); }
  checkTemplate(url, names, env, `${path} 的 url`);

  const headers = {};
  if (raw.headers !== undefined) {
    if (!isObject(raw.headers)) fail(`${path} 的 headers 必须是对象`);
    for (const [k, v] of Object.entries(raw.headers)) {
      if (!/^[a-zA-Z0-9-]{1,40}$/.test(k)) fail(`${path} 的请求头名不合法：${k}`);
      if (/^(host|content-length|connection)$/i.test(k)) fail(`${path} 不能自定义 ${k} 请求头`);
      headers[k.toLowerCase()] = String(v);
      checkTemplate(v, names, env, `${path} 的请求头 ${k}`);
    }
  }

  let body;
  if (raw.body !== undefined) {
    if (method !== 'POST') fail(`${path} 只有 POST 才能设置 body`);
    body = raw.body;
    if (typeof body === 'string') checkTemplate(body, names, env, `${path} 的 body`);
    else if (isObject(body) || Array.isArray(body)) checkDeep(body, names, env, `${path} 的 body`);
    else fail(`${path} 的 body 必须是对象或字符串`);
  }

  let extract;
  if (raw.extract !== undefined && raw.extract !== '') {
    if (!PATH_EXPR_RE.test(raw.extract)) fail(`${path} 的 extract 不合法（例：data.items）`);
    extract = raw.extract;
  }
  let map;
  if (raw.map !== undefined) {
    if (!isObject(raw.map) || !Object.keys(raw.map).length) fail(`${path} 的 map 必须是非空对象`);
    map = {};
    for (const [k, v] of Object.entries(raw.map)) {
      if (!MAP_KEY_RE.test(k)) fail(`${path} 的 map 输出字段名不合法：${k}`);
      if (typeof v !== 'string' || !PATH_EXPR_RE.test(v)) fail(`${path} 的 map.${k} 必须是取值路径（例：name 或 data.name）`);
      map[k] = v;
    }
  }

  if (!Array.isArray(raw.fields) || !raw.fields.length) fail(`${path} 必须写返回字段说明（fields）`);
  const fields = raw.fields.map((f, i) => {
    if (!isObject(f)) fail(`${path} 的第 ${i + 1} 个返回字段必须是对象`);
    const name = String(f.name ?? '');
    if (!/^[A-Za-z0-9_$@.[\]*]+$/.test(name)) fail(`${path} 的返回字段名不合法：${name || '(空)'}`);
    const type = String(f.type ?? 'string');
    if (!type.split('|').every((t) => FIELD_TYPES.has(t))) fail(`${path} 的字段 ${name} 类型不合法`);
    return { name, type, desc: str(f.desc, `${path} 字段 ${name} 的说明`, 1, 300) };
  });
  if (map) {
    for (const key of Object.keys(map)) {
      const documented = fields.some((f) => f.name === key || f.name.startsWith(`${key}.`) || f.name.startsWith(`${key}[`));
      if (!documented) fail(`${path} 的返回字段说明缺少 map 输出字段 ${key}`);
    }
  }

  const cacheTtlSec = raw.cacheTtlSec === undefined ? 300 : Number(raw.cacheTtlSec);
  if (!Number.isInteger(cacheTtlSec) || cacheTtlSec < 0 || cacheTtlSec > 86400) fail(`${path} 的 cacheTtlSec 须为 0~86400 的整数`);
  const timeoutMs = raw.timeoutMs === undefined ? 10000 : Number(raw.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 20000) fail(`${path} 的 timeoutMs 须为 500~20000 的整数`);
  const responseType = raw.responseType ?? 'json';
  if (!['json', 'text'].includes(responseType)) fail(`${path} 的 responseType 只能是 json 或 text`);
  if (responseType === 'text' && (extract || map)) fail(`${path} 是纯文本返回，不能使用 extract / map`);

  return { method, path, summary, params, url, headers, body, extract, map, fields, cacheTtlSec, timeoutMs, responseType };
}

// 解析并校验配置，返回规范化后的对象（多余字段会被拒绝，避免拼写错误静默生效）
export function parseConfig(raw) {
  if (!isObject(raw)) fail('配置必须是 JSON 对象');
  const allowed = new Set(['name', 'category', 'title', 'description', 'source', 'sourceInfo', 'env', 'unofficial', 'routes']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) fail(`未知字段 ${key}`);

  const name = String(raw.name ?? '');
  if (!NAME_RE.test(name)) fail('name 必须是 3~40 位小写字母、数字或 -，并以字母开头');
  if (coreModules.some((m) => m.name === name)) fail(`name ${name} 与已有接口重名`);

  const category = String(raw.category ?? '');
  if (!CATEGORY_IDS.has(category)) fail(`category 只能是 ${[...CATEGORY_IDS].join(' / ')}`);
  const title = str(raw.title, '接口名称', 1, 60);
  const description = raw.description === undefined ? '' : str(raw.description, '接口描述', 0, 300);

  const env = [];
  if (raw.env !== undefined) {
    if (!Array.isArray(raw.env) || raw.env.length > 10) fail('env 必须是 0~10 个环境变量名');
    for (const item of raw.env) {
      const v = typeof item === 'string' ? item : item?.name;
      if (!ENV_RE.test(String(v ?? ''))) fail(`环境变量名不合法：${v}`);
      env.push(String(v));
    }
    if (new Set(env).size !== env.length) fail('环境变量名重复');
  }

  let sourceInfo;
  if (raw.sourceInfo !== undefined) {
    if (!isObject(raw.sourceInfo)) fail('sourceInfo 必须是对象');
    const kind = String(raw.sourceInfo.kind ?? '');
    if (!(kind in SOURCE_TYPES)) fail(`sourceInfo.kind 只能是 ${Object.keys(SOURCE_TYPES).join(' / ')}`);
    const network = String(raw.sourceInfo.network ?? (kind.startsWith('local-') ? 'none' : 'required'));
    if (!NETWORKS.has(network)) fail(`sourceInfo.network 只能是 ${[...NETWORKS].join(' / ')}`);
    sourceInfo = {
      kind,
      label: SOURCE_TYPES[kind],
      network,
      summary: raw.sourceInfo.summary === undefined ? description || `后台新增接口：${title}` : str(raw.sourceInfo.summary, 'sourceInfo.summary', 5, 300),
    };
  }

  if (!Array.isArray(raw.routes) || !raw.routes.length || raw.routes.length > 20) fail('routes 必须是 1~20 个路由');
  const config = { name, category, title, description, env, unofficial: Boolean(raw.unofficial), sourceInfo };
  config.routes = raw.routes.map((r, i) => normalizeRoute(r, config, i));
  const paths = config.routes.map((r) => r.path);
  if (new Set(paths).size !== paths.length) fail('同一个接口里的路由路径重复');
  if (raw.source !== undefined) config.source = str(raw.source, '数据来源', 1, 100);
  return config;
}

// ---------- 运行 ----------

function getPath(value, path) {
  let cur = value;
  for (const part of String(path).split('.')) {
    const m = part.match(/^([^[]+)((?:\[\d+\])*)$/);
    if (!m) return undefined;
    cur = cur?.[m[1]];
    for (const n of m[2].match(/\d+/g) ?? []) cur = cur?.[Number(n)];
    if (cur === undefined) return undefined;
  }
  return cur;
}

function fillText(text, values, where) {
  return String(text).replace(/\{([^}]*)\}/g, (all, token) => {
    if (token.startsWith('env:')) {
      const key = token.slice(4);
      const v = process.env[key];
      if (!v) throw new HttpError(503, `接口还没有配置环境变量 ${key}`);
      return encodeURIComponent(v);
    }
    const v = values[token];
    return encodeURIComponent(v == null ? '' : String(v));
  });
}

// body / 请求头里按原样插入，不做 URL 编码（数字参数保持数字）
function fillDeep(value, values) {
  if (typeof value === 'string') {
    return value.replace(/\{([^}]*)\}/g, (all, token) => {
      if (token.startsWith('env:')) {
        const key = token.slice(4);
        const v = process.env[key];
        if (!v) throw new HttpError(503, `接口还没有配置环境变量 ${key}`);
        return v;
      }
      return values[token] == null ? '' : String(values[token]);
    });
  }
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, values));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, values)]));
  return value;
}

function readValues(params, query) {
  const values = {};
  for (const p of params) {
    values[p.name] = param(query ?? new URLSearchParams(), p.name, {
      default: p.default,
      required: p.required,
      pattern: p.pattern ? new RegExp(p.pattern) : undefined,
      oneOf: p.oneOf,
      int: p.type === 'int',
      min: p.min,
      max: p.max,
    });
  }
  return values;
}

function mapData(source, map) {
  const out = {};
  for (const [key, path] of Object.entries(map)) {
    if (path === '@') { out[key] = source; continue; }
    const v = getPath(source, path);
    if (v === undefined) throw new HttpError(502, `上游返回结构可能已变化：找不到 ${path}`);
    out[key] = v;
  }
  return out;
}

function makeHandler(route) {
  return async (ctx) => {
    const values = readValues(route.params, ctx?.query);
    const url = fillText(route.url, values, route.path);
    const headers = {};
    for (const [k, v] of Object.entries(route.headers ?? {})) headers[k] = fillDeep(v, values);
    const init = { method: route.method, timeoutMs: route.timeoutMs, headers };
    if (route.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(fillDeep(route.body, values));
    }
    const load = async () => {
      const raw = route.responseType === 'text' ? { text: await fetchText(url, init) } : await fetchJSON(url, init);
      const picked = route.extract ? getPath(raw, route.extract) : raw;
      if (route.extract && picked === undefined) throw new HttpError(502, `上游返回结构可能已变化：找不到 ${route.extract}`);
      return route.map ? mapData(picked, route.map) : (picked ?? null);
    };
    if (!route.cacheTtlSec) return { data: await load() };
    const key = `custom:${route.path}:${JSON.stringify(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)))}`;
    return cache.wrap(key, route.cacheTtlSec * 1000, load);
  };
}

export function buildModule(config) {
  const route = config.routes[0];
  const host = (() => { try { return new URL(route.url.replace(/\{[^}]*\}/g, 'x')).hostname; } catch { return null; } })();
  const sourceInfo = config.sourceInfo ?? {
    kind: 'third-party-service',
    label: SOURCE_TYPES['third-party-service'],
    network: 'required',
    summary: config.description || `后台新增接口：${config.title}`,
  };
  return {
    name: config.name,
    category: config.category,
    title: config.title,
    description: config.description,
    source: config.source ?? host ?? '后台新增',
    sourceInfo,
    env: config.env,
    unofficial: Boolean(config.unofficial),
    origin: 'custom',
    custom: true,
    routes: config.routes.map((r) => ({
      method: r.method,
      path: r.path,
      summary: r.summary,
      params: r.params.map((p) => ({ ...p, max: p.type === 'int' ? p.max : (p.maxLength ?? p.max) })),
      fields: r.fields,
      returns: null,
      handler: makeHandler(r),
    })),
  };
}

// ---------- 存储 ----------

const rowOf = (name) => sql('SELECT * FROM custom_apis WHERE name = ?').get(name);
const parseRow = (row) => ({
  name: row.name,
  status: row.status,
  version: row.version,
  publishedAt: row.published_at,
  publishedBy: row.published_by,
  updatedAt: row.updated_at,
  draft: row.draft ? JSON.parse(row.draft) : null,
  config: row.config ? JSON.parse(row.config) : null,
});

// 对外返回解析后的对象（draft/config 是对象，时间字段是 camelCase）
export const getCustomApi = (name) => {
  const row = rowOf(name);
  return row ? parseRow(row) : null;
};

export function listCustomApis() {
  return sql('SELECT * FROM custom_apis ORDER BY updated_at DESC').all().map(parseRow);
}

export function customVersions(name) {
  return sql('SELECT version, note, created_by, created_at FROM custom_api_versions WHERE name = ? ORDER BY version DESC').all(name)
    .map((v) => ({ version: v.version, note: v.note, createdBy: v.created_by, createdAt: v.created_at }));
}

export function saveCustomDraft(raw, { by = null } = {}) {
  const config = parseConfig(raw);
  const json = JSON.stringify(config);
  const ts = Date.now();
  const exists = Boolean(rowOf(config.name));
  if (exists) {
    sql("UPDATE custom_apis SET draft = ?, status = 'draft', updated_at = ? WHERE name = ?").run(json, ts, config.name);
  } else {
    sql('INSERT INTO custom_apis (name, draft, config, version, status, created_at, updated_at) VALUES (?, ?, NULL, 0, ?, ?, ?)')
      .run(config.name, json, 'draft', ts, ts);
  }
  return { name: config.name, status: 'draft', config, published: Boolean(exists && rowOf(config.name)?.config) };
}

// 发布时不允许和核心接口、其他已发布接口的路径冲突
export function assertNoConflict(config) {
  if (coreModules.some((m) => m.name === config.name)) throw new HttpError(409, `name ${config.name} 与已有接口重名`);
  const used = new Set(coreModules.flatMap((m) => m.routes.map((r) => `${r.method} ${r.path}`)));
  for (const row of sql('SELECT name, config FROM custom_apis WHERE config IS NOT NULL AND name <> ?').all(config.name)) {
    let other;
    try { other = JSON.parse(row.config); } catch { continue; }
    for (const r of other.routes ?? []) used.add(`${r.method} ${r.path}`);
  }
  for (const r of config.routes) {
    if (used.has(`${r.method} ${r.path}`)) throw new HttpError(409, `路径 ${r.method} ${r.path} 已被占用（核心接口或其他自定义接口）`);
  }
}

export function publishCustomApi(name, { by = null, note = null } = {}) {
  const row = rowOf(name);
  if (!row) throw new HttpError(404, '接口不存在');
  if (!row.draft) throw new HttpError(400, '没有待发布的草稿');
  const config = parseConfig(JSON.parse(row.draft));
  assertNoConflict(config);
  const prev = sql('SELECT MAX(version) AS v FROM custom_api_versions WHERE name = ?').get(name)?.v ?? row.version ?? 0;
  const version = prev + 1;
  const ts = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    sql(`UPDATE custom_apis SET config = ?, draft = NULL, version = ?, status = 'published', published_at = ?, published_by = ?, updated_at = ? WHERE name = ?`)
      .run(JSON.stringify(config), version, ts, by, ts, name);
    sql('INSERT INTO custom_api_versions (name, version, config, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, version, JSON.stringify(config), note, by, ts);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { name, version };
}

export function rollbackCustomApi(name, version, { by = null, note = null } = {}) {
  const row = rowOf(name);
  if (!row) throw new HttpError(404, '接口不存在');
  const target = sql('SELECT config FROM custom_api_versions WHERE name = ? AND version = ?').get(name, Number(version));
  if (!target) throw new HttpError(404, `没有第 ${version} 版`);
  const config = parseConfig(JSON.parse(target.config));
  assertNoConflict(config);
  sql(`UPDATE custom_apis SET config = ?, version = ?, status = CASE WHEN draft IS NULL THEN 'published' ELSE 'draft' END, updated_at = ? WHERE name = ?`)
    .run(JSON.stringify(config), Number(version), Date.now(), name);
  return { name, version: Number(version), by, note };
}

export function removeCustomApi(name) {
  const row = rowOf(name);
  if (!row) throw new HttpError(404, '接口不存在');
  sql('DELETE FROM custom_api_versions WHERE name = ?').run(name);
  sql('DELETE FROM custom_apis WHERE name = ?').run(name);
  return { name };
}

// 启动/发布时加载线上版本；单条配置坏了只跳过它，不能让整个服务起不来
export function loadCustomModules() {
  const list = [];
  const names = new Set(coreModules.map((m) => m.name));
  const paths = new Set(coreModules.flatMap((m) => m.routes.map((r) => `${r.method} ${r.path}`)));
  for (const row of sql("SELECT name, config FROM custom_apis WHERE config IS NOT NULL ORDER BY name").all()) {
    try {
      const config = parseConfig(JSON.parse(row.config));
      const mod = buildModule(config);
      if (names.has(mod.name)) throw new Error('模块名与已有接口重复');
      for (const r of mod.routes) {
        const key = `${r.method} ${r.path}`;
        if (paths.has(key)) throw new Error(`路径重复：${key}`);
        paths.add(key);
      }
      names.add(mod.name);
      list.push(mod);
    } catch (err) {
      console.error(`[custom-api] 跳过 ${row.name}：${err.message}`);
    }
  }
  return list;
}

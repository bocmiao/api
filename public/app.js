// Miao API 前端：无依赖单页应用（hash 路由）
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtNum = (n) => Number(n ?? 0).toLocaleString('zh-CN');
// 支持时间戳、ISO 字符串，以及 SQLite 的 "YYYY-MM-DD HH:MM:SS"（UTC）
const fmtDate = (s) => {
  if (s == null || s === '') return '—';
  const d = typeof s === 'number' || s.includes('T') ? new Date(s) : new Date(s.replace(' ', 'T') + 'Z');
  return d.toLocaleString('zh-CN', { hour12: false });
};

const state = { user: null, quota: null, catalog: null };

// ---------- 图标 ----------
const ICONS = {
  logo: '<path d="M5 10.5V4l4.2 3.1a9 9 0 0 1 5.6 0L19 4v6.5c.6 1.1 1 2.3 1 3.6C20 18.5 16.4 21 12 21s-8-2.5-8-6.9c0-1.3.4-2.5 1-3.6z"/><path d="M9 13.5v.6M15 13.5v.6M11 16.6l1 .7 1-.7"/>',
  gamepad: '<rect x="2" y="7" width="20" height="10" rx="4"/><path d="M7 10v4M5 12h4M15 11h.01M18 13h.01"/>',
  flame: '<path d="M12 22c4 0 7-3 7-7 0-5-5-7-5-12-3 2-4 5-4 7-1-1-2-2-2-3-2 2-3 5-3 8 0 4 3 7 7 7z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  sparkle: '<path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sunSmall: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
  chart: '<path d="M3 3v18h18"/><path d="M8 17V11M13 17V7M18 17v-4"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  zap: '<path d="M13 2L3 14h9l-1 8 10-12h-9z"/>',
  layers: '<path d="M12 2l10 5-10 5L2 7z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>',
  play: '<path d="M6 4l14 8-14 8z"/>',
  external: '<path d="M14 3h7v7M10 14L21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
};
const icon = (name, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;

// ---------- 请求 ----------
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json;
  try { json = await res.json(); } catch { json = { code: res.status, message: `HTTP ${res.status}` }; }
  if (!res.ok || json.code !== 200) {
    const err = new Error(json.message || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json.data;
}

function toast(msg, err = false) {
  let wrap = $('.toast-wrap');
  if (!wrap) document.body.append((wrap = Object.assign(document.createElement('div'), { className: 'toast-wrap' })));
  const t = Object.assign(document.createElement('div'), { className: `toast${err ? ' err' : ''}`, textContent: msg });
  wrap.append(t);
  while (wrap.children.length > 2) wrap.firstElementChild.remove();
  setTimeout(() => t.remove(), 3200);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch {
    toast('复制失败，请手动选择复制', true);
  }
}

function modal(html, onMount) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal card" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => e.key === 'Escape' && close();
  back.addEventListener('click', (e) => e.target === back && close());
  document.addEventListener('keydown', onKey);
  document.body.append(back);
  onMount?.(back, close);
  $('input, button.primary', back)?.focus();
  return close;
}

function confirmDialog(title, text, { danger = true, okText = '确定' } = {}) {
  return new Promise((resolve) => {
    modal(`<h2>${esc(title)}</h2><p class="muted small">${esc(text)}</p>
      <div class="actions"><button class="btn" data-no>取消</button><button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(okText)}</button></div>`,
    (root, close) => {
      $('[data-no]', root).onclick = () => { close(); resolve(false); };
      $('[data-yes]', root).onclick = () => { close(); resolve(true); };
    });
  });
}

// 表单提交辅助：禁用按钮、显示错误
function bindForm(form, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', form);
    const errBox = $('.form-error', form);
    if (errBox) errBox.hidden = true;
    btn && (btn.disabled = true);
    try {
      await handler(Object.fromEntries(new FormData(form)));
    } catch (err) {
      if (errBox) { errBox.textContent = err.message; errBox.hidden = false; } else toast(err.message, true);
    } finally {
      btn && (btn.disabled = false);
    }
  });
}

// ---------- 主题 ----------
const storage = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
applyTheme(storage.get('theme'));
const isDark = () => document.documentElement.dataset.theme === 'dark' ||
  (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);

// ---------- 布局 ----------
function renderTopbar(route) {
  const u = state.user;
  const q = state.quota;
  const nav = [
    ['#/', '接口', route === 'home' || route === 'api'],
    ['#/docs', '文档', route === 'docs'],
    ...(u ? [['#/console', '控制台', route === 'console']] : []),
    ...(u?.isAdmin ? [['#/admin', '管理', route === 'admin']] : []),
  ];
  $('#topbar').innerHTML = `<div class="wrap">
    <a class="logo" href="#/"><span class="logo-mark">${icon('logo')}</span>Miao API</a>
    <nav class="nav" id="nav">${nav.map(([h, t, a]) => `<a href="${h}" class="${a ? 'active' : ''}">${t}</a>`).join('')}</nav>
    <div class="topbar-right">
      ${q ? `<span class="quota-pill" title="今日调用额度，北京时间 0 点重置">今日剩余 ${fmtNum(q.remaining)} / ${fmtNum(q.limit)}</span>` : ''}
      <button class="btn ghost icon" id="theme" title="切换主题" aria-label="切换主题">${icon(isDark() ? 'sunSmall' : 'moon')}</button>
      ${u
        ? `<button class="btn ghost icon" id="logout" title="退出登录" aria-label="退出登录">${icon('logout')}</button>`
        : `<a class="btn ghost" href="#/login">登录</a><a class="btn primary" href="#/register">免费注册</a>`}
      <button class="btn ghost icon menu-btn" id="menu" aria-label="菜单">${icon('menu')}</button>
    </div></div>`;
  $('#theme').onclick = () => {
    const next = isDark() ? 'light' : 'dark';
    storage.set('theme', next);
    applyTheme(next);
    renderTopbar(route);
  };
  $('#menu').onclick = () => $('#nav').classList.toggle('open');
  $('#logout')?.addEventListener('click', async () => {
    await api('POST', '/auth/logout', {}).catch(() => {});
    await loadMe();
    location.hash = '#/';
  });
}

async function loadMe() {
  try {
    const { user, quota } = await api('GET', '/auth/me');
    state.user = user;
    state.quota = quota;
  } catch {
    state.user = null;
  }
}

async function loadCatalog() {
  if (!state.catalog) state.catalog = await api('GET', '/api');
  return state.catalog;
}

const catOf = (id) => state.catalog?.categories.find((c) => c.id === id) ?? { title: id, icon: 'layers' };

// ---------- 首页 ----------
function moduleBadges(m) {
  return [
    m.unofficial ? '<span class="badge warn" title="数据来自非官方接口或网页，可能随上游改版失效">非官方</span>' : '',
    !m.available ? '<span class="badge danger" title="服务端未配置所需的密钥">需配置</span>' : '',
    m.env.some((e) => e.optional) && m.available ? '<span class="badge" title="可选配置密钥以增强功能">可选 Key</span>' : '',
  ].join('');
}

async function pageHome() {
  const cat = await loadCatalog();
  const routeCount = cat.modules.reduce((n, m) => n + m.routes.length, 0);
  const selected = sessionStorage.getItem('cat') || 'all';
  const sample = `<span class="j-null">$</span> curl ${esc(location.origin)}/api/epic/free \\
    -H <span class="j-str">"X-API-Key: ak_••••••••"</span>

{
  <span class="j-key">"code"</span>: <span class="j-num">200</span>,
  <span class="j-key">"message"</span>: <span class="j-str">"ok"</span>,
  <span class="j-key">"cached"</span>: <span class="j-bool">true</span>,
  <span class="j-key">"data"</span>: {
    <span class="j-key">"current"</span>: [{
      <span class="j-key">"title"</span>: <span class="j-str">"本周免费游戏"</span>,
      <span class="j-key">"endDate"</span>: <span class="j-str">"2026-10-01T15:00:00Z"</span>,
      <span class="j-key">"url"</span>: <span class="j-str">"https://store.epicgames.com/..."</span>
    }],
    <span class="j-key">"upcoming"</span>: [ ... ]
  }
}`;

  $('#main').innerHTML = `
  <div class="wrap">
    <section class="hero">
      <div>
        <h1>一个 Key<br>调用 <em>${routeCount}</em> 个常用接口</h1>
        <p class="lead">游戏限免、全网热榜、天气节假日、汇率行情、壁纸诗词、开发工具……统一格式、自带缓存与容错，内容更新还能推送到微信、钉钉、飞书、Telegram。</p>
        <div class="row">
          <a class="btn primary lg" href="#catalog" id="browse">浏览接口</a>
          ${state.user ? '<a class="btn lg" href="#/console/keys">获取 API Key</a>' : '<a class="btn lg" href="#/register">免费注册</a>'}
        </div>
        <div class="hero-stats">
          <div><b>${cat.modules.length}</b><span>个接口模块</span></div>
          <div><b>${fmtNum(cat.limits.anonDaily)}</b><span>次/天 免登录调用</span></div>
          <div><b>${fmtNum(cat.limits.userDaily)}</b><span>次/天 注册用户</span></div>
        </div>
      </div>
      <div class="code-window"><div class="bar"><i></i><i></i><i></i></div><pre>${sample}</pre></div>
    </section>

    <section class="section" id="catalog">
      <div class="section-title">
        <h2>全部接口</h2>
        <label class="search">${icon('search')}<input class="input" id="q" placeholder="搜索接口，如 天气、热搜、汇率" autocomplete="off"></label>
      </div>
      <div class="cat-tabs" id="cats">
        <button class="chip" data-cat="all">全部 <span class="n">${cat.modules.length}</span></button>
        ${cat.categories.map((c) => `<button class="chip" data-cat="${c.id}">${icon(c.icon)}${esc(c.title)} <span class="n">${c.count}</span></button>`).join('')}
      </div>
      <div class="api-grid" id="grid"></div>
    </section>

    <section class="section">
      <div class="feature-grid">
        ${[
          ['layers', '统一响应格式', '所有接口返回 { code, message, data }，错误码与 HTTP 状态一致，接入一次即可复用。'],
          ['zap', '缓存与容错', '按接口特性缓存上游数据；上游故障时自动返回最近一次成功的数据。'],
          ['key', 'API Key 与额度', `免登录每天 ${fmtNum(cat.limits.anonDaily)} 次；注册后生成 Key，每天 ${fmtNum(cat.limits.userDaily)} 次，用量随时可查。`],
          ['bell', '订阅推送', 'Epic 周免、游戏限免、每日壁纸等内容更新时，自动推送到你常用的渠道。'],
        ].map(([i, t, d]) => `<div class="card feature"><div class="cat-icon">${icon(i)}</div><h3>${t}</h3><p>${d}</p></div>`).join('')}
      </div>
    </section>
  </div>`;

  $('#browse').onclick = (e) => { e.preventDefault(); $('#catalog').scrollIntoView({ behavior: 'smooth' }); };

  let current = cat.categories.some((c) => c.id === selected) ? selected : 'all';
  const draw = () => {
    const q = $('#q').value.trim().toLowerCase();
    $$('#cats .chip').forEach((b) => b.classList.toggle('active', b.dataset.cat === current));
    const list = cat.modules.filter((m) => (current === 'all' || m.category === current) &&
      (!q || [m.title, m.description, m.name, ...m.routes.map((r) => r.path + r.summary)].join(' ').toLowerCase().includes(q)));
    $('#grid').innerHTML = list.length ? list.map((m) => `
      <a class="card api-card" href="#/api/${encodeURIComponent(m.name)}">
        <div class="head"><div class="cat-icon">${icon(catOf(m.category).icon)}</div><h3>${esc(m.title)}</h3></div>
        <p>${esc(m.description || m.routes[0]?.summary)}</p>
        <div class="foot"><span class="path">${esc(m.routes[0]?.path)}${m.routes.length > 1 ? ` +${m.routes.length - 1}` : ''}</span>${moduleBadges(m)}</div>
      </a>`).join('') : '<div class="empty" style="grid-column:1/-1">没有找到匹配的接口</div>';
  };
  $('#cats').onclick = (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    current = b.dataset.cat;
    sessionStorage.setItem('cat', current);
    draw();
  };
  $('#q').oninput = draw;
  draw();
}

// ---------- 接口详情 + 在线调试 ----------
function highlightJson(value) {
  const json = esc(JSON.stringify(value, null, 2));
  return json.replace(/(&quot;(?:\\.|[^&\\]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (m, str, colon, bool) => {
    if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
    if (bool) return `<span class="j-bool">${m}</span>`;
    if (m === 'null') return `<span class="j-null">${m}</span>`;
    return `<span class="j-num">${m}</span>`;
  });
}

// 必填参数预填示例；可选参数留空（使用默认值），在占位符里提示默认值和示例
function placeholderOf(p) {
  const parts = [];
  if (p.default !== undefined && p.default !== '') parts.push(`默认 ${p.default}`);
  if (p.example !== undefined && String(p.example) !== String(p.default)) parts.push(`例 ${p.example}`);
  return parts.join(' · ');
}

function buildRequest(route, values) {
  let path = route.path;
  const query = new URLSearchParams();
  const body = {};
  for (const p of route.params) {
    const v = values[p.name];
    if (v === undefined || v === '') continue;
    if (path.includes(`:${p.name}`)) path = path.replace(`:${p.name}`, encodeURIComponent(v));
    else if (p.in === 'body') body[p.name] = v;
    else query.set(p.name, v);
  }
  const qs = query.toString();
  return { url: path + (qs ? `?${qs}` : ''), body: Object.keys(body).length ? body : undefined };
}

// 返回字段表：按层级缩进，显示字段名最后一段，完整路径放在 title 里
function fieldsTable(fields) {
  if (!fields?.length) return '<p class="faint small">暂无字段说明</p>';
  const rows = fields.map((f) => {
    const path = f.name.replace(/^\[\]\.?/, '');
    const depth = path ? path.split('.').length - 1 : 0;
    const leaf = path ? path.split('.').pop() : '[]';
    const types = f.type.split('|').map((t) => `<span class="type type-${t}">${t}</span>`).join('');
    const label = leaf === '*' ? '<span class="faint">任意键名</span>' : esc(leaf);
    return `<tr><td class="fname" title="${esc(f.name)}"><span style="padding-left:${depth * 18}px">${depth ? '<i class="tree">└</i>' : ''}${label}</span></td>
      <td class="nowrap">${types}</td><td>${esc(f.desc)}</td></tr>`;
  }).join('');
  return `<div class="table-wrap"><table class="table fields-table"><thead><tr><th>字段</th><th>类型</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

const ENVELOPE_FIELDS = [
  { name: 'code', type: 'number', desc: '状态码，与 HTTP 状态码一致，200 表示成功' },
  { name: 'message', type: 'string', desc: '结果说明，成功为 ok，失败时为中文错误原因' },
  { name: 'cached', type: 'boolean', desc: '是否命中服务端缓存（部分本地计算的接口不返回）' },
  { name: 'stale', type: 'boolean', desc: '仅在为 true 时出现：上游暂时不可用，返回的是最近一次成功获取的旧数据' },
  { name: 'updatedAt', type: 'string', desc: '数据获取时间（ISO 8601，UTC），部分接口不返回' },
  { name: 'data', type: 'object|array|null', desc: '接口数据，各接口字段见对应文档；失败时为 null' },
];

function codeSamples(route, req) {
  const full = location.origin + req.url;
  const bodyJson = req.body ? JSON.stringify(req.body) : null;
  const pyBody = req.body ? JSON.stringify(req.body, null, 4).replace(/\n/g, '\n    ') : null;
  return {
    cURL: `curl${route.method !== 'GET' ? ` -X ${route.method}` : ''} "${full}" \\\n  -H "X-API-Key: YOUR_API_KEY"${bodyJson ? ` \\\n  -H "Content-Type: application/json" \\\n  -d '${bodyJson}'` : ''}`,
    JavaScript: `const res = await fetch("${full}", {\n  method: "${route.method}",\n  headers: { "X-API-Key": "YOUR_API_KEY"${bodyJson ? ', "Content-Type": "application/json"' : ''} },${bodyJson ? `\n  body: JSON.stringify(${bodyJson}),` : ''}\n});\nconst { code, message, data } = await res.json();`,
    Python: `import requests\n\nres = requests.${route.method.toLowerCase()}(\n    "${full}",\n    headers={"X-API-Key": "YOUR_API_KEY"},${pyBody ? `\n    json=${pyBody},` : ''}\n)\nprint(res.json()["data"])`,
  };
}

async function pageApi(name) {
  const cat = await loadCatalog();
  const m = cat.modules.find((x) => x.name === name);
  if (!m) return pageNotFound();
  const c = catOf(m.category);
  let active = 0;

  $('#main').innerHTML = `<div class="wrap">
    <div class="crumbs"><a href="#/">接口</a> / ${esc(c.title)} / ${esc(m.title)}</div>
    <div class="detail-head">
      <div class="cat-icon">${icon(c.icon)}</div>
      <div>
        <h1>${esc(m.title)}</h1>
        <div class="muted">${esc(m.description)}</div>
        <div class="row small" style="margin-top:8px">
          ${m.source ? `<span class="faint">数据来源：${esc(m.source)}</span>` : ''}${moduleBadges(m)}
        </div>
        ${m.env.length ? `<div class="small faint" style="margin-top:6px">环境变量：${m.env.map((e) => `<code>${esc(e.name)}</code>${e.optional ? '（可选）' : ''} ${e.configured ? '✓' : '未配置'}`).join('，')}</div>` : ''}
      </div>
    </div>
    <div class="detail">
      <div class="route-list" id="routes">${m.routes.map((r, i) => `
        <button data-i="${i}"><span class="s">${esc(r.summary)}</span><span class="p"><span class="method ${r.method}">${r.method}</span> ${esc(r.path)}</span></button>`).join('')}
      </div>
      <div id="route"></div>
    </div>
  </div>`;

  const drawRoute = () => {
    const r = m.routes[active];
    $$('#routes button').forEach((b) => b.classList.toggle('active', Number(b.dataset.i) === active));
    $('#route').innerHTML = `
      <div class="card card-pad">
        <h2 style="font-size:18px">${esc(r.summary)}</h2>
        <div class="endpoint"><span class="method ${r.method}">${r.method}</span><span class="url">${esc(location.origin + r.path)}</span>
          <button class="btn sm ghost" id="copy-url" title="复制">${icon('copy')}</button></div>
        <h3 class="sub-title">请求参数</h3>
        ${r.params.length ? `<div class="table-wrap"><table class="table params-table"><thead><tr><th>参数</th><th>位置</th><th>说明</th><th>默认值</th></tr></thead><tbody>
          ${r.params.map((p) => `<tr><td>${esc(p.name)}${p.required ? '<span class="req">*</span>' : ''}</td>
            <td class="faint small">${p.in === 'body' ? 'body' : r.path.includes(':' + p.name) ? 'path' : 'query'}</td>
            <td>${esc(p.desc)}</td><td class="faint">${p.default !== undefined ? `<code>${esc(p.default)}</code>` : '—'}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="faint small">无需参数</p>'}
        <h3 class="sub-title">返回字段</h3>
        ${r.raw
          ? `<p class="muted small">${esc(r.returns ?? '返回图片或跳转，而不是 JSON')}</p>`
          : `<p class="faint small" style="margin:0 0 8px">以下为 <code>data</code> 中的字段。外层统一为 <code>{ code, message, cached, stale, updatedAt, data }</code>，<a href="#/docs">查看说明</a>。</p>${fieldsTable(r.fields)}`}
      </div>

      <div class="playground">
        <div class="card card-pad">
          <div class="row" style="justify-content:space-between;margin-bottom:14px"><h3 style="font-size:15px">在线调试</h3>
            <span class="small faint">${state.user ? '计入你的账号额度' : `未登录：每天 ${fmtNum(cat.limits.anonDaily)} 次`}</span></div>
          <form id="try">
            ${r.params.map((p) => `<div class="field"><label for="p-${esc(p.name)}">${esc(p.name)}${p.required ? '<span class="req">*</span>' : ''} <span class="faint">${esc(p.desc)}</span></label>
              <input class="input mono" id="p-${esc(p.name)}" name="${esc(p.name)}" value="${esc(p.required ? p.example ?? '' : '')}" placeholder="${esc(placeholderOf(p))}"></div>`).join('')}
            <button class="btn primary" type="submit" style="width:100%">${icon('play')}发送请求</button>
          </form>
        </div>
        <div class="card response" id="resp">
          <div class="response-bar"><span class="faint">响应</span></div>
          <div class="empty">点击「发送请求」查看返回结果</div>
        </div>
      </div>

      <div class="card" style="margin-top:16px;overflow:hidden">
        <div class="tabs-bar"><div class="tabs" id="lang"></div><button class="btn sm ghost" id="copy-code">${icon('copy')}复制</button></div>
        <div class="code-block"><pre id="code"></pre></div>
      </div>`;

    let lang = storage.get('lang') || 'cURL';
    const drawCode = () => {
      const samples = codeSamples(r, buildRequest(r, Object.fromEntries(new FormData($('#try')))));
      if (!samples[lang]) lang = 'cURL';
      $('#lang').innerHTML = Object.keys(samples).map((k) => `<button class="${k === lang ? 'active' : ''}" data-l="${k}">${k}</button>`).join('');
      $('#code').textContent = samples[lang];
    };
    $('#lang').onclick = (e) => { const b = e.target.closest('[data-l]'); if (b) { lang = b.dataset.l; storage.set('lang', lang); drawCode(); } };
    $('#try').oninput = drawCode;
    $('#copy-code').onclick = () => copy($('#code').textContent);
    $('#copy-url').onclick = () => copy(location.origin + buildRequest(r, Object.fromEntries(new FormData($('#try')))).url);
    drawCode();

    bindForm($('#try'), async (values) => {
      const req = buildRequest(r, values);
      const resp = $('#resp');
      if (r.raw && r.method === 'GET') {
        const src = req.url + (req.url.includes('?') ? '&' : '?') + '_t=' + Date.now();
        resp.innerHTML = `<div class="response-bar"><span class="badge ok">图片/跳转</span><a class="small" href="${esc(req.url)}" target="_blank" rel="noopener">在新窗口打开 ${icon('external')}</a></div>
          <div class="preview"><img alt="响应预览" src="${esc(src)}"></div>`;
        $('img', resp).onerror = () => { $('.preview', resp).innerHTML = '<div class="empty">该响应不是图片（可能是跳转链接或错误），请在新窗口打开查看</div>'; };
        setTimeout(() => loadMe().then(() => renderTopbar('api')), 800);
        return;
      }
      resp.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
      const t0 = performance.now();
      const res = await fetch(req.url, {
        method: r.method,
        headers: req.body ? { 'content-type': 'application/json' } : {},
        body: req.body ? JSON.stringify(req.body) : undefined,
      });
      const ms = Math.round(performance.now() - t0);
      let body;
      try { body = await res.json(); } catch { body = { code: res.status, message: '非 JSON 响应' }; }
      const remaining = res.headers.get('x-ratelimit-remaining');
      resp.innerHTML = `<div class="response-bar">
          <span class="badge ${res.ok ? 'ok' : 'danger'}">${res.status}</span><span class="faint">${ms} ms</span>
          ${body.cached ? '<span class="badge">缓存</span>' : ''}${body.stale ? '<span class="badge warn">旧数据</span>' : ''}
          ${remaining != null ? `<span class="faint" style="margin-left:auto">今日剩余 ${fmtNum(remaining)}</span>` : ''}
        </div><pre>${highlightJson(body)}</pre>`;
      if (res.status === 429 && !state.user) {
        resp.insertAdjacentHTML('beforeend', '<div class="card-pad"><a class="btn primary" href="#/register">免费注册获取更多额度</a></div>');
      }
      await loadMe();
      renderTopbar('api');
    });
  };

  $('#routes').onclick = (e) => { const b = e.target.closest('[data-i]'); if (b) { active = Number(b.dataset.i); drawRoute(); } };
  drawRoute();
}

// ---------- 文档 ----------
async function pageDocs() {
  const cat = await loadCatalog();
  const L = cat.limits;
  const o = esc(location.origin);
  $('#main').innerHTML = `<div class="wrap"><article class="doc">
    <h1>开发文档</h1>
    <p>Miao API 聚合了 ${cat.modules.length} 个常用接口模块。所有接口都是 HTTP GET/POST，返回 JSON，支持跨域调用。</p>

    <h2>快速开始</h2>
    <p>无需注册即可直接调用：</p>
    <pre>curl ${o}/api/epic/free</pre>
    <p>注册后在 <a href="#/console/keys">控制台</a> 创建 API Key，通过请求头传入即可获得更高额度：</p>
    <pre>curl ${o}/api/epic/free -H "X-API-Key: ak_xxxxxxxx"</pre>

    <h2>认证方式</h2>
    <p>以下三种方式任选其一（推荐请求头，避免 Key 出现在日志里）：</p>
    <ul>
      <li>请求头 <code>X-API-Key: ak_xxx</code></li>
      <li>请求头 <code>Authorization: Bearer ak_xxx</code></li>
      <li>查询参数 <code>?key=ak_xxx</code></li>
    </ul>
    <p>Key 无效或已删除时返回 <code>401</code>。同一账号下所有 Key 共享额度。</p>

    <h2>调用额度</h2>
    <div class="table-wrap"><table class="table">
      <thead><tr><th>身份</th><th class="num">每天</th><th class="num">每分钟</th></tr></thead>
      <tbody>
        <tr><td>未登录（按 IP）</td><td class="num">${fmtNum(L.anonDaily)}</td><td class="num">${fmtNum(L.anonMinute)}</td></tr>
        <tr><td>注册用户（按账号）</td><td class="num">${fmtNum(L.userDaily)}</td><td class="num">${fmtNum(L.userMinute)}</td></tr>
      </tbody></table></div>
    <p>额度在北京时间 0 点重置。每个响应都带有以下响应头：</p>
    <ul>
      <li><code>X-RateLimit-Limit</code>：每日总额度</li>
      <li><code>X-RateLimit-Remaining</code>：今日剩余次数</li>
      <li><code>X-RateLimit-Reset</code>：距离重置的秒数</li>
    </ul>

    <h2>响应格式</h2>
    <p>所有 JSON 接口的外层结构相同，接口自身的数据放在 <code>data</code> 里，每个接口的 <code>data</code> 字段说明见接口详情页的「返回字段」。</p>
    ${fieldsTable(ENVELOPE_FIELDS)}
    <p>示例：</p>
    <pre>{
  "code": 200,          // 与 HTTP 状态码一致
  "message": "ok",
  "cached": true,       // 是否命中缓存
  "stale": false,       // 上游故障时返回的旧数据
  "updatedAt": "2026-09-24T12:00:00.000Z",
  "data": { ... }
}</pre>

    <h2>错误码</h2>
    <div class="table-wrap"><table class="table"><tbody>
      ${[['400', '参数错误'], ['401', 'API Key 无效'], ['404', '接口或数据不存在'], ['405', '请求方法不支持'], ['429', '超出调用额度或请求过快'],
        ['502', '上游服务返回错误'], ['503', '服务端未配置该接口所需的密钥'], ['504', '上游服务响应超时']]
        .map(([c, d]) => `<tr><td><code>${c}</code></td><td>${d}</td></tr>`).join('')}
    </tbody></table></div>

    <h2>订阅推送</h2>
    <p>在 <a href="#/console/notify">控制台 → 推送通知</a> 中添加推送渠道（Server酱、Bark、Telegram、钉钉、飞书、企业微信、自定义 Webhook、邮件），然后勾选想订阅的主题。内容更新时会自动推送。</p>
    <p>自定义 Webhook 会收到如下 POST 请求：</p>
    <pre>{ "topic": "epic-free", "title": "...", "text": "Markdown 正文", "url": "...", "sentAt": "..." }</pre>

    <h2>注意事项</h2>
    <ul>
      <li>标记为「非官方」的接口数据来自第三方网页或未公开接口，可能随上游改版暂时失效。</li>
      <li>标记为「需配置」的接口需要站长在服务端配置对应的第三方密钥后才能使用。</li>
    </ul>
  </article></div>`;
}

// ---------- 登录 / 注册 ----------
function pageAuth(mode) {
  if (state.user) { location.hash = '#/console'; return; }
  const reg = mode === 'register';
  const L = state.catalog?.limits;
  $('#main').innerHTML = `<div class="auth"><div class="card">
    <h1>${reg ? '创建账号' : '欢迎回来'}</h1>
    <p class="sub">${reg ? '注册后即可生成 API Key' : '登录以管理你的 API Key 和推送'}</p>
    ${reg && L ? `<ul class="perks">
      <li>${icon('check')}每天 ${fmtNum(L.userDaily)} 次调用额度（免登录仅 ${fmtNum(L.anonDaily)} 次）</li>
      <li>${icon('check')}多个 API Key，用量统计随时查看</li>
      <li>${icon('check')}订阅 Epic 周免等内容更新推送</li></ul>` : ''}
    <form id="auth">
      <div class="form-error" hidden></div>
      <div class="field"><label for="email">邮箱</label><input class="input" id="email" name="email" type="email" autocomplete="email" required></div>
      <div class="field"><label for="password">密码</label><input class="input" id="password" name="password" type="password" minlength="8" autocomplete="${reg ? 'new-password' : 'current-password'}" required>
        ${reg ? '<span class="hint">至少 8 位</span>' : ''}</div>
      <button class="btn primary lg" type="submit" style="width:100%">${reg ? '注册' : '登录'}</button>
    </form>
    <p class="small muted" style="text-align:center;margin:18px 0 0">${reg ? '已有账号？<a href="#/login">登录</a>' : '还没有账号？<a href="#/register">免费注册</a>'}</p>
  </div></div>`;
  bindForm($('#auth'), async (v) => {
    await api('POST', reg ? '/auth/register' : '/auth/login', { email: v.email, password: v.password });
    await loadMe();
    toast(reg ? '注册成功' : '登录成功');
    location.hash = reg ? '#/console/keys' : '#/console';
  });
}

// ---------- 图表 ----------
// series: [{ key, label, cls }]，按顺序堆叠；rows: [{ day, [key]: number }]
// 按容器实际宽度绘制（不拉伸文字），窗口尺寸变化时重绘
function barChart(rows, series) {
  const H = 200, padL = 36, padB = 22, padT = 8;
  const totals = rows.map((r) => series.reduce((s, x) => s + (r[x.key] || 0), 0));
  const max = Math.max(4, ...totals);
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const niceMax = Math.ceil(max / step) * step;
  const y = (v) => H - padB - (v / niceMax) * (H - padB - padT);
  const fmtTick = (t) => (t >= 1000 ? `${+(t / 1000).toFixed(1)}k` : +t.toFixed(1));

  function svg(W) {
    const bw = (W - padL) / rows.length;
    const barW = Math.max(4, Math.min(28, bw * 0.6));
    const labelEvery = bw < 34 ? 2 : 1;
    const cols = rows.map((r, i) => {
      const x = padL + i * bw + (bw - barW) / 2;
      let acc = 0;
      const segs = series.map((s) => {
        const v = r[s.key] || 0;
        if (!v) return '';
        const y0 = y(acc);
        acc += v;
        const top = acc === totals[i];
        // 堆叠段之间留 2px 间隙；只有最上面一段顶部圆角，底部贴基线
        const h = Math.max(1, y0 - y(acc) - (top ? 0 : 2));
        const rad = top ? Math.min(4, h, barW / 2) : 0;
        return `<path class="bar ${s.cls ?? ''}" d="M${x},${y0}V${y0 - h + rad}q0,-${rad} ${rad},-${rad}h${barW - 2 * rad}q${rad},0 ${rad},${rad}V${y0}z"/>`;
      }).join('');
      const label = (rows.length - 1 - i) % labelEvery === 0
        ? `<text class="axis" x="${x + barW / 2}" y="${H - 6}" text-anchor="middle">${r.day.slice(5).replace('-', '/')}</text>` : '';
      return `<g class="col" data-i="${i}"><rect class="hover-bg" x="${padL + i * bw}" y="${padT}" width="${bw}" height="${H - padB - padT}" rx="4"/>${segs}${label}
        <rect class="hit" x="${padL + i * bw}" y="0" width="${bw}" height="${H}"/></g>`;
    }).join('');
    const grid = [0, niceMax / 2, niceMax].map((t) => `<line class="gridline" x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/>
      <text class="axis" x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${fmtTick(t)}</text>`).join('');
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="近 ${rows.length} 天调用量柱状图">${grid}${cols}</svg>`;
  }

  const legend = series.length > 1
    ? `<div class="legend">${series.map((s) => `<span><i class="swatch ${s.cls ?? ''}"></i>${esc(s.label)}</span>`).join('')}</div>` : '';

  return {
    html: `${legend}<div class="chart"><div class="plot"></div><div class="tooltip" hidden></div></div>`,
    mount(root) {
      const chart = $('.chart', root);
      const plot = $('.plot', chart);
      const tip = $('.tooltip', chart);
      let lastW = 0;
      const draw = () => {
        const W = Math.floor(plot.clientWidth);
        if (!W || W === lastW) return;
        lastW = W;
        plot.innerHTML = svg(W);
      };
      draw();
      new ResizeObserver(draw).observe(plot);
      chart.addEventListener('mousemove', (e) => {
        const g = e.target.closest('g.col');
        if (!g) { tip.hidden = true; return; }
        const r = rows[Number(g.dataset.i)];
        tip.innerHTML = `<div class="t">${esc(r.day)}</div>` + series.map((s) =>
          `<div class="v">${series.length > 1 ? `<i class="swatch ${s.cls ?? ''}"></i>${esc(s.label)} ` : ''}<b>${fmtNum(r[s.key])}</b> 次</div>`).join('');
        tip.hidden = false;
        const box = chart.getBoundingClientRect();
        const left = Math.min(e.clientX - box.left + 12, box.width - tip.offsetWidth - 4);
        tip.style.left = `${Math.max(4, left)}px`;
        tip.style.top = `${e.clientY - box.top - tip.offsetHeight - 10}px`;
      });
      chart.addEventListener('mouseleave', () => { tip.hidden = true; });
    },
  };
}

function endpointsTable(rows) {
  if (!rows.length) return '<div class="empty">暂无调用记录</div>';
  return `<div class="table-wrap"><table class="table"><thead><tr><th>接口</th><th class="num">调用</th><th class="num">平均耗时</th><th class="num">失败率</th></tr></thead><tbody>
    ${rows.map((e) => `<tr><td class="mono">${esc(e.path)}</td><td class="num">${fmtNum(e.calls)}</td><td class="num">${fmtNum(e.avgMs)} ms</td>
      <td class="num">${e.calls ? ((e.errors / e.calls) * 100).toFixed(1) : 0}%</td></tr>`).join('')}
  </tbody></table></div>`;
}

// ---------- 控制台 ----------
const CONSOLE_TABS = [
  ['overview', '概览', 'chart'],
  ['keys', 'API Keys', 'key'],
  ['notify', '推送通知', 'bell'],
  ['settings', '账号设置', 'user'],
];

async function pageConsole(tab = 'overview') {
  if (!state.user) { location.hash = '#/login'; return; }
  loadMe().then(() => renderTopbar('console'));
  if (!CONSOLE_TABS.some(([id]) => id === tab)) tab = 'overview';
  $('#main').innerHTML = `<div class="wrap"><div class="console">
    <aside class="side"><div class="who">${esc(state.user.email)}</div>
      ${CONSOLE_TABS.map(([id, t, i]) => `<a href="#/console/${id}" class="${id === tab ? 'active' : ''}">${icon(i)}${t}</a>`).join('')}
    </aside>
    <section id="panel"><div class="loading"><span class="spinner"></span></div></section>
  </div></div>`;
  const panel = $('#panel');
  try {
    await { overview: consoleOverview, keys: consoleKeys, notify: consoleNotify, settings: consoleSettings }[tab](panel);
  } catch (err) {
    panel.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

async function consoleOverview(panel) {
  const u = await api('GET', '/account/usage');
  const q = u.quota;
  const pct = q.limit ? Math.min(100, (q.used / q.limit) * 100) : 0;
  const total14 = u.daily.reduce((s, d) => s + d.count, 0);
  const chart = barChart(u.daily, [{ key: 'count', label: '调用次数' }]);
  panel.innerHTML = `
    <div class="page-head"><div><h1>概览</h1><p>额度于北京时间 0 点重置</p></div><a class="btn" href="#/console/keys">${icon('key')}管理 API Key</a></div>
    <div class="tiles">
      <div class="card tile"><div class="label">今日已用</div><div class="value">${fmtNum(q.used)} <small>/ ${fmtNum(q.limit)}</small></div>
        <div class="meter"><i class="${pct > 80 ? 'hot' : ''}" style="width:${pct}%"></i></div></div>
      <div class="card tile"><div class="label">今日剩余</div><div class="value">${fmtNum(q.remaining)}</div></div>
      <div class="card tile"><div class="label">近 14 天调用</div><div class="value">${fmtNum(total14)}</div></div>
    </div>
    <div class="card" style="margin-bottom:16px"><div class="card-head"><h2>近 14 天调用量</h2></div>${chart.html}</div>
    <div class="grid-2">
      <div class="card"><h2 class="card-title">常用接口（近 7 天）</h2><div style="padding:8px 8px 8px">${endpointsTable(u.endpoints)}</div></div>
      <div class="card"><h2 class="card-title">最近调用</h2><div style="padding:8px">
        ${u.recent.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>时间</th><th>接口</th><th>Key</th><th class="num">状态</th></tr></thead><tbody>
          ${u.recent.map((r) => `<tr><td class="small faint nowrap">${fmtDate(r.ts)}</td><td class="mono">${esc(r.path)}</td><td class="small nowrap">${esc(r.keyName ?? '网页')}</td>
            <td class="num"><span class="badge ${r.status < 400 ? 'ok' : 'danger'}">${r.status}</span></td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">暂无调用记录</div>'}
      </div></div>
    </div>`;
  chart.mount(panel);
}

async function consoleKeys(panel) {
  const keys = await api('GET', '/account/keys');
  panel.innerHTML = `
    <div class="page-head"><div><h1>API Keys</h1><p>同一账号下的 Key 共享每日 ${fmtNum(state.user.dailyLimit)} 次额度</p></div>
      <button class="btn primary" id="new-key">${icon('key')}创建 Key</button></div>
    <div class="card">${keys.length ? `<div class="table-wrap"><table class="table">
      <thead><tr><th>名称</th><th>Key</th><th>创建时间</th><th>最近使用</th><th></th></tr></thead><tbody>
      ${keys.map((k) => `<tr><td>${esc(k.name)}</td><td class="mono">${esc(k.prefix)}••••••••</td><td class="small faint">${fmtDate(k.createdAt)}</td>
        <td class="small faint">${k.lastUsedAt ? fmtDate(k.lastUsedAt) : '从未'}</td>
        <td class="num"><button class="btn sm danger" data-del="${k.id}" data-name="${esc(k.name)}">删除</button></td></tr>`).join('')}
      </tbody></table></div>` : `<div class="empty">${icon('key')}<p>还没有 API Key，创建一个开始调用吧</p></div>`}</div>
    <div class="card card-pad" style="margin-top:16px">
      <h3 style="font-size:15px;margin-bottom:8px">使用方式</h3>
      <div class="code-block"><pre style="border-radius:10px">curl ${esc(location.origin)}/api/epic/free -H "X-API-Key: 你的 Key"</pre></div>
    </div>`;

  $('#new-key').onclick = () => modal(`
    <h2>创建 API Key</h2><p class="muted small">给 Key 起个名字，方便区分用途</p>
    <form id="kf"><div class="form-error" hidden></div>
      <div class="field"><label for="kn">名称</label><input class="input" id="kn" name="name" maxlength="40" placeholder="例如：我的博客"></div>
      <div class="actions"><button class="btn" type="button" data-close>取消</button><button class="btn primary" type="submit">创建</button></div>
    </form>`, (root, close) => {
    $('[data-close]', root).onclick = close;
    bindForm($('#kf', root), async (v) => {
      const k = await api('POST', '/account/keys', { name: v.name });
      $('.modal', root).innerHTML = `<h2>Key 已创建</h2>
        <p class="muted small">请立即复制并妥善保存，关闭后将<b>无法再次查看</b>完整 Key。</p>
        <div class="key-box"><span>${esc(k.key)}</span><button class="btn sm" data-copy>${icon('copy')}复制</button></div>
        <div class="actions"><button class="btn primary" data-done>我已保存</button></div>`;
      $('[data-copy]', root).onclick = () => copy(k.key);
      $('[data-done]', root).onclick = () => { close(); consoleKeys(panel); };
    });
  });

  panel.onclick = async (e) => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    if (!(await confirmDialog('删除 Key', `确定删除「${b.dataset.name}」？使用该 Key 的程序将立即无法调用。`, { okText: '删除' }))) return;
    try {
      await api('DELETE', `/account/keys/${b.dataset.del}`, {});
      toast('已删除');
      consoleKeys(panel);
    } catch (err) { toast(err.message, true); }
  };
}

async function consoleNotify(panel) {
  const n = await api('GET', '/account/notify');
  const typeOf = (id) => n.types.find((t) => t.id === id);
  const subscribed = (topic, ch) => n.subscriptions.some((s) => s.topic === topic && s.channelId === ch);

  panel.innerHTML = `
    <div class="page-head"><div><h1>推送通知</h1><p>添加推送渠道后，订阅感兴趣的主题，内容更新时自动推送</p></div>
      <button class="btn primary" id="add-ch">${icon('bell')}添加渠道</button></div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h2>推送渠道</h2><span class="small faint">${n.channels.length} 个</span></div>
      ${n.channels.length ? `<div class="channel-list">${n.channels.map((c) => `
        <div class="channel"><div class="cat-icon">${icon('bell')}</div>
          <div class="meta"><b>${esc(c.name)}</b> <span class="badge">${esc(typeOf(c.type)?.title ?? c.type)}</span>
            <div class="mono">${esc(Object.values(c.config).join(' · '))}</div></div>
          <button class="btn sm" data-test="${c.id}">发送测试</button>
          <button class="btn sm danger" data-del="${c.id}" data-name="${esc(c.name)}">删除</button>
        </div>`).join('')}</div>` : '<div class="empty">还没有推送渠道</div>'}
    </div>

    <div class="card">
      <div class="card-head"><h2>订阅主题</h2></div>
      ${n.channels.length ? `<div class="table-wrap" style="padding:8px"><table class="table">
        <thead><tr><th>主题</th>${n.channels.map((c) => `<th style="text-align:center">${esc(c.name)}</th>`).join('')}<th></th></tr></thead>
        <tbody>${n.topics.map((t) => `<tr><td><b>${esc(t.title)}</b><div class="small faint">${esc(t.desc)}</div></td>
          ${n.channels.map((c) => `<td style="text-align:center"><label class="switch" title="${esc(t.title)} → ${esc(c.name)}">
            <input type="checkbox" data-topic="${t.id}" data-ch="${c.id}" ${subscribed(t.id, c.id) ? 'checked' : ''}><span></span></label></td>`).join('')}
          <td class="num"><button class="btn sm" data-push="${t.id}">立即推送</button></td></tr>`).join('')}</tbody>
      </table></div>` : '<div class="empty">先添加一个推送渠道</div>'}
    </div>`;

  $('#add-ch').onclick = () => {
    const opts = n.types.map((t) => `<option value="${t.id}" ${t.available ? '' : 'disabled'}>${esc(t.title)}${t.available ? '' : '（未开放）'}</option>`).join('');
    modal(`<h2>添加推送渠道</h2>
      <form id="cf"><div class="form-error" hidden></div>
        <div class="field"><label for="ct">渠道类型</label><select class="input" id="ct" name="type">${opts}</select></div>
        <div class="field"><label for="cn">名称</label><input class="input" id="cn" name="name" maxlength="40" placeholder="例如：我的微信"></div>
        <div id="cfields"></div>
        <div class="actions"><button class="btn" type="button" data-close>取消</button><button class="btn primary" type="submit">保存</button></div>
      </form>`, (root, close) => {
      const drawFields = () => {
        const t = typeOf($('#ct', root).value);
        $('#cfields', root).innerHTML = t.fields.map((f) => `<div class="field"><label for="f-${f.name}">${esc(f.label)}</label>
          <input class="input mono" id="f-${f.name}" name="cfg.${f.name}" placeholder="${esc(f.placeholder ?? '')}" ${f.required ? 'required' : ''}></div>`).join('');
      };
      $('#ct', root).onchange = drawFields;
      drawFields();
      $('[data-close]', root).onclick = close;
      bindForm($('#cf', root), async (v) => {
        const config = {};
        for (const [k, val] of Object.entries(v)) if (k.startsWith('cfg.') && val) config[k.slice(4)] = val.trim();
        await api('POST', '/account/channels', { type: v.type, name: v.name, config });
        close();
        toast('渠道已添加，可以发送测试消息确认');
        consoleNotify(panel);
      });
    });
  };

  panel.onclick = async (e) => {
    const test = e.target.closest('[data-test]');
    const del = e.target.closest('[data-del]');
    const push = e.target.closest('[data-push]');
    try {
      if (test) {
        test.disabled = true;
        await api('POST', `/account/channels/${test.dataset.test}/test`, {}).finally(() => { test.disabled = false; });
        toast('测试消息已发送');
      } else if (del) {
        if (!(await confirmDialog('删除渠道', `确定删除「${del.dataset.name}」？相关订阅也会一并删除。`, { okText: '删除' }))) return;
        await api('DELETE', `/account/channels/${del.dataset.del}`, {});
        consoleNotify(panel);
      } else if (push) {
        const targets = n.subscriptions.filter((s) => s.topic === push.dataset.push);
        if (!targets.length) return toast('请先为该主题开启至少一个渠道', true);
        push.disabled = true;
        await Promise.all(targets.map((s) => api('POST', '/account/subscriptions/push', { topic: s.topic, channelId: s.channelId })))
          .finally(() => { push.disabled = false; });
        toast('已推送当前内容');
      }
    } catch (err) { toast(err.message, true); }
  };

  panel.onchange = async (e) => {
    const cb = e.target.closest('input[data-topic]');
    if (!cb) return;
    try {
      await api('PUT', '/account/subscriptions', { topic: cb.dataset.topic, channelId: Number(cb.dataset.ch), enabled: cb.checked });
      const i = n.subscriptions.findIndex((s) => s.topic === cb.dataset.topic && s.channelId === Number(cb.dataset.ch));
      if (cb.checked && i < 0) n.subscriptions.push({ topic: cb.dataset.topic, channelId: Number(cb.dataset.ch) });
      if (!cb.checked && i >= 0) n.subscriptions.splice(i, 1);
      toast(cb.checked ? '已订阅' : '已取消订阅');
    } catch (err) {
      cb.checked = !cb.checked;
      toast(err.message, true);
    }
  };
}

async function consoleSettings(panel) {
  panel.innerHTML = `
    <div class="page-head"><div><h1>账号设置</h1><p>${esc(state.user.email)} · 注册于 ${fmtDate(state.user.createdAt)}</p></div></div>
    <div class="card card-pad" style="max-width:520px;margin-bottom:16px">
      <h3 style="font-size:15px;margin-bottom:14px">修改密码</h3>
      <form id="pw"><div class="form-error" hidden></div>
        <div class="field"><label for="cur">当前密码</label><input class="input" id="cur" name="current" type="password" autocomplete="current-password" required></div>
        <div class="field"><label for="nw">新密码</label><input class="input" id="nw" name="next" type="password" minlength="8" autocomplete="new-password" required><span class="hint">修改后其他设备将退出登录</span></div>
        <button class="btn primary" type="submit">保存</button>
      </form>
    </div>
    <div class="card card-pad" style="max-width:520px">
      <h3 style="font-size:15px;margin-bottom:6px;color:var(--danger)">注销账号</h3>
      <p class="small muted" style="margin:0 0 14px">将永久删除账号、全部 API Key 与推送配置，无法恢复。</p>
      <form id="del"><div class="form-error" hidden></div>
        <div class="field"><label for="dp">输入密码确认</label><input class="input" id="dp" name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn danger" type="submit">注销账号</button>
      </form>
    </div>`;
  bindForm($('#pw'), async (v) => {
    await api('POST', '/account/password', v);
    $('#pw').reset();
    toast('密码已修改');
  });
  bindForm($('#del'), async (v) => {
    if (!(await confirmDialog('注销账号', '此操作不可撤销，确定继续？', { okText: '永久注销' }))) return;
    await api('DELETE', '/account', v);
    await loadMe();
    location.hash = '#/';
    toast('账号已注销');
  });
}

// ---------- 管理后台 ----------
async function pageAdmin() {
  if (!state.user?.isAdmin) return pageNotFound();
  $('#main').innerHTML = '<div class="wrap"><div class="loading"><span class="spinner"></span></div></div>';
  const [s, users] = await Promise.all([api('GET', '/admin/stats'), api('GET', '/admin/users')]);
  const t = s.totals;
  const rows = s.daily.map((d) => ({ day: d.day, user: d.count - d.anon, anon: d.anon }));
  const chart = barChart(rows, [{ key: 'user', label: '注册用户' }, { key: 'anon', label: '未登录', cls: 's2' }]);
  $('#main').innerHTML = `<div class="wrap" style="padding:28px 20px 80px">
    <div class="page-head"><div><h1>管理后台</h1><p>全站调用统计与用户管理</p></div></div>
    <div class="tiles">
      ${[['24h 调用', t.calls], ['24h 独立 IP', t.ips], ['24h 平均耗时', `${fmtNum(t.avgMs)} ms`], ['24h 失败', t.errors],
        ['注册用户', t.users], ['API Key', t.keys], ['推送渠道', t.channels], ['订阅', t.subscriptions]]
        .map(([l, v]) => `<div class="card tile"><div class="label">${l}</div><div class="value">${typeof v === 'number' ? fmtNum(v) : esc(v ?? 0)}</div></div>`).join('')}
    </div>
    <div class="card" style="margin-bottom:16px"><div class="card-head"><h2>近 14 天调用量</h2></div><div style="height:10px"></div>${chart.html}</div>
    <div class="grid-2" style="margin-bottom:16px">
      <div class="card"><h2 class="card-title">热门接口（近 7 天）</h2><div style="padding:8px">${endpointsTable(s.endpoints)}</div></div>
      <div class="card"><h2 class="card-title">24h 服务端错误</h2><div style="padding:8px">
        ${s.errors.length ? `<table class="table"><thead><tr><th>接口</th><th>状态</th><th class="num">次数</th></tr></thead><tbody>
          ${s.errors.map((e) => `<tr><td class="mono">${esc(e.path)}</td><td><span class="badge danger">${e.status}</span></td><td class="num">${fmtNum(e.n)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">一切正常</div>'}</div></div>
    </div>
    <div class="card"><div class="card-head"><h2>用户</h2><span class="small faint">额度留空表示使用默认值</span></div><div class="table-wrap" style="padding:8px">
      <table class="table"><thead><tr><th>邮箱</th><th>注册时间</th><th class="num">Key</th><th class="num">今日调用</th><th>每日额度</th><th>状态</th></tr></thead><tbody>
      ${users.map((u) => `<tr><td>${esc(u.email)} ${u.isAdmin ? '<span class="badge brand">管理员</span>' : ''}</td>
        <td class="small faint">${fmtDate(u.createdAt)}</td><td class="num">${u.keys}</td><td class="num">${fmtNum(u.usedToday)}</td>
        <td><form class="row" data-limit="${u.id}"><input class="input" style="width:120px;height:30px" name="limit" inputmode="numeric" value="${u.customLimit ?? ''}" placeholder="${fmtNum(u.dailyLimit)}"><button class="btn sm">保存</button></form></td>
        <td>${u.id === state.user.id ? '<span class="faint small">—</span>' : `<button class="btn sm ${u.disabled ? '' : 'danger'}" data-toggle="${u.id}" data-disabled="${u.disabled ? 1 : 0}">${u.disabled ? '启用' : '停用'}</button>`}</td></tr>`).join('')}
      </tbody></table></div></div>
  </div>`;
  chart.mount($('#main'));

  $('#main').addEventListener('submit', async (e) => {
    const f = e.target.closest('[data-limit]');
    if (!f) return;
    e.preventDefault();
    const raw = new FormData(f).get('limit').trim();
    try {
      await api('PATCH', `/admin/users/${f.dataset.limit}`, { dailyLimit: raw === '' ? null : Number(raw) });
      toast('额度已更新');
    } catch (err) { toast(err.message, true); }
  });
  $('#main').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-toggle]');
    if (!b) return;
    const disable = b.dataset.disabled === '0';
    if (disable && !(await confirmDialog('停用用户', '停用后该用户将无法登录，其 API Key 也将失效。', { okText: '停用' }))) return;
    try {
      await api('PATCH', `/admin/users/${b.dataset.toggle}`, { disabled: disable });
      pageAdmin();
    } catch (err) { toast(err.message, true); }
  });
}

function pageNotFound() {
  $('#main').innerHTML = '<div class="wrap"><div class="empty" style="padding:120px 0"><h1 style="font-size:48px;margin-bottom:8px">404</h1><p>页面不存在，<a href="#/">返回首页</a></p></div></div>';
}

// ---------- 路由 ----------
async function router() {
  const hash = location.hash.replace(/^#\/?/, '');
  if (hash === 'catalog') return;
  const [page, arg] = hash.split('/');
  const routeName = { '': 'home', api: 'api', docs: 'docs', login: 'auth', register: 'auth', console: 'console', admin: 'admin' }[page] ?? 'none';
  renderTopbar(routeName);
  window.scrollTo(0, 0);
  try {
    await loadCatalog();
    switch (page) {
      case '': await pageHome(); break;
      case 'api': await pageApi(decodeURIComponent(arg ?? '')); break;
      case 'docs': await pageDocs(); break;
      case 'login': case 'register': pageAuth(page); break;
      case 'console': await pageConsole(arg); break;
      case 'admin': await pageAdmin(); break;
      default: pageNotFound();
    }
  } catch (err) {
    $('#main').innerHTML = `<div class="wrap"><div class="empty" style="padding:100px 0">加载失败：${esc(err.message)}</div></div>`;
  }
  document.title = { home: 'Miao API', api: 'Miao API · 接口', docs: 'Miao API · 文档', auth: 'Miao API · 登录', console: 'Miao API · 控制台', admin: 'Miao API · 管理' }[routeName] ?? 'Miao API';
}

window.addEventListener('hashchange', router);
loadMe().then(router);

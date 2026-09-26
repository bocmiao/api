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
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13v1M15 13v1M9.5 17h5"/><circle cx="12" cy="3.5" r="1"/>',
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
  if (method !== 'GET') pageCache.clear(); // 改动过数据后，页面缓存全部作废
  return json.data;
}

// ---------- 页面数据缓存 ----------
// 切换页面时先用上次的数据立即显示，同时在后台取最新数据；数据有变化且用户还没开始操作时再刷新一次页面
const pageCache = new Map();
let navToken = 0;

async function cachedGet(path) {
  const hit = pageCache.get(path);
  const token = navToken;
  const load = () => api('GET', path).then((data) => {
    pageCache.set(path, { data, at: Date.now(), json: JSON.stringify(data) });
    return data;
  });
  if (!hit) return load();
  if (Date.now() - hit.at > 2000) {
    const started = Date.now();
    load().then(() => {
      const busy = document.querySelector('#main :focus, .modal-back');
      if (token === navToken && !busy && Date.now() - started < 4000 && pageCache.get(path)?.json !== hit.json) router({ keepScroll: true });
    }).catch(() => {});
  }
  return hit.data;
}

// 空闲时预先取好导航栏各页面的数据，第一次点进去也不用等
function prefetchPages() {
  const paths = [];
  if (state.user?.isAdmin) paths.push('/admin/stats', '/admin/users?q=&page=1&size=20', '/admin/changelog', '/admin/settings');
  if (state.user) paths.push('/account/usage', '/account/keys', '/account/notify');
  paths.push('/status');
  let i = 0;
  const next = () => {
    const p = paths[i++];
    if (!p) return;
    (pageCache.has(p) ? Promise.resolve() : api('GET', p).then((data) => pageCache.set(p, { data, at: Date.now(), json: JSON.stringify(data) })))
      .catch(() => {}).finally(() => setTimeout(next, 150));
  };
  next();
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
    // 管理后台的「概览 / 用户 / 更新记录 / 系统设置」在页面右上角切换，导航栏只放一个入口
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
  const before = state.user?.id ?? null;
  try {
    const { user, quota } = await api('GET', '/auth/me');
    state.user = user;
    state.quota = quota;
  } catch {
    state.user = null;
  }
  // 登录身份变化后重新加载接口目录（管理员可见已关闭的接口）
  if ((state.user?.id ?? null) !== before) {
    state.catalog = null;
    pageCache.clear();
    prefetched = false;
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
    m.enabled === false ? '<span class="badge danger" title="已被管理员关闭，仅管理员可见和调用">已关闭</span>' : '',
    m.unofficial ? '<span class="badge warn" title="数据来自非官方接口或网页，可能随上游改版失效">非官方</span>' : '',
    !m.available ? '<span class="badge danger" title="服务端未配置所需的密钥">需配置</span>' : '',
    m.env.some((e) => e.optional) && m.available ? '<span class="badge" title="可选配置密钥以增强功能">可选 Key</span>' : '',
  ].join('');
}

// 接口卡片上的运行状态和调用量：1 万以上用「万」「亿」
const fmtCompact = (n) => (n >= 1e8 ? `${+(n / 1e8).toFixed(1)}亿` : n >= 1e4 ? `${+(n / 1e4).toFixed(1)}万` : fmtNum(n));
const HEALTH = { ok: ['正常', 'ok'], degraded: ['不稳定', 'warn'], down: ['异常', 'danger'], idle: ['正常', 'idle'] };
let cardStats = null;
function statsLine(name) {
  const st = cardStats?.data?.[name];
  if (!st) return '';
  const [label, cls] = HEALTH[st.status] ?? HEALTH.idle;
  return `<div class="card-stats" title="运行状态按最近 24 小时的调用统计；累计为上线以来的调用次数">
    <span class="status-dot ${cls}"></span><span>${label}</span>
    <span class="faint">累计 <b>${fmtCompact(st.total)}</b></span><span class="faint">今日 <b>${fmtCompact(st.today)}</b></span></div>`;
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
        <h1>一个 Key<br>调用 <em>${cat.modules.length}</em> 个常用接口</h1>
        <p class="lead">游戏限免、全网热榜、天气节假日、汇率行情、趣味娱乐、开发工具、网络检测……统一格式、自带缓存与容错，内容更新还能推送到微信、钉钉、飞书、Telegram。</p>
        <div class="row">
          <a class="btn primary lg" href="#catalog" id="browse">浏览接口</a>
          ${state.user ? '<a class="btn lg" href="#/console/keys">获取 API Key</a>' : '<a class="btn lg" href="#/register">免费注册</a>'}
        </div>
        <div class="hero-stats">
          <div title="部分接口包含多个调用地址，例如 Steam 限免与特惠"><b>${routeCount}</b><span>个调用地址</span></div>
          <div><b>${fmtNum(cat.limits.anonDaily)}</b><span>次/天 免登录调用</span></div>
          <div><b>${fmtNum(cat.limits.userDaily)}</b><span>次/天 注册用户</span></div>
        </div>
      </div>
      <div class="code-window"><div class="bar"><i></i><i></i><i></i></div><pre>${sample}</pre></div>
    </section>

    <section class="section" id="today" style="padding-top:8px">
      <div class="section-title"><h2>今日</h2><span class="small faint" id="today-note"></span></div>
      <div class="today-grid" id="today-grid"><div class="loading" style="grid-column:1/-1"><span class="spinner"></span></div></div>
    </section>

    <section class="section" id="catalog">
      <div class="section-title">
        <h2>全部接口</h2>
        <label class="search">${icon('search')}<input class="input" id="q" placeholder="搜索接口，如 天气、热搜、汇率（Ctrl+K）" autocomplete="off"></label>
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
        ${statsLine(m.name)}
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
  loadToday();
  draw();
  // 调用量缓存 1 分钟；取到后重画一次卡片
  if (!cardStats || Date.now() - cardStats.at > 60_000) {
    api('GET', '/stats/modules').then((data) => {
      cardStats = { at: Date.now(), data };
      if ($('#grid')) draw();
    }).catch(() => {});
  }
}

// ---------- 首页「今日」 ----------
function countdown(iso) {
  const ms = new Date(iso) - Date.now();
  if (!(ms > 0)) return '已结束';
  const d = Math.floor(ms / 86400_000);
  const h = Math.floor((ms % 86400_000) / 3600_000);
  return d ? `还剩 ${d} 天 ${h} 小时` : `还剩 ${h} 小时`;
}

// 上次的数据存在浏览器里：再次打开首页时先立即显示，同时在后台取最新数据替换
const TODAY_CACHE = 'todayCache.v1';
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* 隐私模式 */ } };

async function loadToday() {
  if (!$('#today-grid')) return;
  const city = lsGet('todayCity') || '';
  let cached = null;
  try { cached = JSON.parse(lsGet(TODAY_CACHE) || 'null'); } catch { /* 数据损坏 */ }
  let shared = cached?.shared ?? null;
  // undefined 表示天气还在加载；换了城市时不用旧天气
  let weather = cached && cached.city === city ? cached.weather : undefined;
  const draw = () => { if (shared && $('#today-grid')) renderToday({ ...shared, weather }, city); };
  const save = () => lsSet(TODAY_CACHE, JSON.stringify({ shared, weather, city }));
  draw();

  const qs = city ? `?city=${encodeURIComponent(city)}` : '';
  await Promise.all([
    api('GET', '/home/today').then((d) => { shared = d; draw(); save(); })
      .catch(() => { if (!shared) $('#today')?.remove(); }),
    api('GET', `/home/weather${qs}`).then((d) => { weather = d; draw(); if (shared) save(); })
      .catch(() => { if (weather === undefined) { weather = null; draw(); } }),
  ]);
}

function renderToday(t, savedCity) {
  const grid = $('#today-grid');
  const card = (api, title, inner, cls = '') => `<a class="card today-card ${cls}" href="#/api/${api}"><div class="today-title">${title}</div>${inner}</a>`;
  const cards = [];

  if (t.greeting) {
    cards.push(card('greeting', `${esc(t.greeting.date ?? '')} ${esc(t.greeting.weekday ?? '')}`, `
      <div class="today-big">${esc(t.greeting.greeting)}</div><div class="muted small">${esc(t.greeting.tip ?? '')}</div>`));
  }
  if (t.epic?.current?.length) {
    cards.push(card('epic', 'Epic 本周免费', t.epic.current.slice(0, 3).map((g) => `
      <div class="today-game">${g.image?.wide ? `<img src="${esc(g.image.wide)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
        <div><b>${esc(g.title)}</b><div class="small faint">${countdown(g.endDate)}${g.originalPrice ? ` · 原价 ${esc(g.originalPrice)}` : ''}</div></div></div>`).join(''), 'wide'));
  }
  if (t.holiday) {
    const h = t.holiday;
    cards.push(card('holiday', '节假日', h.current
      ? `<div class="today-big">${esc(h.current.name)}假期中</div><div class="muted small">放假第 ${h.current.dayIndex ?? ''} 天，共 ${h.current.days} 天</div>`
      : h.next ? `<div class="today-big">${esc(h.next.name)}</div><div class="muted small">还有 <b>${h.next.daysUntil}</b> 天 · ${esc(h.next.start)} 起放 ${h.next.days} 天</div>`
        : '<div class="muted">暂无放假安排</div>'));
  }
  if (t.weather === undefined) {
    cards.push(card('weather', '天气', '<div class="today-big faint">加载中…</div>'));
  } else if (t.weather?.current) {
    const w = t.weather;
    const how = { chosen: '已选城市', ip: '按 IP 定位', default: '默认城市' }[w.located] ?? '';
    cards.push(card('weather', `${esc(w.location?.name ?? '')} 天气${how ? ` · ${how}` : ''}<button class="today-city" type="button" data-city>切换城市</button>`, `
      <div class="today-big">${Math.round(w.current.temp)}°C <span class="today-sub">${esc(w.current.weather ?? '')}</span></div>
      <div class="muted small">体感 ${Math.round(w.current.feelsLike)}°C · 湿度 ${w.current.humidity}%${w.daily?.[0] ? ` · ${Math.round(w.daily[0].tempMin)}~${Math.round(w.daily[0].tempMax)}°C` : ''}</div>`));
  }
  if (t.fx?.rates) {
    const names = { CNY: '人民币', EUR: '欧元', JPY: '日元', HKD: '港币', GBP: '英镑' };
    cards.push(card('fx', '汇率（1 美元）', `<div class="today-fx">${Object.entries(t.fx.rates).map(([k, v]) =>
      `<span><span class="faint">${names[k] ?? k}</span> <b>${Number(v).toFixed(k === 'JPY' ? 2 : 4)}</b></span>`).join('')}</div>`));
  }
  if (t.hot?.items?.length) {
    cards.push(card('hot-weibo', '微博热搜', `<ol class="today-hot">${t.hot.items.slice(0, 10).map((i) => `<li>${esc(i.title)}</li>`).join('')}</ol>`, 'tall'));
  }
  if (t.hitokoto?.hitokoto) {
    cards.push(card('hitokoto', '一言', `<div class="today-quote">「${esc(t.hitokoto.hitokoto)}」</div>
      <div class="small faint">—— ${esc([t.hitokoto.fromWho, t.hitokoto.from].filter(Boolean).join('《') + (t.hitokoto.fromWho && t.hitokoto.from ? '》' : ''))}</div>`));
  }
  const bing = Array.isArray(t.bing) ? t.bing[0] : null;
  if (bing?.url) {
    cards.push(`<a class="card today-card today-bing wide" href="#/api/bing" style="background-image:url('${esc(bing.url1080 ?? bing.url)}')">
      <div class="today-bing-text"><div class="today-title">必应今日壁纸</div><b>${esc(bing.title ?? '')}</b><div class="small">${esc(bing.description ?? '')}</div></div></a>`);
  }
  // 补位卡片：历史上的今天，取不到时换成金价，保证网格没有空位
  const events = t.history?.events?.filter((e) => e.type === 'event' && e.year) ?? [];
  const gold = t.metals?.international?.find((m) => m.metal === 'gold' && m.price != null);
  if (events.length) {
    const picks = events.slice(-3).reverse();
    cards.push(card('history', '历史上的今天', `<ul class="today-events">${picks.map((e) => `<li><span class="faint">${esc(e.year)}</span> ${esc(e.title)}</li>`).join('')}</ul>`));
  } else if (gold) {
    const up = (gold.changePercent ?? 0) >= 0;
    cards.push(card('metals', '国际金价', `<div class="today-big">$${gold.price.toFixed(2)} <span class="today-sub">/ 盎司</span></div>
      <div class="small ${up ? 'up' : 'down'}">${gold.changePercent != null ? `${up ? '+' : ''}${gold.changePercent}%` : ''}</div>`));
  }
  grid.innerHTML = cards.join('') || '<div class="empty" style="grid-column:1/-1">数据暂时获取不到</div>';
  $('[data-city]', grid)?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const city = prompt('输入城市或区县名称（例如：汝阳、洛阳）。留空恢复按 IP 自动定位。', savedCity);
    if (city === null) return;
    lsSet('todayCity', city.trim() || null);
    loadToday();
  });
  $('#today-note').textContent = '实时数据，每 5 分钟更新 · 点卡片查看对应接口';
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

// 带中文字段注释的 JSON：外层字段用通用说明，data 内按接口的 fields 匹配；数组只注释第一项
const fieldRegex = (name) => new RegExp(`^${name.split('*').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^.\\[\\]]+')}$`);
function commentedJson(body, fields = []) {
  const env = new Map(ENVELOPE_FIELDS.map((f) => [f.name, f.desc]));
  const pats = fields.map((f) => [fieldRegex(f.name), f.desc]);
  const descOf = (path) => pats.find(([re]) => re.test(path))?.[1];
  const short = (d) => { const t = d.split(/[；。]/)[0]; return t.length > 40 ? `${t.slice(0, 40)}…` : t; };
  const cmt = (d) => (d ? ` <span class="j-cmt" title="${esc(d)}">// ${esc(short(d))}</span>` : '');
  const prim = (v) => v === null ? '<span class="j-null">null</span>'
    : typeof v === 'string' ? `<span class="j-str">${esc(JSON.stringify(v))}</span>`
    : typeof v === 'number' ? `<span class="j-num">${v}</span>`
    : typeof v === 'boolean' ? `<span class="j-bool">${v}</span>` : esc(JSON.stringify(v));
  const lines = [];
  const emit = (v, path, depth, label, comma, d, annotate) => {
    const ind = '  '.repeat(depth);
    const c = annotate ? cmt(d) : '';
    if (Array.isArray(v)) {
      if (!v.length) return lines.push(`${ind}${label}[]${comma}${c}`);
      lines.push(`${ind}${label}[${c}`);
      v.forEach((item, i) => emit(item, `${path}[]`, depth + 1, '', i < v.length - 1 ? ',' : '', null, annotate && i === 0));
      return lines.push(`${ind}]${comma}`);
    }
    if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      if (!keys.length) return lines.push(`${ind}${label}{}${comma}${c}`);
      lines.push(`${ind}${label}{${c}`);
      keys.forEach((k, i) => {
        const p = path ? `${path}.${k}` : k;
        emit(v[k], p, depth + 1, `<span class="j-key">${esc(JSON.stringify(k))}</span>: `, i < keys.length - 1 ? ',' : '', descOf(p), annotate);
      });
      return lines.push(`${ind}}${comma}`);
    }
    lines.push(`${ind}${label}${prim(v)}${comma}${c}`);
  };
  if (!body || typeof body !== 'object') return highlightJson(body);
  lines.push('{');
  const keys = Object.keys(body);
  keys.forEach((k, i) => {
    const label = `<span class="j-key">${esc(JSON.stringify(k))}</span>: `;
    const comma = i < keys.length - 1 ? ',' : '';
    if (k === 'data' && body.data && typeof body.data === 'object') {
      lines.push(`  ${label}${Array.isArray(body.data) ? '[' : '{'}${cmt(env.get('data'))}`);
      if (Array.isArray(body.data)) body.data.forEach((item, j) => emit(item, '[]', 2, '', j < body.data.length - 1 ? ',' : '', null, j === 0));
      else Object.keys(body.data).forEach((dk, j, arr) => emit(body.data[dk], dk, 2, `<span class="j-key">${esc(JSON.stringify(dk))}</span>: `, j < arr.length - 1 ? ',' : '', descOf(dk), true));
      lines.push(`  ${Array.isArray(body.data) ? ']' : '}'}${comma}`);
    } else {
      emit(body[k], null, 1, label, comma, env.get(k), true);
    }
  });
  lines.push('}');
  return lines.join('\n');
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
    '网页前端': route.raw && route.method === 'GET'
      ? `<!-- 直接当图片地址使用，无需 Key -->\n<img src="${full}" alt="">`
      : `// 在网页 / 博客主题里由访客浏览器直接调用：不要带 API Key（前端代码所有人可见）\n// 免 Key 调用按每个访客的 IP 计算额度（每天 ${fmtNum(state.catalog?.limits?.anonDaily ?? 100)} 次），接口已支持跨域\nfetch("${full}"${route.method !== 'GET' ? `, {\n  method: "${route.method}",\n  headers: { "Content-Type": "application/json" },\n  body: JSON.stringify(${bodyJson ?? '{}'}),\n}` : ''})\n  .then((r) => r.json())\n  .then(({ code, message, data }) => {\n    if (code !== 200) return console.warn(message);\n    console.log(data); // 在这里把数据渲染到页面\n  });`,
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
        ${m.env.length ? `<div class="small faint" style="margin-top:6px">配置项：${m.env.map((e) => `<code>${esc(e.name)}</code>${e.optional ? '（可选）' : ''} ${e.configured ? '✓' : '未配置'}`).join('，')}
          ${state.user?.isAdmin ? ` · <a href="#/admin/settings/keys/${m.env.map((e) => e.name).join(',')}">去后台配置</a>` : ''}</div>` : ''}
      </div>
    </div>
    ${!m.available && state.user?.isAdmin ? `<div class="notice" style="margin-bottom:16px">该接口需要配置第三方密钥后才能使用。<a class="btn sm primary" href="#/admin/settings/keys/${m.env.map((e) => e.name).join(',')}">去后台配置</a></div>` : ''}
    ${m.enabled === false ? '<div class="form-error" style="margin-bottom:16px">该接口已被管理员关闭：所有人（包括管理员）调用都会返回 403。可在「管理 → 接口开关」中重新开启。</div>' : ''}
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
          <label class="small faint cmt-toggle" title="在每个字段后面显示中文说明"><input type="checkbox" id="cmt-on" ${storage.get('cmt') !== '0' ? 'checked' : ''}> 字段注释</label>
        </div><pre id="resp-json"></pre>`;
      const drawJson = () => {
        const on = $('#cmt-on').checked;
        storage.set('cmt', on ? '1' : '0');
        $('#resp-json').innerHTML = on ? commentedJson(body, r.fields) : highlightJson(body);
      };
      $('#cmt-on').onchange = drawJson;
      drawJson();
      // 返回里带 data:image 图片（如验证码）时直接预览
      const inlineImage = body?.data && typeof body.data === 'object'
        ? Object.values(body.data).find((v) => typeof v === 'string' && /^data:image\/(svg\+xml|png|jpeg|gif|webp);base64,/.test(v)) : null;
      if (inlineImage) {
        resp.querySelector('.response-bar').insertAdjacentHTML('afterend', `<div class="preview inline-preview"><img alt="图片预览" src="${esc(inlineImage)}"></div>`);
      }
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
    <p>Miao API 聚合了 ${cat.modules.length} 个常用接口模块。调用方式就是访问一个网址：把参数带上发出请求，服务器返回一段 JSON 数据。支持跨域，网页、小程序、后端程序都能直接调用。</p>

    <h2>快速开始</h2>
    <p>无需注册即可直接调用：</p>
    <pre>curl ${o}/api/epic/free</pre>
    <p>注册后在 <a href="#/console/keys">控制台</a> 创建 API Key，通过请求头传入即可获得更高额度：</p>
    <pre>curl ${o}/api/epic/free -H "X-API-Key: ak_xxxxxxxx"</pre>

    <h2>请求方式：GET 和 POST</h2>
    <p>每个接口详情页的路径前面都标着请求方式：<span class="method GET">GET</span> 或 <span class="method POST">POST</span>。两者的区别只在于<b>参数放在哪里</b>。</p>

    <h3>GET：参数写在网址里（绝大多数接口）</h3>
    <p>在接口地址后面加 <code>?</code>，参数写成 <code>参数名=值</code>，多个参数之间用 <code>&amp;</code> 连接。例如查上海的天气：</p>
    <pre>${o}/api/weather?city=上海</pre>
    <p>GET 接口可以直接粘到浏览器地址栏里打开，马上就能看到返回结果，这是最快的测试方法。</p>
    <p>参数里有中文、空格或 <code>&amp;</code> 等特殊字符时需要编码。浏览器地址栏会自动处理；写代码时用 <code>URLSearchParams</code>（JavaScript）或 <code>params=</code>（Python）会自动编码，不要自己拼字符串。</p>

    <h3>POST：参数放在请求体里（少数接口）</h3>
    <p>短链接生成、AI 这类会「创建内容」或内容较长的接口使用 POST。参数写成 JSON 放在请求体里，并加上请求头 <code>Content-Type: application/json</code>。POST 接口不能直接在浏览器地址栏打开，可以用接口详情页的「在线调试」测试。</p>

    <h3>怎么看参数写在哪里</h3>
    <p>接口详情页的参数表有一列「位置」：</p>
    <div class="table-wrap"><table class="table"><tbody>
      <tr><td><code>query</code></td><td>写在网址 <code>?</code> 后面（GET 接口）</td></tr>
      <tr><td><code>body</code></td><td>写在 JSON 请求体里（POST 接口）</td></tr>
      <tr><td><code>path</code></td><td>替换路径里的 <code>:名字</code>，例如 <code>/s/:code</code> → <code>/s/abc123</code></td></tr>
    </tbody></table></div>
    <p>标 <span class="req">*</span> 的是必填参数，其他参数不填就使用「默认值」一列的值。</p>

    <h3>各种语言的写法</h3>
    <p><b>浏览器 / HTML</b>（GET 接口直接打开；返回图片的接口可以直接当图片用）：</p>
    <pre>&lt;img src="${o}/api/bing/image" alt="今日壁纸"&gt;
&lt;img src="${o}/api/qrcode?text=https://miao.club" alt="二维码"&gt;</pre>
    <p><b>JavaScript（网页、Node.js）</b>：</p>
    <pre>// GET：用 URLSearchParams 拼参数，会自动编码中文
const qs = new URLSearchParams({ city: '上海' });
const res = await fetch('${o}/api/weather?' + qs);
const { code, message, data } = await res.json();
if (code === 200) console.log(data);   // 成功
else console.warn(message);             // 失败原因（中文）

// POST：参数放在 JSON 请求体里
const r2 = await fetch('${o}/api/shorturl', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: 'https://github.com' }),
});
console.log((await r2.json()).data.short);</pre>
    <p><b>jQuery</b>：</p>
    <pre>$.getJSON('${o}/api/weather', { city: '上海' }, function (res) {
  if (res.code === 200) console.log(res.data);
});</pre>
    <p><b>Python</b>：</p>
    <pre>import requests

# GET
res = requests.get('${o}/api/weather', params={'city': '上海'})
print(res.json()['data'])

# POST
res = requests.post('${o}/api/shorturl', json={'url': 'https://github.com'})
print(res.json()['data']['short'])</pre>
    <p><b>PHP</b>：</p>
    <pre>&lt;?php
// GET
$json = file_get_contents('${o}/api/weather?' . http_build_query(['city' =&gt; '上海']));
$res = json_decode($json, true);
if ($res['code'] === 200) print_r($res['data']);

// POST
$ctx = stream_context_create(['http' =&gt; [
  'method'  =&gt; 'POST',
  'header'  =&gt; "Content-Type: application/json\\r\\n",
  'content' =&gt; json_encode(['url' =&gt; 'https://github.com']),
]]);
$res = json_decode(file_get_contents('${o}/api/shorturl', false, $ctx), true);</pre>
    <p><b>命令行 curl</b>：</p>
    <pre>curl "${o}/api/weather?city=%E4%B8%8A%E6%B5%B7"
curl -X POST ${o}/api/shorturl -H "Content-Type: application/json" -d '{"url":"https://github.com"}'</pre>
    <p>每个接口详情页底部都有 cURL / JavaScript / Python / 网页前端的示例代码，会根据你在「在线调试」里填的参数自动生成，可以直接复制使用。</p>

    <h3>处理返回结果</h3>
    <p>先看 <code>code</code>：等于 200 表示成功，数据在 <code>data</code> 里；不等于 200 时 <code>message</code> 是中文的失败原因，<code>data</code> 为 <code>null</code>。常见错误码见下方「错误码」一节。</p>

    <h2>在网站 / 博客主题里调用</h2>
    <p>接口支持跨域（CORS），可以在网页里由访客的浏览器直接请求，适合博客主题、个人主页的小卡片。</p>
    <ul>
      <li><b>不要带 API Key。</b>主题和前端代码会原样发到每个访客的浏览器，Key 写进去等于公开。</li>
      <li>不带 Key 时按每个访客自己的 IP 计算额度（每天 ${fmtNum(L.anonDaily)} 次），访客再多也不会互相影响；建议在主题里缓存几个小时。</li>
      <li>返回图片的接口（二维码、Bing 壁纸、随机头像、IP 签名档等）可以直接写在 <code>&lt;img src="..."&gt;</code> 里。</li>
    </ul>
    <p>例：在主题的「数据接口」里填 Epic 周免地址：</p>
    <pre>${o}/api/epic/free</pre>
    <p>返回的 <code>data.current</code> 是正在免费的游戏，<code>data.upcoming</code> 是即将免费的游戏，每个游戏的字段见 <a href="#/api/epic">接口详情</a>。在自己的网页里调用：</p>
    <pre>fetch("${o}/api/epic/free")
  .then((r) =&gt; r.json())
  .then(({ data }) =&gt; {
    for (const g of data.current) {
      console.log(g.title, g.url, g.image.wide, g.endDate);
    }
  });</pre>
    <p>需要更高额度、在服务器端调用时，才使用 API Key（见下一节）。</p>

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

// ---------- 登录 / 注册 / 重置密码 ----------
function pageAuth(mode) {
  const reg = mode === 'register';
  const reset = mode === 'reset';
  if (state.user && !reset) { location.hash = '#/console'; return; }
  const L = state.catalog?.limits;
  const ev = Boolean(state.catalog?.auth?.emailVerify);
  const needCode = ev && (reg || reset);
  const title = reg ? '创建账号' : reset ? '重置密码' : '欢迎回来';
  const sub = reg ? '注册后即可生成 API Key' : reset ? '通过邮箱验证码设置新密码' : '登录以管理你的 API Key 和推送';

  if (reset && !ev) {
    $('#main').innerHTML = `<div class="auth"><div class="card"><h1>重置密码</h1>
      <p class="sub">本站未开启邮箱验证，请联系管理员重置密码。</p><a class="btn" href="#/login">返回登录</a></div></div>`;
    return;
  }

  $('#main').innerHTML = `<div class="auth"><div class="card">
    <h1>${title}</h1>
    <p class="sub">${sub}</p>
    ${reg && L ? `<ul class="perks">
      <li>${icon('check')}每天 ${fmtNum(L.userDaily)} 次调用额度（免登录仅 ${fmtNum(L.anonDaily)} 次）</li>
      <li>${icon('check')}多个 API Key，用量统计随时查看</li>
      <li>${icon('check')}订阅 Epic 周免等内容更新推送</li></ul>` : ''}
    <form id="auth" autocomplete="on">
      <div class="form-error" hidden></div>
      <div class="field"><label for="email">邮箱</label><input class="input" id="email" name="email" type="email" autocomplete="email" required></div>
      ${needCode ? `
      <div class="field"><label for="captcha">图形验证码</label>
        <div class="code-row"><input class="input" id="captcha" name="captchaAnswer" autocomplete="off" maxlength="8" placeholder="输入右侧字符">
        <img id="captcha-img" class="captcha-img" alt="图形验证码" title="看不清？点击刷新"></div></div>
      <div class="field"><label for="code">邮箱验证码</label>
        <div class="code-row"><input class="input" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 位数字" required>
        <button class="btn" type="button" id="send-code">获取验证码</button></div></div>` : ''}
      <div class="field"><label for="password">${reset ? '新密码' : '密码'}</label><input class="input" id="password" name="password" type="password" minlength="8" autocomplete="${reg || reset ? 'new-password' : 'current-password'}" required>
        ${reg || reset ? '<span class="hint">至少 8 位</span>' : ''}</div>
      <button class="btn primary lg" type="submit" style="width:100%">${reg ? '注册' : reset ? '重置并登录' : '登录'}</button>
    </form>
    <p class="small muted" style="text-align:center;margin:18px 0 0">${
      reg ? '已有账号？<a href="#/login">登录</a>'
      : reset ? '想起来了？<a href="#/login">返回登录</a>'
      : `还没有账号？<a href="#/register">免费注册</a>${ev ? ' · <a href="#/reset">忘记密码</a>' : ''}`}</p>
  </div></div>`;

  const form = $('#auth');
  const errBox = $('.form-error', form);
  const showErr = (m) => { errBox.textContent = m; errBox.hidden = false; };

  let captchaToken = null;
  const loadCaptcha = async () => {
    try {
      const c = await api('GET', '/auth/captcha');
      captchaToken = c.token;
      $('#captcha-img').src = c.image;
      $('#captcha').value = '';
    } catch (err) { showErr(err.message); }
  };

  if (needCode) {
    loadCaptcha();
    $('#captcha-img').onclick = loadCaptcha;
    const btn = $('#send-code');
    const countdown = (sec) => {
      btn.disabled = true;
      const tick = () => {
        if (!document.body.contains(btn)) return;
        if (sec <= 0) { btn.disabled = false; btn.textContent = '重新获取'; return; }
        btn.textContent = `${sec--} 秒后重试`;
        setTimeout(tick, 1000);
      };
      tick();
    };
    btn.onclick = async () => {
      errBox.hidden = true;
      const email = $('#email').value.trim();
      const answer = $('#captcha').value.trim();
      if (!email || !$('#email').checkValidity()) return showErr('请先填写正确的邮箱');
      if (!answer) return showErr('请先填写图形验证码');
      btn.disabled = true;
      try {
        const r = await api('POST', '/auth/send-code', { email, purpose: reg ? 'register' : 'reset', captchaToken, captchaAnswer: answer });
        toast('验证码已发送，请查收邮件（也看看垃圾箱）');
        countdown(r.cooldown ?? 60);
        $('#code').focus();
      } catch (err) {
        showErr(err.message);
        btn.disabled = false;
      } finally {
        loadCaptcha(); // 图形验证码只能用一次
      }
    };
  }

  bindForm(form, async (v) => {
    if (reset) await api('POST', '/auth/reset-password', { email: v.email, password: v.password, code: v.code });
    else await api('POST', reg ? '/auth/register' : '/auth/login', { email: v.email, password: v.password, ...(needCode ? { code: v.code } : {}) });
    await loadMe();
    toast(reg ? '注册成功' : reset ? '密码已重置' : '登录成功');
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

// pageSize：分页显示（数据已全部取回，在浏览器里翻页）
// diagnose：每行加「AI 分析」按钮（仅管理后台）
function endpointsTable(rows, { pageSize = Infinity, diagnose = false } = {}) {
  if (!rows.length) return '<div class="empty">暂无调用记录</div>';
  const pages = Math.ceil(rows.length / pageSize);
  const row = (e, i) => `<tr data-pg="${Math.floor(i / pageSize) + 1}"${i >= pageSize ? ' hidden' : ''}><td class="mono">${esc(e.path)}</td><td class="num">${fmtNum(e.calls)}</td><td class="num">${fmtNum(e.avgMs)} ms</td>
      <td class="num">${e.calls ? ((e.errors / e.calls) * 100).toFixed(1) : 0}%</td>
      ${diagnose ? `<td class="num">${e.path.startsWith('/api/') ? `<button class="btn sm ${e.errors ? '' : 'ghost'}" type="button" data-diagnose="${esc(e.path)}">AI 分析</button>` : ''}</td>` : ''}</tr>`;
  return `<div class="table-wrap" data-pages="${pages}" data-cur="1"><table class="table"><thead><tr><th>接口</th><th class="num">调用</th><th class="num">平均耗时</th><th class="num">失败率</th>${diagnose ? '<th></th>' : ''}</tr></thead><tbody>
    ${rows.map(row).join('')}
  </tbody></table>${pages > 1 ? `<div class="row pager" style="justify-content:center;gap:8px;padding:10px 0 4px">
    <button class="btn sm" type="button" data-pg-go="-1" disabled>上一页</button>
    <span class="small faint" data-pg-label>第 1 / ${pages} 页</span>
    <button class="btn sm" type="button" data-pg-go="1">下一页</button></div>` : ''}</div>`;
}

// 表格翻页（在浏览器里切换显示的行）
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-pg-go]');
  if (!b) return;
  const wrap = b.closest('[data-pages]');
  const pages = Number(wrap.dataset.pages);
  const cur = Math.min(pages, Math.max(1, Number(wrap.dataset.cur) + Number(b.dataset.pgGo)));
  wrap.dataset.cur = String(cur);
  wrap.querySelectorAll('tr[data-pg]').forEach((r) => { r.hidden = r.dataset.pg !== String(cur); });
  wrap.querySelector('[data-pg-label]').textContent = `第 ${cur} / ${pages} 页`;
  wrap.querySelector('[data-pg-go="-1"]').disabled = cur <= 1;
  wrap.querySelector('[data-pg-go="1"]').disabled = cur >= pages;
});

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
  const u = await cachedGet('/account/usage');
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
  const keys = await cachedGet('/account/keys');
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
  const n = await cachedGet('/account/notify');
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
  const s = await cachedGet('/admin/stats');
  const t = s.totals;
  const rows = s.daily.map((d) => ({ day: d.day, user: d.count - d.anon, anon: d.anon }));
  const chart = barChart(rows, [{ key: 'user', label: '注册用户' }, { key: 'anon', label: '未登录', cls: 's2' }]);
  $('#main').innerHTML = `<div class="wrap" style="padding:28px 20px 80px">
    <div class="page-head"><div><h1>管理后台</h1><p>全站调用统计、系统更新与接口开关</p></div>${adminTabs('overview')}</div>
    <div class="card" id="update-card" style="margin-bottom:16px"><div class="card-head"><h2>系统更新</h2>
      <div class="row" style="gap:8px"><button class="btn sm ghost" id="upload-update" title="服务器下载 GitHub 太慢时使用：在电脑上下载代码包后在这里上传">上传更新包</button>
      <input type="file" id="upload-file" accept=".zip,.tar.gz,.tgz,application/zip,application/gzip" hidden>
      <button class="btn sm" id="check-update">检查更新</button></div></div><div class="card-pad" id="update-body"><div id="ver-now" class="small faint">正在读取当前版本…</div></div></div>
    <div class="card" id="inspect-card" style="margin-bottom:16px"><div class="card-head"><h2>一键巡检</h2>
      <div class="row" style="gap:10px;flex-wrap:wrap"><label class="small" id="insp-costly-label" title=""><input type="checkbox" id="insp-costly"> 包括会消耗额度或产生数据的接口</label>
      <button class="btn sm danger" id="insp-stop" hidden>停止</button><button class="btn sm primary" id="insp-start">开始巡检</button></div></div>
      <div class="card-pad" id="insp-body"><span class="small faint">用每个接口的示例参数依次实际调用一次，检查是否畅通；不计入调用额度，也不算进调用统计。默认跳过多节点检测、AI、整站抓取、批量检测、短链接，勾选后一起巡检。</span></div></div>
    <div class="tiles">
      ${[['24h 调用', t.calls], ['24h 独立 IP', t.ips], ['24h 平均耗时', `${fmtNum(t.avgMs)} ms`], ['24h 失败', t.errors],
        ['注册用户', t.users], ['API Key', t.keys], ['推送渠道', t.channels], ['订阅', t.subscriptions]]
        .map(([l, v]) => `<div class="card tile"><div class="label">${l}</div><div class="value">${typeof v === 'number' ? fmtNum(v) : esc(v ?? 0)}</div></div>`).join('')}
    </div>
    <div class="card" style="margin-bottom:16px"><div class="card-head"><h2>近 14 天调用量</h2></div><div style="height:10px"></div>${chart.html}</div>
    <div class="grid-2" style="margin-bottom:16px">
      <div class="card"><h2 class="card-title">接口调用排行（近 7 天）<span class="small faint" style="font-weight:400;margin-left:6px">共 ${s.endpoints.length} 个接口有调用</span></h2>
        <div style="padding:8px">${endpointsTable(s.endpoints, { pageSize: 10, diagnose: true })}</div></div>
      <div class="card"><h2 class="card-title">24h 服务端错误</h2><div style="padding:8px">
        ${s.errors.length ? `<table class="table"><thead><tr><th>接口</th><th>状态</th><th class="num">次数</th><th></th></tr></thead><tbody>
          ${s.errors.map((e) => `<tr><td class="mono">${esc(e.path)}</td><td><span class="badge danger">${e.status}</span></td><td class="num">${fmtNum(e.n)}</td>
            <td class="num">${e.path.startsWith('/api/') ? `<button class="btn sm" type="button" data-diagnose="${esc(e.path)}">AI 分析</button>` : ''}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">一切正常</div>'}</div></div>
    </div>
    <div class="card" style="margin-bottom:16px"><div class="card-head"><h2>接口开关</h2>
      <div class="row"><span class="small faint" id="mod-count"></span><input class="input" id="mod-q" placeholder="搜索接口" style="width:180px;height:32px"></div></div>
      <div class="card-pad" id="mod-body"><div class="loading" style="padding:12px 0"><span class="spinner"></span></div></div></div>
  </div>`;
  chart.mount($('#main'));
  $('#check-update').onclick = () => checkUpdate();
  $('#upload-update').onclick = () => uploadUpdateHelp();
  initInspect();
  $('#upload-file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) uploadUpdate(f); };
  api('GET', '/admin/version').then((v) => {
    const el = $('#ver-now');
    if (!el) return;
    el.className = '';
    el.innerHTML = `<div class="row" style="gap:10px;flex-wrap:wrap"><span class="small faint">当前版本</span><b style="font-size:18px">v${esc(v.running ?? v.disk ?? '?')}</b>
      ${v.updatedAt ? `<span class="small faint">${shortDate(v.updatedAt)} 在线更新</span>` : ''}
      <a class="small" href="#/admin/changelog">查看更新记录</a>
      <span class="small faint" style="margin-left:auto">点击右上角「检查更新」，看看有没有新版本</span></div>
      ${v.restartNeeded ? `<div class="form-error" style="margin-top:10px">服务器上的代码已经是 v${esc(v.disk)}，但正在运行的仍是 v${esc(v.running)}：请到 1Panel「网站 → 运行环境」重启 Miao API。</div>` : ''}`;
  }).catch(() => { const el = $('#ver-now'); if (el) el.textContent = '点击右上角「检查更新」，看看有没有新版本'; });
  loadModuleSwitches();

}

const adminTabs = (active) => `<div class="seg">
  <a href="#/admin" class="${active === 'overview' ? 'active' : ''}">概览</a>
  <a href="#/admin/users" class="${active === 'users' ? 'active' : ''}">用户</a>
  <a href="#/admin/changelog" class="${active === 'changelog' ? 'active' : ''}">更新记录</a>
  <a href="#/admin/settings" class="${active === 'settings' ? 'active' : ''}">系统设置</a></div>`;

// ---------- 更新记录 ----------
async function pageAdminChangelog() {
  if (!state.user?.isAdmin) return pageNotFound();
  $('#main').innerHTML = '<div class="wrap"><div class="loading"><span class="spinner"></span></div></div>';
  const d = await cachedGet('/admin/changelog');
  const cur = d.running ?? d.disk;
  $('#main').innerHTML = `<div class="wrap" style="padding:28px 20px 80px">
    <div class="page-head"><div><h1>更新记录</h1><p>每个版本改了什么；有新版本时到「管理」页的系统更新里一键更新</p></div>${adminTabs('changelog')}</div>
    <div class="card card-pad" style="margin-bottom:16px"><div class="row" style="gap:12px;flex-wrap:wrap">
      <span class="small faint">当前版本</span><b style="font-size:20px">v${esc(cur ?? '?')}</b>
      ${d.updatedAt ? `<span class="small faint">${shortDate(d.updatedAt)} 在线更新${d.sha ? ` · 提交 ${esc(d.sha.slice(0, 7))}` : ''}</span>` : ''}
      <span style="margin-left:auto"></span><a class="btn sm" href="#/admin">检查新版本</a></div>
      ${d.restartNeeded ? `<div class="form-error" style="margin-top:12px">服务器上的代码已经是 v${esc(d.disk)}，但正在运行的仍是 v${esc(d.running)}：请到 1Panel 重启 Miao API 后生效。</div>` : ''}</div>
    <div class="card card-pad">${d.entries.length ? `<div class="upd-changes">${d.entries.map((c) => `<div class="upd-release">
        <div class="upd-release-head"><b>v${esc(c.version)}</b>${c.date ? `<span class="faint small">${esc(c.date)}</span>` : ''}
          ${c.version === cur ? '<span class="badge ok">当前版本</span>' : ''}
          ${d.restartNeeded && c.version === d.disk ? '<span class="badge warn">重启后生效</span>' : ''}</div>
        <ul>${c.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div>`).join('')}</div>` : '<div class="empty">没有找到更新记录（CHANGELOG.md）</div>'}</div>
  </div>`;
}

// ---------- 用户管理 ----------
async function pageAdminUsers(q = '', page = 1, size) {
  size ??= Number($('#users-size')?.value) || 20;
  if (!state.user?.isAdmin) return pageNotFound();
  const first = !$('#users-page');
  if (first) {
    $('#main').innerHTML = `<div class="wrap" id="users-page" style="padding:28px 20px 80px">
      <div class="page-head"><div><h1>用户</h1><p>查看注册用户、调整每日额度、停用账号</p></div>${adminTabs('users')}</div>
      <div class="card"><div class="card-head"><h2 id="users-count">用户</h2>
        <div class="row" style="gap:8px"><label class="small faint">每页 <select class="input" id="users-size" style="width:auto;height:32px;padding:0 8px">
          ${[10, 20, 50, 100].map((n) => `<option value="${n}" ${n === size ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <form class="row" id="users-search"><input class="input" name="q" placeholder="按邮箱搜索" style="width:220px;height:32px" value="${esc(q)}"><button class="btn sm">搜索</button></form></div></div>
        <div id="users-body"><div class="loading"><span class="spinner"></span></div></div></div></div>`;
    $('#users-search').addEventListener('submit', (e) => { e.preventDefault(); pageAdminUsers(new FormData(e.target).get('q').trim(), 1); });
    $('#users-size').addEventListener('change', () => pageAdminUsers($('#users-body').dataset.q ?? '', 1));
    $('#users-page').addEventListener('submit', async (e) => {
      const f = e.target.closest('[data-limit]');
      if (!f) return;
      e.preventDefault();
      const raw = new FormData(f).get('limit').trim();
      try {
        await api('PATCH', `/admin/users/${f.dataset.limit}`, { dailyLimit: raw === '' ? null : Number(raw) });
        toast('额度已更新');
      } catch (err) { toast(err.message, true); }
    });
    $('#users-page').addEventListener('click', async (e) => {
      const pg = e.target.closest('[data-page]');
      if (pg) return pageAdminUsers(pg.dataset.q, Number(pg.dataset.page));
      const b = e.target.closest('[data-toggle]');
      if (!b) return;
      const disable = b.dataset.disabled === '0';
      if (disable && !(await confirmDialog('停用用户', '停用后该用户将无法登录，其 API Key 也将失效。', { okText: '停用' }))) return;
      try {
        await api('PATCH', `/admin/users/${b.dataset.toggle}`, { disabled: disable });
        const cur = $('#users-body').dataset;
        pageAdminUsers(cur.q ?? '', Number(cur.page ?? 1));
      } catch (err) { toast(err.message, true); }
    });
  }
  const body = $('#users-body');
  let d;
  try {
    d = await cachedGet(`/admin/users?q=${encodeURIComponent(q)}&page=${page}&size=${size}`);
  } catch (err) {
    body.innerHTML = `<div class="form-error" style="margin:16px">${esc(err.message)}</div>`;
    return;
  }
  body.dataset.q = q;
  body.dataset.page = String(page);
  $('#users-count').textContent = q ? `找到 ${fmtNum(d.total)} 个用户` : `共 ${fmtNum(d.total)} 个用户`;
  const pages = Math.max(1, Math.ceil(d.total / d.size));
  body.innerHTML = d.items.length ? `<div class="table-wrap" style="padding:8px"><table class="table">
      <thead><tr><th>邮箱</th><th>注册时间</th><th>最近调用</th><th class="num">Key</th><th class="num">今日调用</th><th class="num">近 7 天</th><th>每日额度 <span class="faint small">留空用默认值</span></th><th>状态</th></tr></thead><tbody>
      ${d.items.map((u) => `<tr><td>${esc(u.email)} ${u.isAdmin ? '<span class="badge brand">管理员</span>' : ''}${u.disabled ? ' <span class="badge danger">已停用</span>' : ''}</td>
        <td class="small faint">${fmtDate(u.createdAt)}</td><td class="small faint">${u.lastCallAt ? fmtDate(u.lastCallAt) : '—'}</td>
        <td class="num">${u.keys}</td><td class="num">${fmtNum(u.usedToday)}</td><td class="num">${fmtNum(u.calls7d)}</td>
        <td><form class="row" data-limit="${u.id}"><input class="input" style="width:120px;height:30px" name="limit" inputmode="numeric" value="${u.customLimit ?? ''}" placeholder="${fmtNum(u.dailyLimit)}"><button class="btn sm">保存</button></form></td>
        <td>${u.id === state.user.id ? '<span class="faint small">—</span>' : `<button class="btn sm ${u.disabled ? '' : 'danger'}" data-toggle="${u.id}" data-disabled="${u.disabled ? 1 : 0}">${u.disabled ? '启用' : '停用'}</button>`}</td></tr>`).join('')}
      </tbody></table></div>
      ${pages > 1 ? `<div class="row" style="justify-content:center;gap:8px;padding:0 0 16px">
        <button class="btn sm" data-page="${page - 1}" data-q="${esc(q)}" ${page <= 1 ? 'disabled' : ''}>上一页</button>
        <span class="small faint">第 ${page} / ${pages} 页</span>
        <button class="btn sm" data-page="${page + 1}" data-q="${esc(q)}" ${page >= pages ? 'disabled' : ''}>下一页</button></div>` : ''}`
    : `<div class="empty">${q ? '没有匹配的用户' : '还没有用户'}</div>`;
}

// ---------- 系统设置 ----------
const SOURCE_LABEL = { panel: ['后台', 'brand'], env: ['环境变量', ''], default: ['默认', ''] };

async function pageAdminSettings(focusGroup, focusKeys) {
  if (!state.user?.isAdmin) return pageNotFound();
  $('#main').innerHTML = '<div class="wrap"><div class="loading"><span class="spinner"></span></div></div>';
  const groups = await cachedGet('/admin/settings');
  const fieldHtml = (f) => {
    const [srcText, srcCls] = SOURCE_LABEL[f.source];
    const src = `<span class="badge ${srcCls}" title="当前值来源">${srcText}</span>`;
    let input;
    if (f.type === 'bool') {
      const on = (f.value || f.default) === '1';
      input = `<label class="switch"><input type="checkbox" data-key="${f.key}" data-type="bool" data-orig="${on ? '1' : '0'}" ${on ? 'checked' : ''}><span></span></label>`;
    } else if (f.type === 'secret') {
      input = `<div class="row"><input class="input mono grow" type="password" autocomplete="new-password" data-key="${f.key}" data-type="secret"
          placeholder="${f.isSet ? '已设置，留空表示不修改' : '未设置'}">
        ${f.isSet && f.source === 'panel' ? `<button class="btn sm ghost danger" type="button" data-clear="${f.key}">清除</button>` : ''}</div>`;
    } else {
      input = `<input class="input ${f.type === 'text' || f.type === 'url' ? 'mono' : ''}" data-key="${f.key}" data-type="${f.type}" data-orig="${esc(f.value)}" value="${esc(f.value)}"
        ${f.type === 'int' ? 'inputmode="numeric"' : ''} placeholder="${esc(f.default != null ? `默认 ${f.default}` : f.placeholder ?? '')}">`;
    }
    const link = f.link ? ` · <a href="${esc(f.link)}" target="_blank" rel="noopener noreferrer">获取地址 ↗</a>` : '';
    return `<div class="set-field">
      <div class="set-label"><span>${esc(f.label)}</span>${src}${f.restart ? '<span class="badge warn">重启后生效</span>' : ''}
        ${f.test ? `<button class="btn sm ghost set-test" type="button" data-test="${f.test}">测试连通性</button>` : ''}</div>
      ${input}
      <div class="hint"><span class="mono">${f.key}</span>${f.help ? ` · ${esc(f.help)}` : ''}${link}</div>
      ${f.test ? `<div class="test-result" data-result="${f.test}" hidden></div>` : ''}
    </div>`;
  };

  $('#main').innerHTML = `<div class="wrap" style="padding:28px 20px 80px">
    <div class="page-head"><div><h1>系统设置</h1><p>保存后立即生效，优先级高于服务器环境变量；清空某项即恢复为环境变量或默认值</p></div>${adminTabs('settings')}</div>
    ${groups.map((g) => `<form class="card card-pad set-group" data-group="${g.id}">
      <div class="row" style="justify-content:space-between;margin-bottom:14px"><h2 style="font-size:16px">${esc(g.title)}</h2>
        <div class="row">${g.id === 'mail' ? '<button class="btn sm" type="button" id="test-mail">发送测试邮件</button>' : ''}<button class="btn sm primary" type="submit">保存</button></div></div>
      <div class="set-grid">${g.fields.map(fieldHtml).join('')}</div>
    </form>`).join('')}
  </div>`;

  // 从接口页跳转过来时：滚动到对应分组并高亮需要填写的项
  if (focusGroup) {
    const form = $(`form[data-group="${CSS.escape(focusGroup)}"]`);
    form?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    for (const k of (focusKeys || '').split(',').filter(Boolean)) {
      $(`[data-key="${CSS.escape(k)}"]`)?.closest('.set-field')?.classList.add('focus');
    }
    $('.set-field.focus [data-key]')?.focus({ preventScroll: true });
  }

  const collect = (form) => {
    const changes = {};
    for (const el of $$('[data-key]', form)) {
      const k = el.dataset.key;
      if (el.dataset.type === 'bool') {
        const v = el.checked ? '1' : '0';
        if (v !== el.dataset.orig) changes[k] = v;
      } else if (el.dataset.type === 'secret') {
        if (el.value.trim()) changes[k] = el.value.trim();
      } else if (el.value.trim() !== el.dataset.orig) {
        changes[k] = el.value.trim() || null;
      }
    }
    return changes;
  };
  const save = async (changes) => {
    if (!Object.keys(changes).length) return toast('没有修改');
    await api('PUT', '/admin/settings', changes);
    state.catalog = null;
    toast('已保存');
    await loadMe();
    pageAdminSettings();
  };

  for (const form of $$('form.set-group')) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await save(collect(form)); } catch (err) { toast(err.message, true); }
    });
  }
  $('#main').addEventListener('click', async (e) => {
    const clr = e.target.closest('[data-clear]');
    if (clr) {
      if (!(await confirmDialog('清除设置', `确定清除 ${clr.dataset.clear}？将恢复为环境变量中的值（如有）。`, { okText: '清除' }))) return;
      try { await save({ [clr.dataset.clear]: null }); } catch (err) { toast(err.message, true); }
    }
    const tbtn = e.target.closest('[data-test]');
    if (tbtn) {
      const form = tbtn.closest('form');
      if (Object.keys(collect(form)).length) return toast('请先保存这一组设置，再测试连通性', true);
      const out = $(`[data-result="${CSS.escape(tbtn.dataset.test)}"]`, form);
      tbtn.disabled = true;
      out.hidden = false;
      out.className = 'test-result';
      out.textContent = '正在测试…';
      try {
        const r = await api('POST', '/admin/settings/test-key', { service: tbtn.dataset.test });
        out.className = `test-result ${r.ok ? 'ok' : 'bad'}`;
        out.textContent = `${r.ok ? '✓' : '✗'} ${r.message}${r.detail ? `：${r.detail}` : ''}`;
      } catch (err) {
        out.className = 'test-result bad';
        out.textContent = `✗ ${err.message}`;
      } finally { tbtn.disabled = false; }
    }
    if (e.target.closest('#test-mail')) {
      const form = e.target.closest('form');
      if (Object.keys(collect(form)).length) return toast('请先保存邮件设置，再发送测试邮件', true);
      const btn = e.target.closest('#test-mail');
      btn.disabled = true;
      try {
        const r = await api('POST', '/admin/settings/test-mail', {});
        toast(`测试邮件已发送到 ${r.to}`);
      } catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
    }
  });
}

// ---------- 接口开关 ----------
async function loadModuleSwitches() {
  const body = $('#mod-body');
  let data;
  try {
    data = await api('GET', '/admin/modules');
  } catch (err) {
    body.innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
    return;
  }
  if (!body.isConnected) return; // 数据回来前已经切到别的页面
  const draw = () => {
    const q = $('#mod-q').value.trim().toLowerCase();
    const on = data.modules.filter((m) => m.enabled).length;
    const needKey = data.modules.filter((m) => m.keys?.mode === 'required' && !m.keys.configured).length;
    $('#mod-count').textContent = `已开放 ${on} / ${data.modules.length}${needKey ? ` · ${needKey} 个待填 Key` : ''}`;
    const legend = `<div class="key-legend small faint"><span class="badge danger">需填 Key</span> 不填写无法使用
      <span class="badge ok">已填 Key</span> 已配置可用 <span class="badge">可选 Key</span> 不填也能用，填了效果更好或限额更高 · 点标签去设置里填写</div>`;
    body.innerHTML = legend + data.categories.map((c) => {
      const list = data.modules.filter((m) => m.category === c.id && (!q || `${m.title} ${m.name} ${m.routes.join(' ')}`.toLowerCase().includes(q)));
      if (!list.length) return '';
      return `<div class="mod-group">
        <div class="mod-group-head"><b>${icon(c.icon)}${esc(c.title)}</b>
          <span class="row"><button class="btn sm ghost" data-bulk="${c.id}" data-on="1">全部开启</button><button class="btn sm ghost" data-bulk="${c.id}" data-on="0">全部关闭</button></span></div>
        <div class="mod-grid">${list.map((m) => `
          <label class="mod-item ${m.enabled ? '' : 'off'}" title="${esc(m.routes.join('\n'))}">
            <span class="switch"><input type="checkbox" data-mod="${esc(m.name)}" ${m.enabled ? 'checked' : ''}><span></span></span>
            <span class="grow"><span class="mod-title">${esc(m.title)}${keyBadge(m.keys)}</span><span class="mod-meta mono">${esc(m.routes[0])}${m.routes.length > 1 ? ` +${m.routes.length - 1}` : ''}</span></span>
            <span class="small faint" title="近 7 天调用">${fmtNum(m.calls7d)}</span>
          </label>`).join('')}</div></div>`;
    }).join('') || '<div class="empty">没有匹配的接口</div>';
  };
  const save = async (names, enabled) => {
    await api('PUT', '/admin/modules', { names, enabled });
    for (const m of data.modules) if (names.includes(m.name)) m.enabled = enabled;
    state.catalog = null; // 首页目录重新加载
    draw();
    toast(enabled ? `已开启 ${names.length} 个接口` : `已关闭 ${names.length} 个接口`);
  };
  body.onchange = async (e) => {
    const cb = e.target.closest('input[data-mod]');
    if (!cb) return;
    try { await save([cb.dataset.mod], cb.checked); } catch (err) { cb.checked = !cb.checked; toast(err.message, true); }
  };
  body.onclick = async (e) => {
    const b = e.target.closest('[data-bulk]');
    if (!b) return;
    const enabled = b.dataset.on === '1';
    const names = data.modules.filter((m) => m.category === b.dataset.bulk && m.enabled !== enabled).map((m) => m.name);
    if (!names.length) return toast(enabled ? '该分类已全部开启' : '该分类已全部关闭');
    if (!enabled && !(await confirmDialog('关闭接口', `确定关闭该分类下的 ${names.length} 个接口？关闭后普通用户调用会返回 403。`, { okText: '关闭' }))) return;
    try { await save(names, enabled); } catch (err) { toast(err.message, true); }
  };
  $('#mod-q').oninput = draw;
  draw();
}

// 接口开关里的密钥标签：点击直达设置里对应的密钥
function keyBadge(k) {
  if (!k) return '';
  const href = `#/admin/settings/${k.group}/${k.names.join(',')}`;
  const tip = `${k.anyOf ? '任选其一填写：' : k.mode === 'required' ? '需要填写：' : '可选填写：'}${k.names.join('、')}`;
  const [cls, text] = k.mode === 'required'
    ? (k.configured ? ['ok', '已填 Key'] : ['danger', k.anyOf ? '需填 Key（任选其一）' : '需填 Key'])
    : (k.configured ? ['ok', '已填可选 Key'] : ['', '可选 Key']);
  return ` <a class="badge ${cls} key-badge" href="${href}" title="${esc(tip)}">${text}</a>`;
}

// ---------- 在线更新 ----------
const shortDate = (d) => (d ? new Date(d).toLocaleString('zh-CN', { hour12: false }) : '—');

async function checkUpdate() {
  const body = $('#update-body');
  const btn = $('#check-update');
  btn.disabled = true;
  body.innerHTML = '<div class="loading" style="padding:12px 0"><span class="spinner"></span></div>';
  try {
    const u = await api('GET', '/admin/update');
    const cur = u.current;
    const latestV = u.latest.version ? `v${u.latest.version}` : '最新代码';
    const verBox = (label, value, sub) => `<div class="ver-box"><div class="faint small">${label}</div><div class="ver">${value}</div><div class="faint small">${sub}</div></div>`;

    let status;
    if (u.hasUpdate) status = `<div class="upd-status new">${icon('zap')}<b>${u.patch ? '有新的修复可以更新' : `发现新版本 ${esc(latestV)}`}</b></div>`;
    else if (u.remoteOlder) status = `<div class="upd-status warn">${icon('shield')}<b>GitHub 上的版本（${esc(latestV)}）比当前还旧</b>
        <span class="small">通常是更新分支设置不对：请到「系统设置 → 在线更新」确认分支，当前读取的是 <code>${esc(u.branch)}</code></span></div>`;
    else status = `<div class="upd-status ok">${icon('check')}<b>已经是最新版本</b></div>`;

    const changes = u.changes.length
      ? `<div class="upd-changes">${u.changes.map((c) => `<div class="upd-release">
          <div class="upd-release-head"><b>v${esc(c.version)}</b>${c.date ? `<span class="faint small">${esc(c.date)}</span>` : ''}</div>
          <ul>${c.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div>`).join('')}</div>`
      : u.hasUpdate ? '<p class="small muted">这次更新包含问题修复和细节改进。</p>' : '';

    body.innerHTML = `
      ${cur.running && cur.version && cur.running !== cur.version ? `<div class="form-error">服务器上的代码已经是 v${esc(cur.version)}，但正在运行的仍是 v${esc(cur.running)}：代码替换后还没有重启服务。请到 1Panel「网站 → 运行环境」重启 Miao API，重启前在线更新可能失败。</div>` : ''}
      ${u.lastRollback ? `<div class="form-error">上次更新后新版本没能正常启动，已于 ${shortDate(u.lastRollback.at)} 自动恢复到更新前的版本。</div>` : ''}
      <div class="ver-row">
        ${verBox('当前版本', cur.version ? `v${esc(cur.version)}` : '—', cur.updatedAt ? `${shortDate(cur.updatedAt)} 更新` : '手动部署')}
        <div class="ver-arrow">→</div>
        ${verBox('GitHub 最新版本', esc(latestV), `${shortDate(u.latest.date)} 发布`)}
      </div>
      ${status}
      ${changes ? `<div class="small faint" style="margin:14px 0 6px">更新内容</div>${changes}` : ''}
      ${u.hasUpdate ? `
        ${!u.managed ? '<p class="small" style="color:var(--warn)">当前服务不是通过 npm start 启动的，更新完成后需要到服务器面板手动重启。</p>' : ''}
        <button class="btn primary" id="do-update" data-sha="${esc(u.latest.sha)}">${icon('zap')}立即更新${u.patch ? '' : `到 ${esc(latestV)}`}</button>
        <p class="small faint" style="margin:10px 0 0">只替换程序代码，账号、API Key、调用记录和系统设置都不受影响。更新前会自动备份，新版本启动失败会自动恢复。</p>` : ''}
      <details class="upd-tech"><summary class="small faint">技术细节</summary>
        <div class="small faint mono" style="margin-top:6px">仓库 ${esc(u.repo)} · 分支 ${esc(u.branch)}<br>
          当前提交 ${esc(cur.sha?.slice(0, 7) ?? '未知（手动部署）')} · 最新提交 ${esc(u.latest.shortSha)} ${esc(u.latest.message)}</div>
        ${u.commits.length ? `<ul class="small faint mono">${u.commits.map((c) => `<li>${esc(c.shortSha)} ${esc(c.message)}</li>`).join('')}</ul>` : ''}
      </details>`;
    $('#do-update')?.addEventListener('click', (e) => runUpdate(e.currentTarget.dataset.sha, u.managed));
  } catch (err) {
    body.innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function updateBar(body, { percent = 0, stage = '', detail = '', tone = '' }) {
  body.innerHTML = `<div class="upd-progress ${tone}">
    <div class="row" style="justify-content:space-between;gap:12px">
      <span class="row" style="gap:8px">${tone ? '' : '<span class="spinner"></span>'}<b>${esc(stage)}</b></span>
      <span class="mono small">${Math.round(percent)}%</span></div>
    <div class="upd-track"><div class="upd-fill" style="width:${Math.max(2, Math.min(100, percent))}%"></div></div>
    <div class="small faint">${esc(detail || '')}</div></div>`;
}

async function runUpdate(sha, managed) {
  if (!(await confirmDialog('确认更新', '将下载新版本并自动重启，网站会中断几秒钟。账号和数据不受影响。', { danger: false, okText: '开始更新' }))) return;
  const body = $('#update-body');
  updateBar(body, { percent: 1, stage: '正在开始更新' });
  let p;
  try {
    p = await api('POST', '/admin/update', { sha });
  } catch (err) {
    body.innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
    return;
  }
  await followUpdate(p, body);
}

// 跟踪后台更新进度，直到完成、失败或服务重启完成（在线更新和上传更新包共用）
async function followUpdate(p, body) {
  // 1. 轮询更新进度（下载、解压、试启动、替换）
  let fails = 0;
  while (p.state === 'running') {
    updateBar(body, p);
    await sleep(700);
    try { p = await api('GET', '/admin/update/progress'); fails = 0; } catch { if (++fails > 10) break; }
  }
  if (p.state === 'error') {
    updateBar(body, { ...p, percent: p.percent, tone: 'bad', detail: p.error });
    return;
  }
  const target = p.result?.version?.version ?? p.target?.version ?? '';
  if (p.state === 'done' && !p.result?.restart) {
    updateBar(body, { percent: 100, stage: `新版本${target ? ` v${target}` : ''} 已下载完成`, detail: '当前不是通过守护进程启动的，请到服务器面板重启服务后生效', tone: 'ok' });
    return;
  }
  // 2. 等待服务重启：重启期间请求失败（包括 CDN 返回的 5xx）属于正常现象，继续等
  updateBar(body, { percent: 98, stage: '正在重启服务', detail: '网站会中断几秒钟，请不要关闭页面' });
  await sleep(3500);
  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch('/status', { cache: 'no-store' });
      const st = res.ok ? (await res.json()).data : null;
      if (st && (!target || st.version === target)) {
        updateBar(body, { percent: 100, stage: `更新成功${st.version ? `，当前版本 v${st.version}` : ''}`, detail: '页面即将刷新以加载新版本', tone: 'ok' });
        await sleep(1500);
        location.reload();
        return;
      }
    } catch { /* 服务还没起来 */ }
    updateBar(body, { percent: 98, stage: '正在重启服务', detail: `已等待 ${i + 4} 秒…` });
    await sleep(1000);
  }
  updateBar(body, { percent: 98, stage: '服务长时间没有恢复', detail: '如果新版本启动失败，守护进程会自动恢复旧版本；请刷新页面查看，或到服务器面板查看运行日志', tone: 'bad' });
}

// ---------- 一键巡检 ----------
const INSPECT_LABEL = { ok: ['正常', 'ok'], fail: ['失败', 'danger'], timeout: ['超时', 'danger'], param: ['参数不适用', 'warn'], skipped: ['跳过', ''], pending: ['等待', ''], running: ['检测中', 'brand'] };
let inspectFilter = 'problem';

async function initInspect() {
  $('#insp-start').onclick = async () => {
    try {
      const d = await api('POST', '/admin/inspect', { includeCostly: $('#insp-costly').checked });
      drawInspect(d);
      pollInspect();
    } catch (err) { toast(err.message, true); }
  };
  $('#insp-stop').onclick = async () => { try { drawInspect(await api('POST', '/admin/inspect/stop', {})); } catch (err) { toast(err.message, true); } };
  $('#insp-body').addEventListener('change', (e) => {
    if (e.target.id !== 'insp-filter') return;
    inspectFilter = e.target.value;
    api('GET', '/admin/inspect').then(drawInspect).catch(() => {});
  });
  try {
    const d = await api('GET', '/admin/inspect');
    $('#insp-costly-label')?.setAttribute('title', Object.entries(d.costly ?? {}).map(([k, v]) => `${k}：${v}`).join('\n'));
    if (d.state !== 'idle') drawInspect(d);
    if (d.state === 'running') pollInspect();
  } catch { /* 忽略 */ }
}

async function pollInspect() {
  while ($('#insp-body')) {
    await sleep(1000);
    let d;
    try { d = await api('GET', '/admin/inspect'); } catch { continue; }
    drawInspect(d);
    if (d.state !== 'running') break;
  }
}

function drawInspect(d) {
  const body = $('#insp-body');
  if (!body) return;
  const running = d.state === 'running';
  $('#insp-start').disabled = running;
  $('#insp-start').textContent = running ? '巡检中…' : d.state === 'idle' ? '开始巡检' : '重新巡检';
  $('#insp-stop').hidden = !running;
  const count = (st) => d.results.filter((r) => r.status === st).length;
  const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
  const problems = d.results.filter((r) => ['fail', 'timeout', 'param'].includes(r.status));
  const rows = inspectFilter === 'all' ? d.results : inspectFilter === 'skipped' ? d.results.filter((r) => r.status === 'skipped') : problems;
  const chip = (st, n) => `<span class="badge ${INSPECT_LABEL[st][1]}">${INSPECT_LABEL[st][0]} ${n}</span>`;
  body.innerHTML = `
    <div class="upd-progress ${running ? '' : problems.some((r) => r.status !== 'param') ? 'bad' : 'ok'}">
      <div class="row" style="justify-content:space-between;gap:12px;flex-wrap:wrap">
        <span class="row" style="gap:8px">${running ? '<span class="spinner"></span>' : ''}<b>${running ? `正在巡检 ${d.done} / ${d.total}` : d.state === 'stopped' ? '巡检已停止' : `巡检完成，用时 ${Math.max(1, Math.round((new Date(d.finishedAt) - new Date(d.startedAt)) / 1000))} 秒`}</b></span>
        <span class="row" style="gap:6px;flex-wrap:wrap">${chip('ok', count('ok'))}${chip('fail', count('fail'))}${chip('timeout', count('timeout'))}${chip('param', count('param'))}${chip('skipped', count('skipped'))}</span></div>
      <div class="upd-track"><div class="upd-fill" style="width:${Math.max(2, pct)}%"></div></div>
      <div class="small faint">${d.includeCostly ? '包括了会消耗额度或产生数据的接口' : '已跳过会消耗额度或产生数据的接口'} · 开始于 ${shortDate(d.startedAt)}</div>
    </div>
    <div class="row" style="justify-content:space-between;margin:14px 0 6px"><span class="small faint">「参数不适用」表示用文档示例参数调用时参数不合适，接口本身多半正常</span>
      <select class="input" id="insp-filter" style="width:auto;height:30px;padding:0 8px">
        <option value="problem" ${inspectFilter === 'problem' ? 'selected' : ''}>只看有问题的（${problems.length}）</option>
        <option value="skipped" ${inspectFilter === 'skipped' ? 'selected' : ''}>看跳过的（${count('skipped')}）</option>
        <option value="all" ${inspectFilter === 'all' ? 'selected' : ''}>全部（${d.results.length}）</option></select></div>
    ${rows.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>状态</th><th>接口</th><th class="num">耗时</th><th>说明</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td><span class="badge ${INSPECT_LABEL[r.status]?.[1] ?? ''}">${INSPECT_LABEL[r.status]?.[0] ?? r.status}</span></td>
        <td><div>${esc(r.title)}</div><div class="mono small faint">${r.method === 'GET' ? '' : `${r.method} `}${esc(r.path)}</div></td>
        <td class="num small">${r.ms != null ? `${fmtNum(r.ms)} ms` : '—'}</td>
        <td class="small">${esc(r.error ?? '')}</td>
        <td class="num">${['fail', 'timeout'].includes(r.status) ? `<button class="btn sm" type="button" data-diagnose="${esc(r.path)}">AI 分析</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>` : `<div class="empty">${running ? '暂时没有发现问题…' : inspectFilter === 'problem' ? '所有接口都正常 🎉' : '没有记录'}</div>`}`;
}

// ---------- 上传更新包 ----------
const ZIP_URL = 'https://github.com/bocmiao/api/archive/refs/heads/Miao-API.zip';

function uploadUpdateHelp() {
  modal(`<h2>上传更新包</h2>
    <p class="muted small" style="line-height:1.8">服务器下载 GitHub 太慢时用这个办法：</p>
    <ol class="small" style="line-height:1.9;padding-left:20px;margin:0 0 12px">
      <li>在你自己的电脑上下载代码包：<a href="${ZIP_URL}" target="_blank" rel="noopener">点这里下载 Miao-API.zip</a>（约 11 MB，不用解压）</li>
      <li>点下面的「选择文件」，选中刚下载的 zip</li>
      <li>上传后服务器会检查新版本能否正常启动，再自动备份、替换并重启；失败会自动恢复</li>
    </ol>
    <p class="small faint">账号、API Key、调用记录和系统设置都不受影响。也支持 .tar.gz 格式。为安全起见，服务器会逐个文件核对是否为 GitHub 官方代码，改动过的代码会被拒绝。</p>
    <label class="small" style="display:block;margin:14px 0 6px">为了安全，请再输入一次管理员密码</label>
    <input class="input" type="password" id="confirm-pw" autocomplete="current-password" placeholder="管理员密码">
    <div class="form-error" id="confirm-err" hidden style="margin-top:8px"></div>
    <div class="actions"><button class="btn" data-no>取消</button><button class="btn primary" data-pick>确认并选择文件</button></div>`, (root, close) => {
    $('[data-no]', root).onclick = close;
    const go = async () => {
      const pw = $('#confirm-pw', root).value;
      const errEl = $('#confirm-err', root);
      if (!pw) { errEl.hidden = false; errEl.textContent = '请输入密码'; return; }
      $('[data-pick]', root).disabled = true;
      try {
        const r = await api('POST', '/admin/confirm', { password: pw });
        uploadConfirm = { token: r.token, exp: Date.now() + r.expiresIn * 1000 - 5000 };
        close();
        $('#upload-file')?.click();
      } catch (err) {
        errEl.hidden = false;
        errEl.textContent = err.message;
        $('[data-pick]', root).disabled = false;
      }
    };
    $('[data-pick]', root).onclick = go;
    $('#confirm-pw', root).onkeydown = (e) => { if (e.key === 'Enter') go(); };
  });
}

// 输入密码后换到的一次性确认码（5 分钟内有效）
let uploadConfirm = null;

async function uploadUpdate(file) {
  const mbText = (n) => `${(n / 1048576).toFixed(1)} MB`;
  if (!uploadConfirm || uploadConfirm.exp < Date.now()) { uploadConfirm = null; return uploadUpdateHelp(); }
  const confirmToken = uploadConfirm.token;
  uploadConfirm = null; // 一次性
  if (!/\.(zip|tar\.gz|tgz)$/i.test(file.name)) return toast('请选择 .zip 或 .tar.gz 格式的代码包', true);
  if (file.size > 60 * 1048576) return toast(`文件太大（${mbText(file.size)}），最大 60 MB`, true);
  if (!(await confirmDialog('确认上传更新', `将用「${file.name}」（${mbText(file.size)}）更新网站并自动重启，网站会中断几秒钟。账号和数据不受影响。`, { danger: false, okText: '上传并更新' }))) return;
  const body = $('#update-body');
  updateBar(body, { percent: 0, stage: '正在上传更新包', detail: `0 / ${mbText(file.size)}` });
  let p;
  try {
    p = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/admin/update/upload');
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.setRequestHeader('x-admin-confirm', confirmToken);
      // 上传占进度条的前一半
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) updateBar(body, { percent: Math.round((e.loaded / e.total) * 50), stage: '正在上传更新包', detail: `${mbText(e.loaded)} / ${mbText(e.total)}` }); };
      xhr.onload = () => {
        let json = null;
        try { json = JSON.parse(xhr.responseText); } catch { /* 非 JSON（比如反向代理的错误页） */ }
        if (xhr.status === 200 && json?.code === 200) resolve(json.data);
        else if (xhr.status === 413) reject(new Error(json?.message ?? '文件超过了服务器允许的上传大小：请在 1Panel 网站设置里把上传大小限制调到 60M 以上，或改用 1Panel 文件管理手动更新'));
        else reject(new Error(json?.message ?? `上传失败（HTTP ${xhr.status}）`));
      };
      xhr.onerror = () => reject(new Error('上传中断，请检查网络后重试'));
      xhr.send(file);
    });
  } catch (err) {
    updateBar(body, { percent: 0, stage: '上传失败', detail: err.message, tone: 'bad' });
    return;
  }
  await followUpdate(p, body);
}

// ---------- 运行状态 ----------
async function pageStatus() {
  $('#main').innerHTML = '<div class="wrap"><div class="loading"><span class="spinner"></span></div></div>';
  const st = await cachedGet('/status');
  const LABEL = { ok: ['正常', 'ok'], degraded: ['部分失败', 'warn'], down: ['故障', 'danger'], idle: ['24 小时内无调用', ''] };
  const count = (k) => st.modules.filter((m) => m.status === k).length;
  const up = st.uptimeSec;
  const upText = up > 86400 ? `${Math.floor(up / 86400)} 天 ${Math.floor((up % 86400) / 3600)} 小时` : up > 3600 ? `${Math.floor(up / 3600)} 小时 ${Math.floor((up % 3600) / 60)} 分钟` : `${Math.floor(up / 60)} 分钟`;
  const overall = count('down') ? ['部分接口故障', 'danger'] : count('degraded') ? ['部分接口不稳定', 'warn'] : ['所有接口运行正常', 'ok'];
  $('#main').innerHTML = `<div class="wrap" style="padding:28px 20px 80px">
    <div class="page-head"><div><h1>运行状态</h1><p>根据最近 24 小时的真实调用统计；上游网站故障时对应接口会显示异常</p></div></div>
    <div class="card card-pad status-hero ${overall[1]}"><span class="status-dot ${overall[1]}"></span><b>${overall[0]}</b>
      <span class="faint small" style="margin-left:auto">版本 v${esc(st.version ?? '')} · 已连续运行 ${upText}</span></div>
    <div class="tiles" style="margin:16px 0">
      ${[['正常', count('ok')], ['部分失败', count('degraded')], ['故障', count('down')], ['无调用', count('idle')]].map(([l, v]) => `<div class="card tile"><div class="label">${l}</div><div class="value">${v}</div></div>`).join('')}
    </div>
    ${st.categories.map((c) => {
      const list = st.modules.filter((m) => m.category === c.id);
      if (!list.length) return '';
      return `<div class="card card-pad" style="margin-bottom:14px"><h2 style="font-size:15px;margin-bottom:10px">${icon(c.icon)} ${esc(c.title)}</h2>
        <div class="status-grid">${list.map((m) => `<a class="status-item" href="#/api/${encodeURIComponent(m.name)}" title="${esc(LABEL[m.status][0])}">
          <span class="status-dot ${LABEL[m.status][1]}"></span><span class="grow">${esc(m.title)}</span>
          <span class="small faint">${m.calls ? `${fmtNum(m.calls)} 次 · ${m.avgMs} ms${m.errorRate ? ` · 失败 ${m.errorRate}%` : ''}` : '—'}</span></a>`).join('')}</div></div>`;
    }).join('')}
  </div>`;
}

// ---------- Ctrl+K 快速搜索 ----------
async function openSearch() {
  if ($('.search-modal')) return;
  const cat = await loadCatalog();
  let sel = 0;
  modal(`<div class="search-modal"><input class="input" id="sk" placeholder="搜索接口名称、路径或用途，回车打开" autocomplete="off">
    <div class="sk-list" id="sk-list"></div><div class="small faint" style="margin-top:8px">↑ ↓ 选择 · 回车打开 · Esc 关闭</div></div>`, (root, close) => {
    const list = $('#sk-list', root);
    let items = [];
    const draw = () => {
      const q = $('#sk', root).value.trim().toLowerCase();
      items = cat.modules.filter((m) => !q || [m.title, m.name, m.description, ...m.routes.map((r) => r.path + r.summary)].join(' ').toLowerCase().includes(q)).slice(0, 12);
      sel = Math.min(sel, Math.max(items.length - 1, 0));
      list.innerHTML = items.map((m, i) => `<a class="sk-item ${i === sel ? 'active' : ''}" href="#/api/${encodeURIComponent(m.name)}" data-i="${i}">
        <span>${icon(catOf(m.category).icon)}</span><span class="grow"><b>${esc(m.title)}</b><span class="small faint mono"> ${esc(m.routes[0]?.path ?? '')}</span></span></a>`).join('') || '<div class="empty">没有匹配的接口</div>';
    };
    $('#sk', root).addEventListener('input', () => { sel = 0; draw(); });
    $('#sk', root).addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, items.length - 1); draw(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); }
      if (e.key === 'Enter' && items[sel]) { location.hash = `#/api/${encodeURIComponent(items[sel].name)}`; close(); }
    });
    list.addEventListener('click', () => close());
    draw();
  });
  $('#sk')?.focus();
}
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
});

function pageNotFound() {
  $('#main').innerHTML = '<div class="wrap"><div class="empty" style="padding:120px 0"><h1 style="font-size:48px;margin-bottom:8px">404</h1><p>页面不存在，<a href="#/">返回首页</a></p></div></div>';
}

// ---------- 路由 ----------
let prefetched = false;
async function router({ keepScroll = false } = {}) {
  const hash = location.hash.replace(/^#\/?/, '');
  if (hash === 'catalog') return;
  const [page, arg, sub, extra] = hash.split('/');
  const routeName = { '': 'home', api: 'api', docs: 'docs', status: 'status', login: 'auth', register: 'auth', reset: 'auth', console: 'console', admin: 'admin' }[page] ?? 'none';
  navToken++;
  renderTopbar(routeName);
  // 换一个新的 #main：上一个页面挂在上面的事件监听随之清除，不会越积越多
  const oldMain = $('#main');
  const scrollY = window.scrollY;
  const freshMain = oldMain.cloneNode(true);
  oldMain.replaceWith(freshMain);
  if (!keepScroll) window.scrollTo(0, 0);
  if (!prefetched) { prefetched = true; setTimeout(prefetchPages, 1500); }
  try {
    await loadCatalog();
    switch (page) {
      case '': await pageHome(); break;
      case 'api': await pageApi(decodeURIComponent(arg ?? '')); break;
      case 'docs': await pageDocs(); break;
      case 'status': await pageStatus(); break;
      case 'login': case 'register': case 'reset': pageAuth(page); break;
      case 'console': await pageConsole(arg); break;
      case 'admin': await (arg === 'settings' ? pageAdminSettings(sub, extra) : arg === 'users' ? pageAdminUsers() : arg === 'changelog' ? pageAdminChangelog() : pageAdmin()); break;
      default: pageNotFound();
    }
  } catch (err) {
    $('#main').innerHTML = `<div class="wrap"><div class="empty" style="padding:100px 0">加载失败：${esc(err.message)}</div></div>`;
  }
  if (keepScroll) window.scrollTo(0, scrollY);
  document.title = { home: 'Miao API', api: 'Miao API · 接口', docs: 'Miao API · 文档', auth: 'Miao API · 登录', console: 'Miao API · 控制台', admin: 'Miao API · 管理' }[routeName] ?? 'Miao API';
}

window.addEventListener('hashchange', () => router());
loadMe().then(() => router());


// ---------- AI 分析接口失败原因（管理后台） ----------
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-diagnose]');
  if (b) openDiagnose(b.dataset.diagnose);
});

function openDiagnose(path) {
  modal(`<div class="diag"><h2>AI 分析 <span class="mono small faint">${esc(path)}</span></h2>
    <div id="diag-body"><div class="row" style="gap:10px;padding:18px 0"><span class="spinner"></span>
      <span class="muted small">正在汇总最近 7 天的调用记录，并实际调用一次该接口，再交给 AI 分析，大约需要 10~30 秒…</span></div></div>
    <div class="actions"><button class="btn" data-close>关闭</button></div></div>`, async (root, close) => {
    $('[data-close]', root).onclick = close;
    const body = $('#diag-body', root);
    let r;
    try {
      r = await api('POST', '/admin/diagnose', { path });
    } catch (err) {
      body.innerHTML = `<div class="form-error">${esc(err.message)}</div>
        ${/AI/.test(err.message) ? '<p class="small"><a href="#/admin/settings/ai">去「设置 → AI」配置</a></p>' : ''}`;
      $('a', body)?.addEventListener('click', close);
      return;
    }
    const d = r.diagnosis;
    const ev = r.evidence;
    const tone = { 正常: 'ok', 部分失败: 'warn', 故障: 'danger' }[d.status] ?? '';
    const list = (items) => (items.length ? `<ul class="diag-list">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="small faint">无</p>');
    const live = ev.liveTest;
    const liveText = live.skipped ? `未测试（${esc(live.skipped)}）`
      : live.ok ? `<span style="color:var(--ok)">成功</span>，耗时 ${fmtNum(live.ms)} ms`
        : `<span style="color:var(--danger)">失败 ${live.status}</span>：${esc(live.error)}（${fmtNum(live.ms)} ms）`;
    body.innerHTML = `
      <div class="row" style="gap:8px;flex-wrap:wrap;margin:6px 0 12px"><span class="badge ${tone}">${esc(d.status)}</span>
        <span class="badge">${esc(d.category)}</span><span class="small faint">判断把握：${esc(d.confidence)}</span></div>
      <p style="margin:0 0 14px;line-height:1.7"><b>${esc(d.summary)}</b></p>
      <div class="small faint">可能原因</div>${list(d.causes)}
      <div class="small faint">处理建议</div>${list(d.suggestions)}
      <details class="upd-tech" style="margin-top:12px"><summary class="small faint">分析依据</summary>
        <div class="small" style="margin-top:8px;line-height:1.8">
          近 7 天调用 ${fmtNum(ev.last7d.calls)} 次，失败 ${fmtNum(ev.last7d.failed ?? 0)} 次，平均 ${fmtNum(ev.last7d.avgMs ?? 0)} ms<br>
          刚才实际调用：${liveText}<br>
          ${ev.module.env.length ? `所需密钥：${ev.module.env.map((x) => `${esc(x.name)} ${x.configured ? '已配置' : x.optional ? '未配置（可选）' : '<b style="color:var(--danger)">未配置</b>'}`).join('，')}<br>` : ''}
          数据来源：${esc(ev.module.source ?? '—')}${ev.module.unofficial ? '（非官方）' : ''}
        </div>
        ${ev.errors.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>状态</th><th>失败原因</th><th class="num">次数</th></tr></thead><tbody>
          ${ev.errors.map((x) => `<tr><td><span class="badge danger">${x.status}</span></td><td class="small">${esc(x.error ?? '（旧记录没有保存原因）')}</td><td class="num">${fmtNum(x.n)}</td></tr>`).join('')}
        </tbody></table></div>` : ''}
        <div class="small faint" style="margin-top:6px">模型 ${esc(r.model ?? '')} · ${shortDate(r.at)}</div>
      </details>`;
  });
}

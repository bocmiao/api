/* 市场层：接口广场 / 工具箱 / 排行榜 / 套餐 / 导航（无构建、无依赖） */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (Number(n) || 0).toLocaleString('en-US');
  const plain = (n) => { n = Number(n) || 0; return n >= 1e8 ? `${(n / 1e8).toFixed(1)}亿` : n >= 1e4 ? `${(n / 1e4).toFixed(1)}万` : fmt(n); };
  const params = () => new URLSearchParams(location.search);
  const isDark = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const CAT_ICO = { games: '🎮', hot: '🔥', life: '☀️', finance: '📈', fun: '✨', ai: '🤖', tools: '🛠️', net: '🌐' };

  const state = { user: null, quota: null, route: location.pathname };
  const memo = { catalog: null, stats: null, overview: null, links: null };

  async function api(method, path, body) {
    const res = await fetch(path, {
      method, credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json;
    try { json = await res.json(); } catch { throw new Error(`请求失败（${res.status}）`); }
    if (json.code !== 200) throw new Error(json.message || `请求失败（${res.status}）`);
    return json.data;
  }

  const ensure = {
    catalog: () => (memo.catalog ??= api('GET', '/api')),
    stats: () => (memo.stats ??= api('GET', '/stats/modules')),
    overview: () => (memo.overview ??= api('GET', '/site/overview')),
    links: () => (memo.links ??= api('GET', '/site/links')),
    notices: () => (memo.notices ??= api('GET', '/site/notices')),
  };

  function noticeKey(n) {
    const day = new Date().toISOString().slice(0, 10);
    return `market-notice:${n.id}:${n.frequency === 'daily' ? day : 'once'}`;
  }
  async function loadNotices() {
    try {
      const list = await ensure.notices();
      const active = (list || []).filter((n) => n.mode === 'bar' && !localStorage.getItem(noticeKey(n)));
      if (!active.length) return;
      $('#notice-bar').innerHTML = active.map((n) => `<div class="market-notice ${esc(n.level)}"><b>${esc(n.title)}</b><span>${esc(n.content)}</span><button type="button" data-notice="${n.id}" aria-label="关闭">×</button></div>`).join('');
      $$('#notice-bar [data-notice]').forEach((b) => b.addEventListener('click', () => {
        const n = active.find((x) => String(x.id) === b.dataset.notice);
        if (n) localStorage.setItem(noticeKey(n), '1');
        b.parentElement.remove();
      }));
    } catch { /* 公告失败不影响页面 */ }
  }

  // ---------- 顶栏 ----------
  function topbar() {
    const u = state.user;
    const q = state.quota;
    const p = location.pathname;
    const links = [
      ['/', '首页', p === '/'], ['/square', '广场', p === '/square'], ['/tools', '工具箱', p === '/tools'],
      ['/ranking', '排行', p === '/ranking'], ['/packages', '套餐', p === '/packages'], ['/nav', '导航', p === '/nav'],
      ['/docs', '文档', p === '/docs'],
      ...(u ? [['/console', '控制台', p.startsWith('/console')]] : []),
    ];
    $('#topbar').innerHTML = `<div class="wrap">
      <a class="logo" href="/"><span class="logo-mark"><img src="/favicon.svg" alt="" width="16" height="16"></span>Miao API</a>
      <nav class="nav" id="nav">${links.map(([h, t, a]) => `<a href="${h}" class="${a ? 'active' : ''}">${t}</a>`).join('')}</nav>
      <div class="topbar-right">
        ${q ? `<span class="quota-pill" title="今日调用额度，北京时间 0 点重置">今日剩余 ${fmt(q.remaining)} / ${fmt(q.limit)}</span>` : ''}
        <button class="btn ghost icon" id="theme" title="切换主题" aria-label="切换主题">${isDark() ? '☀' : '☾'}</button>
        ${u ? `<button class="btn ghost icon" id="logout" title="退出登录" aria-label="退出登录">⎋</button>`
            : '<a class="btn ghost" href="/login">登录</a><a class="btn primary" href="/register">免费注册</a>'}
        <button class="btn ghost icon menu-btn" id="menu" aria-label="菜单">☰</button>
      </div></div>`;
    $('#theme').onclick = () => {
      const next = isDark() ? 'light' : 'dark';
      localStorage.setItem('theme', next);
      document.documentElement.dataset.theme = next;
      topbar();
    };
    $('#menu').onclick = () => $('#nav').classList.toggle('open');
    $('#logout')?.addEventListener('click', async () => {
      await api('POST', '/auth/logout', {}).catch(() => {});
      location.href = '/';
    });
  }

  // ---------- 页面骨架 ----------
  const main = () => $('#main');
  const loading = () => { main().innerHTML = '<div class="market-wrap"><div class="loading"><span class="spinner"></span></div></div>'; };
  const hero = (title, desc, stats = [], crumb = '') => `<section class="market-hero"><div>${crumb ? `<div class="crumbs">${crumb}</div>` : ''}<h1>${esc(title)}</h1><p>${esc(desc)}</p></div><div class="hero-stats">${stats.map(([v, l]) => `<div class="stat-pill"><b>${v}</b><span>${esc(l)}</span></div>`).join('')}</div></section>`;

  function go(query) {
    const url = new URL(location.href);
    for (const [k, v] of Object.entries(query)) {
      if (v === null || v === undefined || v === '' || v === 'all') url.searchParams.delete(k);
      else url.searchParams.set(k, v);
    }
    history.replaceState(null, '', url);
    route();
  }

  // ---------- 接口广场 ----------
  function moduleRows(catalog, stats) {
    return catalog.modules.map((m) => ({ ...m, st: stats[m.name] || {} }));
  }

  async function square() {
    loading();
    const [catalog, stats, ov] = await Promise.all([ensure.catalog(), ensure.stats(), ensure.overview()]);
    const sp = params();
    const f = {
      q: sp.get('q') || '', cat: sp.get('cat') || 'all', type: sp.get('type') || 'all',
      method: sp.get('method') || 'all', sort: sp.get('sort') || 'recommend', page: Math.max(1, Number(sp.get('page')) || 1),
    };
    const all = moduleRows(catalog, stats);
    const routes = all.reduce((n, m) => n + m.routes.length, 0);
    let list = all.filter((m) => {
      if (f.cat !== 'all' && m.category !== f.cat) return false;
      if (f.type === 'featured' && !(m.featured || m.pinned)) return false;
      if (f.type === 'needkey' && m.available !== false) return false;
      if (f.type === 'learning' && !m.unofficial) return false;
      if (f.type === 'custom' && !m.custom) return false;
      if (f.method !== 'all' && !m.routes.some((r) => r.method === f.method)) return false;
      if (f.q) {
        const text = [m.title, m.description, m.name, m.source, ...m.routes.map((r) => r.path + ' ' + (r.summary || ''))].join(' ').toLowerCase();
        if (!text.includes(f.q.toLowerCase())) return false;
      }
      return true;
    });
    if (f.sort === 'hot') list.sort((a, b) => (b.st.total || 0) - (a.st.total || 0));
    else if (f.sort === 'name') list.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
    else list.sort((a, b) => ((b.pinned ? 2 : 0) + (b.featured ? 1 : 0)) - ((a.pinned ? 2 : 0) + (a.featured ? 1 : 0)) || (b.st.total || 0) - (a.st.total || 0));
    const size = 12;
    const pages = Math.max(1, Math.ceil(list.length / size));
    const page = Math.min(f.page, pages);
    const view = list.slice((page - 1) * size, page * size);

    const card = (m) => {
      const badges = [
        m.featured || m.pinned ? '<span class="tag brand">推荐</span>' : '',
        !m.available ? '<span class="tag warn">需配置</span>' : '<span class="tag ok">免费</span>',
        m.unofficial ? '<span class="tag">学习专用</span>' : '',
        m.custom ? '<span class="tag">自建</span>' : '',
        m.routes.some((r) => r.raw) ? '<span class="tag">原始响应</span>' : '',
      ].filter(Boolean).join('');
      const st = m.st.status === 'fail' ? 'warn' : m.st.status === 'idle' ? 'idle' : '';
      const method = m.routes[0]?.method || 'GET';
      return `<a class="api-card" href="/docs/${encodeURIComponent(m.name)}">
        <div class="api-head"><span class="api-ico">${CAT_ICO[m.category] || '•'}</span><div style="min-width:0"><div class="api-title">${esc(m.title)}</div><div class="api-path">${method} ${esc(m.routes[0]?.path || '')}${m.routes.length > 1 ? ` +${m.routes.length - 1}` : ''}</div></div></div>
        <p class="api-desc">${esc(m.description || m.routes[0]?.summary || '')}</p>
        <div class="api-badges">${badges}</div>
        <div class="api-foot"><span><i class="status-dot ${st}"></i>${m.st.status === 'fail' ? '异常' : m.st.status === 'idle' ? '待调用' : '正常'}</span><span>${plain(m.st.total || 0)} 次调用</span></div>
      </a>`;
    };

    const cats = [{ id: 'all', title: '全部分类', icon: '▦', count: all.length }, ...catalog.categories];
    main().innerHTML = `<div class="market-wrap">
      ${hero('接口广场', '一个 Key 调用常用数据。按分类、调用方式或热度筛选，点开卡片查看参数、返回字段、在线调试和示例代码。', [
        [String(catalog.modules.length), '开放接口'], [String(routes), '调用地址'],
        [plain(ov?.requestTotal || 0), '累计调用'], [ov?.today?.availability != null ? `${ov.today.availability}%` : '—', '今日成功率'],
      ], '<a href="/">首页</a> / 接口广场')}
      <div class="market-tabs"><a class="active" href="/square">接口广场</a><a href="/tools">工具箱</a><a href="/ranking">排行榜</a><a href="/packages">套餐</a><a href="/nav">导航</a></div>
      <div class="square-layout">
        <aside class="side-panel">
          <div class="side-title">分类</div>
          <div class="cat-list">${cats.map((c) => `<button class="cat-item ${f.cat === c.id ? 'active' : ''}" data-cat="${c.id}"><span class="ico">${CAT_ICO[c.id] || '▦'}</span><span>${esc(c.title)}</span><span class="n">${c.count}</span></button>`).join('')}</div>
          <div class="side-note">找不到想要的接口？<a href="/links">提交友链</a> 或在 GitHub 提 Issue；自部署后也可以自己加模块。</div>
        </aside>
        <section class="square-main">
          <form class="search-row" id="search"><input id="q" value="${esc(f.q)}" placeholder="搜索接口名称、路径、说明……" autocomplete="off"><button class="btn primary" type="submit">搜索</button></form>
          <div class="filter-panel">
            <div class="filter-row"><span class="filter-label">类型</span>
              ${[['all', '全部'], ['featured', '推荐'], ['needkey', '需配置'], ['learning', '学习专用'], ['custom', '自建']].map(([v, t]) => `<button class="chip ${f.type === v ? 'active' : ''}" data-type="${v}">${t}</button>`).join('')}
            </div>
            <div class="filter-row"><span class="filter-label">方式</span>
              ${[['all', '全部'], ['GET', 'GET'], ['POST', 'POST']].map(([v, t]) => `<button class="chip ${f.method === v ? 'active' : ''}" data-method="${v}">${t}</button>`).join('')}
              <span class="filter-label" style="margin-left:12px">排序</span>
              <select id="sort"><option value="recommend" ${f.sort === 'recommend' ? 'selected' : ''}>综合排序</option><option value="hot" ${f.sort === 'hot' ? 'selected' : ''}>调用最多</option><option value="name" ${f.sort === 'name' ? 'selected' : ''}>名称 A-Z</option></select>
            </div>
          </div>
          <div class="result-meta"><span>共 ${list.length} 个接口</span><span>第 ${page} / ${pages} 页</span></div>
          <div class="api-grid">${view.length ? view.map(card).join('') : '<div class="empty" style="grid-column:1/-1">没有匹配的接口，换个关键词试试。</div>'}</div>
          <div class="pager">
            <button id="prev" ${page <= 1 ? 'disabled' : ''}>上一页</button>
            ${Array.from({ length: Math.min(pages, 9) }, (_, i) => { const n = pages <= 9 ? i + 1 : Math.max(1, Math.min(pages - 8, page - 4)) + i; return `<button data-page="${n}" class="${n === page ? 'on' : ''}">${n}</button>`; }).join('')}
            <button id="next" ${page >= pages ? 'disabled' : ''}>下一页</button>
          </div>
        </section>
      </div></div>`;

    $('#search').onsubmit = (e) => { e.preventDefault(); go({ q: $('#q').value.trim(), page: 1 }); };
    $$('.cat-item').forEach((b) => (b.onclick = () => go({ cat: b.dataset.cat, page: 1 })));
    $$('[data-type]').forEach((b) => (b.onclick = () => go({ type: b.dataset.type, page: 1 })));
    $$('[data-method]').forEach((b) => (b.onclick = () => go({ method: b.dataset.method, page: 1 })));
    $('#sort').onchange = (e) => go({ sort: e.target.value, page: 1 });
    $('#prev')?.addEventListener('click', () => go({ page: Math.max(1, page - 1) }));
    $('#next')?.addEventListener('click', () => go({ page: Math.min(pages, page + 1) }));
    $$('[data-page]').forEach((b) => (b.onclick = () => go({ page: b.dataset.page })));
  }

  // ---------- 工具箱 ----------
  const TOOL_CATS = [['all', '全部工具'], ['codec', '编码转换'], ['hash', '哈希加密'], ['time', '时间日期'], ['text', '文本处理'], ['dev', '开发辅助']];
  const TOOLS = [
    { id: 'json', cat: 'codec', ico: '{ }', name: 'JSON 格式化', desc: '格式化、压缩、校验 JSON' },
    { id: 'base64', cat: 'codec', ico: 'B64', name: 'Base64', desc: 'UTF-8 文本编码 / 解码' },
    { id: 'url', cat: 'codec', ico: '%', name: 'URL 编解码', desc: 'encodeURIComponent / decode' },
    { id: 'html', cat: 'codec', ico: '</>', name: 'HTML 转义', desc: '实体编码 / 解码' },
    { id: 'jwt', cat: 'codec', ico: 'JWT', name: 'JWT 解码', desc: '查看 Header 与 Payload' },
    { id: 'sha256', cat: 'hash', ico: '#', name: 'SHA-256', desc: '浏览器 Web Crypto 计算' },
    { id: 'sha1', cat: 'hash', ico: '#', name: 'SHA-1', desc: '兼容旧系统校验' },
    { id: 'md5', cat: 'hash', ico: 'MD5', name: 'MD5', desc: '32 位小写 MD5' },
    { id: 'timestamp', cat: 'time', ico: '⏱', name: '时间戳转换', desc: 'Unix 时间戳与日期互转' },
    { id: 'uuid', cat: 'dev', ico: 'ID', name: 'UUID', desc: '生成 v4 UUID' },
    { id: 'regex', cat: 'text', ico: '.*', name: '正则测试', desc: '实时匹配与分组结果' },
    { id: 'password', cat: 'dev', ico: '•••', name: '随机密码', desc: '可选长度与字符集' },
    { id: 'textstats', cat: 'text', ico: '¶', name: '文本统计', desc: '字符、词、行、字节数' },
    { id: 'color', cat: 'dev', ico: '◉', name: '颜色转换', desc: 'HEX / RGB / HSL 互转' },
    { id: 'radix', cat: 'dev', ico: '0x', name: '进制转换', desc: '2 / 8 / 10 / 16 进制' },
    { id: 'case', cat: 'text', ico: 'Aa', name: '大小写转换', desc: '大写、小写、首字母、驼峰' },
  ];

  const toolPanel = (id) => {
    const t = TOOLS.find((x) => x.id === id);
    if (!t) return '';
    const out = (label = '输出') => `<label>${label}</label><div class="tool-out" id="out">等待操作…</div>`;
    const copyBtn = '<button class="btn ghost" id="copy" type="button">复制结果</button>';
    let body = '';
    if (id === 'json') body = `<label>JSON</label><textarea id="a" placeholder='{"hello":"world"}'></textarea><div class="tool-actions"><button class="btn primary" id="run1">格式化</button><button class="btn" id="run2">压缩</button><button class="btn ghost" id="run3">校验</button>${copyBtn}</div>${out()}`;
    else if (id === 'base64') body = `<label>文本 / Base64</label><textarea id="a" placeholder="输入文本或 Base64"></textarea><div class="tool-actions"><button class="btn primary" id="run1">编码</button><button class="btn" id="run2">解码</button>${copyBtn}</div>${out()}`;
    else if (id === 'url') body = `<label>文本</label><textarea id="a" placeholder="输入 URL 或文本"></textarea><div class="tool-actions"><button class="btn primary" id="run1">编码</button><button class="btn" id="run2">解码</button>${copyBtn}</div>${out()}`;
    else if (id === 'html') body = `<label>文本</label><textarea id="a" placeholder="<div>hello</div>"></textarea><div class="tool-actions"><button class="btn primary" id="run1">转义</button><button class="btn" id="run2">还原</button>${copyBtn}</div>${out()}`;
    else if (id === 'jwt') body = `<label>JWT</label><textarea id="a" placeholder="eyJhbGciOi..."></textarea><div class="tool-actions"><button class="btn primary" id="run1">解码</button>${copyBtn}</div>${out('Header + Payload')}`;
    else if (id === 'sha256' || id === 'sha1' || id === 'md5') body = `<label>文本</label><textarea id="a" placeholder="输入要计算的文本"></textarea><div class="tool-actions"><button class="btn primary" id="run1">计算</button>${copyBtn}</div>${out('哈希值')}`;
    else if (id === 'timestamp') body = `<div class="tool-grid-2"><div><label>Unix 时间戳（秒 / 毫秒）</label><input id="a" type="text" placeholder="1700000000"></div><div><label>日期时间</label><input id="b" type="datetime-local"></div></div><div class="tool-actions"><button class="btn primary" id="run1">时间戳 → 日期</button><button class="btn" id="run2">日期 → 时间戳</button><button class="btn ghost" id="run3">当前时间</button>${copyBtn}</div>${out()}`;
    else if (id === 'uuid') body = `<label>生成数量</label><input id="a" type="number" value="5" min="1" max="50"><div class="tool-actions"><button class="btn primary" id="run1">生成</button>${copyBtn}</div>${out()}`;
    else if (id === 'regex') body = `<div class="tool-grid-2"><div><label>表达式</label><input id="p" type="text" placeholder="\\d+"></div><div><label>修饰符</label><input id="f" type="text" placeholder="g" value="g"></div></div><label>测试文本</label><textarea id="a" placeholder="abc 123 def 456"></textarea><div class="tool-actions"><button class="btn primary" id="run1">匹配</button>${copyBtn}</div>${out('匹配结果')}`;
    else if (id === 'password') body = `<div class="tool-row"><div><label>长度</label><input id="len" type="number" value="20" min="4" max="128"></div><div><label>包含</label><select id="mode"><option value="all">大小写 + 数字 + 符号</option><option value="alnum">大小写 + 数字</option><option value="num">纯数字</option></select></div></div><div class="tool-actions"><button class="btn primary" id="run1">生成</button>${copyBtn}</div>${out('密码')}`;
    else if (id === 'textstats') body = `<label>文本</label><textarea id="a" placeholder="粘贴文本"></textarea><div class="tool-actions"><button class="btn primary" id="run1">统计</button></div>${out('统计结果')}`;
    else if (id === 'color') body = `<label>颜色（#RRGGBB 或 rgb(...)）</label><input id="a" type="text" value="#4f46e5"><div class="tool-actions"><button class="btn primary" id="run1">转换</button>${copyBtn}</div>${out()}`;
    else if (id === 'radix') body = `<div class="tool-row"><div><label>数值</label><input id="a" type="text" value="255"></div><div><label>原进制</label><select id="from"><option>2</option><option>8</option><option selected>10</option><option>16</option></select></div><div><label>目标进制</label><select id="to"><option>2</option><option>8</option><option>10</option><option selected>16</option></select></div></div><div class="tool-actions"><button class="btn primary" id="run1">转换</button>${copyBtn}</div>${out()}`;
    else if (id === 'case') body = `<label>文本</label><textarea id="a" placeholder="hello World"></textarea><div class="tool-actions"><button class="btn primary" id="run1">大写</button><button class="btn" id="run2">小写</button><button class="btn" id="run3">首字母</button><button class="btn" id="run4">驼峰</button>${copyBtn}</div>${out()}`;
    return `<section class="tool-panel"><h2>${t.ico} ${esc(t.name)}</h2><p class="hint">${esc(t.desc)}。所有计算都在浏览器本地完成，不会上传。</p>${body}</section>`;
  };

  // 工具函数
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  function b64encode(s) { const b = enc.encode(s); let bin = ''; for (const x of b) bin += String.fromCharCode(x); return btoa(bin).replace(/(.{76})/g, '$1\n'); }
  function b64decode(s) { const bin = atob(s.replace(/\s+/g, '')); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return dec.decode(b); }
  function htmlEncode(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function htmlDecode(s) { const t = document.createElement('textarea'); t.innerHTML = s; return t.value; }
  async function digest(algo, s) { const h = await crypto.subtle.digest(algo, enc.encode(s)); return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
  const b64url = (s) => b64decode(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  function md5(s) {
    const K = [0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391];
    const R = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    const bytes = enc.encode(s), len = bytes.length;
    const padded = new Uint8Array((((len + 8) >> 6) + 1) << 6);
    padded.set(bytes); padded[len] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, (len * 8) >>> 0, true);
    dv.setUint32(padded.length - 4, Math.floor(len * 8 / 0x100000000), true);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let off = 0; off < padded.length; off += 64) {
      const M = []; for (let i = 0; i < 16; i++) M.push(dv.getUint32(off + i * 4, true));
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        const tmp = D; D = C; C = B;
        const sum = (A + F + K[i] + M[g]) | 0;
        B = (B + ((sum << R[i]) | (sum >>> (32 - R[i])))) | 0;
        A = tmp;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    const out = new DataView(new ArrayBuffer(16));
    [a0, b0, c0, d0].forEach((v, i) => out.setUint32(i * 4, v, true));
    return [...new Uint8Array(out.buffer)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  const setOut = (s) => { const o = $('#out'); if (o) o.textContent = s; };
  const copyOut = () => { navigator.clipboard.writeText($('#out')?.textContent || '').then(() => { const b = $('#copy'); if (b) { b.textContent = '已复制'; setTimeout(() => (b.textContent = '复制结果'), 1200); } }); };

  function bindTool(id) {
    $('#copy')?.addEventListener('click', copyOut);
    const val = () => $('#a')?.value ?? '';
    if (id === 'json') {
      $('#run1').onclick = () => { try { setOut(JSON.stringify(JSON.parse(val()), null, 2)); } catch (e) { setOut('JSON 错误：' + e.message); } };
      $('#run2').onclick = () => { try { setOut(JSON.stringify(JSON.parse(val()))); } catch (e) { setOut('JSON 错误：' + e.message); } };
      $('#run3').onclick = () => { try { JSON.parse(val()); setOut('✓ 合法 JSON'); } catch (e) { setOut('✗ ' + e.message); } };
    } else if (id === 'base64') {
      $('#run1').onclick = () => { try { setOut(b64encode(val())); } catch (e) { setOut('编码失败：' + e.message); } };
      $('#run2').onclick = () => { try { setOut(b64decode(val())); } catch (e) { setOut('解码失败：不是合法 Base64'); } };
    } else if (id === 'url') {
      $('#run1').onclick = () => setOut(encodeURIComponent(val()));
      $('#run2').onclick = () => { try { setOut(decodeURIComponent(val())); } catch { setOut('解码失败：包含非法转义'); } };
    } else if (id === 'html') {
      $('#run1').onclick = () => setOut(htmlEncode(val()));
      $('#run2').onclick = () => setOut(htmlDecode(val()));
    } else if (id === 'jwt') {
      $('#run1').onclick = () => { try { const [h, p] = val().trim().split('.'); setOut('HEADER\n' + JSON.stringify(JSON.parse(b64url(h)), null, 2) + '\n\nPAYLOAD\n' + JSON.stringify(JSON.parse(b64url(p)), null, 2)); } catch { setOut('不是合法的 JWT'); } };
    } else if (id === 'sha256' || id === 'sha1' || id === 'md5') {
      $('#run1').onclick = async () => {
        const text = val();
        setOut('计算中…');
        try { setOut(id === 'md5' ? md5(text) : await digest(id === 'sha256' ? 'SHA-256' : 'SHA-1', text)); } catch (e) { setOut('计算失败：' + e.message); }
      };
    } else if (id === 'timestamp') {
      $('#run1').onclick = () => { const n = Number(val()); if (!n) return setOut('请输入时间戳'); const ms = n < 1e12 ? n * 1000 : n; const d = new Date(ms); setOut(`本地时间：${d.toLocaleString()}\nISO UTC：${d.toISOString()}\n毫秒：${ms}\n秒：${Math.floor(ms / 1000)}`); };
      $('#run2').onclick = () => { const v = $('#b').value; if (!v) return setOut('请选择日期时间'); const ms = new Date(v).getTime(); setOut(`秒：${Math.floor(ms / 1000)}\n毫秒：${ms}\nISO：${new Date(ms).toISOString()}`); };
      $('#run3').onclick = () => { const ms = Date.now(); $('#a').value = Math.floor(ms / 1000); setOut(`当前秒：${Math.floor(ms / 1000)}\n当前毫秒：${ms}\n本地：${new Date(ms).toLocaleString()}`); };
    } else if (id === 'uuid') {
      $('#run1').onclick = () => { const n = Math.max(1, Math.min(50, Number(val()) || 1)); const list = Array.from({ length: n }, () => crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); })); setOut(list.join('\n')); };
    } else if (id === 'regex') {
      $('#run1').onclick = () => { try { const re = new RegExp($('#p').value, $('#f').value); const text = val(); const m = [...text.matchAll(re)]; setOut(m.length ? m.map((x, i) => `${i + 1}. ${x[0]}  @${x.index}${x.length > 1 ? `  分组: ${x.slice(1).join(' | ')}` : ''}`).join('\n') : '没有匹配'); } catch (e) { setOut('正则错误：' + e.message); } };
    } else if (id === 'password') {
      $('#run1').onclick = () => { const len = Math.max(4, Math.min(128, Number($('#len').value) || 20)); const mode = $('#mode').value; const sets = mode === 'num' ? '0123456789' : mode === 'alnum' ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' : 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+[]{};:,.?'; const a = new Uint32Array(len); crypto.getRandomValues(a); setOut([...a].map((x) => sets[x % sets.length]).join('')); };
    } else if (id === 'textstats') {
      $('#run1').onclick = () => { const t = val(); setOut(`字符：${t.length}\n字符（不含空白）：${t.replace(/\s/g, '').length}\n行数：${t ? t.split(/\r?\n/).length : 0}\n词数：${(t.trim().match(/\S+/g) || []).length}\nUTF-8 字节：${enc.encode(t).length}`); };
    } else if (id === 'color') {
      $('#run1').onclick = () => { let s = val().trim(); let m; if ((m = s.match(/^#?([0-9a-f]{6})$/i))) { const n = parseInt(m[1], 16); const r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255; const hsl = rgb2hsl(r, g, b); setOut(`HEX：#${m[1].toLowerCase()}\nRGB：rgb(${r}, ${g}, ${b})\nHSL：hsl(${hsl[0]}, ${hsl[1]}%, ${hsl[2]}%)`); } else if ((m = s.match(/rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/))) { setOut(`HEX：#${[m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('')}`); } else setOut('支持 #RRGGBB 或 rgb(r,g,b)'); };
    } else if (id === 'radix') {
      $('#run1').onclick = () => { try { const n = BigInt(parseInt(val().trim(), Number($('#from').value))); setOut(n.toString(Number($('#to').value))); } catch { setOut('数值不合法'); } };
    } else if (id === 'case') {
      const t = () => val();
      $('#run1').onclick = () => setOut(t().toUpperCase());
      $('#run2').onclick = () => setOut(t().toLowerCase());
      $('#run3').onclick = () => setOut(t().replace(/\b\w/g, (c) => c.toUpperCase()));
      $('#run4').onclick = () => setOut(t().trim().toLowerCase().replace(/[^a-z0-9]+(.)/g, (_, c) => c.toUpperCase()));
    }
  }

  function rgb2hsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b); let h = 0, s = 0; const l = (max + min) / 2;
    if (max !== min) { const d = max - min; s = l > .5 ? d / (2 - max - min) : d / (max + min); h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; }
    return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
  }

  async function tools() {
    loading();
    const sp = params();
    const active = sp.get('tool') || '';
    const cat = sp.get('cat') || 'all';
    const list = TOOLS.filter((t) => cat === 'all' || t.cat === cat);
    main().innerHTML = `<div class="market-wrap">
      ${hero('工具箱', '编码、哈希、时间戳、正则、颜色……常用的开发小工具，全部在浏览器本地计算。', [[String(TOOLS.length), '个工具'], ['6', '个分类'], ['0', '次上传']], '<a href="/">首页</a> / 工具箱')}
      <div class="market-tabs"><a href="/square">接口广场</a><a class="active" href="/tools">工具箱</a><a href="/ranking">排行榜</a><a href="/packages">套餐</a><a href="/nav">导航</a></div>
      <div class="tool-layout">
        <aside class="side-panel"><div class="side-title">工具分类</div><div class="cat-list">${TOOL_CATS.map(([id, name]) => `<button class="cat-item ${cat === id ? 'active' : ''}" data-cat="${id}"><span>${name}</span><span class="n">${id === 'all' ? TOOLS.length : TOOLS.filter((t) => t.cat === id).length}</span></button>`).join('')}</div></aside>
        <div>${active ? toolPanel(active) : ''}
          <div class="tool-grid">${list.map((t) => `<button class="tool-card" data-tool="${t.id}" type="button"><span class="ico">${t.ico}</span><span><b>${esc(t.name)}</b><span>${esc(t.desc)}</span></span></button>`).join('')}</div>
        </div>
      </div></div>`;
    $$('.cat-item').forEach((b) => (b.onclick = () => go({ cat: b.dataset.cat, tool: null })));
    $$('[data-tool]').forEach((b) => (b.onclick = () => go({ tool: b.dataset.tool })));
    if (active) bindTool(active);
  }

  // ---------- 排行榜 ----------
  function chart(series) {
    const w = 640, h = 190, pad = 26, max = Math.max(1, ...series.map((d) => d.ok + d.fail));
    const x = (i) => pad + (i * (w - pad * 2)) / Math.max(1, series.length - 1);
    const y = (v) => h - pad - (v / max) * (h - pad * 2);
    const line = (key) => series.map((d, i) => `${x(i)},${y(d[key] ?? 0)}`).join(' ');
    const area = `${pad},${h - pad} ${line('ok')} ${x(series.length - 1)},${h - pad}`;
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="近 7 日调用趋势">
      ${[0, .5, 1].map((p) => `<line x1="${pad}" x2="${w - pad}" y1="${h - pad - p * (h - pad * 2)}" y2="${h - pad - p * (h - pad * 2)}" stroke="var(--border)" stroke-dasharray="3 4"/>`).join('')}
      <polygon points="${area}" fill="var(--brand-soft)" opacity=".8"/>
      <polyline points="${line('ok')}" fill="none" stroke="var(--series-1)" stroke-width="2"/>
      <polyline points="${line('fail')}" fill="none" stroke="var(--series-2)" stroke-width="2"/>
      ${series.map((d, i) => `<text x="${x(i)}" y="${h - 8}" font-size="9" fill="var(--text-3)" text-anchor="middle">${esc(d.day?.slice(5) || '')}</text>`).join('')}
    </svg>
    <div class="chart-legend"><span><i class="dot" style="background:var(--series-1)"></i>成功</span><span><i class="dot" style="background:var(--series-2)"></i>失败</span></div>`;
  }

  async function ranking() {
    loading();
    const [catalog, stats, ov] = await Promise.all([ensure.catalog(), ensure.stats(), ensure.overview()]);
    const mods = moduleRows(catalog, stats);
    const top = [...mods].sort((a, b) => (b.st.total || 0) - (a.st.total || 0)).slice(0, 10);
    const max = Math.max(1, ...top.map((m) => m.st.total || 0));
    const cats = catalog.categories.map((c) => ({ ...c, count: mods.filter((m) => m.category === c.id).length })).sort((a, b) => b.count - a.count);
    const maxCat = Math.max(1, ...cats.map((c) => c.count));
    const status = mods.reduce((acc, m) => { const s = m.st.status === 'fail' ? 'fail' : m.st.status === 'idle' ? 'idle' : 'ok'; acc[s]++; return acc; }, { ok: 0, fail: 0, idle: 0 });
    main().innerHTML = `<div class="market-wrap">
      ${hero('API 调用排行榜', '公开的调用统计与接口热度。数据每分钟更新，只统计聚合接口本身，不包含控制台访问。', [
        [plain(ov?.requestTotal || 0), '累计调用'], [plain(ov?.today?.calls || 0), '今日调用'],
        [ov?.today?.availability != null ? `${ov.today.availability}%` : '—', '今日成功率'], [String(ov?.apis || mods.length), '开放接口'], [String(ov?.users || 0), '注册用户'],
      ], '<a href="/">首页</a> / 排行榜')}
      <div class="market-tabs"><a href="/square">接口广场</a><a href="/tools">工具箱</a><a class="active" href="/ranking">排行榜</a><a href="/packages">套餐</a><a href="/nav">导航</a></div>
      <div class="rank-grid">
        <section class="panel"><h2>接口热度 TOP 10 <small>累计调用</small></h2><div class="rank-list">${top.map((m, i) => `<div class="rank-row"><span class="idx">${String(i + 1).padStart(2, '0')}</span><div class="bar-wrap"><div class="name"><b>${esc(m.title)}</b><span class="val">${plain(m.st.total || 0)}</span></div><div class="bar"><i style="width:${Math.max(2, ((m.st.total || 0) / max) * 100)}%"></i></div></div></div>`).join('') || '<div class="empty">还没有调用数据</div>'}</div></section>
        <section class="panel"><h2>近 7 日趋势 <small>不含今天</small></h2>${chart(ov?.trend || [])}<div style="margin-top:12px;display:flex;gap:18px;font-size:12px;color:var(--text-2)"><span>今日成功 <b>${fmt(Math.max(0, (ov?.today?.calls || 0) - (ov?.today?.fail || 0)))}</b></span><span>今日失败 <b>${fmt(ov?.today?.fail || 0)}</b></span><span>24h 可用率 <b>${ov?.last24h?.availability != null ? `${ov.last24h.availability}%` : '—'}</b></span></div></section>
      </div>
      <div class="rank-grid" style="margin-top:16px">
        <section class="panel"><h2>分类分布 <small>${mods.length} 个接口</small></h2><div class="cat-bars">${cats.map((c) => `<div class="cat-bar"><span>${esc(c.title)}</span><div class="bar"><i style="width:${(c.count / maxCat) * 100}%"></i></div><span>${c.count}</span></div>`).join('')}</div></section>
        <section class="panel"><h2>运行状态 <small><a href="/status">详细状态 →</a></small></h2><div class="rank-list"><div class="rank-row"><span class="idx">●</span><div class="bar-wrap"><div class="name"><b>正常</b><span class="val">${status.ok} 个</span></div><div class="bar"><i style="width:${(status.ok / Math.max(1, mods.length)) * 100}%;background:var(--ok)"></i></div></div></div><div class="rank-row"><span class="idx">●</span><div class="bar-wrap"><div class="name"><b>异常</b><span class="val">${status.fail} 个</span></div><div class="bar"><i style="width:${(status.fail / Math.max(1, mods.length)) * 100}%;background:var(--warn)"></i></div></div></div><div class="rank-row"><span class="idx">●</span><div class="bar-wrap"><div class="name"><b>待调用</b><span class="val">${status.idle} 个</span></div><div class="bar"><i style="width:${(status.idle / Math.max(1, mods.length)) * 100}%;background:var(--text-3)"></i></div></div></div></div></section>
      </div></div>`;
  }

  // ---------- 套餐 ----------
  async function packages() {
    loading();
    const catalog = await ensure.catalog();
    const L = catalog.limits || { anonDaily: 100, userDaily: 10000 };
    const plans = [
      { name: '匿名使用', price: '¥0', sub: '无需注册', items: [`每天 ${fmt(L.anonDaily)} 次`, '全部接口', '跨域调用', '无需 API Key'], cta: '直接调用', href: '/docs', featured: false },
      { name: '注册用户', price: '¥0', sub: '免费注册', items: [`每天 ${fmt(L.userDaily)} 次`, 'API Key 管理', '调用统计', '推送订阅', '兑换码加次数'], cta: '免费注册', href: '/register', featured: true },
      { name: '额度包', price: '按需', sub: '兑换码 / 联系管理员', items: ['额外调用次数', '不过期', '控制台兑换', '适合临时高峰'], cta: '控制台兑换', href: '/console', featured: false },
      { name: '自部署', price: '¥0', sub: 'GPL-3.0 开源', items: ['无调用限制', '自己加接口', '数据在自己服务器', 'Node.js / Docker'], cta: 'GitHub 开源', href: 'https://github.com/bocmiao/api', featured: false },
    ];
    main().innerHTML = `<div class="market-wrap">
      ${hero('接口套餐', '在线站点目前不接支付。免费额度足够日常使用；需要更多次数可以注册、用兑换码，或直接自部署。', [[String(catalog.modules.length), '开放接口'], [String(L.anonDaily), '匿名/天'], [String(L.userDaily), '注册/天'], ['0', '付费门槛']], '<a href="/">首页</a> / 套餐')}
      <div class="market-tabs"><a href="/square">接口广场</a><a href="/tools">工具箱</a><a href="/ranking">排行榜</a><a class="active" href="/packages">套餐</a><a href="/nav">导航</a></div>
      <div class="notice-box">当前站点没有开通在线支付。套餐页只说明额度与使用方式；额外次数通过兑换码或管理员发放，不产生自动扣费。</div>
      <div class="plan-grid">${plans.map((p) => `<div class="plan ${p.featured ? 'featured' : ''}"><h3>${p.name}${p.featured ? ' <span class="tag brand">推荐</span>' : ''}</h3><div class="price">${p.price} <small>${p.sub}</small></div><ul>${p.items.map((i) => `<li>${i}</li>`).join('')}</ul><a class="btn ${p.featured ? 'primary' : ''}" href="${p.href}" ${p.href.startsWith('http') ? 'target="_blank" rel="noopener"' : ''}>${p.cta}</a></div>`).join('')}</div>
      <section class="panel"><h2>额度对比</h2><table class="compare"><thead><tr><th>项目</th><th>匿名</th><th>注册</th><th>兑换码</th><th>自部署</th></tr></thead><tbody><tr><td>调用额度</td><td>${fmt(L.anonDaily)} / 天</td><td>${fmt(L.userDaily)} / 天</td><td>额外次数</td><td>无限制</td></tr><tr><td>API Key</td><td>—</td><td>✓</td><td>✓</td><td>✓</td></tr><tr><td>调用统计</td><td>—</td><td>✓</td><td>✓</td><td>✓</td></tr><tr><td>推送订阅</td><td>—</td><td>✓</td><td>✓</td><td>✓</td></tr><tr><td>数据位置</td><td>本站</td><td>本站</td><td>本站</td><td>自己的服务器</td></tr></tbody></table></section>
      </div>`;
  }

  // ---------- 导航 ----------
  async function nav() {
    loading();
    const data = await ensure.links();
    const sp = params(); const q = (sp.get('q') || '').toLowerCase();
    const links = (data.links || []).filter((l) => !q || [l.name, l.description, l.url].join(' ').toLowerCase().includes(q));
    const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
    main().innerHTML = `<div class="market-wrap">
      ${hero('导航', '一些常用、好用的站点和工具。友链申请通过后会出现在这里；也可以在首页底部看到。', [[String((data.links || []).length), '个站点'], [String(links.length), '当前筛选'], ['∞', '随时补充']], '<a href="/">首页</a> / 导航')}
      <div class="market-tabs"><a href="/square">接口广场</a><a href="/tools">工具箱</a><a href="/ranking">排行榜</a><a href="/packages">套餐</a><a class="active" href="/nav">导航</a></div>
      <div class="search-row" style="margin-top:18px"><form id="search" style="display:flex;gap:8px;flex:1"><input id="q" value="${esc(sp.get('q') || '')}" placeholder="搜索站点、描述、域名……"><button class="btn primary" type="submit">搜索</button></form><a class="btn" href="/links">申请友链</a></div>
      <div class="nav-grid">${links.length ? links.map((l) => `<a class="nav-card" href="${esc(l.url)}" target="_blank" rel="noopener"><span class="nav-avatar">${esc((l.name || '?').slice(0, 1))}</span><span style="min-width:0"><b>${esc(l.name)}</b><span>${esc(l.description || '')}</span><span class="nav-host">${esc(host(l.url))}</span></span></a>`).join('') : '<div class="empty" style="grid-column:1/-1">还没有匹配的站点。</div>'}</div>
      </div>`;
    $('#search').onsubmit = (e) => { e.preventDefault(); go({ q: $('#q').value.trim() }); };
  }

  // ---------- 路由 ----------
  const routes = { '/square': square, '/tools': tools, '/ranking': ranking, '/packages': packages, '/nav': nav };
  async function route() {
    state.route = location.pathname;
    topbar();
    const fn = routes[location.pathname];
    if (!fn) { location.href = '/'; return; }
    try { await fn(); } catch (e) {
      main().innerHTML = `<div class="market-wrap"><div class="empty">加载失败：${esc(e.message)}<br><br><button class="btn" onclick="location.reload()">重试</button></div></div>`;
    }
  }

  // 只拦截市场内部链接，其他页面走完整刷新
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a || a.target || a.origin !== location.origin) return;
    if (!routes[a.pathname]) return;
    e.preventDefault();
    history.pushState(null, '', a.pathname + a.search);
    route();
  });
  window.addEventListener('popstate', route);

  // 启动
  (async () => {
    try { const me = await api('GET', '/auth/me'); state.user = me.user; state.quota = me.quota; } catch {}
    topbar();
    loadNotices();
    route();
  })();
})();

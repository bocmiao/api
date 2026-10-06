// 站点运营相关的页面和组件：首页平台数据与开源部署、接口文档页的状态码与调用统计、公告、友情链接、
// 管理后台「运营」（公告、友链审核、兑换码、操作日志、登录记录）和接口运行参数。
// 与 app.js 共用全局函数（$、esc、api、modal 等），在 app.js 之后加载。

const REPO_URL = 'https://github.com/bocmiao/api';

// 时长：毫秒 → 「30 分钟」「2 小时」
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${+(s / 60).toFixed(1)} 分钟`;
  if (s < 86400) return `${+(s / 3600).toFixed(1)} 小时`;
  return `${+(s / 86400).toFixed(1)} 天`;
}

// 文字转 HTML：先转义，再把网址变成链接、换行变成 <br>
const linkify = (text) => esc(text).replace(/https?:\/\/[^\s<>"']+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`).replace(/\n/g, '<br>');

// 响应栏里的请求 ID：点击复制
function ridBadge(rid) {
  return rid ? `<button type="button" class="badge rid" title="请求 ID，反馈问题时附上它；点击复制" data-copy-text="${esc(rid)}">ID ${esc(rid)}</button>` : '';
}

// 页面安全策略不允许内联 onclick：带 data-copy-text 的元素统一在这里处理复制
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy-text]');
  if (b) { e.preventDefault(); copy(b.dataset.copyText); }
});

// 返回数据里第一张图片的地址（壁纸、头像、封面等），最多找 3 层
function findImageUrl(data, depth = 0) {
  if (!data || depth > 3) return null;
  const isImg = (v) => typeof v === 'string' && /^https:\/\/[^\s"'<>]+\.(?:jpe?g|png|gif|webp|avif)(?:[?#][^\s"'<>]*)?$/i.test(v);
  if (Array.isArray(data)) {
    for (const x of data.slice(0, 5)) { const f = findImageUrl(x, depth + 1); if (f) return f; }
    return null;
  }
  if (typeof data !== 'object') return null;
  for (const v of Object.values(data)) if (isImg(v)) return v;
  for (const v of Object.values(data)) if (v && typeof v === 'object') { const f = findImageUrl(v, depth + 1); if (f) return f; }
  return null;
}

// ---------- 错误码说明（开发文档、接口状态码表共用） ----------
const ERROR_DOCS = [
  ['400', 'BAD_REQUEST', '参数缺失或格式不对，message 里写了具体哪个参数'],
  ['401', 'INVALID_API_KEY', 'API Key 无效或已删除（不带 Key 也能调用，带了就必须正确）'],
  ['401', 'LOGIN_REQUIRED', '该接口需要登录后使用'],
  ['403', 'KEY_DISABLED', '该 Key 已停用'],
  ['403', 'KEY_SOURCE_DENIED', '不满足该 Key 的来源限制（IP 或网站域名）'],
  ['403', 'KEY_SCOPE_DENIED', '该 Key 没有调用这个接口的权限'],
  ['403', 'API_DISABLED', '接口已被站长关闭'],
  ['404', 'NOT_FOUND', '接口或数据不存在'],
  ['405', 'METHOD_NOT_ALLOWED', '请求方法不对（如 POST 接口用了 GET）'],
  ['429', 'QUOTA_EXCEEDED', '今日额度已用完，北京时间 0 点重置'],
  ['429', 'RATE_LIMITED', '请求太快，超过每分钟上限'],
  ['500', 'INTERNAL_ERROR', '服务器内部错误'],
  ['502', 'UPSTREAM_ERROR', '上游数据源出错（不扣额度）'],
  ['503', 'SERVICE_UNAVAILABLE', '服务端未配置所需的密钥（不扣额度）'],
  ['503', 'API_SUSPENDED', '接口暂停服务，message 里写了原因（不扣额度）'],
  ['504', 'UPSTREAM_TIMEOUT', '上游数据源响应超时（不扣额度）'],
];

// ---------- 接口文档页 ----------
function cacheLine(r) {
  if (r.cacheTtl == null) return '';
  return r.cacheTtl > 0
    ? `<p class="small cache-line">${icon('zap')}缓存 <b>${fmtDuration(r.cacheTtl)}</b>：相同参数在这段时间内直接返回缓存数据（响应里 <code>cached: true</code>、响应头 <code>X-Cache: HIT</code>），上游故障时返回最近一次成功的数据</p>`
    : `<p class="small cache-line">${icon('zap')}实时获取，不缓存</p>`;
}

// 状态码表：该接口可能返回的状态码，近 7 天实际出现的次数异步填入
function codesTable(m, r) {
  const redirect = r.raw && /302/.test(r.returns ?? r.summary ?? '');
  const codes = new Map([redirect ? ['302', '成功：跳转到目标地址（图片等）'] : ['200', r.raw ? '成功' : '成功，数据在 data 里']]);
  if (r.params.length) codes.set('400', '参数缺失或格式不对');
  codes.set('401', 'API Key 无效');
  codes.set('403', 'Key 已停用、不满足 Key 的来源限制或接口范围、接口被关闭');
  codes.set('429', '超过每日额度或每分钟上限');
  if (m.source && !/本地/.test(m.source)) {
    codes.set('502', '上游数据源出错（不扣额度）');
    codes.set('504', '上游数据源响应超时（不扣额度）');
  }
  if (m.env.length || m.suspended) codes.set('503', m.suspended ? '接口暂停服务' : '服务端未配置所需的密钥');
  codes.set('500', '服务器内部错误（不扣额度）');
  const rows = [...codes].sort((a, b) => a[0] - b[0]);
  return `<div class="table-wrap"><table class="table codes-table" data-path="${esc(r.path)}"><thead><tr><th>状态码</th><th>说明</th><th class="num">近 7 天</th></tr></thead><tbody>
    ${rows.map(([c, d]) => `<tr data-code="${c}"><td><span class="badge ${c < 300 ? 'ok' : c < 500 ? 'warn' : 'danger'}">${c}</span></td><td>${esc(d)}</td><td class="num faint">—</td></tr>`).join('')}
  </tbody></table></div><p class="small faint" style="margin:6px 0 0">失败时返回内容里有 <code>errorCode</code>，含义见 <a href="/docs">开发文档「错误码」</a>。</p>`;
}

const moduleStatsCache = new Map();
async function loadRouteStats(m, r) {
  const box = $('#sec-stats');
  let d = moduleStatsCache.get(m.name);
  try {
    if (!d || Date.now() - d.at > 60_000) {
      d = { at: Date.now(), data: await api('GET', `/stats/module/${encodeURIComponent(m.name)}`) };
      moduleStatsCache.set(m.name, d);
    }
  } catch (err) {
    if (box) box.innerHTML = `<div class="small faint">调用统计加载失败：${esc(err.message)}</div>`;
    return;
  }
  if (!box?.isConnected) return;
  const st = d.data.routes[r.path];
  if (!st) { box.remove(); return; }
  // 状态码表里填上近 7 天出现的次数；表里没有的状态码追加一行
  const tbody = $(`.codes-table[data-path="${CSS.escape(r.path)}"] tbody`);
  for (const c of st.codes) {
    let tr = tbody?.querySelector(`[data-code="${c.status}"]`);
    if (!tr && tbody) {
      tbody.insertAdjacentHTML('beforeend', `<tr data-code="${c.status}"><td><span class="badge ${c.status < 300 ? 'ok' : c.status < 500 ? 'warn' : 'danger'}">${c.status}</span></td><td class="faint">其他</td><td class="num"></td></tr>`);
      tr = tbody.lastElementChild;
    }
    if (tr) { tr.lastElementChild.textContent = fmtNum(c.n); tr.lastElementChild.classList.remove('faint'); }
  }
  const sum = (list) => list.reduce((n, x) => n + x.calls, 0);
  const tw = sum(st.thisWeek);
  const lw = sum(st.lastWeek);
  const delta = lw ? Math.round(((tw - lw) / lw) * 1000) / 10 : null;
  const w = d.data.week;
  const chart = weekChart(st.thisWeek, st.lastWeek);
  box.innerHTML = `<div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px"><h3 style="font-size:15px">调用统计</h3>
      <span class="small faint">最近 7 个完整的天（不含今天）与再往前 7 天对比</span></div>
    <div class="mini-tiles">
      <div><span>累计调用</span><b>${fmtNum(st.total)}</b></div>
      <div><span>近 7 天</span><b>${fmtNum(tw)}</b>${delta != null ? `<em class="${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '+' : ''}${delta}%</em>` : ''}</div>
      <div title="整个接口（含全部调用地址）最近 7 天"><span>成功率</span><b>${w.successRate != null ? `${w.successRate}%` : '—'}</b></div>
      <div title="整个接口最近 7 天，P50 / P95 为耗时中位数和 95% 分位"><span>耗时 P50 / P95</span><b>${w.p50 != null ? `${fmtNum(w.p50)} / ${fmtNum(w.p95)} ms` : '—'}</b></div>
      ${w.cacheHit != null ? `<div><span>缓存命中</span><b>${w.cacheHit}%</b></div>` : ''}
    </div>
    ${chart.html}`;
  chart.mount(box);
}

// 本周（柱，成功 / 失败堆叠）与上周（折线）对比图
function weekChart(thisWeek, lastWeek) {
  const H = 180, padL = 36, padB = 22, padT = 10;
  const max = Math.max(4, ...thisWeek.map((x) => x.calls), ...lastWeek.map((x) => x.calls));
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const niceMax = Math.ceil(max / step) * step;
  const y = (v) => H - padB - (v / niceMax) * (H - padB - padT);
  const fmtTick = (t) => (t >= 1000 ? `${+(t / 1000).toFixed(1)}k` : +t.toFixed(1));
  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const label = (day) => `${day.slice(5).replace('-', '/')} ${WEEK[new Date(`${day}T00:00:00Z`).getUTCDay()]}`;
  function svg(W) {
    const bw = (W - padL) / thisWeek.length;
    const barW = Math.max(6, Math.min(30, bw * 0.5));
    const cx = (i) => padL + i * bw + bw / 2;
    const bars = thisWeek.map((d, i) => {
      const x = cx(i) - barW / 2;
      const okH = y(0) - y(d.ok);
      const failH = y(0) - y(d.fail);
      return `<g class="col" data-i="${i}"><rect class="hover-bg" x="${padL + i * bw}" y="${padT}" width="${bw}" height="${H - padB - padT}" rx="4"/>
        ${d.ok ? `<rect class="bar" x="${x}" y="${y(d.ok)}" width="${barW}" height="${Math.max(1, okH)}" rx="3"/>` : ''}
        ${d.fail ? `<rect class="bar fail" x="${x}" y="${y(d.ok + d.fail)}" width="${barW}" height="${Math.max(1, failH)}" rx="3"/>` : ''}
        <text class="axis" x="${cx(i)}" y="${H - 6}" text-anchor="middle">${bw < 60 ? d.day.slice(8) : label(d.day)}</text>
        <rect class="hit" x="${padL + i * bw}" y="0" width="${bw}" height="${H}"/></g>`;
    }).join('');
    const line = lastWeek.map((d, i) => `${i ? 'L' : 'M'}${cx(i)},${y(d.calls)}`).join('');
    const dots = lastWeek.map((d, i) => `<circle class="prev-dot" cx="${cx(i)}" cy="${y(d.calls)}" r="2.5"/>`).join('');
    const grid = [0, niceMax / 2, niceMax].map((t) => `<line class="gridline" x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/>
      <text class="axis" x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${fmtTick(t)}</text>`).join('');
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="近 7 天调用量与上周对比">${grid}${bars}<path class="prev-line" d="${line}"/>${dots}</svg>`;
  }
  return {
    html: `<div class="legend"><span><i class="swatch"></i>成功</span><span><i class="swatch fail"></i>失败</span><span><i class="swatch prev"></i>上周同期</span></div>
      <div class="chart"><div class="plot"></div><div class="tooltip" hidden></div></div>`,
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
        const i = Number(g.dataset.i);
        const a = thisWeek[i];
        const b = lastWeek[i];
        tip.innerHTML = `<div class="t">${esc(a.day)}</div><div class="v">成功 <b>${fmtNum(a.ok)}</b> · 失败 <b>${fmtNum(a.fail)}</b></div>
          <div class="v faint">上周同期 ${esc(b.day)}：<b>${fmtNum(b.calls)}</b> 次</div>`;
        tip.hidden = false;
        const box = chart.getBoundingClientRect();
        tip.style.left = `${Math.max(4, Math.min(e.clientX - box.left + 12, box.width - tip.offsetWidth - 4))}px`;
        tip.style.top = `${e.clientY - box.top - tip.offsetHeight - 10}px`;
      });
      chart.addEventListener('mouseleave', () => { tip.hidden = true; });
    },
  };
}

// ---------- 首页：平台数据、开源部署、友情链接 ----------
function ossSection() {
  return `<section class="section"><div class="card oss-card">
    <div class="oss-text">
      <div class="badge brand" style="margin-bottom:10px">GPL v3 开源</div>
      <h2>开源免费，可以部署到自己的服务器</h2>
      <p>Miao API 的全部源码都在 GitHub 上。只需要 Node.js 22.13 以上或 Docker，<b>没有任何 npm 依赖</b>；部署后第一个注册的账号就是管理员，额度、密钥、接口开关都在网页后台里设置，有新版本时后台一键更新。</p>
      <div class="row" style="gap:10px;flex-wrap:wrap;margin-top:16px">
        <a class="btn primary" href="${REPO_URL}" target="_blank" rel="noopener">${icon('github')}GitHub 仓库</a>
        <a class="btn" href="/about#deploy">查看部署步骤</a>
        <a class="btn ghost" href="${REPO_URL}/issues" target="_blank" rel="noopener">反馈问题</a>
      </div>
    </div>
    <div class="code-window"><div class="bar"><i></i><i></i><i></i></div><pre><span class="j-null"># 需要 Node.js 22.13+，没有任何 npm 依赖</span>
git clone ${REPO_URL}.git miao-api
cd miao-api
npm start

<span class="j-null"># 或者用 Docker</span>
docker build -t miao-api .
docker run -d -p 3000:3000 \\
  -v miao-api-data:/app/data miao-api</pre>
      <button class="btn sm ghost oss-copy" type="button" data-copy-text="${esc(`git clone ${REPO_URL}.git miao-api\ncd miao-api\nnpm start`)}">${icon('copy')}复制</button></div>
  </div></section>`;
}

let platformCache = null;
async function loadPlatform() {
  const sec = $('#platform');
  if (!sec) return;
  try {
    if (!platformCache || Date.now() - platformCache.at > 60_000) platformCache = { at: Date.now(), data: await api('GET', '/site/overview') };
  } catch { return; }
  const d = platformCache.data;
  if (!d || !sec.isConnected) return;
  const delta = d.last24h.delta;
  const tiles = [
    ['开放接口', fmtNum(d.apis), `${fmtNum(d.routes)} 个调用地址`],
    ['累计调用', fmtCompact(d.requestTotal), '上线以来的接口调用'],
    ['注册用户', fmtNum(d.users), '免费注册即可创建 API Key'],
    ['今日调用', fmtNum(d.today.calls), '北京时间今天 0 点起'],
    ['24 小时调用', fmtNum(d.last24h.calls), delta == null ? '与前 24 小时比较' : `${delta >= 0 ? '比前 24 小时多' : '比前 24 小时少'} ${Math.abs(delta)}%`],
    ['24 小时可用率', d.last24h.availability != null ? `${d.last24h.availability}%` : '—', '不含参数错误等调用方原因'],
  ];
  const rows = d.trend.map((t) => ({ day: t.day, ok: t.ok, fail: t.fail }));
  const chart = barChart(rows, [{ key: 'ok', label: '成功' }, { key: 'fail', label: '失败', cls: 'fail' }]);
  sec.hidden = false;
  sec.innerHTML = `<div class="section-title"><h2>平台数据</h2><span class="small faint">实时统计，每分钟更新 · <a href="/status">运行状态</a></span></div>
    <div class="platform-tiles">${tiles.map(([l, v, h]) => `<div class="card tile"><div class="label">${l}</div><div class="value">${v}</div><div class="small faint">${esc(h)}</div></div>`).join('')}</div>
    <div class="grid-2 platform-grid">
      <div class="card"><div class="card-head"><h2>近 7 天调用</h2><span class="small faint">不含还没过完的今天</span></div>${chart.html}</div>
      <div class="card"><div class="card-head"><h2>热门接口</h2><span class="small faint">近 7 天调用最多</span></div>
        ${d.hot.length ? `<ol class="hot-list">${d.hot.map((h, i) => `<li><span class="rank r${i + 1}">${i + 1}</span><a href="/docs/${encodeURIComponent(h.name)}">${esc(h.title)}</a><span class="faint small">${fmtCompact(h.calls)} 次</span></li>`).join('')}</ol>`
          : '<div class="empty">还没有调用数据</div>'}</div>
    </div>`;
  chart.mount(sec);
}

async function loadHomeLinks() {
  const sec = $('#home-links');
  if (!sec) return;
  let d;
  try { d = await api('GET', '/site/links'); } catch { return; }
  if (!d.links.length || !sec.isConnected) return;
  sec.hidden = false;
  sec.innerHTML = `<div class="section-title"><h2>友情链接</h2><a class="small" href="/links">申请友链 →</a></div>
    <div class="home-links">${d.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.description || l.url)}">${esc(l.name)}</a>`).join('')}</div>`;
}

// ---------- 友情链接页 ----------
async function pageLinks() {
  const d = await api('GET', '/site/links');
  const host = (u) => { try { return new URL(u).host; } catch { return u; } };
  const STATUS = { pending: ['审核中', 'warn'], approved: ['已通过', 'ok'], rejected: ['未通过', 'danger'] };
  $('#main').innerHTML = `<div class="wrap" style="padding:28px 20px 80px">
    <div class="page-head"><div><h1>友情链接</h1><p>Miao API 的合作伙伴站点，欢迎交换友链</p></div></div>
    ${d.links.length ? `<div class="links-grid">${d.links.map((l) => `<a class="card link-card" href="${esc(l.url)}" target="_blank" rel="noopener">
        <b>${esc(l.name)}</b><span class="small muted">${esc(l.description || '')}</span><span class="small faint mono">${esc(host(l.url))}</span></a>`).join('')}</div>`
      : '<div class="card"><div class="empty">还没有友情链接，欢迎成为第一个</div></div>'}
    <div class="grid-2" style="margin-top:20px">
      <div class="card card-pad">
        <h3 style="font-size:15px;margin-bottom:6px">申请友链</h3>
        ${d.apply.open ? `<p class="small muted" style="margin:0 0 12px">${linkify(d.apply.notice)}</p>
          ${state.user ? `<form id="link-apply"><div class="form-error" hidden></div>
            <div class="field"><label for="la-n">网站名称</label><input class="input" id="la-n" name="name" maxlength="30" required></div>
            <div class="field"><label for="la-u">网站地址</label><input class="input" id="la-u" name="url" type="url" placeholder="https://" required></div>
            <div class="field"><label for="la-d">一句话介绍 <span class="faint">可选</span></label><input class="input" id="la-d" name="description" maxlength="100"></div>
            <button class="btn primary" type="submit">提交申请</button></form>`
          : `<p class="small">请先 <a href="/login">登录</a> 或 <a href="/register">免费注册</a> 后提交申请。</p>`}`
        : '<p class="small muted">暂未开放友链申请。</p>'}
      </div>
      <div class="card card-pad">
        <h3 style="font-size:15px;margin-bottom:10px">本站信息</h3>
        <div class="table-wrap"><table class="table"><tbody>
          <tr><td class="faint">名称</td><td>Miao API</td></tr>
          <tr><td class="faint">地址</td><td class="mono">${esc(location.origin)}</td></tr>
          <tr><td class="faint">介绍</td><td>开源免费的聚合 API 接口平台</td></tr>
          <tr><td class="faint">图标</td><td class="mono">${esc(location.origin)}/favicon.svg</td></tr>
        </tbody></table></div>
        ${d.mine.length ? `<h3 style="font-size:15px;margin:16px 0 8px">我的申请</h3>
          <div class="table-wrap"><table class="table"><tbody>${d.mine.map((l) => {
            const [t, c] = STATUS[l.status] ?? [l.status, ''];
            return `<tr><td>${esc(l.name)}<div class="small faint mono">${esc(host(l.url))}</div></td><td><span class="badge ${c}">${t}</span>${l.note ? `<div class="small faint">${esc(l.note)}</div>` : ''}</td></tr>`;
          }).join('')}</tbody></table></div>` : ''}
      </div>
    </div></div>`;
  const form = $('#link-apply');
  if (form) bindForm(form, async (v) => {
    await api('POST', '/site/links', v);
    toast('已提交，管理员审核通过后展示');
    pageLinks();
  });
}

// ---------- 公告：顶部横条 + 弹窗 ----------
const NOTICE_KEY = 'notices.seen.v1';
const noticeSeen = () => { try { return JSON.parse(localStorage.getItem(NOTICE_KEY)) ?? {}; } catch { return {}; } };
const markNotice = (n, val) => {
  const seen = noticeSeen();
  seen[`${n.id}:${n.updatedAt}`] = val;
  // 只保留最近 50 条记录
  const keys = Object.keys(seen);
  for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete seen[k];
  try { localStorage.setItem(NOTICE_KEY, JSON.stringify(seen)); } catch { /* 无痕模式 */ }
};
const todayStr = () => new Date().toLocaleDateString('en-CA');

async function initNotices() {
  state.noticesLoaded = true;
  let list;
  try { list = await api('GET', '/site/notices'); } catch { return; }
  const seen = noticeSeen();
  const bar = $('#notice-bar');
  const bars = list.filter((n) => n.mode === 'bar' && !seen[`${n.id}:${n.updatedAt}`]);
  if (bar) {
    bar.innerHTML = bars.map((n) => `<div class="notice-bar ${esc(n.level)}" data-nid="${n.id}"><div class="wrap">
      ${icon('megaphone')}<div class="grow"><b>${esc(n.title)}</b>${n.content ? `<span class="notice-text">${linkify(n.content)}</span>` : ''}</div>
      <button class="btn sm ghost icon" type="button" data-nclose="${n.id}" aria-label="关闭公告">${icon('x')}</button></div></div>`).join('');
    bar.onclick = (e) => {
      const b = e.target.closest('[data-nclose]');
      if (!b) return;
      const n = bars.find((x) => x.id === Number(b.dataset.nclose));
      if (n) markNotice(n, 'closed');
      b.closest('.notice-bar').remove();
    };
  }
  // 弹窗一次只弹一个（优先级最高的）
  const popup = list.find((n) => {
    if (n.mode !== 'popup') return false;
    const v = seen[`${n.id}:${n.updatedAt}`];
    return n.frequency === 'always' || (n.frequency === 'daily' ? v !== todayStr() : !v);
  });
  if (popup && !document.querySelector('.modal-back')) {
    modal(`<div class="notice-pop ${esc(popup.level)}"><h2>${icon('megaphone')}${esc(popup.title)}</h2>
      ${popup.content ? `<div class="notice-body">${linkify(popup.content)}</div>` : ''}
      <div class="actions"><button class="btn primary" data-ok>我知道了</button></div></div>`, (root, close) => {
      markNotice(popup, popup.frequency === 'daily' ? todayStr() : 'seen');
      $('[data-ok]', root).onclick = close;
    });
  }
}

// ---------- 管理后台：按请求 ID 查调用 ----------
async function lookupRequest(rid) {
  try {
    const r = await api('GET', `/admin/request?rid=${encodeURIComponent(rid)}`);
    const row = (k, v) => `<tr><td class="faint nowrap">${k}</td><td>${v}</td></tr>`;
    modal(`<h2>请求 ${esc(r.rid)}</h2><div class="table-wrap"><table class="table"><tbody>
      ${row('时间', esc(new Date(r.at).toLocaleString('zh-CN', { hour12: false })))}
      ${row('接口', `<span class="mono">${esc(r.path)}</span>`)}
      ${row('状态', `<span class="badge ${r.status < 400 ? 'ok' : 'danger'}">${r.status}</span> ${fmtNum(r.ms)} ms${r.cached === 1 ? ' · 命中缓存' : r.cached === 2 ? ' · 上游故障返回旧数据' : ''}`)}
      ${r.error ? row('失败原因', `<span style="color:var(--danger)">${esc(r.error)}</span>`) : ''}
      ${row('调用方', r.user ? `${esc(r.user.email)}${r.key ? ` · Key「${esc(r.key.name)}」<span class="mono faint">${esc(r.key.prefix)}…</span>` : ' · 网页登录'}` : '未登录访客')}
      ${row('IP', `<span class="mono">${esc(r.ip ?? '—')}</span> ${esc([r.region, r.isp].filter(Boolean).join(' · '))}`)}
      ${row('来源网站', esc(r.referer ?? '—'))}
      ${row('客户端', esc(r.client ?? '—'))}
      ${row('返回大小', r.bytes != null ? `${fmtNum(r.bytes)} 字节` : '—')}
    </tbody></table></div>
    <div class="actions">${r.status >= 500 && r.path.startsWith('/api/') ? `<button class="btn" data-diagnose="${esc(r.path)}">AI 分析</button>` : ''}<button class="btn primary" data-close>关闭</button></div>`,
    (root, close) => { $('[data-close]', root).onclick = close; });
  } catch (err) { toast(err.message, true); }
}

// ---------- 管理后台：接口运行参数 ----------
function optBadges(o) {
  if (!o) return '';
  return [o.pinned ? '置顶' : '', o.featured ? '推荐' : '', o.cacheTtlMs != null ? '缓存' : '', o.minuteLimit ? '限流' : ''].filter(Boolean)
    .map((t) => ` <span class="badge brand">${t}</span>`).join('');
}

function editModuleOptions(m, onSaved) {
  const o = m.options ?? {};
  modal(`<h2>${esc(m.title)} · 运行参数</h2>
    <form id="mo"><div class="form-error" hidden></div>
      <label class="small" style="display:flex;gap:6px;align-items:center;margin-bottom:8px"><input type="checkbox" name="pinned" ${o.pinned ? 'checked' : ''}> 置顶：首页接口列表排在最前面</label>
      <label class="small" style="display:flex;gap:6px;align-items:center;margin-bottom:14px"><input type="checkbox" name="featured" ${o.featured ? 'checked' : ''}> 推荐：接口卡片和文档页显示「推荐」标签</label>
      <div class="field"><label for="mo-c">缓存时长（秒） <span class="faint">留空使用接口自带的设置，0 表示不缓存</span></label>
        <input class="input" id="mo-c" name="cacheTtlSec" inputmode="numeric" value="${o.cacheTtlMs != null ? Math.round(o.cacheTtlMs / 1000) : ''}" placeholder="接口默认"></div>
      <div class="field"><label for="mo-l">每分钟上限（每个账号 / 每个 IP） <span class="faint">留空不单独限制</span></label>
        <input class="input" id="mo-l" name="minuteLimit" inputmode="numeric" value="${o.minuteLimit ?? ''}" placeholder="不单独限制"></div>
      <div class="actions" style="justify-content:space-between"><button class="btn" type="button" data-clear>清除该接口缓存</button>
        <span class="row" style="gap:8px"><button class="btn" type="button" data-close>取消</button><button class="btn primary" type="submit">保存</button></span></div>
    </form>`, (root, close) => {
    $('[data-close]', root).onclick = close;
    $('[data-clear]', root).onclick = async () => {
      try {
        const r = await api('POST', `/admin/modules/${encodeURIComponent(m.name)}/cache/clear`, {});
        toast(r.cleared ? `已清除 ${r.cleared} 条缓存` : '当前没有缓存数据');
      } catch (err) { toast(err.message, true); }
    };
    bindForm($('#mo', root), async (v) => {
      const opts = await api('PUT', `/admin/modules/${encodeURIComponent(m.name)}/options`, {
        pinned: Boolean(v.pinned), featured: Boolean(v.featured),
        cacheTtlSec: v.cacheTtlSec.trim() === '' ? null : Number(v.cacheTtlSec), minuteLimit: v.minuteLimit.trim() === '' ? null : Number(v.minuteLimit),
      });
      close();
      toast('已保存');
      onSaved?.(opts);
    });
  });
}

// ---------- 管理后台：运营（公告、友链、兑换码、操作日志、登录记录） ----------
const SITE_TABS = [['notices', '公告'], ['links', '友情链接'], ['redeem', '兑换码'], ['audit', '操作日志'], ['logins', '登录记录']];

async function pageAdminSite(tab = 'notices') {
  if (!state.user?.isAdmin) return pageNotFound();
  if (!SITE_TABS.some(([id]) => id === tab)) tab = 'notices';
  $('#main').innerHTML = `<div class="wrap" style="padding:28px 20px 80px">
    <div class="page-head"><div><h1>运营</h1><p>公告、友情链接、兑换码，以及管理操作和登录记录</p></div>${adminTabs('site')}</div>
    <div class="seg" style="margin-bottom:16px">${SITE_TABS.map(([id, t]) => `<a href="/admin/site/${id}" class="${id === tab ? 'active' : ''}">${t}</a>`).join('')}</div>
    <div id="site-panel"><div class="loading"><span class="spinner"></span></div></div></div>`;
  const panel = $('#site-panel');
  try {
    await { notices: adminNotices, links: adminLinks, redeem: adminRedeem, audit: adminAudit, logins: adminLogins }[tab](panel);
  } catch (err) {
    panel.innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
  }
}

const NOTICE_LEVEL = { info: ['普通', ''], warn: ['提醒', 'warn'], important: ['重要', 'danger'] };
const NOTICE_MODE = { bar: '顶部横条', popup: '弹窗' };
const NOTICE_FREQ = { once: '只弹一次', daily: '每天一次', always: '每次打开' };
const NOTICE_AUD = { all: '所有人', guest: '未登录访客', user: '登录用户', admin: '仅管理员' };
const toLocalInput = (iso) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');

async function adminNotices(panel) {
  const list = await api('GET', '/admin/notices');
  panel.innerHTML = `<div class="card"><div class="card-head"><h2>公告</h2><button class="btn sm primary" id="n-new">发布公告</button></div>
    ${list.length ? `<div class="table-wrap" style="padding:8px"><table class="table"><thead><tr><th>标题</th><th>方式</th><th>可见</th><th>时间</th><th class="num">优先级</th><th>状态</th><th></th></tr></thead><tbody>
      ${list.map((n) => {
        const now = Date.now();
        const live = n.enabled && (!n.startsAt || Date.parse(n.startsAt) <= now) && (!n.endsAt || Date.parse(n.endsAt) > now);
        const [lv, lc] = NOTICE_LEVEL[n.level] ?? ['', ''];
        return `<tr><td><span class="badge ${lc}">${lv}</span> ${esc(n.title)}</td>
          <td class="small">${NOTICE_MODE[n.mode]}${n.mode === 'popup' ? ` · ${NOTICE_FREQ[n.frequency]}` : ''}</td><td class="small">${NOTICE_AUD[n.audience]}</td>
          <td class="small faint">${n.startsAt ? fmtDate(n.startsAt) : '立即'} ~ ${n.endsAt ? fmtDate(n.endsAt) : '长期'}</td><td class="num">${n.priority}</td>
          <td>${live ? '<span class="badge ok">展示中</span>' : n.enabled ? '<span class="badge">未在时间内</span>' : '<span class="badge">已关闭</span>'}</td>
          <td class="num nowrap"><button class="btn sm" data-edit="${n.id}">编辑</button> <button class="btn sm danger" data-del="${n.id}">删除</button></td></tr>`;
      }).join('')}</tbody></table></div>` : '<div class="empty">还没有公告。维护通知、上游故障说明、活动推广都可以发在这里</div>'}</div>`;
  const edit = (n = null) => modal(`<h2>${n ? '编辑公告' : '发布公告'}</h2>
    <form id="nf"><div class="form-error" hidden></div>
      <div class="field"><label for="nf-t">标题</label><input class="input" id="nf-t" name="title" maxlength="80" required value="${esc(n?.title ?? '')}"></div>
      <div class="field"><label for="nf-c">内容 <span class="faint">可选，网址会自动变成链接</span></label><textarea class="input" id="nf-c" name="content" rows="4" maxlength="2000">${esc(n?.content ?? '')}</textarea></div>
      <div class="grid-2" style="gap:12px">
        <div class="field"><label>级别</label><select class="input" name="level">${Object.entries(NOTICE_LEVEL).map(([k, [t]]) => `<option value="${k}" ${n?.level === k ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="field"><label>可见人群</label><select class="input" name="audience">${Object.entries(NOTICE_AUD).map(([k, t]) => `<option value="${k}" ${n?.audience === k ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="field"><label>展示方式</label><select class="input" name="mode">${Object.entries(NOTICE_MODE).map(([k, t]) => `<option value="${k}" ${n?.mode === k ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="field"><label>弹窗频率</label><select class="input" name="frequency">${Object.entries(NOTICE_FREQ).map(([k, t]) => `<option value="${k}" ${n?.frequency === k ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="field"><label>开始时间 <span class="faint">留空立即</span></label><input class="input" type="datetime-local" name="startsAt" value="${toLocalInput(n?.startsAt)}"></div>
        <div class="field"><label>结束时间 <span class="faint">留空长期</span></label><input class="input" type="datetime-local" name="endsAt" value="${toLocalInput(n?.endsAt)}"></div>
        <div class="field"><label>优先级 <span class="faint">0~100，越大越靠前</span></label><input class="input" name="priority" inputmode="numeric" value="${n?.priority ?? 0}"></div>
        <div class="field"><label>&nbsp;</label><label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="enabled" ${!n || n.enabled ? 'checked' : ''}> 启用</label></div>
      </div>
      <p class="small faint">顶部横条访客关闭后不再显示；修改公告后会重新显示。</p>
      <div class="actions"><button class="btn" type="button" data-close>取消</button><button class="btn primary" type="submit">保存</button></div>
    </form>`, (root, close) => {
    $('[data-close]', root).onclick = close;
    bindForm($('#nf', root), async (v) => {
      const body = {
        ...v, enabled: Boolean(v.enabled), priority: Number(v.priority || 0),
        startsAt: v.startsAt ? new Date(v.startsAt).toISOString() : null, endsAt: v.endsAt ? new Date(v.endsAt).toISOString() : null,
      };
      await api(n ? 'PUT' : 'POST', n ? `/admin/notices/${n.id}` : '/admin/notices', body);
      close();
      toast('已保存');
      adminNotices(panel);
      initNotices();
    });
  });
  $('#n-new').onclick = () => edit();
  panel.onclick = async (e) => {
    const ed = e.target.closest('[data-edit]');
    if (ed) return edit(list.find((x) => x.id === Number(ed.dataset.edit)));
    const del = e.target.closest('[data-del]');
    if (!del || !(await confirmDialog('删除公告', '删除后无法恢复。', { okText: '删除' }))) return;
    try { await api('DELETE', `/admin/notices/${del.dataset.del}`, {}); adminNotices(panel); } catch (err) { toast(err.message, true); }
  };
}

async function adminLinks(panel) {
  const list = await api('GET', '/admin/links');
  const STATUS = { pending: ['待审核', 'warn'], approved: ['已通过', 'ok'], rejected: ['已拒绝', 'danger'] };
  panel.innerHTML = `<div class="card"><div class="card-head"><h2>友情链接</h2>
      <span class="row" style="gap:8px"><a class="btn sm ghost" href="/admin/settings/site">申请设置</a><a class="btn sm ghost" href="/links">查看友链页</a><button class="btn sm primary" id="l-new">直接添加</button></span></div>
    ${list.length ? `<div class="table-wrap" style="padding:8px"><table class="table"><thead><tr><th>网站</th><th>申请人</th><th>时间</th><th class="num">排序</th><th>状态</th><th></th></tr></thead><tbody>
      ${list.map((l) => {
        const [t, c] = STATUS[l.status];
        return `<tr><td><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.name)}</a><div class="small faint mono">${esc(l.url)}</div>${l.description ? `<div class="small muted">${esc(l.description)}</div>` : ''}</td>
          <td class="small">${esc(l.email ?? '管理员添加')}</td><td class="small faint">${fmtDate(l.createdAt)}</td><td class="num">${l.sort}</td>
          <td><span class="badge ${c}">${t}</span>${l.note ? `<div class="small faint">${esc(l.note)}</div>` : ''}</td>
          <td class="num nowrap">${l.status !== 'approved' ? `<button class="btn sm primary" data-st="approved" data-id="${l.id}">通过</button> ` : ''}${l.status !== 'rejected' ? `<button class="btn sm" data-st="rejected" data-id="${l.id}">拒绝</button> ` : ''}
            <button class="btn sm" data-edit="${l.id}">编辑</button> <button class="btn sm danger" data-del="${l.id}">删除</button></td></tr>`;
      }).join('')}</tbody></table></div>` : '<div class="empty">还没有友链申请</div>'}</div>
    <p class="small faint">审核前请确认对方站点能正常访问、内容合法，并已添加本站链接。</p>`;
  const edit = (l = null) => modal(`<h2>${l ? '编辑友链' : '添加友链'}</h2>
    <form id="lf"><div class="form-error" hidden></div>
      <div class="field"><label>网站名称</label><input class="input" name="name" maxlength="30" required value="${esc(l?.name ?? '')}"></div>
      <div class="field"><label>网站地址</label><input class="input" name="url" type="url" required value="${esc(l?.url ?? '')}" placeholder="https://"></div>
      <div class="field"><label>一句话介绍</label><input class="input" name="description" maxlength="100" value="${esc(l?.description ?? '')}"></div>
      <div class="field"><label>排序 <span class="faint">越大越靠前</span></label><input class="input" name="sort" inputmode="numeric" value="${l?.sort ?? 0}"></div>
      <div class="actions"><button class="btn" type="button" data-close>取消</button><button class="btn primary" type="submit">保存</button></div>
    </form>`, (root, close) => {
    $('[data-close]', root).onclick = close;
    bindForm($('#lf', root), async (v) => {
      await api(l ? 'PUT' : 'POST', l ? `/admin/links/${l.id}` : '/admin/links', { ...v, sort: Number(v.sort || 0) });
      close();
      adminLinks(panel);
    });
  });
  $('#l-new').onclick = () => edit();
  panel.onclick = async (e) => {
    try {
      const st = e.target.closest('[data-st]');
      if (st) {
        let note;
        if (st.dataset.st === 'rejected') {
          note = await promptDialog('拒绝友链', '原因会显示给申请人。', { label: '原因', placeholder: '例如：未添加本站链接', okText: '拒绝', danger: true });
          if (note == null) return;
        }
        await api('PUT', `/admin/links/${st.dataset.id}`, { status: st.dataset.st, ...(note ? { note } : {}) });
        return adminLinks(panel);
      }
      const ed = e.target.closest('[data-edit]');
      if (ed) return edit(list.find((x) => x.id === Number(ed.dataset.edit)));
      const del = e.target.closest('[data-del]');
      if (del && (await confirmDialog('删除友链', '删除后无法恢复。', { okText: '删除' }))) {
        await api('DELETE', `/admin/links/${del.dataset.del}`, {});
        adminLinks(panel);
      }
    } catch (err) { toast(err.message, true); }
  };
}

async function adminRedeem(panel) {
  const list = await api('GET', '/admin/redeem');
  panel.innerHTML = `<div class="card card-pad" style="margin-bottom:16px">
      <h3 style="font-size:15px;margin-bottom:6px">${icon('gift')} 生成兑换码</h3>
      <p class="small muted" style="margin:0 0 12px">用户在「控制台 → 账号设置」兑换，得到的额外次数在当天额度用完后使用，用完为止。适合 QQ 群活动、感谢赞助者，不需要接入在线支付。</p>
      <form id="rf" class="redeem-form"><div class="form-error" hidden></div>
        <div class="field"><label>每个兑换码的次数</label><input class="input" name="calls" inputmode="numeric" required placeholder="例如 10000"></div>
        <div class="field"><label>生成数量</label><input class="input" name="count" inputmode="numeric" value="1"></div>
        <div class="field"><label>每个码可兑换人数</label><input class="input" name="maxUses" inputmode="numeric" value="1"></div>
        <div class="field"><label>过期时间 <span class="faint">可选</span></label><input class="input" type="datetime-local" name="expiresAt"></div>
        <div class="field"><label>备注 <span class="faint">可选</span></label><input class="input" name="note" maxlength="60" placeholder="例如：十月群活动"></div>
        <div class="field"><label>&nbsp;</label><button class="btn primary" type="submit">生成</button></div>
      </form></div>
    <div class="card"><div class="card-head"><h2>兑换码</h2><span class="small faint">最近 500 个</span></div>
      ${list.length ? `<div class="table-wrap" style="padding:8px"><table class="table"><thead><tr><th>兑换码</th><th class="num">次数</th><th class="num">已兑换</th><th>过期</th><th>备注</th><th></th></tr></thead><tbody>
        ${list.map((c) => `<tr><td class="mono"><button class="btn sm ghost" type="button" data-copy-code="${esc(c.code)}" title="复制">${esc(c.code)}</button></td><td class="num">${fmtNum(c.calls)}</td>
          <td class="num">${c.used} / ${c.maxUses}</td><td class="small faint">${c.expiresAt ? fmtDate(c.expiresAt) : '不过期'}</td><td class="small">${esc(c.note ?? '')}</td>
          <td class="num"><button class="btn sm danger" data-del="${esc(c.code)}">删除</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">还没有兑换码</div>'}</div>`;
  bindForm($('#rf'), async (v) => {
    const r = await api('POST', '/admin/redeem', { ...v, calls: Number(v.calls), count: Number(v.count || 1), maxUses: Number(v.maxUses || 1), expiresAt: v.expiresAt ? new Date(v.expiresAt).toISOString() : null });
    modal(`<h2>已生成 ${r.codes.length} 个兑换码</h2><textarea class="input mono" rows="${Math.min(12, r.codes.length + 1)}" readonly>${esc(r.codes.join('\n'))}</textarea>
      <div class="actions"><button class="btn" data-copy-all>全部复制</button><button class="btn primary" data-close>完成</button></div>`, (root, close) => {
      $('[data-copy-all]', root).onclick = () => copy(r.codes.join('\n'));
      $('[data-close]', root).onclick = () => { close(); adminRedeem(panel); };
    });
  });
  panel.onclick = async (e) => {
    const cp = e.target.closest('[data-copy-code]');
    if (cp) return copy(cp.dataset.copyCode);
    const del = e.target.closest('[data-del]');
    if (!del || !(await confirmDialog('删除兑换码', '删除后该码不能再兑换，已兑换的次数不受影响。', { okText: '删除' }))) return;
    try { await api('DELETE', `/admin/redeem/${encodeURIComponent(del.dataset.del)}`, {}); adminRedeem(panel); } catch (err) { toast(err.message, true); }
  };
}

const AUDIT_ACTIONS = {
  'user.limit': '调整用户额度', 'user.disable': '停用 / 启用用户', 'module.enable': '开启接口', 'module.disable': '关闭接口',
  'module.options': '修改接口运行参数', 'module.cache.clear': '清除接口缓存', 'settings.save': '修改系统设置',
  'notice.create': '发布公告', 'notice.update': '修改公告', 'notice.delete': '删除公告',
  'link.create': '添加友链', 'link.update': '修改友链', 'link.approved': '通过友链', 'link.rejected': '拒绝友链', 'link.pending': '友链改为待审核', 'link.delete': '删除友链',
  'redeem.create': '生成兑换码', 'redeem.delete': '删除兑换码',
};

function pager(d, go) {
  const pages = Math.max(1, Math.ceil(d.total / d.size));
  return pages > 1 ? `<div class="row" style="justify-content:center;gap:8px;padding:0 0 16px">
    <button class="btn sm" data-pg="${d.page - 1}" ${d.page <= 1 ? 'disabled' : ''}>上一页</button><span class="small faint">第 ${d.page} / ${pages} 页</span>
    <button class="btn sm" data-pg="${d.page + 1}" ${d.page >= pages ? 'disabled' : ''}>下一页</button></div>` : '';
}

async function adminAudit(panel, page = 1) {
  const d = await api('GET', `/admin/audit?page=${page}`);
  panel.innerHTML = `<div class="card"><div class="card-head"><h2>操作日志</h2><span class="small faint">共 ${fmtNum(d.total)} 条 · 只能新增，不能修改或删除</span></div>
    ${d.items.length ? `<div class="table-wrap" style="padding:8px"><table class="table"><thead><tr><th>时间</th><th>管理员</th><th>操作</th><th>对象</th><th>原因</th></tr></thead><tbody>
      ${d.items.map((a) => `<tr><td class="small faint nowrap">${fmtDate(a.at)}</td><td class="small">${esc(a.admin ?? '—')}</td>
        <td class="small" title="${esc(a.detail ?? '')}">${esc(AUDIT_ACTIONS[a.action] ?? a.action)}</td><td class="small">${esc(a.target ?? '')}</td><td class="small">${esc(a.reason ?? '')}</td></tr>`).join('')}
    </tbody></table></div>${pager(d)}` : '<div class="empty">还没有操作记录</div>'}</div>`;
  panel.onclick = (e) => { const b = e.target.closest('[data-pg]'); if (b) adminAudit(panel, Number(b.dataset.pg)); };
}

async function adminLogins(panel, page = 1, failed = false) {
  const d = await api('GET', `/admin/logins?page=${page}${failed ? '&failed=1' : ''}`);
  panel.innerHTML = `<div class="card"><div class="card-head"><h2>登录记录</h2>
      <label class="small"><input type="checkbox" id="lg-failed" ${failed ? 'checked' : ''}> 只看失败</label></div>
    ${d.items.length ? `<div class="table-wrap" style="padding:8px"><table class="table"><thead><tr><th>时间</th><th>邮箱</th><th>IP</th><th>地区</th><th>客户端</th><th>结果</th></tr></thead><tbody>
      ${d.items.map((l) => `<tr><td class="small faint nowrap">${fmtDate(l.at)}</td><td class="small">${esc(l.email ?? '—')}</td><td class="mono small">${esc(l.ip ?? '—')}</td>
        <td class="small">${esc(l.region ?? '—')}</td><td class="small">${esc(l.client ?? '—')}</td>
        <td>${l.ok ? '<span class="badge ok">成功</span>' : `<span class="badge danger">失败</span> <span class="small faint">${esc(l.reason ?? '')}</span>`}</td></tr>`).join('')}
    </tbody></table></div>${pager(d)}` : '<div class="empty">暂无记录</div>'}
    <p class="small faint" style="padding:0 16px 12px">登录记录保留 180 天。同一 IP 连续输错密码会被暂时限制登录。</p></div>`;
  $('#lg-failed').onchange = (e) => adminLogins(panel, 1, e.target.checked);
  panel.onclick = (e) => { const b = e.target.closest('[data-pg]'); if (b) adminLogins(panel, Number(b.dataset.pg), failed); };
}

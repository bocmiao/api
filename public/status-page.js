// 运行状态页（公开）：总体状态、可用率、进行中的故障、各接口近 90 天可用率条、故障记录
// 依赖 app.js 的全局工具函数（$、esc、fmtNum、fmtCompact、cachedGet、api、icon 等），在 app.js 之后加载

const ST_LABEL = {
  ok: ['正常', 'ok'],
  degraded: ['部分失败', 'warn'],
  down: ['故障', 'danger'],
  idle: ['无数据', ''],
  suspended: ['暂不可用', ''],
};
const ST_HINT = {
  ok: '正常',
  degraded: '部分失败：最近一次检测有部分路径失败，或 24 小时内服务端错误较多',
  down: '故障：有未结束的故障，或最近一次检测全部失败',
  idle: '无数据：24 小时内没有调用，也还没有自动检测',
  suspended: '暂不可用：数据源已停止提供',
};

const STATUS_CSS = `
:root { --st-good: #22a55a; --st-mid: #e5a50a; --st-bad: #e0453a; --st-none: #dcdce2; }
:root[data-theme="dark"] { --st-good: #3fbf6f; --st-mid: #e8b12a; --st-bad: #ef5f57; --st-none: #2e2f36; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --st-good: #3fbf6f; --st-mid: #e8b12a; --st-bad: #ef5f57; --st-none: #2e2f36; } }
.st-page { padding: 28px 20px 80px; }
.st-sec { margin-bottom: 16px; }
.st-hero { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 20px 22px; }
.st-hero-icon { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; flex: none; background: var(--ok-soft); color: var(--ok); }
.st-hero-icon svg { width: 22px; height: 22px; stroke-width: 2.4; }
.st-hero.warn .st-hero-icon { background: var(--warn-soft); color: var(--warn); }
.st-hero.danger .st-hero-icon { background: var(--danger-soft); color: var(--danger); }
.st-hero-main { flex: 1; min-width: 220px; }
.st-hero-title { font-size: 19px; font-weight: 700; }
.st-hero-sub { font-size: 13px; color: var(--text-2); margin-top: 3px; line-height: 1.6; }
.st-hero-side { text-align: right; font-size: 13px; color: var(--text-3); line-height: 1.7; }
.st-hero-side b { color: var(--text-2); font-weight: 600; }
.st-tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)) minmax(0, 1.9fr); gap: 14px; }
.st-tile { padding: 16px 18px; }
.st-tile .st-tl { font-size: 13px; color: var(--text-2); }
.st-tile .st-tv { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; margin-top: 4px; letter-spacing: -0.01em; }
.st-tile .st-tv small { font-size: 14px; font-weight: 600; margin-left: 1px; }
.st-tv.st-good { color: var(--ok); } .st-tv.st-mid { color: var(--warn); } .st-tv.st-bad { color: var(--danger); } .st-tv.st-none { color: var(--text-3); }
.st-counts { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; margin-top: 8px; }
.st-count { display: flex; flex-direction: column; gap: 2px; }
.st-count b { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
.st-count span { font-size: 12px; color: var(--text-2); display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.st-count .status-dot { width: 7px; height: 7px; }
.st-count.zero b { color: var(--text-3); font-weight: 600; }
.st-alert { border-color: color-mix(in srgb, var(--danger) 35%, var(--border)); background: color-mix(in srgb, var(--danger-soft) 70%, var(--surface)); padding: 16px 20px; }
.st-alert-head { display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--danger); font-size: 15px; }
.st-alert-item { display: flex; gap: 10px; padding: 10px 0 0; margin-top: 10px; border-top: 1px solid color-mix(in srgb, var(--danger) 18%, transparent); font-size: 14px; }
.st-alert-head + .st-alert-item { border-top: 0; margin-top: 4px; padding-top: 6px; }
.st-alert-item .status-dot { margin-top: 6px; }
.st-alert-item a { font-weight: 600; color: var(--text); }
.st-meta { font-size: 13px; color: var(--text-2); margin-top: 2px; overflow-wrap: anywhere; }
.st-pulse { animation: st-pulse 1.6s ease-in-out infinite; }
@keyframes st-pulse { 0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--danger) 45%, transparent); } 50% { box-shadow: 0 0 0 5px transparent; } }
.st-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; margin: 22px 0 14px; }
.st-toolbar .search { max-width: 280px; }
.st-chips { display: flex; gap: 6px; flex-wrap: wrap; flex-basis: 100%; min-width: 0; order: 3; }
.st-chips .chip { height: 32px; padding: 0 12px; font-size: 13px; }
.st-seg { flex: none; margin-left: auto; }
.st-seg button { padding: 5px 12px; border-radius: 8px; color: var(--text-2); font-size: 13px; background: none; border: 0; cursor: pointer; font: inherit; font-size: 13px; }
.st-seg button:hover { color: var(--text); }
.st-seg button.active { background: var(--surface); color: var(--text); font-weight: 600; box-shadow: var(--shadow); }
.st-seg button .n { font-size: 12px; opacity: .65; margin-left: 2px; }
.st-cat { margin-bottom: 14px; padding: 6px 20px 8px; }
.st-cat-head { display: flex; align-items: center; gap: 8px; padding: 12px 0 10px; flex-wrap: wrap; }
.st-cat-head h2 { font-size: 15px; font-weight: 600; display: inline-flex; align-items: center; gap: 7px; }
.st-cat-head h2 svg { width: 16px; height: 16px; color: var(--text-2); }
.st-cat-head .st-cat-sum { margin-left: auto; display: flex; gap: 6px; flex-wrap: wrap; }
.st-row, .st-colhead { display: grid; grid-template-columns: minmax(150px, 230px) minmax(0, 1fr) 236px; gap: 6px 22px; align-items: center; }
.st-colhead { font-size: 12px; color: var(--text-3); padding: 0 0 6px; border-bottom: 1px solid var(--border); }
.st-colhead .st-metrics span { text-align: right; }
.st-row { padding: 12px 0 10px; border-bottom: 1px solid var(--border); }
.st-row:last-child { border-bottom: 0; }
.st-name { display: flex; align-items: center; gap: 9px; min-width: 0; }
.st-name a { color: var(--text); font-weight: 500; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.st-name .badge { flex: none; }
.st-name-sub { font-size: 12px; color: var(--text-3); margin: 2px 0 0 19px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.st-name-sub.danger { color: var(--danger); }
.st-name-sub.warn { color: var(--warn); }
.st-barwrap { min-width: 0; }
.st-bar { display: flex; gap: 2px; height: 28px; align-items: stretch; touch-action: manipulation; }
.st-bar i { flex: 1 1 0; min-width: 0; border-radius: 2px; background: var(--st-none); cursor: pointer; transition: opacity .1s, transform .1s; }
.st-bar i.g { background: var(--st-good); }
.st-bar i.y { background: var(--st-mid); }
.st-bar i.r { background: var(--st-bad); }
.st-bar i.on { transform: scaleY(1.12); filter: brightness(1.08); }
.st-bar:hover i:not(.on) { opacity: .7; }
.st-row.susp .st-bar i { background: var(--st-none); }
.st-row.susp .st-name a { color: var(--text-2); }
.st-foot { display: flex; justify-content: space-between; gap: 8px; font-size: 11.5px; color: var(--text-3); margin-top: 5px; white-space: nowrap; }
.st-foot b { font-weight: 600; color: var(--text-2); font-variant-numeric: tabular-nums; }
.st-foot .st-line { flex: 1; height: 1px; background: var(--border); align-self: center; min-width: 8px; }
.st-metrics { display: grid; grid-template-columns: 70px 64px 62px; gap: 0 12px; justify-content: end; align-items: center; font-variant-numeric: tabular-nums; }
.st-m { text-align: right; font-size: 14px; white-space: nowrap; }
.st-m b { font-weight: 600; }
.st-m em { display: none; font-style: normal; }
.st-m small { color: var(--text-3); font-size: 12px; margin-left: 1px; }
.st-m.st-good b { color: var(--ok); } .st-m.st-mid b { color: var(--warn); } .st-m.st-bad b { color: var(--danger); } .st-m.st-none b { color: var(--text-3); font-weight: 400; }
.st-spark { display: block; width: 100%; height: 18px; margin-top: 4px; color: var(--brand); opacity: .75; }
.st-empty { padding: 50px 16px; text-align: center; color: var(--text-3); }
.st-tip { position: fixed; z-index: 60; pointer-events: none; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 6px 24px rgb(0 0 0 / .14); padding: 9px 12px; font-size: 12.5px; line-height: 1.65; min-width: 150px; opacity: 0; transform: translateY(4px); transition: opacity .12s, transform .12s; }
.st-tip.show { opacity: 1; transform: none; }
.st-tip .st-tip-d { font-weight: 600; margin-bottom: 2px; }
.st-tip .st-tip-r { display: flex; justify-content: space-between; gap: 14px; color: var(--text-2); }
.st-tip .st-tip-r b { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }
.st-tip .sw { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; vertical-align: 0; background: var(--st-none); }
.st-tip .sw.g { background: var(--st-good); } .st-tip .sw.y { background: var(--st-mid); } .st-tip .sw.r { background: var(--st-bad); }
.st-hist { padding: 6px 20px 8px; }
.st-hist-item { display: flex; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--border); }
.st-hist-item:last-child { border-bottom: 0; }
.st-hist-item .status-dot { margin-top: 6px; }
.st-hist-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 14px; }
.st-hist-title a { color: var(--text); font-weight: 600; }
.st-hist-reason { font-size: 13px; color: var(--text-2); margin-top: 3px; overflow-wrap: anywhere; }
.st-note { font-size: 13px; color: var(--text-2); line-height: 1.75; padding: 16px 20px; background: var(--surface-2); box-shadow: none; }
.st-note b { color: var(--text); font-weight: 600; }
.st-legend { display: inline-flex; gap: 12px; flex-wrap: wrap; margin-top: 6px; }
.st-legend span { display: inline-flex; align-items: center; gap: 5px; }
.st-legend i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; background: var(--st-none); }
.st-legend i.g { background: var(--st-good); } .st-legend i.y { background: var(--st-mid); } .st-legend i.r { background: var(--st-bad); }
@media (max-width: 960px) {
  .st-tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .st-tiles .st-tile-counts { grid-column: 1 / -1; }
}
@media (max-width: 760px) {
  .st-page { padding: 20px 16px 60px; }
  .st-hero { padding: 16px; gap: 12px; }
  .st-hero-side { text-align: left; flex-basis: 100%; }
  .st-tiles { gap: 10px; }
  .st-tile { padding: 12px 14px; }
  .st-tile .st-tv { font-size: 20px; }
  .st-tile .st-tl { font-size: 12px; }
  .st-count b { font-size: 17px; }
  .st-count span { font-size: 11px; gap: 4px; }
  .st-toolbar .search { max-width: none; flex: 1 1 200px; }
  .st-seg { margin-left: 0; }
  .st-chips { flex-wrap: nowrap; overflow-x: auto; flex-basis: 100%; scrollbar-width: none; padding-bottom: 2px; }
  .st-chips::-webkit-scrollbar { display: none; }
  .st-chips .chip { flex: none; }
  .st-cat { padding: 4px 14px 6px; }
  .st-colhead { display: none; }
  .st-row { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .st-metrics { display: flex; justify-content: flex-start; flex-wrap: wrap; gap: 2px 14px; order: 2; }
  .st-barwrap { order: 3; }
  .st-m { font-size: 12.5px; text-align: left; }
  .st-m em { display: inline; color: var(--text-3); margin-right: 4px; font-size: 12px; }
  .st-m.st-sparkcell { display: none; }
  .st-bar { height: 26px; gap: 1px; }
  .st-bar i { border-radius: 1px; }
  .st-hist { padding: 4px 14px 6px; }
}
`;

function stEnsureCss() {
  if (document.getElementById('status-page-css')) return;
  const s = document.createElement('style');
  s.id = 'status-page-css';
  s.textContent = STATUS_CSS;
  document.head.appendChild(s);
}

// 可用率对应的颜色等级
const stTone = (a) => (a == null ? 'none' : a >= 99.5 ? 'good' : a >= 97 ? 'mid' : 'bad');
const stSeg = (a) => (a == null ? 'n' : a >= 99.5 ? 'g' : a >= 97 ? 'y' : 'r');
const stPct = (a) => (a == null ? '—' : String(Math.floor(Math.min(100, a) * 100) / 100));
const stPctText = (a) => (a == null ? '—' : `${stPct(a)}%`);

function stDuration(min) {
  min = Math.max(1, Math.round(min));
  if (min < 60) return `${min} 分钟`;
  if (min < 1440) return `${Math.floor(min / 60)} 小时${min % 60 ? ` ${min % 60} 分钟` : ''}`;
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  return `${d} 天${h ? ` ${h} 小时` : ''}`;
}
function stAgo(iso) {
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return '刚刚';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  return `${Math.floor(sec / 86400)} 天前`;
}
// 本地时间 MM-DD HH:mm（今年以外带年份）
function stTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}-${md}`;
}
function stUptime(sec) {
  if (sec >= 86400) return `${Math.floor(sec / 86400)} 天 ${Math.floor((sec % 86400) / 3600)} 小时`;
  if (sec >= 3600) return `${Math.floor(sec / 3600)} 小时 ${Math.floor((sec % 3600) / 60)} 分钟`;
  return `${Math.max(1, Math.floor(sec / 60))} 分钟`;
}
const stDocLink = (name, title) => `<a href="/docs/${encodeURIComponent(name)}">${esc(title)}</a>`;

// 近 90 天可用率：按每天的调用 + 检测次数加权
function stAvg90(m) {
  let w = 0; let s = 0; let plain = 0; let n = 0;
  m.days.forEach((a, i) => {
    if (a == null) return;
    const c = m.dayCalls?.[i] || 0;
    w += c; s += a * c; plain += a; n++;
  });
  if (!n) return null;
  return Math.floor((w ? s / w : plain / n) * 100) / 100;
}

function stSpark(values) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 2) return '';
  const max = Math.max(...pts.map(([, v]) => v));
  const min = Math.min(...pts.map(([, v]) => v));
  const span = max - min || 1;
  const n = values.length - 1 || 1;
  const d = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${((i / n) * 100).toFixed(1)} ${(16 - ((v - min) / span) * 14).toFixed(1)}`).join('');
  return `<svg class="st-spark" viewBox="0 0 100 18" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.4" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function stModuleRow(m, i, st) {
  const susp = m.status === 'suspended';
  const [label, tone] = ST_LABEL[m.status] ?? ST_LABEL.idle;
  const avg = susp ? null : stAvg90(m);
  const bar = m.days.map((a, d) => `<i class="${susp ? 'n' : stSeg(a)}" data-d="${d}"></i>`).join('');
  let sub = '';
  if (m.status === 'down') sub = `<div class="st-name-sub danger">${m.incidentSince ? `故障中 · 自 ${esc(stTime(m.incidentSince))} 起` : '最近一次检测全部失败'}</div>`;
  else if (m.status === 'degraded') sub = `<div class="st-name-sub warn">${m.lastCheck?.failed ? `最近一次检测 ${m.lastCheck.failed}/${m.lastCheck.total} 个路径失败` : `24 小时失败率 ${esc(m.errorRate)}%`}</div>`;
  else if (susp) sub = '<div class="st-name-sub">数据源已停止提供</div>';
  const badge = m.status === 'ok' ? '' : `<span class="badge ${tone}">${label}</span>`;
  const av = susp ? null : m.availability;
  const spark = susp ? '' : stSpark(m.spark ?? []);
  return `<div class="st-row${susp ? ' susp' : ''}" data-m="${i}">
    <div class="st-namecell">
      <div class="st-name"><span class="status-dot ${tone}" title="${esc(ST_HINT[m.status] ?? '')}"></span>${stDocLink(m.name, m.title)}${badge}</div>${sub}
    </div>
    <div class="st-barwrap">
      <div class="st-bar" role="img" aria-label="${esc(m.title)} 近 90 天可用率${avg == null ? '：无数据' : ` ${stPctText(avg)}`}">${bar}</div>
      <div class="st-foot"><span>90 天前</span><span class="st-line"></span><span>${susp ? '暂不可用' : avg == null ? '暂无数据' : `<b>${stPctText(avg)}</b> 可用`}</span><span class="st-line"></span><span>今天</span></div>
    </div>
    <div class="st-metrics">
      <span class="st-m st-${stTone(av)}" title="最近 24 小时可用率"><em>24h 可用率</em><b>${stPctText(av)}</b></span>
      <span class="st-m${m.p95 == null ? ' st-none' : ''}" title="最近 24 小时 P95 耗时"><em>P95</em><b>${m.p95 == null ? '—' : fmtNum(m.p95)}</b>${m.p95 == null ? '' : '<small>ms</small>'}</span>
      <span class="st-m${m.calls ? '' : ' st-none'}" title="最近 24 小时调用 ${fmtNum(m.calls)} 次"><em>24h 调用</em><b>${m.calls ? fmtCompact(m.calls) : '0'}</b></span>
      ${spark ? `<span class="st-m st-sparkcell" style="grid-column:1/-1" title="最近 24 小时每小时平均耗时">${spark}</span>` : ''}
    </div>
  </div>`;
}

async function pageStatus() {
  stEnsureCss();
  const main = $('#main');
  main.innerHTML = '<div class="wrap"><div class="loading"><span class="spinner"></span></div></div>';
  let st = await cachedGet('/status');
  if (!main.isConnected) return;

  const view = { q: '', cat: 'all', bad: false };
  let rows = []; // 每个模块预先生成好的 HTML
  const isBad = (m) => m.status === 'down' || m.status === 'degraded';

  main.innerHTML = `<div class="wrap st-page">
    <div class="page-head"><div><h1>运行状态</h1><p>各接口的实时可用性、近 90 天可用率和故障记录</p></div></div>
    <div id="st-top"></div>
    <div class="st-toolbar">
      <label class="search">${icon('search')}<input class="input" id="st-q" placeholder="搜索接口名称" autocomplete="off"></label>
      <div class="st-chips" id="st-cats"></div>
      <div class="seg st-seg" id="st-filter"></div>
    </div>
    <div id="st-list"></div>
    <div id="st-hist"></div>
    <div class="card st-note st-sec">
      <b>可用率怎么算？</b>系统每 ${st.checks?.intervalMin > 0 ? esc(st.checks.intervalMin) : 30} 分钟用示例参数自动检测一遍所有接口，可用率 = 1 −（检测失败次数 + 真实调用中的服务端错误次数）÷（检测次数 + 调用次数）。参数错误、额度用尽等客户端错误不计入。上游网站故障时对应接口也会显示异常。数据每分钟更新。
      <div class="st-legend"><span><i class="g"></i>≥ 99.5%</span><span><i class="y"></i>97% – 99.5%</span><span><i class="r"></i>&lt; 97%</span><span><i></i>无数据</span></div>
    </div>
    <div class="st-tip" id="st-tip" role="tooltip"></div>
  </div>`;

  const renderTop = () => {
    const live = st.modules.filter((m) => m.status !== 'suspended');
    const count = (k) => st.modules.filter((m) => m.status === k).length;
    const overall = live.some((m) => m.status === 'down') ? ['部分接口故障', 'danger', 'zap']
      : live.some((m) => m.status === 'degraded') ? ['部分接口不稳定', 'warn', 'zap'] : ['所有接口运行正常', 'ok', 'check'];
    const ck = st.checks ?? {};
    let checkLine = '';
    if (ck.intervalMin > 0) {
      const parts = [`每 ${esc(ck.intervalMin)} 分钟一次`];
      if (ck.running) parts.push('正在检测…');
      if (ck.lastRun) {
        parts.push(`上次 ${esc(stAgo(ck.lastRun.at))}`, `${fmtNum(ck.lastRun.total)} 个接口`, ck.lastRun.failed ? `<span style="color:var(--danger)">${fmtNum(ck.lastRun.failed)} 个失败</span>` : '全部通过');
      } else {
        const last = Math.max(0, ...st.modules.map((m) => (m.lastCheck ? new Date(m.lastCheck.at).getTime() : 0)));
        if (last && !ck.running) parts.push(`上次 ${esc(stAgo(new Date(last).toISOString()))}`);
      }
      checkLine = `自动检测：${parts.join('，')}`;
    }
    const upTile = (label, v) => `<div class="card st-tile"><div class="st-tl">${label}</div><div class="st-tv st-${stTone(v)}">${v == null ? '—' : `${stPct(v)}<small>%</small>`}</div></div>`;
    const cnt = (label, k, tone) => {
      const n = count(k);
      return `<div class="st-count${n ? '' : ' zero'}" title="${esc(ST_HINT[k])}"><b>${n}</b><span><span class="status-dot ${tone}"></span>${label}</span></div>`;
    };
    const open = st.incidents.filter((x) => !x.endedAt);
    $('#st-top', main).innerHTML = `
      <div class="card st-hero st-sec ${overall[1]}">
        <div class="st-hero-icon">${icon(overall[2])}</div>
        <div class="st-hero-main">
          <div class="st-hero-title">${overall[0]}</div>
          <div class="st-hero-sub">${checkLine || `共 ${live.length} 个接口`}</div>
        </div>
        <div class="st-hero-side">版本 <b>v${esc(st.version ?? '—')}</b><br>已连续运行 ${esc(stUptime(st.uptimeSec ?? 0))}</div>
      </div>
      ${open.length ? `<div class="card st-alert st-sec">
        <div class="st-alert-head"><span class="status-dot danger st-pulse"></span>${open.length} 个接口正在故障中</div>
        ${open.map((x) => `<div class="st-alert-item"><div class="grow">
          <div>${stDocLink(x.module, x.title)}</div>
          <div class="st-meta">自 ${esc(stTime(x.startedAt))} 起，已持续 ${esc(stDuration(x.minutes))} · ${x.source === 'traffic' ? '实际调用发现' : '自动检测发现'}</div>
          ${x.reason ? `<div class="st-meta">${esc(x.reason)}</div>` : ''}
        </div></div>`).join('')}
      </div>` : ''}
      <div class="st-tiles st-sec">
        ${upTile('24 小时可用率', st.uptime?.d1)}${upTile('7 天可用率', st.uptime?.d7)}${upTile('30 天可用率', st.uptime?.d30)}
        <div class="card st-tile st-tile-counts"><div class="st-tl">接口状态（共 ${st.modules.length} 个）</div>
          <div class="st-counts">${cnt('正常', 'ok', 'ok')}${cnt('部分失败', 'degraded', 'warn')}${cnt('故障', 'down', 'danger')}${cnt('无数据', 'idle', '')}${cnt('暂不可用', 'suspended', '')}</div>
        </div>
      </div>`;
  };

  const renderChips = () => {
    const known = new Set(st.categories.map((c) => c.id));
    const cats = st.categories.map((c) => ({ ...c, n: st.modules.filter((m) => m.category === c.id).length })).filter((c) => c.n);
    if (view.cat !== 'all' && !known.has(view.cat)) view.cat = 'all';
    $('#st-cats', main).innerHTML = `<button class="chip${view.cat === 'all' ? ' active' : ''}" data-cat="all">全部 <span class="n">${st.modules.length}</span></button>
      ${cats.map((c) => `<button class="chip${view.cat === c.id ? ' active' : ''}" data-cat="${esc(c.id)}">${icon(c.icon)}${esc(c.title)} <span class="n">${c.n}</span></button>`).join('')}`;
    const nBad = st.modules.filter(isBad).length;
    $('#st-filter', main).innerHTML = `<button data-bad="0" class="${view.bad ? '' : 'active'}">全部</button><button data-bad="1" class="${view.bad ? 'active' : ''}">只看异常<span class="n">${nBad}</span></button>`;
  };

  const renderList = () => {
    const q = view.q.trim().toLowerCase();
    const match = (m) => (!q || m.title.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
      && (view.cat === 'all' || m.category === view.cat) && (!view.bad || isBad(m));
    const order = { down: 0, degraded: 1, ok: 2, idle: 3, suspended: 4 };
    const cats = [...st.categories];
    // 未登记的分类也显示出来，避免漏掉接口
    for (const m of st.modules) if (!cats.some((c) => c.id === m.category)) cats.push({ id: m.category, title: catOf(m.category).title, icon: catOf(m.category).icon });
    const html = cats.map((c) => {
      const list = st.modules.map((m, i) => [m, i]).filter(([m]) => m.category === c.id && match(m))
        .sort(([a, ai], [b, bi]) => (view.bad ? order[a.status] - order[b.status] : 0) || ai - bi);
      if (!list.length) return '';
      const all = st.modules.filter((m) => m.category === c.id);
      const nd = all.filter((m) => m.status === 'down').length;
      const ng = all.filter((m) => m.status === 'degraded').length;
      const sum = nd || ng
        ? `${nd ? `<span class="badge danger">${nd} 个故障</span>` : ''}${ng ? `<span class="badge warn">${ng} 个部分失败</span>` : ''}`
        : '<span class="badge ok">全部正常</span>';
      return `<section class="card st-cat">
        <div class="st-cat-head"><h2>${icon(c.icon)}${esc(c.title)}</h2><span class="small faint">${all.length} 个接口</span><span class="st-cat-sum">${sum}</span></div>
        <div class="st-colhead"><span>接口</span><span>近 90 天可用率</span><span class="st-metrics"><span>24h 可用率</span><span>P95</span><span>24h 调用</span></span></div>
        ${list.map(([, i]) => rows[i]).join('')}
      </section>`;
    }).join('');
    $('#st-list', main).innerHTML = html || `<div class="card st-empty">${view.bad && !q && view.cat === 'all' ? '所有接口运行正常，没有异常' : '没有找到匹配的接口'}</div>`;
  };

  const renderHist = () => {
    const list = st.incidents;
    $('#st-hist', main).innerHTML = `<section class="card st-hist st-sec">
      <div class="st-cat-head"><h2>故障记录</h2><span class="small faint">最近 30 天</span></div>
      ${list.length ? list.map((x) => `<div class="st-hist-item">
        <span class="status-dot ${x.endedAt ? '' : 'danger'}"></span>
        <div class="grow">
          <div class="st-hist-title">${stDocLink(x.module, x.title)}${x.endedAt ? '<span class="badge ok">已恢复</span>' : '<span class="badge danger">进行中</span>'}</div>
          <div class="st-meta">开始 ${esc(stTime(x.startedAt))}${x.endedAt ? ` · 恢复 ${esc(stTime(x.endedAt))} · 持续 ${esc(stDuration(x.minutes))}` : ` · 已持续 ${esc(stDuration(x.minutes))}`} · 来源：${x.source === 'traffic' ? '实际调用' : '自动检测'}</div>
          ${x.reason ? `<div class="st-hist-reason">${esc(x.reason)}</div>` : ''}
        </div>
      </div>`).join('') : '<div class="st-empty" style="padding:28px 0 32px">最近 30 天暂无故障记录</div>'}
    </section>`;
  };

  const renderAll = () => {
    rows = st.modules.map((m, i) => stModuleRow(m, i, st));
    renderTop();
    renderChips();
    renderList();
    renderHist();
  };
  renderAll();

  // ---------- 交互 ----------
  const qInput = $('#st-q', main);
  let qTimer;
  qInput.addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { view.q = qInput.value; hideTip(); renderList(); }, 80);
  });
  $('#st-cats', main).addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    view.cat = b.dataset.cat;
    renderChips();
    renderList();
  });
  $('#st-filter', main).addEventListener('click', (e) => {
    const b = e.target.closest('[data-bad]');
    if (!b) return;
    view.bad = b.dataset.bad === '1';
    renderChips();
    renderList();
  });

  // 单个浮动提示，事件委托到列表容器
  const tip = $('#st-tip', main);
  const list = $('#st-list', main);
  let tipSeg = null;
  let tipAt = 0;
  function hideTip() {
    tip.classList.remove('show');
    tipSeg?.classList.remove('on');
    tipSeg = null;
  }
  function showTip(seg) {
    const row = seg.closest('[data-m]');
    const m = st.modules[+row.dataset.m];
    const d = +seg.dataset.d;
    if (!m) return;
    tipSeg?.classList.remove('on');
    if (tipSeg !== seg) tipAt = Date.now();
    tipSeg = seg;
    seg.classList.add('on');
    const susp = m.status === 'suspended';
    const a = susp ? null : m.days[d];
    const n = m.dayCalls?.[d] ?? 0;
    const date = st.days?.[d] ?? '';
    const isToday = d === m.days.length - 1;
    tip.innerHTML = `<div class="st-tip-d">${esc(date)}${isToday ? '（今天）' : ''}</div>
      <div class="st-tip-r"><span><span class="sw ${susp ? 'n' : stSeg(a)}"></span>可用率</span><b>${susp ? '暂不可用' : a == null ? '无数据' : stPctText(a)}</b></div>
      <div class="st-tip-r"><span>调用 + 检测</span><b>${fmtNum(n)} 次</b></div>`;
    tip.classList.add('show');
    const r = seg.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const vw = document.documentElement.clientWidth;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(vw - tw - 8, left));
    let top = r.top - th - 8;
    if (top < 68) top = r.bottom + 8; // 顶栏下方放不下时显示在下面
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }
  list.addEventListener('mouseover', (e) => {
    const seg = e.target.closest('.st-bar i');
    if (seg) showTip(seg);
  });
  // 触屏上浏览器会补发模拟的鼠标事件，最近点按过就不按鼠标移出收起提示
  let touchAt = 0;
  list.addEventListener('touchstart', () => { touchAt = Date.now(); }, { passive: true });
  const byMouse = () => Date.now() - touchAt > 1000;
  list.addEventListener('mouseleave', () => { if (byMouse()) hideTip(); });
  list.addEventListener('mouseout', (e) => {
    if (byMouse() && e.target.closest('.st-bar') && !e.relatedTarget?.closest?.('.st-bar')) hideTip();
  });
  // 手机上点按显示；滑过整条也能看
  list.addEventListener('click', (e) => {
    const seg = e.target.closest('.st-bar i');
    // 触屏点按前会先触发一次模拟的 mouseover，刚显示的提示不要立即收起
    if (seg) { if (tipSeg === seg && Date.now() - tipAt > 500) hideTip(); else showTip(seg); }
  });
  list.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    const el = t && document.elementFromPoint(t.clientX, t.clientY);
    if (el?.matches?.('.st-bar i')) { e.preventDefault(); showTip(el); }
  }, { passive: false });
  const outside = (e) => {
    if (!main.isConnected) { document.removeEventListener('click', outside); window.removeEventListener('scroll', onScroll); return; }
    if (!e.target.closest?.('.st-bar')) hideTip();
  };
  const onScroll = () => { if (tipSeg) hideTip(); };
  document.addEventListener('click', outside);
  window.addEventListener('scroll', onScroll, { passive: true });

  // ---------- 每分钟自动刷新 ----------
  const timer = setInterval(async () => {
    if (!main.isConnected) {
      clearInterval(timer);
      document.removeEventListener('click', outside);
      window.removeEventListener('scroll', onScroll);
      return;
    }
    if (document.hidden) return;
    try {
      const fresh = await api('GET', '/status');
      if (!main.isConnected) return;
      st = fresh;
      hideTip();
      renderAll();
    } catch { /* 网络抖动时保留旧数据 */ }
  }, 60_000);
}

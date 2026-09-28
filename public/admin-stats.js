// 管理后台「统计」页（/admin/stats）：调用量趋势、接口明细、调用方、来源、地域、用户增长、限流与错误、自动检测
// 依赖 app.js 里的全局函数（$、esc、api、modal、adminTabs、openDiagnose 等），在 app.js 之后加载
/* global $, $$, esc, fmtNum, fmtCompact, shortDate, api, toast, modal, adminTabs, openDiagnose, state, pageNotFound, catOf, sleep */

const AS_DAY = 86400_000;
const AS_RANGES = [['today', '今天'], ['24h', '24 小时'], ['7d', '7 天'], ['30d', '30 天'], ['90d', '90 天'], ['custom', '自定义']];
const AS_STACK = [
  { key: 'anon', label: '未登录', color: 'var(--series-1)' },
  { key: 'session', label: '网页登录', color: 'var(--series-2)' },
  { key: 'apikey', label: 'API Key', color: 'var(--as-s3)' },
];
const AS_VIA = { anon: '未登录', session: '网页登录', apikey: 'API Key' };
const AS_WEEK = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const AS_PAGE_SIZE = 20;

const asState = {
  range: { key: '7d', from: '', to: '' },
  token: 0,
  overlay: { line: true, lower: false },
  ep: { items: [], sort: 'calls', dir: -1, q: '', cat: '', page: 1 },
};

// ---------- 小工具 ----------
const asLs = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 隐私模式 */ } },
};
// 北京时间的各个部分
const asBj = (t) => {
  const d = new Date(t + 8 * 3600_000);
  return { y: d.getUTCFullYear(), M: d.getUTCMonth() + 1, D: d.getUTCDate(), h: d.getUTCHours(), m: d.getUTCMinutes(), wd: (d.getUTCDay() + 6) % 7 };
};
const asPad = (n) => String(n).padStart(2, '0');
const asYmd = (t) => { const b = asBj(t); return `${b.y}-${asPad(b.M)}-${asPad(b.D)}`; };
const asHm = (b) => `${asPad(b.h)}:${asPad(b.m)}`;
const asMd = (t) => { const b = asBj(t); return `${b.M}/${b.D} ${asHm(b)}`; };
function asAxisLabel(t, gran) {
  const b = asBj(t);
  if (gran === '5m') return asHm(b);
  if (gran === 'hour') return b.h === 0 ? `${b.M}/${b.D}` : `${b.M}/${b.D} ${asPad(b.h)}时`;
  return `${b.M}/${b.D}`;
}
function asFullLabel(t, gran) {
  const b = asBj(t);
  const day = `${b.M}月${b.D}日 ${AS_WEEK[b.wd]}`;
  if (gran === '5m') return `${day} ${asHm(b)}–${asHm(asBj(t + 300_000))}`;
  if (gran === 'hour') return `${day} ${asPad(b.h)}:00–${asPad((b.h + 1) % 24)}:00`;
  return day;
}
const asAgo = (ts) => {
  if (!ts) return '—';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return asYmd(ts);
};
const asMs = (n) => (n == null ? '—' : n >= 1000 ? `${+(n / 1000).toFixed(2)} s` : `${fmtNum(n)} ms`);
const asPct = (n) => (n == null ? '—' : `${n}%`);
const asBytes = (n) => (n == null ? '—' : n >= 1048576 ? `${+(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${+(n / 1024).toFixed(1)} KB` : `${n} B`);
const asTick = (v) => (v >= 1e4 ? `${+(v / 1e4).toFixed(1)}万` : `${+v.toFixed(v < 10 ? 1 : 0)}`);
function asNice(m, min = 4) {
  m = Math.max(m, min);
  const p = 10 ** Math.floor(Math.log10(m));
  const f = m / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 4 ? 4 : f <= 5 ? 5 : 10) * p;
}
const asEmpty = (t = '暂无数据') => `<div class="empty as-empty">${esc(t)}</div>`;
const asSkel = (h = 160) => `<div class="as-skel-wrap"><div class="as-skel" style="height:${h}px"></div></div>`;
const asErr = (err, sec) => `<div class="form-error as-err">加载失败：${esc(err.message)}
  <button class="btn sm" type="button" data-as-retry="${esc(sec)}">重试</button></div>`;

// 与上期比较。goodUp：数字变大是好事；pp：比率，用「个百分点」
function asChange(cur, prev, { goodUp = true, pp = false, neutral = false } = {}) {
  if (cur == null) return '<span class="faint">—</span>';
  if (pp) {
    if (prev == null) return '<span class="faint">上期无数据</span>';
    const d = +(cur - prev).toFixed(2);
    if (!d) return '<span class="faint">持平</span>';
    const cls = neutral ? '' : (d > 0) === goodUp ? 'good' : 'bad';
    return `<span class="as-chg ${cls}">${d > 0 ? '↑' : '↓'} ${Math.abs(d)} 个点</span>`;
  }
  if (!prev) return cur ? '<span class="faint">上期无数据</span>' : '<span class="faint">持平</span>';
  const d = ((cur - prev) / prev) * 100;
  if (Math.abs(d) < 0.05) return '<span class="faint">持平</span>';
  const cls = neutral ? '' : (d > 0) === goodUp ? 'good' : 'bad';
  return `<span class="as-chg ${cls}">${d > 0 ? '↑' : '↓'} ${Math.abs(d) >= 100 ? Math.round(Math.abs(d)) : +Math.abs(d).toFixed(1)}%</span>`;
}

// ---------- 样式 ----------
function asInjectCss() {
  if (document.getElementById('admin-stats-css')) return;
  const st = document.createElement('style');
  st.id = 'admin-stats-css';
  st.textContent = `
:root { --as-s3: #1baf7a; }
:root[data-theme="dark"] { --as-s3: #199e70; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --as-s3: #199e70; } }
.as-page { padding: 28px 20px 80px; }
.as-page .page-head .seg { max-width: 100%; overflow-x: auto; }
.as-page .seg a { white-space: nowrap; }
.as-bar { display: flex; flex-wrap: wrap; gap: 10px 12px; align-items: center; padding: 12px 16px; margin-bottom: 16px; }
.as-seg { display: inline-flex; flex-wrap: wrap; padding: 3px; gap: 2px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; }
.as-seg button { border: 0; background: transparent; padding: 5px 12px; border-radius: 8px; color: var(--text-2); font-size: 13.5px; cursor: pointer; white-space: nowrap; }
.as-seg button:hover { color: var(--text); }
.as-seg button.active { background: var(--surface); color: var(--text); font-weight: 600; box-shadow: var(--shadow); }
.as-custom { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.as-custom .input { height: 32px; width: 150px; padding: 0 8px; }
.as-bar-right { margin-left: auto; display: flex; gap: 8px; }
.as-range-info { font-size: 12.5px; color: var(--text-3); margin: -6px 2px 14px; }
.as-sec { margin-bottom: 16px; min-width: 0; }
.as-sec .card-head { flex-wrap: wrap; }
.as-sec .card-head h2 .faint { font-weight: 400; font-size: 12.5px; margin-left: 6px; }
.as-body { padding: 12px 20px 18px; }
.as-grid2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
.as-grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px; }
@media (max-width: 960px) { .as-grid2, .as-grid3 { grid-template-columns: minmax(0, 1fr); } }
.as-sub { font-size: 13px; font-weight: 600; margin: 4px 0 8px; color: var(--text); }
.as-sub .faint { font-weight: 400; }
.as-note { font-size: 12px; color: var(--text-3); margin-top: 8px; }
.as-note.warn { color: var(--warn); }
.as-err { margin: 14px 20px; display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
.as-empty { padding: 28px 12px; font-size: 13.5px; }
.as-skel-wrap { padding: 14px 20px 18px; }
.as-skel { border-radius: 8px; background: linear-gradient(90deg, var(--surface-2) 25%, var(--border) 50%, var(--surface-2) 75%); background-size: 200% 100%; animation: as-shim 1.3s linear infinite; }
@keyframes as-shim { from { background-position: 200% 0; } to { background-position: -200% 0; } }
.as-tile { padding: 16px 18px; min-width: 0; }
.as-tile .label { display: flex; align-items: center; gap: 4px; cursor: help; }
.as-tile .value { font-size: 26px; }
.as-tile .value small { margin-left: 4px; }
.as-tile .as-foot { font-size: 12px; color: var(--text-3); margin-top: 4px; display: flex; gap: 8px; flex-wrap: wrap; }
.as-tiles-skel .as-tile .value { height: 32px; }
.as-chg { font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums; }
.as-chg.good { color: var(--ok); }
.as-chg.bad { color: var(--danger); }
.as-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12.5px; color: var(--text-2); align-items: center; }
.as-legend span, .as-legend label { display: inline-flex; align-items: center; gap: 6px; }
.as-legend label { cursor: pointer; }
.as-legend input { margin: 0; accent-color: var(--brand); }
.as-sw { width: 10px; height: 10px; border-radius: 3px; display: inline-block; flex: none; }
.as-sw.line { height: 3px; border-radius: 2px; width: 14px; }
.as-chart { position: relative; margin-top: 10px; }
.as-plot { width: 100%; touch-action: pan-y; }
.as-plot svg { display: block; }
.as-chart .tooltip { top: 0; }
.as-grid { stroke: var(--border); stroke-width: 1; }
.as-ax { fill: var(--text-3); font-size: 11px; }
.as-ax.t { fill: var(--text-2); font-size: 11.5px; }
.as-cross { stroke: var(--text-3); stroke-width: 1; stroke-dasharray: 3 3; }
.tooltip .as-tt-row { display: flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
.tooltip .as-tt-row b { margin-left: auto; padding-left: 12px; }
.as-heat { display: grid; grid-template-columns: 30px repeat(24, minmax(0, 1fr)); gap: 2px; position: relative; }
.as-heat i { display: block; aspect-ratio: 1; border-radius: 3px; min-height: 8px; }
.as-heat i:hover { outline: 2px solid var(--text); outline-offset: -1px; }
.as-heat .wd, .as-heat .hr { font-size: 10.5px; line-height: 1; color: var(--text-3); line-height: 1; align-self: center; white-space: nowrap; }
.as-heat .hr { text-align: left; overflow: visible; padding-top: 4px; }
.as-heat-scale { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text-3); margin-top: 10px; justify-content: flex-end; }
.as-heat-scale .ramp { width: 90px; height: 8px; border-radius: 4px; background: linear-gradient(90deg, var(--surface-2), var(--series-1)); }
.as-hb { display: grid; gap: 9px; }
.as-hb-row { min-width: 0; }
.as-hb-row[data-cat], .as-hb-row[data-drill] { cursor: pointer; }
.as-hb-row[data-cat]:hover .as-hb-label, .as-hb-row[data-drill]:hover .as-hb-label { color: var(--brand); }
.as-hb-top { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; margin-bottom: 3px; }
.as-hb-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.as-hb-val { white-space: nowrap; font-variant-numeric: tabular-nums; font-weight: 600; }
.as-hb-val .faint { font-weight: 400; margin-left: 4px; }
.as-hb-track { height: 6px; background: var(--surface-2); border-radius: 3px; overflow: hidden; }
.as-hb-track i { display: block; height: 100%; border-radius: 3px; background: var(--series-1); }
.as-tools { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.as-tools .input { height: 32px; }
.as-tools input.input { width: 200px; }
.as-tools select.input { width: auto; padding: 0 8px; }
.as-ep-table th[data-sort] { cursor: pointer; user-select: none; }
.as-ep-table th[data-sort]:hover { color: var(--text); }
.as-ep-table th .arr { font-size: 10px; margin-left: 2px; }
.as-ep-table tbody tr { cursor: pointer; }
.as-ep-table tbody tr:hover td, .as-ep-table tbody tr:focus-visible td { background: var(--surface-2); }
.as-ep-table tbody tr:focus-visible { outline: none; }
.as-ep-name { min-width: 180px; max-width: 280px; }
.as-ep-name b { font-weight: 500; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.as-ep-name .mono { font-size: 12px; color: var(--text-3); display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.as-spark { display: block; }
.as-pager { display: flex; justify-content: center; align-items: center; gap: 8px; padding: 10px 0 2px; }
.as-page .table td, .as-drill .table td { font-size: 13.5px; }
.as-page .table th, .as-page .table td, .as-drill .table th, .as-drill .table td { padding: 8px 10px; }
.as-page .table-wrap, .as-drill .table-wrap { margin: 0 -10px; }
.as-page .table td.num, .as-drill .table td.num { white-space: nowrap; }
.as-collapsed tr[data-more] { display: none; }
.as-trunc { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.as-split { display: flex; height: 10px; border-radius: 5px; overflow: hidden; gap: 2px; background: var(--surface); margin: 6px 0 8px; }
.as-split i { display: block; height: 100%; }
.as-kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin-bottom: 14px; }
.as-kv > div { background: var(--surface-2); border-radius: 10px; padding: 10px 12px; min-width: 0; }
.as-kv .k { font-size: 12px; color: var(--text-2); }
.as-kv .v { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
.as-kv .v small { font-size: 12px; font-weight: 500; color: var(--text-3); margin-left: 2px; }
.as-kv .s { font-size: 11.5px; color: var(--text-3); }
.modal-back:has(.as-drill) { align-items: start; overflow-y: auto; }
.modal:has(.as-drill) { max-width: 1000px; padding: 22px 24px; }
.as-drill-head { display: flex; gap: 12px; align-items: flex-start; justify-content: space-between; margin-bottom: 14px; flex-wrap: wrap; }
.as-drill-head h2 { margin: 0 0 2px; }
.as-drill-head .mono { color: var(--text-3); word-break: break-all; }
.as-drill .as-dsec { margin-top: 20px; }
.as-drill .as-kv { grid-template-columns: repeat(4, minmax(0, 1fr)); }
@media (max-width: 640px) { .as-kv, .as-drill .as-kv { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; } }
@media (max-width: 640px) {
  .as-page { padding: 20px 16px 60px; }
  .as-bar { padding: 10px 12px; }
  .as-bar-right { margin-left: 0; }
  .as-body { padding: 10px 14px 16px; }
  .as-sec .card-head { padding: 14px 14px 0; }
  .as-skel-wrap { padding: 12px 14px 16px; }
  .as-tile { padding: 12px 14px; }
  .as-tile .value { font-size: 21px; }
  .as-tile .value small { display: block; margin: 2px 0 0; font-size: 12px; }
  .as-seg button { padding: 5px 8px; font-size: 13px; }
  .as-tools input.input { width: 100%; flex: 1 1 140px; }
  .as-custom .input { width: 138px; }
  .modal-back:has(.as-drill) { padding: 8px; }
  .modal:has(.as-drill) { padding: 16px 14px; max-height: none; }
  .as-heat { grid-template-columns: 26px repeat(24, minmax(0, 1fr)); gap: 1px; }
  .as-heat i { border-radius: 2px; }
}`;
  document.head.append(st);
}

// ---------- 图表 ----------
// 横向条形排行：items [{ label(已转义的 HTML), value, sub?, color?, attrs? }]
function asHBars(items, { total, fmt = fmtNum, unit = '', max } = {}) {
  if (!items.length) return asEmpty();
  const m = max ?? Math.max(1, ...items.map((x) => x.value));
  return `<div class="as-hb">${items.map((x) => `<div class="as-hb-row" ${x.attrs ?? ''}>
    <div class="as-hb-top"><span class="as-hb-label" title="${esc(x.title ?? '')}">${x.label}${x.sub ? ` <span class="faint small">${x.sub}</span>` : ''}</span>
    <span class="as-hb-val">${fmt(x.value)}${unit}${total ? `<span class="faint">${((x.value / total) * 100).toFixed(1)}%</span>` : ''}</span></div>
    <div class="as-hb-track"><i style="width:${Math.max(x.value ? 1 : 0, (x.value / m) * 100).toFixed(2)}%;${x.color ? `background:${x.color}` : ''}"></i></div></div>`).join('')}</div>`;
}

function asSpark(vals, w = 76, h = 22) {
  if (!vals?.length) return '';
  const m = Math.max(1, ...vals);
  const step = vals.length > 1 ? w / (vals.length - 1) : 0;
  const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / m) * (h - 4)).toFixed(1)}`);
  if (vals.length === 1) pts.push(`${w},${pts[0].split(',')[1]}`);
  return `<svg class="as-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <polygon points="0,${h} ${pts.join(' ')} ${w},${h}" fill="var(--series-1)" fill-opacity=".14"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="var(--series-1)" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

// 时间序列图：堆叠柱（点少）或堆叠面积（点多）+ 可选的同轴折线 + 可选的下方独立小图（例如 P95 耗时，单独的纵轴）
// cfg: { gran, stack:[{key,label,color}], line?:{key,label,color}, lower?:{key,label,fmt}, showLine, showLower, unit, height }
function asTimeChart(host, rows, cfg) {
  host.innerHTML = '<div class="as-chart"><div class="as-plot"></div><div class="tooltip" hidden></div></div>';
  const box = $('.as-chart', host);
  const plot = $('.as-plot', host);
  const tip = $('.tooltip', host);
  const n = rows.length;
  let g = null;
  let lastW = 0;
  const draw = () => {
    const W = Math.floor(plot.clientWidth);
    if (!W) return;
    lastW = W;
    const padL = 44, padR = 12, padT = 8, mainH = cfg.height ?? 200;
    const lowOn = !!(cfg.lower && cfg.showLower);
    const lineOn = !!(cfg.line && cfg.showLine);
    const lowH = 64;
    const lowTop = padT + mainH + 30;
    const axisY = (lowOn ? lowTop + lowH : padT + mainH) + 17;
    const H = axisY + 4;
    const pw = W - padL - padR;
    const bw = pw / Math.max(1, n);
    const cx = (i) => padL + (i + 0.5) * bw;
    const tot = rows.map((r) => cfg.stack.reduce((s, x) => s + (r[x.key] || 0), 0));
    const mx = asNice(Math.max(0, ...tot, ...(lineOn ? rows.map((r) => r[cfg.line.key] || 0) : [])));
    const y = (v) => padT + mainH - (v / mx) * mainH;
    let out = '';
    for (const f of [0, 0.5, 1]) {
      out += `<line class="as-grid" x1="${padL}" x2="${W - padR}" y1="${y(mx * f)}" y2="${y(mx * f)}"/>
        <text class="as-ax" x="${padL - 6}" y="${y(mx * f) + 4}" text-anchor="end">${asTick(mx * f)}</text>`;
    }
    if (bw >= 3) {
      const barW = Math.min(26, Math.max(2, bw * 0.7));
      rows.forEach((r, i) => {
        const x = cx(i) - barW / 2;
        const segs = cfg.stack.filter((s) => r[s.key] > 0);
        let acc = 0;
        segs.forEach((s, j) => {
          const y0 = y(acc);
          acc += r[s.key];
          const top = j === segs.length - 1;
          const h = Math.max(1, y0 - y(acc) - (top ? 0 : 1.5));
          const rad = top ? Math.min(3, h, barW / 2) : 0;
          out += `<path fill="${s.color}" d="M${x.toFixed(1)},${y0.toFixed(1)}V${(y0 - h + rad).toFixed(1)}q0,-${rad} ${rad},-${rad}h${(barW - 2 * rad).toFixed(1)}q${rad},0 ${rad},${rad}V${y0.toFixed(1)}z"/>`;
        });
      });
    } else if (n) {
      let lower = rows.map(() => 0);
      for (const s of cfg.stack) {
        const upper = rows.map((r, i) => lower[i] + (r[s.key] || 0));
        const top = upper.map((v, i) => `${cx(i).toFixed(1)},${y(v).toFixed(1)}`);
        const bottom = lower.map((v, i) => `${cx(i).toFixed(1)},${y(v).toFixed(1)}`).reverse();
        out += `<polygon fill="${s.color}" fill-opacity=".85" points="${top.join(' ')} ${bottom.join(' ')}"/>`;
        lower = upper;
      }
    }
    const path = (vals, yf) => {
      let d = '';
      let pen = false;
      const dots = [];
      vals.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${cx(i).toFixed(1)},${yf(v).toFixed(1)}`;
        if (!pen && (i === n - 1 || vals[i + 1] == null)) dots.push(i);
        pen = true;
      });
      return { d, dots };
    };
    if (lineOn) {
      const p = path(rows.map((r) => r[cfg.line.key] ?? 0), y);
      out += `<path d="${p.d}" fill="none" stroke="${cfg.line.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    if (lowOn) {
      const vals = rows.map((r) => r[cfg.lower.key]);
      const lmx = asNice(Math.max(0, ...vals.filter((v) => v != null)), 10);
      const ly = (v) => lowTop + lowH - (v / lmx) * lowH;
      const f = cfg.lower.fmt ?? asTick;
      out += `<text class="as-ax t" x="${padL}" y="${lowTop - 10}">${esc(cfg.lower.label)}</text>`;
      for (const v of [0, lmx]) out += `<line class="as-grid" x1="${padL}" x2="${W - padR}" y1="${ly(v)}" y2="${ly(v)}"/><text class="as-ax" x="${padL - 6}" y="${ly(v) + 4}" text-anchor="end">${esc(f(v))}</text>`;
      const p = path(vals, ly);
      out += `<path d="${p.d}" fill="none" stroke="var(--text-2)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      out += p.dots.map((i) => `<circle cx="${cx(i)}" cy="${ly(vals[i])}" r="2.5" fill="var(--text-2)"/>`).join('');
    }
    // 横轴标签：按宽度挑一部分，避开右边缘
    // 间隔取整（5 分钟 / 整点 / 整天），标签落在北京时间的整数刻度上
    const unit = cfg.gran === '5m' ? 300_000 : cfg.gran === 'hour' ? 3600_000 : AS_DAY;
    const steps = (cfg.gran === '5m' ? [1, 3, 6, 12, 24, 36, 72] : cfg.gran === 'hour' ? [1, 2, 3, 6, 12, 24, 48, 72, 168] : [1, 2, 3, 7, 14, 30, 60, 90]);
    const minPx = cfg.gran === 'day' ? 48 : cfg.gran === 'hour' ? 84 : 52;
    const every = steps.find((k) => k * bw >= minPx) ?? Math.ceil(minPx / bw);
    for (let i = 0; i < n; i++) {
      const aligned = cfg.gran === 'day' ? (n - 1 - i) % every === 0 : Math.round((rows[i].t + 8 * 3600_000) / unit) % every === 0;
      if (!aligned || cx(i) > W - 30 || cx(i) < padL + 10) continue;
      out += `<text class="as-ax" x="${cx(i).toFixed(1)}" y="${axisY}" text-anchor="middle">${esc(asAxisLabel(rows[i].t, cfg.gran))}</text>`;
    }
    out += `<line class="as-cross" x1="0" x2="0" y1="${padT}" y2="${axisY - 12}" visibility="hidden"/>`;
    plot.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="趋势图">${out}</svg>`;
    g = { padL, bw, W };
  };
  const hide = () => {
    tip.hidden = true;
    const c = $('.as-cross', plot);
    if (c) c.setAttribute('visibility', 'hidden');
  };
  const move = (e) => {
    if (!g || !n) return;
    const rect = plot.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = Math.floor((px - g.padL) / g.bw);
    if (i < 0 || i >= n) return hide();
    const r = rows[i];
    const x = g.padL + (i + 0.5) * g.bw;
    const c = $('.as-cross', plot);
    c.setAttribute('x1', x);
    c.setAttribute('x2', x);
    c.setAttribute('visibility', 'visible');
    const unit = cfg.unit ?? '次';
    const total = cfg.stack.reduce((s, x2) => s + (r[x2.key] || 0), 0);
    const rowsHtml = cfg.stack.map((s) => `<div class="as-tt-row"><i class="as-sw" style="background:${s.color}"></i>${esc(s.label)}<b>${fmtNum(r[s.key] || 0)} ${unit}</b></div>`);
    if (cfg.stack.length > 1) rowsHtml.push(`<div class="as-tt-row">合计<b>${fmtNum(total)} ${unit}</b></div>`);
    if (cfg.line && cfg.showLine) rowsHtml.push(`<div class="as-tt-row"><i class="as-sw line" style="background:${cfg.line.color}"></i>${esc(cfg.line.label)}<b>${fmtNum(r[cfg.line.key] || 0)} ${esc(cfg.line.unit ?? unit)}</b></div>`);
    if (cfg.lower && cfg.showLower) rowsHtml.push(`<div class="as-tt-row"><i class="as-sw line" style="background:var(--text-2)"></i>${esc(cfg.lower.label)}<b>${r[cfg.lower.key] == null ? '—' : esc((cfg.lower.fmt ?? String)(r[cfg.lower.key]))}</b></div>`);
    tip.innerHTML = `<div class="t">${esc(asFullLabel(r.t, cfg.gran))}</div>${rowsHtml.join('')}`;
    tip.hidden = false;
    const bw2 = box.clientWidth;
    let left = x + 14;
    if (left + tip.offsetWidth > bw2 - 4) left = x - tip.offsetWidth - 14;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = '0px';
  };
  plot.addEventListener('pointermove', move);
  plot.addEventListener('pointerdown', move);
  plot.addEventListener('pointerleave', hide);
  draw();
  new ResizeObserver(() => { if (Math.floor(plot.clientWidth) !== lastW) { hide(); draw(); } }).observe(plot);
  return { redraw: () => { hide(); draw(); } };
}

function asLegend(items) {
  return `<div class="as-legend">${items.map((s) => `<span><i class="as-sw" style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</div>`;
}

// ---------- 页面 ----------
function asQs() {
  const r = asState.range;
  return r.key === 'custom' ? `range=custom&from=${encodeURIComponent(r.from)}&to=${encodeURIComponent(r.to)}` : `range=${r.key}`;
}

async function pageAdminStats() {
  if (!state.user?.isAdmin) return pageNotFound();
  asInjectCss();
  const saved = asLs.get('adminStats.range');
  if (saved && AS_RANGES.some(([k]) => k === saved.key)) asState.range = { key: saved.key, from: saved.from || '', to: saved.to || '' };
  const r = asState.range;
  if (!r.from) r.from = asYmd(Date.now() - 6 * AS_DAY);
  if (!r.to) r.to = asYmd(Date.now());
  asState.ep = { ...asState.ep, q: '', cat: '', page: 1 };
  const card = (id, title, extra = '', h = 180) => `<section class="card as-sec" id="as-${id}"><div class="card-head"><h2>${title}</h2>${extra}</div><div class="as-slot">${asSkel(h)}</div></section>`;
  $('#main').innerHTML = `<div class="wrap as-page" id="as-root">
    <div class="page-head"><div><h1>统计</h1><p>调用量、接口、调用方、来源与错误的详细统计</p></div>${adminTabs('stats')}</div>
    <div class="card as-bar">
      <div class="as-seg" role="group" aria-label="时间范围">${AS_RANGES.map(([k, t]) => `<button type="button" data-range="${k}" class="${r.key === k ? 'active' : ''}">${t}</button>`).join('')}</div>
      <form class="as-custom" id="as-custom" ${r.key === 'custom' ? '' : 'hidden'}>
        <input class="input" type="date" name="from" value="${esc(r.from)}" max="${asYmd(Date.now())}" aria-label="开始日期"><span class="faint">至</span>
        <input class="input" type="date" name="to" value="${esc(r.to)}" max="${asYmd(Date.now())}" aria-label="结束日期">
        <button class="btn sm primary">查询</button></form>
      <div class="as-bar-right"><button class="btn sm" type="button" id="as-csv" title="把下方「接口明细」（按当前筛选和排序）导出为 CSV，可用 Excel 打开">导出 CSV</button>
        <button class="btn sm" type="button" id="as-refresh">刷新</button></div>
    </div>
    <div class="as-range-info" id="as-range-info">&nbsp;</div>
    <div id="as-kpi" class="as-slot-kpi">${asKpiSkeleton()}</div>
    ${card('trend', '调用趋势', `<div class="as-legend" id="as-trend-tg">
      <label title="服务端错误（5xx）次数，和调用量用同一纵轴"><input type="checkbox" data-ov="line" ${asState.overlay.line ? 'checked' : ''}><i class="as-sw line" style="background:var(--danger)"></i>失败（5xx）</label>
      <label title="在下方单独显示 P95 耗时"><input type="checkbox" data-ov="lower" ${asState.overlay.lower ? 'checked' : ''}>P95 耗时</label></div>`, 240)}
    <div class="as-grid2">
      ${card('heat', '时段热力图 <span class="faint">北京时间</span>', '', 170)}
      ${card('cats', '分类占比', '', 170)}
    </div>
    ${card('ep', '接口明细', `<div class="as-tools"><input class="input" type="search" id="as-ep-q" placeholder="搜索接口名称或地址" aria-label="搜索接口">
      <select class="input" id="as-ep-cat" aria-label="按分类筛选"><option value="">全部分类</option></select></div>`, 320)}
    ${card('callers', '调用方', '', 260)}
    <div class="as-grid2">
      ${card('sources', '来源与客户端', '', 220)}
      ${card('geo', '地域', '', 220)}
    </div>
    ${card('growth', '用户增长', '', 260)}
    ${card('issues', '限流与错误', '', 220)}
    ${card('health', '自动检测', '<button class="btn sm primary" type="button" id="as-health-run">立即检测</button>', 90)}
  </div>`;
  const root = $('#as-root');
  asBind(root);
  asLoadAll(root);
}

function asKpiSkeleton() {
  return `<div class="tiles tiles-4 as-tiles-skel">${Array.from({ length: 8 }, () => '<div class="card tile as-tile"><div class="as-skel" style="height:14px;width:60%"></div><div class="as-skel" style="height:28px;margin-top:10px;width:80%"></div></div>').join('')}</div>`;
}

const asSlot = (root, id) => $(`#as-${id} .as-slot`, root);

function asBind(root) {
  root.addEventListener('click', (e) => {
    const rb = e.target.closest('[data-range]');
    if (rb) {
      const key = rb.dataset.range;
      $$('[data-range]', root).forEach((b) => b.classList.toggle('active', b === rb));
      $('#as-custom', root).hidden = key !== 'custom';
      if (key === 'custom') return; // 选好日期后点「查询」
      asState.range.key = key;
      asLs.set('adminStats.range', asState.range);
      asLoadAll(root);
      return;
    }
    const retry = e.target.closest('[data-as-retry]');
    if (retry) return asLoaders[retry.dataset.asRetry]?.(root, asState.token);
    if (asToggleMore(e)) return;
    if (e.target.closest('#as-refresh')) return asLoadAll(root);
    if (e.target.closest('#as-csv')) return asExportCsv();
    if (e.target.closest('#as-health-run')) return asRunHealth(root);
    const sort = e.target.closest('th[data-sort]');
    if (sort) {
      const k = sort.dataset.sort;
      if (asState.ep.sort === k) asState.ep.dir *= -1;
      else { asState.ep.sort = k; asState.ep.dir = k === 'title' ? 1 : -1; }
      asState.ep.page = 1;
      return asRenderEpTable(root);
    }
    const pg = e.target.closest('[data-ep-page]');
    if (pg) {
      asState.ep.page = Number(pg.dataset.epPage);
      asRenderEpTable(root);
      $('#as-ep', root).scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    const cat = e.target.closest('[data-cat]');
    if (cat) {
      asState.ep.cat = cat.dataset.cat;
      asState.ep.page = 1;
      const sel = $('#as-ep-cat', root);
      if (sel) sel.value = cat.dataset.cat;
      asRenderEpTable(root);
      $('#as-ep', root).scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    const drill = e.target.closest('[data-drill]');
    if (drill && !e.target.closest('a, button')) asOpenDrill(drill.dataset.drill);
  });
  root.addEventListener('keydown', (e) => {
    const tr = e.target.closest('tr[data-drill]');
    if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); asOpenDrill(tr.dataset.drill); }
  });
  $('#as-custom', root).addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const from = String(f.get('from') || '');
    const to = String(f.get('to') || '');
    if (!from || !to) return toast('请选择开始和结束日期', true);
    if (from > to) return toast('结束日期不能早于开始日期', true);
    asState.range = { key: 'custom', from, to };
    asLs.set('adminStats.range', asState.range);
    asLoadAll(root);
  });
  root.addEventListener('change', (e) => {
    const ov = e.target.closest('[data-ov]');
    if (ov) {
      asState.overlay[ov.dataset.ov] = ov.checked;
      if (asTrendChart) {
        asTrendChart.cfg.showLine = asState.overlay.line;
        asTrendChart.cfg.showLower = asState.overlay.lower;
        asTrendChart.chart.redraw();
      }
      return;
    }
    if (e.target.id === 'as-ep-cat') { asState.ep.cat = e.target.value; asState.ep.page = 1; asRenderEpTable(root); }
  });
  root.addEventListener('input', (e) => {
    if (e.target.id !== 'as-ep-q') return;
    asState.ep.q = e.target.value.trim().toLowerCase();
    asState.ep.page = 1;
    asRenderEpTable(root);
  });
}

let asTrendChart = null;

function asToggleMore(e) {
  const more = e.target.closest('[data-as-more]');
  if (!more) return false;
  const t = more.closest('.as-tbl');
  const collapsed = t.classList.toggle('as-collapsed');
  more.textContent = collapsed ? `展开全部 ${t.querySelectorAll('tbody tr').length} 条` : '收起';
  return true;
}

// 各卡片的加载函数：并行请求，各自显示加载中 / 出错
const asLoaders = {
  overview: (root, tok) => asLoad(root, tok, ['kpi', 'trend', 'heat', 'cats'], `/admin/analytics/overview?${asQs()}`, asRenderOverview),
  endpoints: (root, tok) => asLoad(root, tok, ['ep'], `/admin/analytics/endpoints?${asQs()}`, asRenderEndpoints),
  audience: (root, tok) => asLoad(root, tok, ['callers', 'sources', 'geo'], `/admin/analytics/audience?${asQs()}`, asRenderAudience),
  users: (root, tok) => asLoad(root, tok, ['growth'], `/admin/analytics/users?${asQs()}`, asRenderGrowth),
  issues: (root, tok) => asLoad(root, tok, ['issues'], `/admin/analytics/issues?${asQs()}`, asRenderIssues),
  health: (root, tok) => asLoad(root, tok, ['health'], '/admin/health', asRenderHealth),
};
const asSecOf = { kpi: 'overview', trend: 'overview', heat: 'overview', cats: 'overview', ep: 'endpoints', callers: 'audience', sources: 'audience', geo: 'audience', growth: 'users', issues: 'issues', health: 'health' };

function asLoadAll(root) {
  const tok = ++asState.token;
  for (const fn of Object.values(asLoaders)) fn(root, tok);
}

async function asLoad(root, tok, ids, path, render) {
  for (const id of ids) {
    if (id === 'kpi') $('#as-kpi', root).innerHTML = asKpiSkeleton();
    else {
      const s = asSlot(root, id);
      if (s && !s.querySelector('.as-skel')) s.innerHTML = asSkel(Math.max(120, Math.min(260, s.offsetHeight - 30)));
    }
  }
  let d;
  try {
    d = await api('GET', path);
  } catch (err) {
    if (!root.isConnected || tok !== asState.token) return;
    for (const id of ids) {
      const html = asErr(err, asSecOf[id]);
      if (id === 'kpi') $('#as-kpi', root).innerHTML = `<div class="card as-sec">${html}</div>`;
      else asSlot(root, id).innerHTML = html;
    }
    return;
  }
  if (!root.isConnected || tok !== asState.token) return;
  try {
    render(root, d);
  } catch (err) {
    console.error(err);
    for (const id of ids) {
      const el = id === 'kpi' ? $('#as-kpi', root) : asSlot(root, id);
      el.innerHTML = asErr(new Error(`显示出错（${err.message}）`), asSecOf[id]);
    }
  }
}

// ---------- 概览：KPI、趋势、热力图、分类 ----------
function asRenderOverview(root, d) {
  const { cur, prev } = d.kpi;
  const rg = d.range;
  const info = rg.key === 'custom'
    ? `${asState.range.from} 至 ${asState.range.to}`
    : `${asMd(rg.from)} 至 ${asMd(rg.to)}`;
  $('#as-range-info', root).textContent = `${rg.label}：${info}（北京时间）· 与上一段同样长的时间（${asMd(rg.prevFrom)} 至 ${asMd(rg.prevTo)}）比较`;
  const approx = cur.uniquesExact ? '' : ' <span class="badge" title="超出调用明细保留时间，按每天的独立数相加，同一 IP / 用户在不同日子会重复计算">按天累计</span>';
  const tile = (label, tip, value, change, foot = '') => `<div class="card tile as-tile" title="${esc(tip)}">
    <div class="label">${label}</div><div class="value">${value}</div>
    <div class="as-foot">${change}${foot}</div></div>`;
  const prevTxt = (v) => `<span>上期 ${v}</span>`;
  $('#as-kpi', root).innerHTML = `<div class="tiles tiles-4">
    ${tile('调用量', '这段时间内所有接口被调用的总次数（含失败和被限流的请求）', fmtNum(cur.calls), asChange(cur.calls, prev.calls), prevTxt(fmtNum(prev.calls)))}
    ${tile(`独立 IP${approx}`, '有调用的不同 IP 地址数', fmtNum(cur.ips), asChange(cur.ips, prev.ips), prevTxt(fmtNum(prev.ips)))}
    ${tile(`活跃用户${approx}`, '有过调用（网页登录或 API Key）的注册用户数', fmtNum(cur.activeUsers), asChange(cur.activeUsers, prev.activeUsers), prevTxt(fmtNum(prev.activeUsers)))}
    ${tile('新注册', '这段时间内新注册的用户数', fmtNum(cur.newUsers), asChange(cur.newUsers, prev.newUsers), prevTxt(fmtNum(prev.newUsers)))}
    ${tile('成功率', '状态码小于 400 的调用占比；4xx 通常是参数错误或被限流，5xx 是服务端或上游故障', asPct(cur.successRate), asChange(cur.successRate, prev.successRate, { pp: true }), `<span>5xx ${fmtNum(cur.e5xx)} · 4xx ${fmtNum(cur.e4xx)}</span>`)}
    ${tile('平均耗时 / P95', '平均耗时，以及 95% 的调用在多少毫秒内完成（P95，由耗时分段估算）', `${asMs(cur.avgMs)}<small>P95 ${asMs(cur.p95)}</small>`, asChange(cur.avgMs, prev.avgMs, { goodUp: false }), prevTxt(asMs(prev.avgMs)))}
    ${tile('缓存命中率', '直接用缓存返回、没有请求上游的调用占比', asPct(cur.cacheHit), asChange(cur.cacheHit, prev.cacheHit, { pp: true }), prevTxt(asPct(prev.cacheHit)))}
    ${tile('限流次数', '因超过频率或每日额度被拒绝（429）的次数', fmtNum(cur.limited), asChange(cur.limited, prev.limited, { goodUp: false }), prevTxt(fmtNum(prev.limited)))}
  </div>`;

  // 趋势
  const trend = asSlot(root, 'trend');
  if (!d.series.some((r) => r.calls)) {
    trend.innerHTML = `<div class="as-body">${asEmpty('这段时间没有调用')}</div>`;
    asTrendChart = null;
  } else {
    trend.innerHTML = `<div class="as-body">${asLegend(AS_STACK)}<div class="as-trend-plot"></div></div>`;
    const cfg = {
      gran: rg.gran, stack: AS_STACK, unit: '次',
      line: { key: 'e5xx', label: '失败（5xx）', color: 'var(--danger)' },
      lower: { key: 'p95', label: 'P95 耗时', fmt: asMs },
      showLine: asState.overlay.line, showLower: asState.overlay.lower,
    };
    asTrendChart = { cfg, chart: asTimeChart($('.as-trend-plot', trend), d.series, cfg) };
  }

  // 热力图
  const heat = asSlot(root, 'heat');
  const hm = d.heatmap;
  const mx = Math.max(0, ...hm.data.flat());
  if (!mx) heat.innerHTML = `<div class="as-body">${asEmpty('还没有按小时的调用数据')}</div>`;
  else {
    const cells = hm.data.map((row, di) => `<span class="wd">${esc((hm.weekdays[di] ?? AS_WEEK[di]).replace('周', ''))}</span>${row.map((v, h) =>
      `<i data-hm="${di},${h},${v}" style="background:${v ? `color-mix(in srgb, var(--series-1) ${Math.round(14 + 86 * (v / mx))}%, var(--surface-2))` : 'var(--surface-2)'}"></i>`).join('')}`).join('');
    const hrs = `<span></span>${Array.from({ length: 24 }, (_, h) => `<span class="hr">${h % 6 === 0 ? h : ''}</span>`).join('')}`;
    heat.innerHTML = `<div class="as-body"><div class="as-chart"><div class="as-heat" role="img" aria-label="星期 × 小时的调用量热力图">${cells}${hrs}</div><div class="tooltip" hidden></div></div>
      <div class="as-heat-scale"><span>少</span><span class="ramp"></span><span>多（${fmtNum(mx)} 次）</span></div>
      <div class="as-note">${hm.from && hm.from < rg.from ? '范围不足 7 天时按最近 7 天统计；' : ''}同一星期几的多周数据相加</div></div>`;
    const wrapEl = $('.as-chart', heat);
    const tip = $('.tooltip', heat);
    const show = (e) => {
      const c = e.target.closest('[data-hm]');
      if (!c) { tip.hidden = true; return; }
      const [di, h, v] = c.dataset.hm.split(',').map(Number);
      tip.innerHTML = `<div class="as-tt-row">${esc(hm.weekdays[di] ?? AS_WEEK[di])} ${asPad(h)}:00<b>${fmtNum(v)} 次</b></div>`;
      tip.hidden = false;
      const b = wrapEl.getBoundingClientRect();
      const cb = c.getBoundingClientRect();
      let left = cb.left - b.left + cb.width / 2 - tip.offsetWidth / 2;
      left = Math.max(0, Math.min(left, b.width - tip.offsetWidth));
      tip.style.left = `${left}px`;
      tip.style.top = `${cb.top - b.top - tip.offsetHeight - 6}px`;
    };
    wrapEl.addEventListener('pointerover', show);
    wrapEl.addEventListener('pointerdown', show);
    wrapEl.addEventListener('pointerleave', () => { tip.hidden = true; });
  }

  // 分类
  const cats = asSlot(root, 'cats');
  const used = d.categories.filter((c) => c.calls > 0);
  const total = used.reduce((s, c) => s + c.calls, 0);
  const idle = d.categories.length - used.length;
  cats.innerHTML = `<div class="as-body">${used.length
    ? asHBars(used.map((c) => ({ label: esc(c.title), value: c.calls, attrs: c.id === 'other' ? '' : `data-cat="${esc(c.id)}" title="在接口明细中只看这个分类"` })), { total })
    : asEmpty('这段时间没有调用')}
    ${idle && used.length ? `<div class="as-note">另有 ${idle} 个分类没有调用 · 点击分类可筛选下方接口明细</div>` : ''}</div>`;
  asFillCatSelect(root, d.categories);
}

function asFillCatSelect(root, categories) {
  const sel = $('#as-ep-cat', root);
  if (!sel) return;
  sel.innerHTML = `<option value="">全部分类</option>${categories.map((c) => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('')}`;
  sel.value = asState.ep.cat;
}

// ---------- 接口明细 ----------
const AS_EP_COLS = [
  ['title', '接口', ''], ['calls', '调用', 'num'], ['share', '占比', 'num'], ['successRate', '成功率', 'num'], ['e4xx', '4xx', 'num'],
  ['e5xx', '5xx', 'num'], ['avgMs', '平均', 'num'], ['p95', 'P95', 'num'], ['cacheHit', '缓存命中', 'num'], [null, '趋势', ''], ['change', '较上期', 'num'],
];

function asRenderEndpoints(root, d) {
  asState.ep.items = d.items;
  asState.ep.total = d.total;
  asState.ep.routesTotal = d.routesTotal;
  const sel = $('#as-ep-cat', root);
  if (sel && sel.options.length <= 1 && state.catalog?.categories) asFillCatSelect(root, state.catalog.categories);
  asRenderEpTable(root);
}

function asEpFiltered() {
  const { items, q, cat, sort, dir } = asState.ep;
  const list = items.filter((e) => (!cat || e.category === cat)
    && (!q || `${e.title ?? ''} ${e.path} ${e.module ?? ''} ${e.summary ?? ''}`.toLowerCase().includes(q)));
  return list.sort((a, b) => {
    const va = sort === 'title' ? (a.title ?? a.path) : a[sort];
    const vb = sort === 'title' ? (b.title ?? b.path) : b[sort];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (typeof va === 'string' ? va.localeCompare(vb, 'zh-CN') : va - vb) * dir || b.calls - a.calls;
  });
}

function asRenderEpTable(root) {
  const slot = asSlot(root, 'ep');
  if (!slot) return;
  const st = asState.ep;
  const list = asEpFiltered();
  const pages = Math.max(1, Math.ceil(list.length / AS_PAGE_SIZE));
  st.page = Math.min(Math.max(1, st.page), pages);
  const rows = list.slice((st.page - 1) * AS_PAGE_SIZE, st.page * AS_PAGE_SIZE);
  const title = $('#as-ep .card-head h2', root);
  if (title) title.innerHTML = `接口明细<span class="faint">${fmtNum(st.items.length)} / ${fmtNum(st.routesTotal ?? 0)} 个接口有调用</span>`;
  if (!st.items.length) { slot.innerHTML = `<div class="as-body">${asEmpty('这段时间没有接口被调用')}</div>`; return; }
  if (!list.length) { slot.innerHTML = `<div class="as-body">${asEmpty('没有符合条件的接口')}</div>`; return; }
  const th = AS_EP_COLS.map(([k, t, cls]) => {
    if (!k) return `<th>${t}</th>`;
    const on = st.sort === k;
    return `<th class="${cls}" data-sort="${k}" aria-sort="${on ? (st.dir > 0 ? 'ascending' : 'descending') : 'none'}" title="点击排序">${t}<span class="arr">${on ? (st.dir > 0 ? ' ▲' : ' ▼') : ''}</span></th>`;
  }).join('');
  const rate = (v, warnAt, badAt) => (v == null ? '—' : `<span style="color:${v < badAt ? 'var(--danger)' : v < warnAt ? 'var(--warn)' : 'inherit'}">${v}%</span>`);
  const body = rows.map((e) => `<tr data-drill="${esc(e.path)}" tabindex="0" title="${esc(e.summary || '查看这个接口的详细统计')}">
    <td class="as-ep-name"><b>${esc(e.title ?? e.module ?? e.path)}</b><span class="mono">${esc(e.path)}</span></td>
    <td class="num"><b>${fmtNum(e.calls)}</b></td><td class="num">${asPct(e.share)}</td><td class="num">${rate(e.successRate, 99, 95)}</td>
    <td class="num">${e.e4xx ? fmtNum(e.e4xx) : '<span class="faint">0</span>'}</td>
    <td class="num">${e.e5xx ? `<span style="color:var(--danger)">${fmtNum(e.e5xx)}</span>` : '<span class="faint">0</span>'}</td>
    <td class="num">${asMs(e.avgMs)}</td><td class="num">${asMs(e.p95)}</td><td class="num">${asPct(e.cacheHit)}</td>
    <td>${asSpark(e.spark)}</td>
    <td class="num">${e.change == null ? (e.calls ? '<span class="badge brand">新增</span>' : '—') : asChange(e.calls, e.prevCalls, { neutral: false })}</td></tr>`).join('');
  slot.innerHTML = `<div class="as-body"><div class="table-wrap"><table class="table as-ep-table"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>
    <div class="as-pager">${pages > 1 ? `<button class="btn sm" type="button" data-ep-page="${st.page - 1}" ${st.page <= 1 ? 'disabled' : ''}>上一页</button>
      <span class="small faint">第 ${st.page} / ${pages} 页 · 共 ${fmtNum(list.length)} 个</span>
      <button class="btn sm" type="button" data-ep-page="${st.page + 1}" ${st.page >= pages ? 'disabled' : ''}>下一页</button>`
    : `<span class="small faint">共 ${fmtNum(list.length)} 个 · 点击一行查看详情</span>`}</div></div>`;
}

function asExportCsv() {
  const st = asState.ep;
  if (!st.items.length) return toast('接口明细还没有数据', true);
  const list = asEpFiltered();
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`; // 防止被 Excel 当成公式
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['接口名称', '地址', '模块', '分类', '调用次数', '占比(%)', '成功率(%)', '4xx', '5xx', '失败率(%)', '限流', '平均耗时(ms)', 'P95(ms)', '缓存命中率(%)', '平均响应(字节)', '上期调用', '较上期(%)'];
  const lines = [head, ...list.map((e) => [e.title ?? '', e.path, e.module ?? '', e.category ? catOf(e.category).title : '', e.calls, e.share, e.successRate, e.e4xx, e.e5xx,
    e.errorRate, e.limited, e.avgMs, e.p95, e.cacheHit, e.avgBytes, e.prevCalls, e.change])].map((r) => r.map(cell).join(','));
  const blob = new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // 文件名用 ASCII：个别浏览器遇到中文文件名会退回成没有扩展名的 download
  const r = asState.range;
  a.download = `miao-api-endpoints-${r.key === 'custom' ? `${r.from}_${r.to}` : r.key}-${asYmd(Date.now())}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`已导出 ${list.length} 个接口`);
}

// ---------- 调用方 / 来源 / 地域 ----------
const asCappedNote = (w) => {
  if (!w?.capped) return '';
  const days = Math.max(1, Math.round((w.to - w.from) / AS_DAY));
  return `<div class="as-note warn">来源、地域等明细只保留最近 ${days} 天，这里只统计 ${asYmd(w.from)} 之后的调用</div>`;
};
// limit：超出的行先收起，点「展开全部」再显示
const asTable = (head, rows, empty = '暂无数据', limit = Infinity) => (rows.length
  ? `<div class="as-tbl${rows.length > limit ? ' as-collapsed' : ''}"><div class="table-wrap"><table class="table"><thead><tr>${head.map(([t, c]) => `<th class="${c ?? ''}">${t}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r, i) => (i >= limit ? r.replace(/^\s*<tr/, '<tr data-more') : r)).join('')}</tbody></table></div>
    ${rows.length > limit ? `<div class="as-pager"><button class="btn sm ghost" type="button" data-as-more>展开全部 ${rows.length} 条</button></div>` : ''}</div>`
  : asEmpty(empty));
const asIpWhere = (x) => [x.region, x.isp].filter(Boolean).map(esc).join(' · ') || '<span class="faint">未知</span>';

function asRenderAudience(root, d) {
  const via = ['anon', 'session', 'apikey'].map((k) => ({ k, calls: d.via.find((v) => v.via === k)?.calls ?? 0 }));
  const viaTotal = via.reduce((s, v) => s + v.calls, 0);
  const viaColor = { anon: 'var(--series-1)', session: 'var(--series-2)', apikey: 'var(--as-s3)' };
  const ips = d.ips;
  asSlot(root, 'callers').innerHTML = `<div class="as-body">
    <div class="as-grid2" style="margin-bottom:18px">
      <div><div class="as-sub">调用方式</div>
        ${viaTotal ? `<div class="as-split">${via.filter((v) => v.calls).map((v) => `<i style="width:${(v.calls / viaTotal) * 100}%;background:${viaColor[v.k]}" title="${AS_VIA[v.k]} ${fmtNum(v.calls)} 次"></i>`).join('')}</div>` : ''}
        ${asHBars(via.map((v) => ({ label: `<i class="as-sw" style="background:${viaColor[v.k]}"></i> ${AS_VIA[v.k]}`, value: v.calls, color: viaColor[v.k] })), { total: viaTotal || 1 })}</div>
      <div><div class="as-sub">访客 IP <span class="faint">共 ${fmtNum(ips.total)} 个</span></div>
        ${ips.total ? `<div class="as-split"><i style="width:${(ips.new / ips.total) * 100}%;background:var(--series-1)"></i><i style="width:${(ips.returning / ips.total) * 100}%;background:var(--series-2)"></i></div>` : ''}
        ${asHBars([{ label: '<i class="as-sw" style="background:var(--series-1)"></i> 新 IP', sub: '第一次出现', value: ips.new }, { label: '<i class="as-sw" style="background:var(--series-2)"></i> 回访 IP', sub: '之前来过', value: ips.returning, color: 'var(--series-2)' }], { total: ips.total || 1 })}</div>
    </div>
    <div class="as-grid3">
      <div><div class="as-sub">调用最多的用户</div>${asTable([['邮箱'], ['调用', 'num'], ['失败', 'num'], ['最近', 'nowrap']],
        d.topUsers.map((u) => `<tr><td class="as-trunc" title="${esc(u.email ?? '')}">${u.email ? esc(u.email) : `<span class="faint">已删除 #${esc(u.id)}</span>`}</td><td class="num">${fmtNum(u.calls)}</td>
          <td class="num">${u.errors ? `<span style="color:var(--danger)">${fmtNum(u.errors)}</span>` : '<span class="faint">0</span>'}</td><td class="small faint nowrap">${asAgo(u.lastAt)}</td></tr>`), '还没有登录用户调用', 10)}</div>
      <div><div class="as-sub">调用最多的 API Key</div>${asTable([['Key'], ['所属用户'], ['调用', 'num'], ['最近', 'nowrap']],
        d.topKeys.map((k) => `<tr><td class="nowrap">${k.name ? esc(k.name) : '<span class="faint">未命名</span>'}${k.prefix ? ` <span class="mono small faint">${esc(k.prefix)}…</span>` : ''}</td>
          <td class="as-trunc small" title="${esc(k.email ?? '')}">${esc(k.email ?? '—')}</td><td class="num">${fmtNum(k.calls)}</td><td class="small faint nowrap">${asAgo(k.lastAt)}</td></tr>`), '还没有通过 API Key 的调用', 10)}</div>
      <div><div class="as-sub">调用最多的 IP</div>${asTable([['IP'], ['地区 / 运营商'], ['用户', 'num'], ['调用', 'num']],
        d.topIps.map((x) => `<tr title="最近 ${asAgo(x.lastAt)}"><td class="mono small nowrap">${esc(x.ip)}</td><td class="small nowrap">${asIpWhere(x)}</td>
          <td class="num">${fmtNum(x.users)}</td><td class="num">${fmtNum(x.calls)}</td></tr>`), '暂无数据', 10)}</div>
    </div>${asCappedNote(d.window)}</div>`;

  const refTotal = d.referers.reduce((s, r) => s + r.calls, 0) + d.noReferer;
  const cliTotal = d.clients.reduce((s, r) => s + r.calls, 0);
  asSlot(root, 'sources').innerHTML = `<div class="as-body">
    <div class="as-sub">来源网站 <span class="faint">按 Referer 的域名</span></div>
    ${d.referers.length || d.noReferer ? asHBars([...d.referers.map((r) => ({ label: esc(r.host), title: r.host, value: r.calls })),
      ...(d.noReferer ? [{ label: '<span class="faint">无来源（直接调用 / 程序调用）</span>', value: d.noReferer, color: 'var(--text-3)' }] : [])], { total: refTotal }) : asEmpty()}
    <div class="as-sub" style="margin-top:18px">客户端类型 <span class="faint">按 User-Agent 判断</span></div>
    ${asHBars(d.clients.map((c) => ({ label: esc(c.name), value: c.calls, color: 'var(--series-2)' })), { total: cliTotal })}
    ${asCappedNote(d.window)}</div>`;

  const regTotal = d.regions.reduce((s, r) => s + r.calls, 0) + d.unknownRegion;
  const ispTotal = d.isps.reduce((s, r) => s + r.calls, 0);
  const regs = d.regions.slice(0, 15);
  asSlot(root, 'geo').innerHTML = `<div class="as-body">
    <div class="as-sub">地区 <span class="faint">按调用次数</span></div>
    ${regs.length || d.unknownRegion ? asHBars([...regs.map((r) => ({ label: esc(r.region), sub: `${fmtNum(r.ips)} 个 IP`, value: r.calls })),
      ...(d.unknownRegion ? [{ label: '<span class="faint">未知</span>', value: d.unknownRegion, color: 'var(--text-3)' }] : [])], { total: regTotal }) : asEmpty()}
    ${d.regions.length > regs.length ? `<div class="as-note">只显示前 ${regs.length} 个地区（共 ${d.regions.length} 个）</div>` : ''}
    <div class="as-sub" style="margin-top:18px">运营商</div>
    ${asHBars(d.isps.map((r) => ({ label: esc(r.isp), value: r.calls, color: 'var(--series-2)' })), { total: ispTotal })}
    ${asCappedNote(d.window)}</div>`;
}

// ---------- 用户增长 ----------
function asRenderGrowth(root, d) {
  const ret = (r, label, tip) => `<div title="${esc(tip)}"><div class="k">${label}</div>${r.cohort
    ? `<div class="v">${asPct(r.rate)}</div><div class="s">${fmtNum(r.retained)} / ${fmtNum(r.cohort)} 人</div>`
    : '<div class="v faint" style="font-size:16px">样本不足</div><div class="s">还没有满足条件的新用户</div>'}</div>`;
  const slot = asSlot(root, 'growth');
  const hasData = d.daily.some((x) => x.registrations || x.activeUsers);
  slot.innerHTML = `<div class="as-body"><div class="as-kv">
      <div title="全部注册用户（含已停用）"><div class="k">注册用户</div><div class="v">${fmtNum(d.totalUsers)}</div><div class="s">${d.disabledUsers ? `已停用 ${fmtNum(d.disabledUsers)}` : '无停用'}</div></div>
      <div title="最近 24 小时有调用的注册用户"><div class="k">日活 DAU</div><div class="v">${fmtNum(d.dau)}</div><div class="s">最近 24 小时</div></div>
      <div title="最近 7 天有调用的注册用户"><div class="k">周活 WAU</div><div class="v">${fmtNum(d.wau)}</div><div class="s">最近 7 天</div></div>
      <div title="最近 30 天有调用的注册用户"><div class="k">月活 MAU</div><div class="v">${fmtNum(d.mau)}</div><div class="s">最近 30 天</div></div>
      ${ret(d.retention.d1, '次日留存', '注册后第 2 天（24~48 小时内）仍有调用的比例')}
      ${ret(d.retention.d7, '7 日留存', '注册 7 天后的一周内仍有调用的比例')}
    </div>
    ${hasData ? `${asLegend([{ label: '新注册', color: 'var(--series-1)' }, { label: '活跃用户', color: 'var(--series-2)' }])}<div class="as-growth-plot"></div>` : asEmpty('这段时间没有注册或活跃用户')}
    <div class="as-note">留存按调用明细计算，只统计明细保留期内注册的用户</div></div>`;
  if (hasData) {
    const rows = d.daily.map((x) => ({ ...x, t: Date.parse(`${x.day}T00:00:00+08:00`) }));
    asTimeChart($('.as-growth-plot', slot), rows, {
      gran: 'day', unit: '人', height: 160,
      stack: [{ key: 'registrations', label: '新注册', color: 'var(--series-1)' }],
      line: { key: 'activeUsers', label: '活跃用户', color: 'var(--series-2)' }, showLine: true,
    });
  }
}

// ---------- 限流与错误 ----------
function asRenderIssues(root, d) {
  const lim = d.limited;
  const statusBadge = (s) => `<span class="badge ${s >= 500 ? 'danger' : s === 429 ? 'warn' : s >= 400 ? 'warn' : 'ok'}">${esc(s)}</span>`;
  asSlot(root, 'issues').innerHTML = `<div class="as-body">
    <div class="as-grid2" style="margin-bottom:18px">
      <div><div class="as-sub">被限流最多的调用方 <span class="faint">共 ${fmtNum(lim.total)} 次</span></div>
        ${asTable([['类型'], ['调用方'], ['次数', 'num'], ['主要接口']], lim.subjects.map((s) => `<tr>
          <td><span class="badge ${s.type === 'user' ? 'brand' : ''}">${s.type === 'user' ? '用户' : 'IP'}</span></td>
          <td class="as-trunc"><span class="${s.type === 'ip' ? 'mono small' : ''}">${esc(s.label)}</span>${s.region ? `<div class="small faint">${esc(s.region)}</div>` : ''}</td>
          <td class="num"><b>${fmtNum(s.count)}</b></td>
          <td class="small">${s.paths.map((p) => `<div class="nowrap"><span class="mono small">${esc(p.path)}</span> <span class="faint">${fmtNum(p.count)}</span></div>`).join('')}</td></tr>`), '这段时间没有调用被限流', 10)}</div>
      <div><div class="as-sub">限流最多的接口</div>
        ${asHBars(lim.paths.map((p) => ({ label: `${esc(p.title ?? p.path)} <span class="mono small faint">${esc(p.path)}</span>`, title: p.path, value: p.count, color: 'var(--warn)', attrs: `data-drill="${esc(p.path)}"` })))}</div>
    </div>
    <div class="as-sub">失败的调用 <span class="faint">按接口、状态码和原因分组</span></div>
    ${asTable([['接口'], ['状态'], ['原因'], ['次数', 'num'], ['首次', 'nowrap'], ['最近', 'nowrap'], ['']], d.errors.map((e) => `<tr>
      <td class="as-ep-name" data-drill="${esc(e.path)}" style="cursor:pointer" title="查看这个接口的详细统计"><b>${esc(e.title ?? e.path)}</b><span class="mono">${esc(e.path)}</span></td>
      <td>${statusBadge(e.status)}</td><td class="small" style="min-width:160px">${e.error ? esc(e.error) : '<span class="faint">（没有记录原因）</span>'}</td>
      <td class="num"><b>${fmtNum(e.count)}</b></td><td class="small faint nowrap" title="${esc(shortDate(e.firstAt))}">${asAgo(e.firstAt)}</td>
      <td class="small faint nowrap" title="${esc(shortDate(e.lastAt))}">${asAgo(e.lastAt)}</td>
      <td>${e.path.startsWith('/api/') && e.status >= 500 ? `<button class="btn sm" type="button" data-diagnose="${esc(e.path)}">AI 分析</button>` : ''}</td></tr>`), '这段时间没有失败的调用', 12)}
    ${asCappedNote(d.window)}</div>`;
}

// ---------- 自动检测 ----------
function asRenderHealth(root, d) {
  const btn = $('#as-health-run', root);
  if (btn) { btn.disabled = !!d.running; btn.textContent = d.running ? '检测中…' : '立即检测'; }
  const lr = d.lastRun;
  const lrAt = lr ? Date.parse(lr.at) : null;
  asSlot(root, 'health').innerHTML = `<div class="as-body">
    <div class="as-kv">
      <div><div class="k">上次检测</div><div class="v" style="font-size:17px">${lr ? asAgo(lrAt) : '—'}</div><div class="s">${lr ? esc(shortDate(lrAt)) : '服务启动后还没有完成过检测'}</div></div>
      <div><div class="k">用时</div><div class="v" style="font-size:17px">${lr ? asMs(lr.ms) : '—'}</div><div class="s">每 ${fmtNum(d.intervalMin)} 分钟自动检测一次</div></div>
      <div><div class="k">检测接口</div><div class="v" style="font-size:17px">${lr ? fmtNum(lr.total) : '—'}</div><div class="s">用示例参数实际调用</div></div>
      <div><div class="k">失败</div><div class="v" style="font-size:17px;${lr?.failed ? 'color:var(--danger)' : ''}">${lr ? fmtNum(lr.failed) : '—'}</div><div class="s">${d.running ? '<span class="spinner" style="width:12px;height:12px;vertical-align:-2px"></span> 正在检测…' : lr ? (lr.failed ? '需要关注' : '全部正常') : ''}</div></div>
    </div>
    ${d.failed.length ? `<div class="as-sub">最近一次检测失败的接口</div>${asTable([['接口'], ['状态'], ['耗时', 'num'], ['原因'], ['']], d.failed.map((f) => `<tr>
      <td class="as-ep-name" data-drill="${esc(f.path)}" style="cursor:pointer"><b>${esc(f.module)}</b><span class="mono">${esc(f.path)}</span></td>
      <td><span class="badge danger">${esc(f.status ?? '失败')}</span></td><td class="num">${asMs(f.ms)}</td><td class="small" style="min-width:160px">${esc(f.error ?? '—')}</td>
      <td>${f.path.startsWith('/api/') ? `<button class="btn sm" type="button" data-diagnose="${esc(f.path)}">AI 分析</button>` : ''}</td></tr>`), '暂无数据', 10)}`
    : lr ? '<div class="small faint">最近一次检测全部通过。</div>' : ''}</div>`;
}

async function asRunHealth(root) {
  const btn = $('#as-health-run', root);
  btn.disabled = true;
  btn.textContent = '检测中…';
  try {
    await api('POST', '/admin/health/run', {});
    toast('已开始检测，完成后自动刷新');
  } catch (err) {
    if (err.status !== 409) { toast(err.message, true); btn.disabled = false; btn.textContent = '立即检测'; return; }
  }
  for (;;) {
    await sleep(3000);
    if (!root.isConnected) return;
    let h;
    try { h = await api('GET', '/admin/health'); } catch (err) { toast(err.message, true); return; }
    if (!root.isConnected) return;
    asRenderHealth(root, h);
    if (!h.running) {
      toast(h.lastRun?.failed ? `检测完成：${h.lastRun.failed} 个接口失败` : '检测完成，全部正常', !!h.lastRun?.failed);
      return;
    }
  }
}

// ---------- 单个接口详情 ----------
const AS_LAT_LABEL = (le) => (le == null ? '>5s' : le >= 1000 ? `≤${le / 1000}s` : `≤${le}ms`);

function asOpenDrill(path) {
  const qs = asQs();
  modal(`<div class="as-drill"><div class="as-drill-head"><div style="min-width:0"><h2 id="as-d-title">接口详情</h2><div class="mono small">${esc(path)}</div></div>
    <div class="row" style="gap:8px">${path.startsWith('/api/') ? `<button class="btn sm" type="button" data-as-ai>${icon('sparkle')}AI 分析</button>` : ''}<button class="btn sm" type="button" data-as-close>关闭</button></div></div>
    <div id="as-d-body">${asSkel(90)}${asSkel(200)}</div></div>`, async (back, close) => {
    $('[data-as-close]', back).addEventListener('click', close);
    back.addEventListener('click', asToggleMore);
    $('[data-as-ai]', back)?.addEventListener('click', () => { close(); openDiagnose(path); });
    const body = $('#as-d-body', back);
    let d;
    try {
      d = await api('GET', `/admin/analytics/endpoint?${qs}&path=${encodeURIComponent(path)}`);
    } catch (err) {
      if (body.isConnected) body.innerHTML = `<div class="form-error">加载失败：${esc(err.message)}</div>`;
      return;
    }
    if (!body.isConnected) return;
    $('#as-d-title', back).textContent = d.title ?? d.module ?? '接口详情';
    const { cur, prev } = d.kpi;
    const kv = (k, v, ch, tip = '') => `<div title="${esc(tip)}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${ch}</div></div>`;
    const latTotal = d.latency.reduce((s, x) => s + x.count, 0);
    const stTotal = d.statuses.reduce((s, x) => s + x.count, 0);
    const stColor = (s) => (s >= 500 ? 'var(--danger)' : s >= 400 ? 'var(--warn)' : 'var(--ok)');
    const hasSeries = d.series.some((r) => r.calls);
    body.innerHTML = `
      ${d.summary ? `<p class="small muted" style="margin:-6px 0 14px">${esc(d.summary)}${d.category ? ` · ${esc(catOf(d.category).title)}` : ''}</p>` : ''}
      <div class="as-kv">
        ${kv('调用', fmtNum(cur.calls), asChange(cur.calls, prev.calls), `上期 ${fmtNum(prev.calls)}`)}
        ${kv('成功率', asPct(cur.successRate), asChange(cur.successRate, prev.successRate, { pp: true }), `上期 ${asPct(prev.successRate)}`)}
        ${kv('4xx / 5xx', `${fmtNum(cur.e4xx)}<small> / </small>${fmtNum(cur.e5xx)}`, asChange(cur.e5xx, prev.e5xx, { goodUp: false }), '变化按 5xx 计算')}
        ${kv('平均耗时', asMs(cur.avgMs), asChange(cur.avgMs, prev.avgMs, { goodUp: false }), `上期 ${asMs(prev.avgMs)}`)}
        ${kv('P95', asMs(cur.p95), asChange(cur.p95, prev.p95, { goodUp: false }), `P50 ${asMs(cur.p50)} · 最大 ${asMs(cur.maxMs)}`)}
        ${kv('缓存命中', asPct(cur.cacheHit), asChange(cur.cacheHit, prev.cacheHit, { pp: true }), `上期 ${asPct(prev.cacheHit)}`)}
        ${kv('限流', fmtNum(cur.limited), asChange(cur.limited, prev.limited, { goodUp: false }))}
        ${kv('平均响应', asBytes(cur.avgBytes), '<span class="faint">响应大小</span>')}
      </div>
      <div class="as-dsec"><div class="as-sub">调用趋势</div>${hasSeries ? `${asLegend([...AS_STACK, { label: '失败（5xx）', color: 'var(--danger)' }])}<div class="as-d-plot"></div>` : asEmpty('这段时间没有调用')}</div>
      <div class="as-grid2 as-dsec">
        <div><div class="as-sub">耗时分布</div>${latTotal ? asHBars(d.latency.map((x) => ({ label: AS_LAT_LABEL(x.le), value: x.count })), { total: latTotal }) : asEmpty()}</div>
        <div><div class="as-sub">状态码</div>${stTotal ? asHBars(d.statuses.map((x) => ({ label: `<span class="badge ${x.status >= 500 ? 'danger' : x.status >= 400 ? 'warn' : 'ok'}">${esc(x.status)}</span>`, value: x.count, color: stColor(x.status) })), { total: stTotal }) : asEmpty()}</div>
      </div>
      <div class="as-dsec"><div class="as-sub">失败原因</div>${asTable([['状态'], ['原因'], ['次数', 'num'], ['首次', 'nowrap'], ['最近', 'nowrap']], d.errors.map((e) => `<tr>
        <td><span class="badge ${e.status >= 500 ? 'danger' : 'warn'}">${esc(e.status)}</span></td><td class="small" style="min-width:160px">${e.error ? esc(e.error) : '<span class="faint">（没有记录原因）</span>'}</td>
        <td class="num">${fmtNum(e.count)}</td><td class="small faint nowrap" title="${esc(shortDate(e.firstAt))}">${asAgo(e.firstAt)}</td><td class="small faint nowrap" title="${esc(shortDate(e.lastAt))}">${asAgo(e.lastAt)}</td></tr>`), '没有失败的调用')}</div>
      <div class="as-grid2 as-dsec">
        <div><div class="as-sub">调用最多的用户</div>${asHBars(d.topUsers.map((u) => ({ label: esc(u.email ?? `#${u.id}`), title: u.email, value: u.calls })))}</div>
        <div><div class="as-sub">调用最多的 IP</div>${asHBars(d.topIps.map((x) => ({ label: `<span class="mono small">${esc(x.ip ?? '未知')}</span>`, sub: asIpWhere(x), value: x.calls, color: 'var(--series-2)' })))}</div>
      </div>
      <div class="as-grid2 as-dsec">
        <div><div class="as-sub">来源网站</div>${asHBars(d.referers.map((r) => ({ label: esc(r.host), title: r.host, value: r.calls })))}</div>
        <div><div class="as-sub">客户端</div>${asHBars(d.clients.map((c) => ({ label: esc(c.name), value: c.calls, color: 'var(--series-2)' })))}</div>
      </div>
      <div class="as-dsec"><div class="as-sub">最近的自动检测</div>${asTable([['时间', 'nowrap'], ['结果'], ['状态'], ['耗时', 'num'], ['说明']], d.health.map((h) => `<tr>
        <td class="small nowrap" title="${esc(shortDate(h.ts))}">${esc(asMd(h.ts))}</td><td><span class="badge ${h.ok ? 'ok' : 'danger'}">${h.ok ? '正常' : '失败'}</span></td>
        <td class="small">${esc(h.status ?? '—')}</td><td class="num">${asMs(h.ms)}</td><td class="small" style="min-width:140px">${esc(h.error ?? '')}</td></tr>`), '还没有检测记录', 8)}</div>
      ${asCappedNote(d.window)}`;
    if (hasSeries) {
      asTimeChart($('.as-d-plot', body), d.series, {
        gran: d.range?.gran ?? 'day', stack: AS_STACK, unit: '次', height: 170,
        line: { key: 'e5xx', label: '失败（5xx）', color: 'var(--danger)' }, showLine: true,
        lower: { key: 'p95', label: 'P95 耗时', fmt: asMs }, showLower: true,
      });
    }
  });
}

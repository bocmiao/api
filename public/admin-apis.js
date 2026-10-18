// 接口工作台（管理后台 → 接口）：可视化编辑接口文案、试跑、体检，以及新增/发布声明式接口。
// 依赖 app.js 里的 $、esc、api、toast、navigate、adminTabs、promptDialog 等全局函数。
// 本文件在 app.js 之后加载，页面函数在 DOMContentLoaded 之后才被调用。

const API_TEMPLATE = {
  name: 'custom-example',
  category: 'tools',
  title: '示例接口',
  description: '从后台新增的声明式接口：抓取一个公开数据源并映射成统一格式。',
  sourceInfo: { kind: 'third-party-service', network: 'required', summary: '示例数据源，发布前请改成真实来源。' },
  routes: [{
    method: 'GET',
    path: '/api/custom/example',
    summary: '示例：按关键词查询',
    params: [{ name: 'q', required: true, desc: '关键词', example: 'hello', maxLength: 40 }],
    url: 'https://api.example.com/search?q={q}',
    extract: 'data',
    map: { title: 'name', link: 'url' },
    fields: [{ name: 'title', type: 'string', desc: '标题' }, { name: 'link', type: 'string', desc: '链接' }],
    cacheTtlSec: 300,
    timeoutMs: 10000,
  }],
};

const apiUrl = (name) => `/admin/apis/${encodeURIComponent(name)}`;
const originBadge = (m) => m.custom
  ? '<span class="badge warn">自定义</span>'
  : '<span class="badge">核心</span>';

async function pageAdminApis(name) {
  if (!state.user?.isAdmin) return pageNotFound();
  if (name === 'new') return pageAdminApiNew();
  if (name) return pageAdminApiDetail(name);
  return pageAdminApiList();
}

// ---------- 列表 ----------

async function pageAdminApiList() {
  $('#main').innerHTML = '<div class="wrap"><div class="loading"><span class="spinner"></span></div></div>';
  const d = await cachedGet('/admin/apis');
  const rows = d.modules.map((m) => {
    const draftOnly = m.customDraft && !m.version;
    const stateBadge = draftOnly
      ? '<span class="badge warn">草稿</span>'
      : m.compliance
        ? `<span class="badge danger" title="${esc(m.compliance)}">合规下线</span>`
        : m.enabled ? '<span class="badge ok">正常</span>' : '<span class="badge">已关闭</span>';
    const health = m.health ? (m.health.ok ? '<span class="badge ok">最近正常</span>' : `<span class="badge danger" title="${esc(m.health.error ?? '')}">最近失败</span>`) : '<span class="faint">未检测</span>';
    const search = `${m.name} ${m.title} ${m.category} ${m.routes.map((r) => r.path).join(' ')}`.toLowerCase();
    return `<tr data-search="${esc(search)}">
      <td><a href="${apiUrl(m.name)}"><b>${esc(m.title)}</b></a><div class="small faint mono">${esc(m.name)}</div></td>
      <td class="small">${esc(m.category)}</td>
      <td>${originBadge(m)}</td>
      <td>${stateBadge}${m.customDraft ? ' <span class="badge warn">有草稿</span>' : ''}</td>
      <td class="num">${fmtNum(m.calls7d)}</td>
      <td class="num">${m.overrides ? `<span class="badge">${m.overrides}</span>` : '<span class="faint">—</span>'}</td>
      <td>${health}</td>
      <td class="num"><a class="btn sm" href="${apiUrl(m.name)}">编辑</a></td>
    </tr>`;
  }).join('');
  const doctor = d.doctor;
  const doctorHtml = doctor.ok
    ? '<span class="badge ok">体检通过</span> <span class="small faint">没有失效文案</span>'
    : `<span class="badge danger">${doctor.issues.length} 项待处理</span>
       <div class="small" style="margin-top:8px;line-height:1.9">${doctor.issues.slice(0, 8).map((i) => {
        const label = { orphan: '代码里已没有该字段', stale: '代码结构变过', invalid: '内容不合法', 'module-missing': '接口已被删除', 'invalid-target': '目标格式不合法' }[i.kind] ?? i.kind;
        return `<div><code class="mono">${esc(i.target)}</code> · ${esc(label)} ${i.name ? `<a class="small" href="${apiUrl(i.name)}">去处理</a>` : ''}${i.kind === 'module-missing' && i.name ? ` <button class="btn sm" data-clear-meta="${esc(i.name)}">清理</button>` : ''}</div>`;
      }).join('')}${doctor.issues.length > 8 ? '<div class="faint">…还有更多，请在对应接口里处理</div>' : ''}</div>`;
  $('#main').innerHTML = `<div class="wrap" style="padding:28px 20px 80px">
    <div class="page-head"><div><h1>接口</h1><p>可视化编辑接口文案、试跑、体检；也可以在后台新增声明式接口，发布后立即生效</p></div>${adminTabs('apis')}</div>
    <div class="card card-pad" style="margin-bottom:16px">
      <div class="row" style="gap:10px;flex-wrap:wrap;align-items:center">
        <b>体检</b>${doctorHtml}<span style="margin-left:auto"></span>
        <a class="btn sm primary" href="/admin/apis/new">＋ 新建接口</a>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h2>接口列表 <span class="small faint" style="font-weight:400">共 ${d.modules.length} 个</span></h2>
        <div class="row" style="gap:8px"><input class="input" id="api-q" placeholder="搜索名称、路径、说明" style="width:220px;height:32px">
        <a class="btn sm" href="/openapi.json" target="_blank" rel="noopener">OpenAPI</a></div></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>接口</th><th>分类</th><th>类型</th><th>状态</th><th class="num">7 天调用</th><th class="num">文案覆盖</th><th>最近检测</th><th></th></tr></thead>
      <tbody id="api-rows">${rows || '<tr><td colspan="8"><div class="empty">还没有接口</div></td></tr>'}</tbody></table></div>
    </div>
  </div>`;
  $('#api-q').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    for (const tr of $$('#api-rows tr[data-search]')) tr.hidden = Boolean(q) && !tr.dataset.search.includes(q);
  });
  for (const btn of $$('[data-clear-meta]')) {
    btn.addEventListener('click', async () => {
      if (!(await confirmDialog('清理失效文案', `删除 ${btn.dataset.clearMeta} 留下的全部文案补丁？`, { okText: '清理' }))) return;
      try {
        const r = await api('DELETE', `/admin/apis/${encodeURIComponent(btn.dataset.clearMeta)}/meta`);
        toast(`已清理 ${r.cleared} 条`);
        pageAdminApiList();
      } catch (err) { toast(err.message, true); }
    });
  }
}

// ---------- 新建 ----------

async function pageAdminApiNew() {
  $('#main').innerHTML = `<div class="wrap" style="padding:28px 20px 80px">
    <div class="page-head"><div><h1>新建接口</h1><p>声明式配置：取值 → 请求上游 → 映射字段，不执行任意代码</p></div>${adminTabs('apis')}</div>
    <div class="card card-pad">
      <p class="small faint" style="margin-top:0">配置保存为草稿，发布前会校验字段说明；发布后立即出现在首页、文档和 OpenAPI 里。示例里的地址和字段请替换成真实值。</p>
      <textarea class="input mono" id="custom-config" rows="26" style="height:auto;padding:12px;line-height:1.6">${esc(JSON.stringify(API_TEMPLATE, null, 2))}</textarea>
      <div class="row" style="gap:10px;margin-top:12px;flex-wrap:wrap">
        <button class="btn sm primary" id="custom-save">保存草稿</button>
        <button class="btn sm" id="custom-check">校验</button>
        <a class="btn sm ghost" href="/admin/apis">返回</a>
        <span class="small faint" id="custom-msg"></span>
      </div>
      <pre class="mono small" id="custom-out" style="display:none;white-space:pre-wrap;margin-top:12px"></pre>
    </div>
  </div>`;
  const ta = $('#custom-config');
  const out = $('#custom-out');
  const msg = $('#custom-msg');
  const configOf = () => { try { return JSON.parse(ta.value); } catch (err) { throw new Error(`JSON 格式错误：${err.message}`); } };
  $('#custom-check').onclick = async () => {
    try {
      const d = await api('POST', '/admin/custom-apis/validate', { config: configOf() });
      out.style.display = '';
      out.textContent = `校验通过：${d.preview.name}（${d.preview.routes.map((r) => `${r.method} ${r.path}`).join('、')}）`
        + (d.warnings?.length ? `\n注意：${d.warnings.join('；')}` : '');
      msg.textContent = '';
    } catch (err) { toast(err.message, true); msg.textContent = err.message; }
  };
  $('#custom-save').onclick = async () => {
    try {
      const config = configOf();
      await api('POST', '/admin/custom-apis', { config });
      toast('草稿已保存');
      navigate(apiUrl(config.name));
    } catch (err) { toast(err.message, true); msg.textContent = err.message; }
  };
}

// ---------- 详情 ----------

async function pageAdminApiDetail(name) {
  $('#main').innerHTML = '<div class="wrap"><div class="loading"><span class="spinner"></span></div></div>';
  const d = await api('GET', apiUrl(name));
  const m = d.module;
  const groups = new Map([['', []]]);
  for (const t of d.targets) {
    const key = t.path ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const metaSection = (title, list) => list.length ? `<div class="meta-group"><h3 class="meta-group-title">${esc(title)}</h3>
    ${list.map((t) => {
      const long = /description|desc|summary/.test(t.target);
      const control = long
        ? `<textarea class="input" rows="2" style="height:auto;padding:8px" data-meta-target="${esc(t.target)}" data-code="${esc(t.code)}" maxlength="${t.limit}">${esc(t.value)}</textarea>`
        : `<input class="input" data-meta-target="${esc(t.target)}" data-code="${esc(t.code)}" value="${esc(t.value)}" maxlength="${t.limit}">`;
      return `<label class="meta-row${t.overridden ? ' is-overridden' : ''}">
        <span class="meta-label">${esc(t.label)}${t.overridden ? ' <span class="badge ok">已改</span>' : ''}${t.stale ? ' <span class="badge warn" title="代码结构变过，请确认文案">待确认</span>' : ''}</span>
        <span class="meta-code small faint">代码默认：${esc(t.code) || '（空）'}</span>
        ${control}
        ${t.overridden ? `<button class="btn sm ghost" type="button" data-meta-reset="${esc(t.target)}">还原</button>` : ''}
      </label>`;
    }).join('')}
  </div>` : '';

  const metaBody = [...groups.entries()].map(([path, list]) => {
    if (!path) return metaSection('接口信息', list);
    const route = m.routes.find((r) => r.path === path);
    return metaSection(`${path}${route?.summary ? ` · ${route.summary}` : ''}`, list);
  }).join('');

  const routesHtml = m.routes.map((route) => `<div class="card card-pad" style="margin-bottom:10px">
    <div class="row" style="gap:8px;flex-wrap:wrap"><b class="mono">${esc(route.method)} ${esc(route.path)}</b>
      <span class="small">${esc(route.summary ?? '')}</span></div>
    ${(route.params ?? []).length ? `<div class="small" style="margin-top:8px"><b>参数</b>${route.params.map((p) => `<div class="mono small">${esc(p.name)}${p.required ? ' *' : ''} · ${esc(p.desc ?? '')}</div>`).join('')}</div>` : '<div class="small faint" style="margin-top:8px">无需参数</div>'}
    ${(route.fields ?? []).length ? `<details style="margin-top:8px"><summary class="small faint">返回字段（${route.fields.length}）</summary><div class="small" style="margin-top:6px">${route.fields.map((f) => `<div class="mono small">${esc(f.name)}（${esc(f.type)}）· ${esc(f.desc)}</div>`).join('')}</div></details>` : ''}
  </div>`).join('');

  const health = m.health
    ? `${m.health.ok ? '<span class="badge ok">最近正常</span>' : '<span class="badge danger">最近失败</span>'} <span class="small faint">${esc(fmtDate(m.health.ts))}${m.health.ms != null ? ` · ${fmtNum(m.health.ms)} ms` : ''}${m.health.error ? ` · ${esc(m.health.error)}` : ''}</span>`
    : '<span class="small faint">还没有检测记录</span>';

  const customPanel = m.custom ? customEditor(d, m) : `<div class="card card-pad"><p class="small faint" style="margin:0">这是代码里的核心接口：可以改文案、试跑，但不能在网页里改实现逻辑。需要新增接口请用「新建接口」。</p></div>`;
  const draftOnly = m.custom && d.custom && !d.custom.config;

  $('#main').innerHTML = `<div class="wrap" style="padding:28px 20px 80px">
    <div class="page-head"><div><a class="small" href="/admin/apis">← 接口列表</a>
      <h1 style="margin-top:6px">${esc(m.title)}</h1>
      <p><span class="mono">${esc(m.name)}</span> · ${esc(m.category)} · ${originBadge(m)} ${draftOnly ? '<span class="badge warn">草稿</span>' : m.enabled ? '<span class="badge ok">正常</span>' : '<span class="badge">已关闭</span>'}${m.compliance ? `<span class="badge danger">${esc(m.compliance)}</span>` : ''}</p></div>${adminTabs('apis')}</div>
    <div class="seg" id="api-tabs">
      <button class="active" data-tab="overview">概览</button>
      <button data-tab="meta">文案</button>
      <button data-tab="try">试跑</button>
      <button data-tab="custom">${m.custom ? '接口定义' : '说明'}</button>
    </div>
    <section data-panel="overview">
      <div class="card card-pad" style="margin-bottom:16px">
        <div class="grid-2">
          <div><div class="small faint">数据来源</div><div>${esc(m.source ?? '—')}</div>
            ${m.sourceInfo ? `<div class="small faint" style="margin-top:4px">${esc(m.sourceInfo.label)}：${esc(m.sourceInfo.summary)}</div>` : ''}</div>
          <div><div class="small faint">近 7 天调用</div><div style="font-size:22px">${fmtNum(m.calls7d)}</div>
            <div style="margin-top:6px">${health}</div></div>
        </div>
      </div>
      <div class="card" style="margin-bottom:16px"><div class="card-head"><h2>接口地址</h2>
        <div class="row" style="gap:8px"><a class="btn sm" href="/docs/${encodeURIComponent(m.name)}" target="_blank" rel="noopener">查看文档</a>
        <button class="btn sm" id="toggle-module">${m.enabled ? '关闭接口' : '开启接口'}</button></div></div>
        <div class="card-pad">${routesHtml}</div></div>
      <div class="card card-pad"><div class="row" style="gap:16px;flex-wrap:wrap">
        <span class="small faint">shapeHash <code class="mono">${esc(d.shapeHash.slice(0, 12))}</code></span>
        <span class="small faint">注册表版本 <code class="mono">v${d.rev}</code></span>
        <span class="small faint">文案覆盖 ${d.targets.filter((t) => t.overridden).length} 项</span>
      </div></div>
    </section>
    <section data-panel="meta" hidden>
      <div class="card"><div class="card-head"><h2>文案编辑</h2>
        <div class="row" style="gap:8px"><span class="small faint">只改说法，不改参数和字段结构</span><button class="btn sm primary" id="meta-save">保存修改</button></div></div>
        <div class="card-pad" id="meta-body">${metaBody || '<div class="empty">没有可编辑的文案</div>'}</div></div>
    </section>
    <section data-panel="try" hidden>
      <div class="card"><div class="card-head"><h2>试跑</h2><span class="small faint">直接调用处理函数，不计额度、不写调用日志</span></div>
        <div class="card-pad">${tryPanel(m)}</div></div>
    </section>
    <section data-panel="custom" hidden>${customPanel}</section>
  </div>`;

  // 标签切换
  for (const btn of $$('#api-tabs button')) {
    btn.addEventListener('click', () => {
      for (const b of $$('#api-tabs button')) b.classList.toggle('active', b === btn);
      for (const panel of $$('[data-panel]')) panel.hidden = panel.dataset.panel !== btn.dataset.tab;
    });
  }

  $('#toggle-module').onclick = async () => {
    try {
      await api('PUT', '/admin/modules', { names: [m.name], enabled: !m.enabled });
      toast(!m.enabled ? '接口已开启' : '接口已关闭');
      pageAdminApiDetail(name);
    } catch (err) { toast(err.message, true); }
  };

  // 保存文案
  $('#meta-save')?.addEventListener('click', async () => {
    const changes = [];
    for (const el of $$('[data-meta-target]')) {
      if (el.value !== el.dataset.code) changes.push({ target: el.dataset.metaTarget, value: el.value });
    }
    if (!changes.length) return toast('没有修改');
    try {
      const r = await api('PUT', `${apiUrl(name)}/meta`, { changes });
      toast(`已保存 ${r.applied.length} 项文案`);
      pageAdminApiDetail(name);
    } catch (err) { toast(err.message, true); }
  });
  for (const btn of $$('[data-meta-reset]')) {
    btn.addEventListener('click', async () => {
      try {
        await api('PUT', `${apiUrl(name)}/meta`, { reset: [btn.dataset.metaReset] });
        toast('已恢复代码默认值');
        pageAdminApiDetail(name);
      } catch (err) { toast(err.message, true); }
    });
  }

  bindTryPanel(m);
  if (m.custom) bindCustomEditor(d, m);
}

function tryPanel(m) {
  return m.routes.map((route, i) => `<div class="try-block" data-try="${i}" style="margin-bottom:18px">
    <div class="row" style="gap:8px;flex-wrap:wrap"><b class="mono">${esc(route.method)} ${esc(route.path)}</b><span class="small">${esc(route.summary ?? '')}</span></div>
    <div class="row" style="gap:8px;flex-wrap:wrap;margin:8px 0">
      ${(route.params ?? []).filter((p) => p.in !== 'body').map((p) => `<label class="small">${esc(p.name)}${p.required ? ' *' : ''}
        <input class="input" data-param="${esc(p.name)}" data-required="${p.required ? '1' : ''}" value="${esc(p.example ?? '')}" placeholder="${esc(p.desc ?? '')}" style="height:32px;min-width:150px"></label>`).join('') || '<span class="small faint">无需参数</span>'}
      ${route.method === 'POST' ? `<textarea class="input mono" data-body rows="2" placeholder='JSON body（可选）' style="height:auto;min-width:260px;padding:6px"></textarea>` : ''}
      <button class="btn sm primary" data-run="${i}">运行</button>
    </div>
    <pre class="mono small" data-out="${i}" style="display:none;white-space:pre-wrap;background:var(--bg-soft,#f6f6f6);padding:10px;border-radius:8px;max-height:320px;overflow:auto"></pre>
  </div>`).join('');
}

function bindTryPanel(m) {
  for (const btn of $$('[data-run]')) {
    btn.addEventListener('click', async () => {
      const i = Number(btn.dataset.run);
      const route = m.routes[i];
      const block = btn.closest('[data-try]');
      const query = {};
      for (const input of block.querySelectorAll('[data-param]')) {
        if (input.value !== '') query[input.dataset.param] = input.value;
        else if (input.dataset.required) return toast(`请填写参数 ${input.dataset.param}`, true);
      }
      let body;
      const bodyEl = block.querySelector('[data-body]');
      if (bodyEl?.value.trim()) {
        try { body = JSON.parse(bodyEl.value); } catch { return toast('body 不是合法 JSON', true); }
      }
      const out = block.querySelector('[data-out]');
      out.style.display = '';
      out.textContent = '运行中…';
      try {
        const r = await api('POST', `${apiUrl(m.name)}/try`, { path: route.path, query, body });
        out.textContent = r.ok ? JSON.stringify(r.data, null, 2) : `失败 ${r.error.status}：${r.error.message}`;
      } catch (err) { out.textContent = err.message; }
    });
  }
}

// ---------- 自定义接口 ----------

function customEditor(d, m) {
  const working = d.custom.draft ?? d.custom.config;
  const status = d.custom.status === 'draft'
    ? '<span class="badge warn">有未发布的草稿</span>'
    : '<span class="badge ok">已发布</span>';
  return `<div class="card" style="margin-bottom:16px"><div class="card-head"><h2>接口定义</h2>
      <div class="row" style="gap:8px">${status}
        <button class="btn sm" id="custom-check">校验</button>
        <button class="btn sm" id="custom-save">保存草稿</button>
        <button class="btn sm primary" id="custom-publish">发布</button>
        ${d.custom.draft && d.custom.config ? '<button class="btn sm ghost" id="custom-discard">放弃草稿</button>' : ''}
        <button class="btn sm danger" id="custom-delete">删除</button></div></div>
    <div class="card-pad">
      <p class="small faint" style="margin-top:0">声明式配置：url 里用 <code>{参数名}</code> 取值，<code>{env:变量名}</code> 引用环境变量；extract 取上游路径，map 映射成返回字段。保存草稿不影响线上，发布后才生效。</p>
      <textarea class="input mono" id="custom-config" rows="22" style="height:auto;padding:12px;line-height:1.6">${esc(JSON.stringify(working, null, 2))}</textarea>
      <pre class="mono small" id="custom-out" style="display:none;white-space:pre-wrap;margin-top:12px"></pre>
      ${d.custom.config ? `<details style="margin-top:14px"><summary class="small faint">当前线上版本：v${d.custom.version}${d.custom.publishedAt ? ` · ${esc(fmtDate(d.custom.publishedAt))}` : ''}</summary>
        <pre class="mono small" style="white-space:pre-wrap;margin-top:8px">${esc(JSON.stringify(d.custom.config, null, 2))}</pre></details>` : ''}
    </div></div>
    ${d.custom.versions?.length ? `<div class="card"><div class="card-head"><h2>发布记录</h2><span class="small faint">回滚只切换线上指向，不改历史</span></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>版本</th><th>说明</th><th>发布人</th><th>时间</th><th></th></tr></thead><tbody>
      ${d.custom.versions.map((v) => `<tr><td>v${v.version}</td><td class="small">${esc(v.note ?? '—')}</td><td class="small">${esc(v.createdBy ?? '—')}</td><td class="small">${esc(fmtDate(v.createdAt))}</td>
        <td class="num"><button class="btn sm" data-rollback="${v.version}">回滚到此版</button></td></tr>`).join('')}
      </tbody></table></div></div>` : ''}`;
}

function bindCustomEditor(d, m) {
  const ta = $('#custom-config');
  const out = $('#custom-out');
  const configOf = () => {
    try { return JSON.parse(ta.value); } catch (err) { throw new Error(`JSON 格式错误：${err.message}`); }
  };
  $('#custom-check').onclick = async () => {
    try {
      const r = await api('POST', '/admin/custom-apis/validate', { config: configOf() });
      out.style.display = '';
      out.textContent = `校验通过：${r.preview.name}\n${r.preview.routes.map((x) => `${x.method} ${x.path}`).join('\n')}`
        + (r.warnings?.length ? `\n\n注意：\n${r.warnings.join('\n')}` : '');
    } catch (err) { out.style.display = ''; out.textContent = err.message; toast(err.message, true); }
  };
  $('#custom-save').onclick = async () => {
    try {
      await api('PUT', `/admin/custom-apis/${encodeURIComponent(m.name)}`, { config: configOf() });
      toast('草稿已保存');
      pageAdminApiDetail(m.name);
    } catch (err) { toast(err.message, true); }
  };
  $('#custom-publish').onclick = async () => {
    const reason = await promptDialog('发布接口', '填写发布说明（会记录到操作日志）', { placeholder: '例如：新增热榜来源、修正上游地址' });
    if (!reason) return;
    try {
      await api('POST', `/admin/custom-apis/${encodeURIComponent(m.name)}/publish`, { reason, note: reason });
      toast('已发布，立即生效');
      pageAdminApiDetail(m.name);
    } catch (err) { toast(err.message, true); }
  };
  $('#custom-discard')?.addEventListener('click', async () => {
    if (!(await confirmDialog('放弃草稿', '未发布的修改会丢失，确定继续？'))) return;
    try {
      await api('POST', `/admin/custom-apis/${encodeURIComponent(m.name)}/discard`, {});
      toast('已放弃草稿');
      pageAdminApiDetail(m.name);
    } catch (err) { toast(err.message, true); }
  });
  $('#custom-delete').onclick = async () => {
    if (!(await confirmDialog('删除接口', `删除 ${m.name} 后，所有调用会返回 404，且发布记录一并删除。`, { okText: '永久删除' }))) return;
    const reason = await promptDialog('删除接口', '填写删除原因（会记录到操作日志）', { placeholder: '例如：上游已停止服务' });
    if (!reason) return;
    try {
      await api('DELETE', `/admin/custom-apis/${encodeURIComponent(m.name)}`, { reason });
      toast('接口已删除');
      navigate('/admin/apis');
    } catch (err) { toast(err.message, true); }
  };
  for (const btn of $$('[data-rollback]')) {
    btn.addEventListener('click', async () => {
      const reason = await promptDialog('回滚接口', `回滚到 v${btn.dataset.rollback}，填写原因`, { placeholder: '例如：新版本上游不可用' });
      if (!reason) return;
      try {
        await api('POST', `/admin/custom-apis/${encodeURIComponent(m.name)}/rollback`, { version: Number(btn.dataset.rollback), reason });
        toast(`已回滚到 v${btn.dataset.rollback}`);
        pageAdminApiDetail(m.name);
      } catch (err) { toast(err.message, true); }
    });
  }
}

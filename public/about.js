// 产品发布页（/about）的交互：主题切换、复制、实时请求示例、截图切换、滚动出现动画
document.documentElement.classList.add('js');
(() => {
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const storage = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 无痕模式等 */ } },
  };

  // 主题：与主站共用同一个设置
  const applyTheme = (t) => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
  applyTheme(storage.get('theme'));
  const isDark = () => document.documentElement.dataset.theme === 'dark'
    || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  $('#theme').addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    applyTheme(next);
    storage.set('theme', next);
  });

  // 复制
  async function copy(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    const old = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = old; }, 1500);
  }
  $$('[data-copy]').forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy, b)));

  // JSON 高亮（先转义再着色）
  const escHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  function highlight(obj, maxLines = 400) {
    let text = JSON.stringify(obj, null, 2);
    const lines = text.split('\n');
    if (lines.length > maxLines) text = `${lines.slice(0, maxLines).join('\n')}\n  …`;
    return escHtml(text).replace(
      /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (m, str, colon, lit, num) => {
        if (str) return colon ? `<span class="j-k">${str}</span>${colon}` : `<span class="j-s">${str}</span>`;
        if (lit) return `<span class="j-b">${lit}</span>`;
        return `<span class="j-n">${num}</span>`;
      },
    );
  }

  async function request(path) {
    const t0 = performance.now();
    const res = await fetch(path, { headers: { accept: 'application/json' } });
    const json = await res.json();
    return { json, ms: Math.round(performance.now() - t0), status: res.status };
  }

  // 首屏：实时请求微博热搜，失败时保留示例
  (async () => {
    const path = '/api/hot/weibo?limit=3';
    try {
      const { json } = await request(path);
      if (json.code !== 200) return;
      $('#hero-url').textContent = `GET ${path}`;
      $('#hero-json').innerHTML = `<span class="j-c">// 刚刚实时请求的结果</span>\n${highlight(json, 60)}`;
    } catch { /* 保留页面里的示例 */ }
  })();

  // 在线试用
  const tryJson = $('#try-json');
  let seq = 0;
  async function runTry(btn) {
    $$('.try-item').forEach((b) => { b.classList.toggle('on', b === btn); b.setAttribute('aria-selected', String(b === btn)); });
    const path = btn.dataset.path;
    const my = ++seq;
    $('#try-url').textContent = `GET ${path}`;
    $('#try-doc').href = `/docs/${btn.dataset.doc}`;
    tryJson.innerHTML = '<span class="j-c">// 请求中…</span>';
    $('#try-time').innerHTML = '&nbsp;';
    try {
      const { json, ms, status } = await request(path);
      if (my !== seq) return;
      tryJson.innerHTML = highlight(json);
      $('#try-time').textContent = `HTTP ${status} · ${ms} ms${json.cached ? ' · 来自缓存' : ''}`;
    } catch (err) {
      if (my !== seq) return;
      tryJson.innerHTML = `<span class="j-c">// 请求失败：${escHtml(err.message)}</span>`;
    }
  }
  $$('.try-item').forEach((b) => b.addEventListener('click', () => runTry(b)));
  // 滚动到「在线试用」时才发第一次请求，不浪费访客额度
  const trySec = $('#try');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) { io.disconnect(); runTry($('.try-item.on')); }
    }, { rootMargin: '200px' });
    io.observe(trySec);
  } else {
    runTry($('.try-item.on'));
  }

  // 截图切换
  const SHOTS = [
    ['/img/playground.jpg', 'Miao API 在线调试：返回结果带中文字段注释和示例代码', '每个接口都能在线调试，返回结果旁边直接显示字段的中文说明，下方附 cURL、JavaScript、Python 示例代码。'],
    ['/img/status.jpg', 'Miao API 运行状态页：各接口 24 小时调用量与失败率', '公开的运行状态页，按真实调用统计每个接口最近 24 小时的调用量、平均耗时和失败率。'],
    ['/img/console.jpg', '用户控制台：API Key 管理与调用量统计', '注册后在控制台管理 API Key，查看每天的用量、常用接口和最近的调用记录。'],
    ['/img/admin.jpg', 'Miao API 管理后台：调用统计、接口排行、故障诊断', '自己部署后拥有完整的管理后台：全站统计、接口排行、失败记录，一键巡检和故障诊断。'],
    ['/img/settings.jpg', 'Miao API 管理后台系统设置：额度、注册、第三方密钥', '额度、注册开关、邮件、第三方密钥都在网页里配置，保存后立即生效。'],
  ];
  $$('[data-shot]').forEach((b) => b.addEventListener('click', () => {
    const [src, alt, cap] = SHOTS[Number(b.dataset.shot)];
    $$('[data-shot]').forEach((x) => x.classList.toggle('on', x === b));
    const img = $('#shot-img');
    img.src = src;
    img.alt = alt;
    $('#shot-cap').textContent = cap;
  }));
  // 预加载其余截图，切换时不闪
  window.addEventListener('load', () => SHOTS.slice(1).forEach(([src]) => { new Image().src = src; }));

  // 部署代码切换与复制
  let codeTab = 'node';
  $$('[data-code]').forEach((b) => b.addEventListener('click', () => {
    codeTab = b.dataset.code;
    $$('[data-code]').forEach((x) => x.classList.toggle('on', x === b));
    $('#code-node').hidden = codeTab !== 'node';
    $('#code-docker').hidden = codeTab !== 'docker';
  }));
  $('#copy-code').addEventListener('click', (e) => {
    // 只复制命令本身：去掉注释行和最后的输出示例
    const text = $(`#code-${codeTab}`).textContent.split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#') && !l.startsWith('Miao API 已启动'))
      .map((l) => l.replace(/\s+#.*$/, ''))
      .join('\n');
    copy(text, e.currentTarget);
  });

  // 滚动出现
  const reveals = $$('.reveal');
  if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -60px 0px' });
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add('in'));
  }
})();

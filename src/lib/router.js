// 极简路由：支持 GET/POST/... 与 :param 路径参数
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, path, handler, meta = {}) {
    const keys = [];
    const pattern = path
      .split(/(\/:[a-zA-Z_]+)/)
      .map((seg) => (seg.startsWith('/:') ? (keys.push(seg.slice(2)), '/([^/]+)') : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('');
    const re = new RegExp(`^${pattern}$`);
    this.routes.push({ method, path, re, keys, handler, ...meta });
  }

  match(method, pathname) {
    let allowed = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      allowed = true;
      if (r.method !== method) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      return { route: r, params };
    }
    return allowed ? { methodNotAllowed: true } : null;
  }
}

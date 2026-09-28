// 51.la 网站统计：管理员在「系统设置 → 第三方统计」粘贴 51.la 提供的统计代码（或只填统计 ID），
// 服务端只从中提取 id、ck 和几个开关保存，页面里由本站的 /la51.js 去初始化，
// 不把任意代码原样插进页面，也不需要为此放开内联脚本；安全策略只额外允许 51.la 的域名。
import { HttpError } from './http.js';

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const FLAGS = ['autoTrack', 'hashMode', 'screenRecord'];

// 接受整段统计代码、LA.init({...}) 或只有统计 ID；返回规范化后的 LA.init({...}) 文本，清空时返回 ''
export function normalizeLa51(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (ID_RE.test(text)) return la51Text({ id: text, ck: text, autoTrack: true, hashMode: false, screenRecord: false });
  const pick = (key) => new RegExp(`["']?${key}["']?\\s*:\\s*["']([A-Za-z0-9_-]{1,64})["']`).exec(text)?.[1] ?? null;
  const flag = (key) => {
    const m = new RegExp(`["']?${key}["']?\\s*:\\s*(true|false|1|0|!0|!1)`).exec(text);
    return m ? ['true', '1', '!0'].includes(m[1]) : false;
  };
  const id = pick('id');
  if (!id || !ID_RE.test(id)) throw new HttpError(400, '没有找到 51.la 统计 ID：请粘贴 51.la 后台给出的统计代码，或直接填写统计 ID');
  const ck = pick('ck') ?? id;
  return la51Text({ id, ck, ...Object.fromEntries(FLAGS.map((k) => [k, flag(k)])) });
}

const la51Text = (c) => `LA.init({id:"${c.id}",ck:"${c.ck}",${FLAGS.map((k) => `${k}:${Boolean(c[k])}`).join(',')}})`;

// 读取当前设置；没有填写或格式不对时返回 null
export function la51Config(env = process.env) {
  const v = String(env.LA51_CODE ?? '').trim();
  if (!v) return null;
  try {
    const t = normalizeLa51(v);
    const id = /id:"([^"]+)"/.exec(t)[1];
    const ck = /ck:"([^"]+)"/.exec(t)[1];
    return { id, ck, ...Object.fromEntries(FLAGS.map((k) => [k, new RegExp(`${k}:true`).test(t)])) };
  } catch {
    return null;
  }
}

// 插到页面 </body> 前的两段脚本：51.la 官方 SDK + 本站的初始化脚本（配置放在 data 属性里，已转义）
export function la51Tags(cfg = la51Config()) {
  if (!cfg) return '';
  const json = JSON.stringify(cfg).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<script charset="UTF-8" id="LA_COLLECT" src="https://sdk.51.la/js-sdk-pro.min.js"></script>\n<script src="/la51.js" data-config="${json}"></script>\n`;
}

// 页面安全策略：默认只允许本站脚本；启用 51.la 后额外允许其脚本和数据上报域名
export function pageCsp(cfg = la51Config()) {
  const la = cfg ? ' https://*.51.la' : '';
  return `default-src 'self'; script-src 'self'${la}; connect-src 'self'${cfg ? ' https://*.51.la wss://*.51.la' : ''};${cfg ? " worker-src 'self' blob:;" : ''} img-src * data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'`;
}

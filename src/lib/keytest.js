// 后台「系统设置」里第三方服务的连通性测试：用当前生效的配置（已保存的值）向上游发一个最小请求，
// 判断密钥是否有效。结果只给管理员看，不会返回密钥本身。
import { randomUUID } from 'node:crypto';
import { HttpError } from './http.js';
import { baiduSign, youdaoSign, deeplEndpoint } from '../apis/tools/translate.js';
import { buildQueryBody } from '../apis/life/express.js';
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from '../apis/ai/llm.js';

const TIMEOUT_MS = 10_000;
const env = (k) => (process.env[k] || '').trim();
const ok = (message, detail = null) => ({ ok: true, message, detail });
const fail = (message, detail = null) => ({ ok: false, message, detail });

// 返回 { status, json, text }，网络错误时抛出带中文说明的错误
async function call(url, { method = 'GET', headers = {}, body } = {}) {
  let res;
  try {
    res = await fetch(url, { method, headers: { accept: 'application/json', ...headers }, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new Error(err.name === 'TimeoutError' ? '连接超时（10 秒）' : `无法连接：${err.cause?.code || err.message}`);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

const form = (obj) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(obj).toString(),
});

// 每个服务：keys 是它用到的设置项（按钮放在第一项旁边），required 为没有填写时是否直接判定未配置
export const SERVICES = [
  {
    id: 'kuaidi100', title: '快递100', keys: ['KUAIDI100_KEY', 'KUAIDI100_CUSTOMER'], required: ['KUAIDI100_KEY', 'KUAIDI100_CUSTOMER'],
    link: 'https://api.kuaidi100.com/manager/v2/myinfo/enterprise',
    async test() {
      const r = await call('https://poll.kuaidi100.com/poll/query.do',
        form(Object.fromEntries(new URLSearchParams(buildQueryBody({ com: 'yuantong', num: 'YT0000000000000' }, env('KUAIDI100_KEY'), env('KUAIDI100_CUSTOMER'))))));
      const j = r.json;
      if (!j) return fail(`快递100 返回了无法识别的内容（HTTP ${r.status}）`);
      // 用一个不存在的单号查询：返回「查询无结果」说明签名和授权都通过了
      if (j.result === true || String(j.returnCode) === '500' || j.status === '200') return ok('授权有效（测试单号查询无结果属正常）');
      return fail(`快递100：${j.message || '授权失败'}${j.returnCode ? `（代码 ${j.returnCode}）` : ''}`);
    },
  },
  {
    id: 'deepl', title: 'DeepL', keys: ['DEEPL_API_KEY'], required: ['DEEPL_API_KEY'],
    link: 'https://www.deepl.com/your-account/keys',
    async test() {
      const key = env('DEEPL_API_KEY');
      const r = await call(deeplEndpoint(key).replace(/\/translate$/, '/usage'), { headers: { authorization: `DeepL-Auth-Key ${key}` } });
      if (r.status === 200 && r.json) {
        const { character_count: used, character_limit: limit } = r.json;
        return ok('Key 有效', limit ? `本月已用 ${used} / ${limit} 字符` : null);
      }
      if (r.status === 403) return fail('Key 无效（免费版 Key 以 :fx 结尾，请确认没有复制错）');
      if (r.status === 456) return fail('本月额度已用完');
      return fail(`DeepL 返回 HTTP ${r.status}`);
    },
  },
  {
    id: 'baidu', title: '百度翻译', keys: ['BAIDU_TRANSLATE_APPID', 'BAIDU_TRANSLATE_KEY'], required: ['BAIDU_TRANSLATE_APPID', 'BAIDU_TRANSLATE_KEY'],
    link: 'https://fanyi-api.baidu.com/manage/developer',
    async test() {
      const appid = env('BAIDU_TRANSLATE_APPID');
      const salt = String(Date.now());
      const r = await call('https://fanyi-api.baidu.com/api/trans/vip/translate',
        form({ q: 'hello', from: 'en', to: 'zh', appid, salt, sign: baiduSign(appid, 'hello', salt, env('BAIDU_TRANSLATE_KEY')) }));
      const j = r.json;
      if (j?.trans_result?.length) return ok('配置有效', `测试翻译：hello → ${j.trans_result[0].dst}`);
      const hints = { 52003: 'APP ID 不正确或未开通服务', 54001: '密钥不正确（签名错误）', 54004: '账户余额不足', 58000: '服务器 IP 不在百度翻译的 IP 白名单里', 58001: '不支持的语言方向', 90107: '认证未通过或未生效' };
      return fail(`百度翻译：${hints[j?.error_code] || j?.error_msg || `HTTP ${r.status}`}${j?.error_code ? `（错误码 ${j.error_code}）` : ''}`);
    },
  },
  {
    id: 'youdao', title: '有道智云', keys: ['YOUDAO_APP_KEY', 'YOUDAO_APP_SECRET'], required: ['YOUDAO_APP_KEY', 'YOUDAO_APP_SECRET'],
    link: 'https://ai.youdao.com/console/',
    async test() {
      const appKey = env('YOUDAO_APP_KEY');
      const salt = randomUUID();
      const curtime = String(Math.floor(Date.now() / 1000));
      const r = await call('https://openapi.youdao.com/api', form({
        q: 'hello', from: 'en', to: 'zh-CHS', appKey, salt, signType: 'v3', curtime,
        sign: youdaoSign(appKey, 'hello', salt, curtime, env('YOUDAO_APP_SECRET')),
      }));
      const j = r.json;
      if (j?.errorCode === '0') return ok('配置有效', `测试翻译：hello → ${j.translation?.[0] ?? ''}`);
      const hints = { 108: '应用 ID 不正确', 110: '应用没有绑定「文本翻译」服务', 202: '签名检验失败（应用密钥不正确）', 206: '服务器时间不准', 401: '账户已欠费', 411: '访问频率受限' };
      return fail(`有道智云：${hints[j?.errorCode] || `返回错误`}${j?.errorCode ? `（错误码 ${j.errorCode}）` : `（HTTP ${r.status}）`}`);
    },
  },
  {
    id: 'qweather', title: '和风天气', keys: ['QWEATHER_KEY', 'QWEATHER_HOST'], required: ['QWEATHER_KEY'],
    link: 'https://console.qweather.com/project',
    async test() {
      const key = env('QWEATHER_KEY');
      const host = env('QWEATHER_HOST').replace(/^https?:\/\//, '').replace(/\/+$/, '') || 'devapi.qweather.com';
      const r = await call(`https://${host}/v7/weather/now?location=101010100&lang=zh`, { headers: { 'X-QW-Api-Key': key } });
      const code = r.json?.code;
      if (code === '200') return ok('Key 有效', `测试查询北京当前天气：${r.json.now?.text ?? ''} ${r.json.now?.temp ?? ''}℃`);
      const hints = { 401: 'Key 不正确，或与 API Host 不属于同一个账号', 402: '额度已用完或账户欠费', 403: '无访问权限（检查项目的凭据限制）', 429: '请求过于频繁' };
      const noHost = !env('QWEATHER_HOST') ? '；新注册的账号必须填写「API Host」（控制台 → 设置）' : '';
      return fail(`和风天气：${hints[code] || `返回 ${code ?? `HTTP ${r.status}`}`}${noHost}`);
    },
  },
  {
    id: 'itad', title: 'IsThereAnyDeal', keys: ['ITAD_API_KEY'], required: ['ITAD_API_KEY'],
    link: 'https://isthereanydeal.com/apps/my/',
    async test() {
      const r = await call(`https://api.isthereanydeal.com/games/lookup/v1?key=${encodeURIComponent(env('ITAD_API_KEY'))}&appid=730`);
      if (r.status === 200) return ok('Key 有效');
      if (r.status === 401 || r.status === 403) return fail('Key 无效');
      return fail(`IsThereAnyDeal 返回 HTTP ${r.status}`);
    },
  },
  {
    id: 'coingecko', title: 'CoinGecko', keys: ['COINGECKO_API_KEY'], required: [],
    link: 'https://www.coingecko.com/en/developers/dashboard',
    async test() {
      const key = env('COINGECKO_API_KEY');
      const r = await call('https://api.coingecko.com/api/v3/ping', { headers: key ? { 'x-cg-demo-api-key': key } : {} });
      if (r.status === 200) return ok(key ? 'Key 有效' : '未填写 Key，匿名访问正常');
      if (r.status === 401 || r.status === 400) return fail('Key 无效（这里需要 Demo Key，不是 Pro Key）');
      if (r.status === 429) return fail('请求过于频繁，稍后再试');
      return fail(`CoinGecko 返回 HTTP ${r.status}`);
    },
  },
  {
    id: 'globalping', title: 'Globalping', keys: ['GLOBALPING_TOKEN'], required: [],
    link: 'https://dash.globalping.io/tokens',
    async test() {
      const token = env('GLOBALPING_TOKEN');
      const r = await call('https://api.globalping.io/v1/limits', { headers: token ? { authorization: `Bearer ${token}` } : {} });
      if (token && (r.status === 401 || r.status === 403)) return fail('Token 无效或已过期');
      if (r.status !== 200) return fail(`Globalping 返回 HTTP ${r.status}`);
      const c = r.json?.rateLimit?.measurements?.create;
      const credits = r.json?.credits?.remaining;
      const detail = [
        c ? `本小时剩余 ${c.remaining} / ${c.limit} 次（${c.type === 'user' ? '按账号' : '按服务器 IP'}计算）` : null,
        credits != null ? `额外积分 ${credits}` : null,
      ].filter(Boolean).join('，') || null;
      if (token && c?.type && c.type !== 'user') return fail('Token 没有生效，仍按匿名额度计算', detail);
      return ok(token ? 'Token 有效' : '未填写 Token，正在使用匿名额度', detail);
    },
  },
  {
    id: 'llm', title: '大模型', keys: ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'], required: ['LLM_API_KEY'],
    link: 'https://platform.deepseek.com/api_keys',
    async test() {
      const base = (env('LLM_BASE_URL') || DEFAULT_BASE_URL).replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
      const model = env('LLM_MODEL') || DEFAULT_MODEL;
      const auth = { authorization: `Bearer ${env('LLM_API_KEY')}` };
      // 发一个最短的对话请求：能同时验证地址、Key 和模型名
      const r = await call(`${base}/chat/completions`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: '回复 OK' }], max_tokens: 5, stream: false }),
      });
      if (r.status === 200 && r.json?.choices) return ok('配置有效', `模型 ${r.json.model || model} 回复：${String(r.json.choices[0]?.message?.content ?? '').trim().slice(0, 50)}`);
      const msg = r.json?.error?.message || r.json?.message || '';
      if (r.status === 401 || r.status === 403) return fail('API Key 无效，或与接口地址不属于同一家服务商', msg || null);
      if (r.status === 402) return fail('账户余额不足', msg || null);
      if (r.status === 404) return fail(msg ? `模型名称或接口地址不正确` : '接口地址不正确（找不到 /chat/completions）', msg || null);
      if (r.status === 400) return fail(`请求被拒绝，多半是模型名称「${model}」不对`, msg || null);
      if (r.status === 429) return fail('请求过于频繁或额度已用完', msg || null);
      return fail(`大模型接口返回 HTTP ${r.status}`, msg || null);
    },
  },
  {
    id: 'github', title: 'GitHub', keys: ['GITHUB_TOKEN'], required: [],
    link: 'https://github.com/settings/personal-access-tokens',
    async test() {
      const token = env('GITHUB_TOKEN');
      const repo = env('UPDATE_REPO') || 'bocmiao/api';
      const r = await call(`https://api.github.com/repos/${repo}`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'miao-api', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      });
      const quota = r.headers.get('x-ratelimit-limit') ? `接口额度剩余 ${r.headers.get('x-ratelimit-remaining')} / ${r.headers.get('x-ratelimit-limit')} 次每小时` : null;
      if (r.status === 200) return ok(`${token ? 'Token 有效，' : '未填写 Token，'}可以访问仓库 ${repo}`, quota);
      if (r.status === 401) return fail('Token 无效或已过期');
      if (r.status === 404) return fail(`找不到仓库 ${repo}：仓库名写错，或私有仓库没有填写有权限的 Token`);
      if (r.status === 403) return fail('GitHub 拒绝访问，可能是接口额度用完', quota);
      return fail(`GitHub 返回 HTTP ${r.status}`);
    },
  },
];

const BY_ID = new Map(SERVICES.map((s) => [s.id, s]));
export const serviceOfKey = new Map(SERVICES.map((s) => [s.keys[0], s]));
export const linkOfKey = new Map(SERVICES.flatMap((s) => s.keys.map((k) => [k, s.link])));
linkOfKey.set('QWEATHER_HOST', 'https://console.qweather.com/setting');
linkOfKey.delete('LLM_BASE_URL');
linkOfKey.delete('LLM_MODEL');

export async function testService(id) {
  const svc = BY_ID.get(id);
  if (!svc) throw new HttpError(400, '未知服务');
  const missing = svc.required.filter((k) => !env(k));
  if (missing.length) return fail(`尚未配置：请先填写并保存 ${missing.join('、')}`);
  try {
    return await svc.test();
  } catch (err) {
    return fail(err.message);
  }
}

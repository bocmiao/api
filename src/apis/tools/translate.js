import { createHash, randomUUID } from 'node:crypto';
import { cache } from '../../lib/cache.js';
import { fetchJSON, HttpError, param } from '../../lib/http.js';

const MAX_TEXT = 2000;

// 统一语言代码 → 各家代码（null 表示不支持）
const LANGS = {
  zh: { name: '简体中文', deepl: 'ZH-HANS', deeplSrc: 'ZH', baidu: 'zh', youdao: 'zh-CHS' },
  'zh-TW': { name: '繁体中文', deepl: 'ZH-HANT', deeplSrc: 'ZH', baidu: 'cht', youdao: 'zh-CHT' },
  en: { name: '英语', deepl: 'EN-US', deeplSrc: 'EN', baidu: 'en', youdao: 'en' },
  ja: { name: '日语', deepl: 'JA', deeplSrc: 'JA', baidu: 'jp', youdao: 'ja' },
  ko: { name: '韩语', deepl: 'KO', deeplSrc: 'KO', baidu: 'kor', youdao: 'ko' },
  fr: { name: '法语', deepl: 'FR', deeplSrc: 'FR', baidu: 'fra', youdao: 'fr' },
  de: { name: '德语', deepl: 'DE', deeplSrc: 'DE', baidu: 'de', youdao: 'de' },
  es: { name: '西班牙语', deepl: 'ES', deeplSrc: 'ES', baidu: 'spa', youdao: 'es' },
  ru: { name: '俄语', deepl: 'RU', deeplSrc: 'RU', baidu: 'ru', youdao: 'ru' },
  it: { name: '意大利语', deepl: 'IT', deeplSrc: 'IT', baidu: 'it', youdao: 'it' },
  pt: { name: '葡萄牙语', deepl: 'PT-BR', deeplSrc: 'PT', baidu: 'pt', youdao: 'pt' },
  vi: { name: '越南语', deepl: null, deeplSrc: null, baidu: 'vie', youdao: 'vi' },
  th: { name: '泰语', deepl: null, deeplSrc: null, baidu: 'th', youdao: 'th' },
  ar: { name: '阿拉伯语', deepl: 'AR', deeplSrc: 'AR', baidu: 'ara', youdao: 'ar' },
};

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

export function baiduSign(appid, q, salt, key) {
  return md5(`${appid}${q}${salt}${key}`);
}

// 有道 v3：input = q 长度 ≤ 20 时为 q，否则为 前10字符 + 长度 + 后10字符
export function youdaoInput(q) {
  const chars = Array.from(q);
  if (chars.length <= 20) return q;
  return `${chars.slice(0, 10).join('')}${chars.length}${chars.slice(-10).join('')}`;
}

export function youdaoSign(appKey, q, salt, curtime, appSecret) {
  return sha256(`${appKey}${youdaoInput(q)}${salt}${curtime}${appSecret}`);
}

export function deeplEndpoint(key) {
  return key.endsWith(':fx') ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate';
}

const reverseLang = (field, code) => Object.keys(LANGS).find((k) => LANGS[k][field]?.toLowerCase() === String(code ?? '').toLowerCase()) ?? code ?? null;

const PROVIDERS = {
  deepl: {
    title: 'DeepL',
    configured: () => Boolean(process.env.DEEPL_API_KEY),
    async translate(text, from, to) {
      const key = process.env.DEEPL_API_KEY;
      const target = LANGS[to].deepl;
      if (!target) throw new HttpError(400, `DeepL 不支持翻译为${LANGS[to].name}`);
      const body = { text: [text], target_lang: target };
      if (from !== 'auto') {
        if (!LANGS[from].deeplSrc) throw new HttpError(400, `DeepL 不支持源语言${LANGS[from].name}`);
        body.source_lang = LANGS[from].deeplSrc;
      }
      const raw = await fetchJSON(deeplEndpoint(key), {
        method: 'POST',
        headers: { authorization: `DeepL-Auth-Key ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return parseDeepl(raw);
    },
  },
  baidu: {
    title: '百度翻译',
    configured: () => Boolean(process.env.BAIDU_TRANSLATE_APPID && process.env.BAIDU_TRANSLATE_KEY),
    async translate(text, from, to) {
      const appid = process.env.BAIDU_TRANSLATE_APPID;
      const salt = String(Date.now());
      const form = new URLSearchParams({
        q: text,
        from: from === 'auto' ? 'auto' : LANGS[from].baidu,
        to: LANGS[to].baidu,
        appid,
        salt,
        sign: baiduSign(appid, text, salt, process.env.BAIDU_TRANSLATE_KEY),
      });
      const raw = await fetchJSON('https://fanyi-api.baidu.com/api/trans/vip/translate', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      return parseBaidu(raw);
    },
  },
  youdao: {
    title: '有道智云',
    configured: () => Boolean(process.env.YOUDAO_APP_KEY && process.env.YOUDAO_APP_SECRET),
    async translate(text, from, to) {
      const appKey = process.env.YOUDAO_APP_KEY;
      const salt = randomUUID();
      const curtime = String(Math.floor(Date.now() / 1000));
      const form = new URLSearchParams({
        q: text,
        from: from === 'auto' ? 'auto' : LANGS[from].youdao,
        to: LANGS[to].youdao,
        appKey,
        salt,
        sign: youdaoSign(appKey, text, salt, curtime, process.env.YOUDAO_APP_SECRET),
        signType: 'v3',
        curtime,
      });
      const raw = await fetchJSON('https://openapi.youdao.com/api', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      return parseYoudao(raw);
    },
  },
};

export function parseDeepl(raw) {
  const t = raw?.translations?.[0];
  if (!t || typeof t.text !== 'string') throw new HttpError(502, 'DeepL 返回的数据格式无法识别');
  return { result: t.text, detected: reverseLang('deeplSrc', t.detected_source_language) };
}

export function parseBaidu(raw) {
  if (raw?.error_code && raw.error_code !== '52000') {
    throw new HttpError(502, `百度翻译错误 ${raw.error_code}：${raw.error_msg ?? ''}`.trim());
  }
  if (!Array.isArray(raw?.trans_result)) throw new HttpError(502, '百度翻译返回的数据格式无法识别');
  return { result: raw.trans_result.map((r) => r.dst).join('\n'), detected: reverseLang('baidu', raw.from) };
}

export function parseYoudao(raw) {
  if (String(raw?.errorCode) !== '0') throw new HttpError(502, `有道翻译错误码 ${raw?.errorCode ?? '未知'}`);
  if (!Array.isArray(raw.translation)) throw new HttpError(502, '有道翻译返回的数据格式无法识别');
  const src = typeof raw.l === 'string' ? raw.l.split('2')[0] : null;
  return { result: raw.translation.join('\n'), detected: reverseLang('youdao', src) };
}

export function pickProvider(requested) {
  if (requested) {
    const p = PROVIDERS[requested];
    if (!p) throw new HttpError(400, `provider 只能是 ${Object.keys(PROVIDERS).join(' / ')}`);
    if (!p.configured()) throw new HttpError(503, `服务端未配置 ${p.title} 的密钥，该翻译源暂不可用`);
    return requested;
  }
  const first = Object.keys(PROVIDERS).find((k) => PROVIDERS[k].configured());
  if (!first) throw new HttpError(503, '服务端未配置任何翻译服务（DeepL / 百度 / 有道），该接口暂不可用');
  return first;
}

export default {
  name: 'translate',
  category: 'tools',
  title: '翻译',
  description: '多语言文本翻译，支持 DeepL、百度翻译、有道智云',
  source: 'DeepL / 百度翻译 / 有道智云',
  // 三个翻译源任选其一配置即可
  env: ['DEEPL_API_KEY', 'BAIDU_TRANSLATE_APPID', 'BAIDU_TRANSLATE_KEY', 'YOUDAO_APP_KEY', 'YOUDAO_APP_SECRET'].map((name) => ({ name, optional: true })),
  isAvailable: () => Object.values(PROVIDERS).some((p) => p.configured()),
  routes: [
    {
      method: 'GET',
      path: '/api/translate',
      summary: '翻译文本（自动选择已配置的翻译服务）',
      params: [
        { name: 'text', required: true, desc: `待翻译文本，最多 ${MAX_TEXT} 个字符`, example: 'Hello, world!' },
        { name: 'to', default: 'zh', desc: `目标语言：${Object.keys(LANGS).join(' / ')}`, example: 'zh' },
        { name: 'from', default: 'auto', desc: '源语言，auto 为自动检测', example: 'auto' },
        { name: 'provider', required: false, desc: '指定翻译服务 deepl / baidu / youdao（默认取第一个已配置的）', example: 'deepl' },
      ],
      async handler({ query }) {
        const text = param(query, 'text', { required: true, max: MAX_TEXT });
        const to = param(query, 'to', { default: 'zh', oneOf: Object.keys(LANGS) });
        const from = param(query, 'from', { default: 'auto', oneOf: ['auto', ...Object.keys(LANGS)] });
        const provider = pickProvider(param(query, 'provider', { oneOf: Object.keys(PROVIDERS) }));
        if (from === to) throw new HttpError(400, '源语言与目标语言相同');
        const key = `translate:${provider}:${from}:${to}:${sha256(text)}`;
        const res = await cache.wrap(key, 24 * 3600_000, () => PROVIDERS[provider].translate(text, from, to));
        return { ...res, data: { provider, from, to, detected: res.data.detected, text, result: res.data.result } };
      },
    },
  ],
};

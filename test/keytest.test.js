import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SERVICES, testService, serviceOfKey, linkOfKey } from '../src/lib/keytest.js';
import { SETTING_GROUPS } from '../src/lib/settings.js';

const KEYS = SETTING_GROUPS.flatMap((g) => g.fields.map((f) => f.key));
const ALL_ENV = [...new Set(SERVICES.flatMap((s) => s.keys)), 'UPDATE_REPO'];

let saved;
let calls;
const realFetch = globalThis.fetch;
// responder(url, opts) → { status, body, headers }
function mockFetch(responder) {
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const { status = 200, body = {}, headers = {} } = await responder(String(url), opts);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  };
}

beforeEach(() => {
  saved = Object.fromEntries(ALL_ENV.map((k) => [k, process.env[k]]));
  for (const k of ALL_ENV) delete process.env[k];
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(saved)) if (v == null) delete process.env[k]; else process.env[k] = v;
});

describe('服务定义', () => {
  test('每个服务用到的设置项都在系统设置里，且都有获取地址', () => {
    for (const s of SERVICES) {
      for (const k of s.keys) assert.ok(KEYS.includes(k), `${s.id}: ${k} 不在 SETTING_GROUPS`);
      if (s.id !== 'proxy') assert.match(s.link, /^https:\/\//, '第三方服务都有获取地址（代理是自己的服务器，没有）');
      assert.equal(serviceOfKey.get(s.keys[0]), s);
    }
    assert.equal(linkOfKey.get('QWEATHER_HOST'), 'https://console.qweather.com/setting');
    assert.equal(linkOfKey.has('LLM_MODEL'), false);
  });

  test('未知服务 400；必填项没填时不发请求', async () => {
    await assert.rejects(testService('nope'), (e) => e.status === 400);
    mockFetch(() => ({}));
    const r = await testService('deepl');
    assert.equal(r.ok, false);
    assert.match(r.message, /DEEPL_API_KEY/);
    assert.equal(calls.length, 0);
  });
});

describe('各服务', () => {
  test('DeepL：免费版走 api-free 的 usage，403 判为 Key 无效', async () => {
    process.env.DEEPL_API_KEY = 'abc:fx';
    mockFetch(() => ({ body: { character_count: 10, character_limit: 500000 } }));
    const r = await testService('deepl');
    assert.equal(r.ok, true);
    assert.equal(calls[0].url, 'https://api-free.deepl.com/v2/usage');
    assert.equal(calls[0].opts.headers.authorization, 'DeepL-Auth-Key abc:fx');
    assert.match(r.detail, /10 \/ 500000/);
    mockFetch(() => ({ status: 403 }));
    assert.match((await testService('deepl')).message, /无效/);
  });

  test('百度翻译：错误码给出中文原因', async () => {
    process.env.BAIDU_TRANSLATE_APPID = '1';
    process.env.BAIDU_TRANSLATE_KEY = 'k';
    mockFetch(() => ({ body: { error_code: '54001', error_msg: 'Invalid Sign' } }));
    const r = await testService('baidu');
    assert.equal(r.ok, false);
    assert.match(r.message, /密钥不正确.*54001/);
    mockFetch(() => ({ body: { trans_result: [{ src: 'hello', dst: '你好' }] } }));
    assert.deepEqual([(await testService('baidu')).ok, (await testService('baidu')).detail], [true, '测试翻译：hello → 你好']);
  });

  test('快递100：查询无结果视为授权有效，签名失败判为失败', async () => {
    process.env.KUAIDI100_KEY = 'k';
    process.env.KUAIDI100_CUSTOMER = 'c';
    mockFetch(() => ({ body: { result: false, returnCode: '500', message: '查询无结果，请隔段时间再查' } }));
    assert.equal((await testService('kuaidi100')).ok, true);
    assert.match(calls[0].opts.body, /customer=c/);
    mockFetch(() => ({ body: { result: false, returnCode: '503', message: '验证签名失败' } }));
    const r = await testService('kuaidi100');
    assert.equal(r.ok, false);
    assert.match(r.message, /验证签名失败.*503/);
  });

  test('和风天气：带 API Host 与请求头；未填 Host 时提示', async () => {
    process.env.QWEATHER_KEY = 'q';
    process.env.QWEATHER_HOST = 'https://abc.re.qweatherapi.com/';
    mockFetch(() => ({ body: { code: '200', now: { text: '晴', temp: '20' } } }));
    const r = await testService('qweather');
    assert.equal(r.ok, true);
    assert.ok(calls[0].url.startsWith('https://abc.re.qweatherapi.com/v7/weather/now?'));
    assert.equal(calls[0].opts.headers['X-QW-Api-Key'], 'q');
    delete process.env.QWEATHER_HOST;
    mockFetch(() => ({ body: { code: '401' } }));
    assert.match((await testService('qweather')).message, /API Host/);
  });

  test('Globalping：不填 Token 也能测，Token 未生效时报错', async () => {
    mockFetch(() => ({ body: { rateLimit: { measurements: { create: { type: 'ip', limit: 250, remaining: 240, reset: 100 } } } } }));
    const anon = await testService('globalping');
    assert.equal(anon.ok, true);
    assert.match(anon.message, /匿名/);
    assert.equal(calls[0].opts.headers.authorization, undefined);

    process.env.GLOBALPING_TOKEN = 't';
    assert.equal((await testService('globalping')).ok, false);
    mockFetch(() => ({ body: { rateLimit: { measurements: { create: { type: 'user', limit: 500, remaining: 499, reset: 100 } } }, credits: { remaining: 0 } } }));
    const r = await testService('globalping');
    assert.equal(r.ok, true);
    assert.match(r.detail, /499 \/ 500.*按账号/);
    assert.equal(calls.at(-1).opts.headers.authorization, 'Bearer t');
    mockFetch(() => ({ status: 401 }));
    assert.match((await testService('globalping')).message, /无效/);
  });

  test('大模型：用最短对话验证，地址去掉末尾 /chat/completions', async () => {
    process.env.LLM_API_KEY = 'sk';
    process.env.LLM_BASE_URL = 'https://api.example.com/v1/chat/completions';
    process.env.LLM_MODEL = 'm1';
    mockFetch(() => ({ body: { model: 'm1', choices: [{ message: { content: 'OK' } }] } }));
    const r = await testService('llm');
    assert.equal(r.ok, true);
    assert.equal(calls[0].url, 'https://api.example.com/v1/chat/completions');
    assert.equal(JSON.parse(calls[0].opts.body).model, 'm1');
    mockFetch(() => ({ status: 401, body: { error: { message: 'Authentication Fails' } } }));
    const bad = await testService('llm');
    assert.equal(bad.ok, false);
    assert.equal(bad.detail, 'Authentication Fails');
  });

  test('GitHub：404 提示仓库或权限，带额度信息', async () => {
    process.env.UPDATE_REPO = 'a/b';
    mockFetch(() => ({ status: 200, body: {}, headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '59' } }));
    const r = await testService('github');
    assert.equal(r.ok, true);
    assert.equal(calls[0].url, 'https://api.github.com/repos/a/b');
    assert.match(r.detail, /59 \/ 60/);
    mockFetch(() => ({ status: 404 }));
    assert.match((await testService('github')).message, /a\/b/);
  });

  test('网络错误和超时转成中文提示，不抛出', async () => {
    process.env.ITAD_API_KEY = 'x';
    globalThis.fetch = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
    const r = await testService('itad');
    assert.equal(r.ok, false);
    assert.match(r.message, /无法连接：ENOTFOUND/);
    globalThis.fetch = async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); };
    assert.match((await testService('itad')).message, /超时/);
  });
});

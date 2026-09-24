import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import lifeModules from '../../src/apis/life/index.js';
import toolModules from '../../src/apis/tools/index.js';
import { parseUA, WINDOWS_VERSIONS } from '../../src/lib/ua.js';
import moyuModule, { loadMoyu, paydayCountdown, weekendCountdown, upcomingHolidays, QUOTES } from '../../src/apis/life/moyu.js';
import bmiModule, { calcBMI } from '../../src/apis/life/bmi.js';
import captchaModule, {
  CaptchaStore, store as captchaStore, makeChallenge, renderCaptcha, createCaptcha, chineseToNumber, normalizeAnswer, GLYPHS, TTL_MS, EXPIRED_GRACE_MS,
} from '../../src/apis/tools/captcha.js';
import visitorModule, { lookupLocation, parseAcceptLanguage, visitorInfo } from '../../src/apis/tools/visitor.js';
import uaModule, { TEMPLATES, BROWSER_KEYS, randomUA } from '../../src/apis/tools/useragent.js';
import colorModule, { parseColor, convertColor, randomColor, relativeLuminance, contrastRatio } from '../../src/apis/tools/color.js';
import ipcardModule, { escapeXml, fit, renderIpCard, greetingFor, localParts } from '../../src/apis/tools/ipcard.js';
import { assertFieldsDocumented, collectPaths, matcher } from '../helpers/fields.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/life/${name}`, import.meta.url), 'utf8'));
const q = (obj = {}) => new URLSearchParams(obj);
const route = (mod, path) => mod.routes.find((r) => r.path === path);
const MODULES = [moyuModule, bmiModule, captchaModule, visitorModule, uaModule, colorModule, ipcardModule];

// 按 URL 片段返回预置响应的假 fetch；没配置的 URL 一律报网络错误，确保测试不会真的联网
function mockFetch(t, routes) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    for (const [frag, body] of Object.entries(routes)) {
      if (!String(url).includes(frag)) continue;
      if (body instanceof Error) throw body;
      if (typeof body === 'function') return body(String(url));
      if (typeof body === 'number') return new Response('mock', { status: body });
      return Response.json(body);
    }
    throw new TypeError(`fetch failed (unmocked ${url})`);
  });
  return calls;
}

// 两个方向都校验：返回的每个字段都有说明；说明里的每个字段也都在样例中出现过
const checked = new Set();
function checkFields(r, ...samples) {
  for (const s of samples) assertFieldsDocumented(r, s);
  const paths = new Set();
  for (const s of samples) collectPaths(s, '', paths);
  const phantom = r.fields.map((f) => f.name).filter((name) => {
    if (name === '[]') return !samples.every(Array.isArray);
    const re = matcher(name.replace(/\[\]$/, ''));
    return ![...paths].some((p) => re.test(p));
  });
  assert.deepEqual(phantom, [], `${r.path} 的 fields 写了样例中没有出现的字段：${phantom.join(', ')}`);
  checked.add(`${r.method} ${r.path}`);
}

// ---------------- 注册 ----------------

test('模块已注册到对应分类，参数都有 desc 和 example', () => {
  for (const m of [moyuModule, bmiModule]) assert.ok(lifeModules.includes(m), m.name);
  for (const m of [captchaModule, visitorModule, uaModule, colorModule, ipcardModule]) assert.ok(toolModules.includes(m), m.name);
  for (const m of MODULES) {
    assert.ok(m.source && m.title && m.description, m.name);
    for (const r of m.routes) {
      assert.ok(Array.isArray(r.params) && r.params.length, `${r.path} 缺少 params`);
      for (const p of r.params) assert.ok(p.desc && p.example != null, `${r.path} ${p.name}`);
      assert.ok(!r.public, `${r.path} 不应是 public`);
    }
  }
});

// ---------------- UA 解析 ----------------

// [UA, 浏览器, 浏览器版本, 系统, 系统版本, 设备类型, 引擎, 爬虫名]
const UA_CASES = [
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36', 'Chrome', '128.0.0.0', 'Windows', '10/11', 'desktop', 'Blink', null],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.2739.79', 'Edge', '128.0.2739.79', 'Windows', '10/11', 'desktop', 'Blink', null],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0', 'Firefox', '130.0', 'Windows', '10/11', 'desktop', 'Gecko', null],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15', 'Safari', '17.6', 'macOS', '10.15.7', 'desktop', 'WebKit', null],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 OPR/113.0.0.0', 'Opera', '113.0.0.0', 'Windows', '10/11', 'desktop', 'Blink', null],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1', 'Safari', '17.6', 'iOS', '17.6.1', 'mobile', 'WebKit', null],
  ['Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1', 'Safari', '16.6', 'iPadOS', '16.6', 'tablet', 'WebKit', null],
  ['Mozilla/5.0 (iPad; CPU OS 12_5_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1', 'Safari', '12.1.2', 'iOS', '12.5.7', 'tablet', 'WebKit', null],
  ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36', 'Chrome', '128.0.0.0', 'Android', '10', 'mobile', 'Blink', null],
  ['Mozilla/5.0 (Linux; Android 13; V2227A Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 XWEB/1160117 MMWEBSDK/20240404 MMWEBID/2345 MicroMessenger/8.0.49.2600(0x2800315A) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64', 'WeChat', '8.0.49.2600', 'Android', '13', 'mobile', 'Blink', null],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003137) NetType/WIFI Language/zh_CN', 'WeChat', '8.0.49', 'iOS', '17.4.1', 'mobile', 'WebKit', null],
  ['Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.138 Safari/537.36 NetType/WIFI MicroMessenger/7.0.20.1781(0x6700143B) WindowsWechat(0x63090a13) XWEB/9129 Flue', 'WeChat', '7.0.20.1781', 'Windows', '10/11', 'desktop', 'Blink', null],
  ['Mozilla/5.0 (Linux; U; Android 13; zh-cn; PGT-AL10 Build/TP1A.220905.001) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/109.0.5414.86 MQQBrowser/14.9 Mobile Safari/537.36 COVC/046915', 'QQ Browser', '14.9', 'Android', '13', 'mobile', 'Blink', null],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Core/1.116.438.400 QQBrowser/13.0.6070.400', 'QQ Browser', '13.0.6070.400', 'Windows', '10/11', 'desktop', 'Blink', null],
  ['Mozilla/5.0 (Linux; U; Android 12; zh-CN; 22041211AC Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.58 UWS/3.22.2.66 UCBrowser/16.4.0.1310 Mobile Safari/537.36', 'UC Browser', '16.4.0.1310', 'Android', '12', 'mobile', 'Blink', null],
  ['Mozilla/5.0 (Linux; U; Android 14; zh-CN; 2311DRK48C Build/UP1A.230905.011) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.58 Quark/7.0.5.581 Mobile Safari/537.36', 'Quark', '7.0.5.581', 'Android', '14', 'mobile', 'Blink', null],
  ['Mozilla/5.0 (Linux; Android 12; ANA-AN00 Build/HUAWEIANA-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/97.0.4692.98 Mobile Safari/537.36 T7/13.52 SP-engine/2.91.0 baiduboxapp/13.52.0.10 (Baidu; P1 12) NABar/1.0', 'Baidu App', '13.52.0.10', 'Android', '12', 'mobile', 'Blink', null],
  ['Mozilla/5.0 (Linux; Android 12; HarmonyOS; NOH-AN00; HMSCore 6.13.0.302) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.5735.196 HuaweiBrowser/14.0.6.302 Mobile Safari/537.36', 'Huawei Browser', '14.0.6.302', 'HarmonyOS', null, 'mobile', 'Blink', null],
  ['Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile HuaweiBrowser/5.0.6.300', 'Huawei Browser', '5.0.6.300', 'HarmonyOS', '5.0', 'mobile', 'Blink', null],
  ['Mozilla/5.0 (Linux; U; Android 14; zh-cn; 23116PN5BC Build/UKQ1.230804.001) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/115.0.5790.168 Mobile Safari/537.36 XiaoMi/MiuiBrowser/18.4.40329', 'Mi Browser', '18.4.40329', 'Android', '14', 'mobile', 'Blink', null],
  ['Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S9210) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36', 'Samsung Internet', '25.0', 'Android', '14', 'mobile', 'Blink', null],
  ['Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0', 'Firefox', '129.0', 'Linux', null, 'desktop', 'Gecko', null],
  ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36', 'Chrome', '128.0.0.0', 'ChromeOS', '14541.0.0', 'desktop', 'Blink', null],
  ['Mozilla/5.0 (Windows NT 6.1; WOW64; Trident/7.0; rv:11.0) like Gecko', 'IE', '11.0', 'Windows', '7', 'desktop', 'Trident', null],
  ['Mozilla/5.0 (Windows NT 6.3; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36', 'Chrome', '109.0.0.0', 'Windows', '8.1', 'desktop', 'Blink', null],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1', 'Chrome', '128.0.6613.98', 'iOS', '17.5', 'mobile', 'WebKit', null],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/129.0 Mobile/15E148 Safari/605.1.15', 'Firefox', '129.0', 'iOS', '17.5', 'mobile', 'WebKit', null],
  ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 EdgA/128.0.2739.73', 'Edge', '128.0.2739.73', 'Android', '10', 'mobile', 'Blink', null],
  ['Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36', 'Chrome', '128.0.0.0', 'Android', '13', 'tablet', 'Blink', null],
  ['Mozilla/5.0 (Linux; Android 9; Cubot X19) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36', 'Chrome', '120.0.0.0', 'Android', '9', 'mobile', 'Blink', null],
  ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', null, null, null, null, 'bot', null, 'Googlebot'],
  ['Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.119 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Chrome', '128.0.6613.119', 'Android', '6.0.1', 'bot', 'Blink', 'Googlebot'],
  ['Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)', null, null, null, null, 'bot', null, 'Baiduspider'],
  ['Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)', null, null, null, null, 'bot', null, 'bingbot'],
  ['Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)', null, null, null, null, 'bot', null, 'YandexBot'],
  ['Sogou web spider/4.0(+http://www.sogou.com/docs/help/webmasters.htm#07)', null, null, null, null, 'bot', null, 'Sogou Spider'],
  ['Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)', null, null, 'Android', '5.0', 'bot', 'WebKit', 'Bytespider'],
  ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)', null, null, null, null, 'bot', 'WebKit', 'GPTBot'],
  ['curl/8.4.0', null, null, null, null, 'bot', null, 'curl'],
  ['python-requests/2.32.3', null, null, null, null, 'bot', null, 'python-requests'],
  ['Mozilla/5.0 (compatible; FooCrawlBot/1.3; +https://foo.example/bot)', null, null, null, null, 'bot', null, 'FooCrawlBot'],
];

describe('UA 解析', () => {
  test(`${UA_CASES.length} 个真实 UA`, () => {
    assert.ok(UA_CASES.length >= 20);
    for (const [ua, browser, version, os, osVersion, device, engine, bot] of UA_CASES) {
      const p = parseUA(ua);
      const msg = ua.slice(0, 90);
      assert.equal(p.browser.name, browser, `browser: ${msg}`);
      assert.equal(p.browser.version, version, `version: ${msg}`);
      assert.equal(p.browser.major, version ? version.split('.')[0] : null, `major: ${msg}`);
      assert.equal(p.os.name, os, `os: ${msg}`);
      assert.equal(p.os.version, osVersion, `osVersion: ${msg}`);
      assert.equal(p.device.type, device, `device: ${msg}`);
      assert.equal(p.engine.name, engine, `engine: ${msg}`);
      assert.equal(p.isBot, bot !== null, `isBot: ${msg}`);
      assert.equal(p.bot, bot, `bot: ${msg}`);
    }
  });

  test('设备厂商与型号', () => {
    const vm = (ua) => [parseUA(ua).device.vendor, parseUA(ua).device.model];
    assert.deepEqual(vm(UA_CASES[5][0]), ['Apple', 'iPhone']);
    assert.deepEqual(vm(UA_CASES[3][0]), ['Apple', 'Mac']);
    assert.deepEqual(vm(UA_CASES[9][0]), ['vivo', 'V2227A']);
    assert.deepEqual(vm(UA_CASES[14][0]), ['Xiaomi', '22041211AC']);
    assert.deepEqual(vm(UA_CASES[16][0]), ['Huawei', 'ANA-AN00']);
    assert.deepEqual(vm(UA_CASES[20][0]), ['Samsung', 'SM-S9210']);
    assert.deepEqual(vm(UA_CASES[18][0]), ['Huawei', null]);
    // Chrome 精简 UA 的占位型号 K 不算型号
    assert.deepEqual(vm(UA_CASES[8][0]), [null, null]);
    assert.deepEqual(vm(UA_CASES[0][0]), [null, null]);
  });

  test('Windows 版本映射、空 UA、引擎版本', () => {
    assert.equal(WINDOWS_VERSIONS['10.0'], '10/11');
    assert.equal(parseUA('Mozilla/5.0 (Windows NT 6.2; WOW64) AppleWebKit/537.36 Chrome/49.0 Safari/537.36').os.version, '8');
    assert.equal(parseUA('Mozilla/4.0 (compatible; MSIE 8.0; Windows NT 5.1; Trident/4.0)').os.version, 'XP');
    assert.equal(parseUA('Mozilla/4.0 (compatible; MSIE 8.0; Windows NT 5.1; Trident/4.0)').browser.name, 'IE');
    const empty = parseUA('');
    assert.equal(empty.isBot, true);
    assert.equal(empty.bot, 'unknown');
    assert.equal(empty.device.type, 'bot');
    assert.equal(parseUA(undefined).bot, 'unknown');
    assert.equal(parseUA(UA_CASES[0][0]).engine.version, '128.0.0.0');
    assert.equal(parseUA(UA_CASES[3][0]).engine.version, '605.1.15');
    assert.equal(parseUA(UA_CASES[2][0]).engine.version, '130.0');
  });

  test('随机 UA 的每个模板都能被解析回对应的浏览器和设备', () => {
    const expected = {
      chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox', safari: 'Safari', opera: 'Opera', wechat: 'WeChat', qq: 'QQ Browser',
      uc: 'UC Browser', quark: 'Quark', baidu: 'Baidu App', huawei: 'Huawei Browser', xiaomi: 'Mi Browser', samsung: 'Samsung Internet',
    };
    assert.deepEqual(BROWSER_KEYS.sort(), Object.keys(expected).sort());
    for (const [key, byDevice] of Object.entries(TEMPLATES)) {
      for (const [device, fns] of Object.entries(byDevice)) {
        for (const fn of fns) {
          for (let i = 0; i < 20; i++) {
            const ua = fn();
            const p = parseUA(ua);
            assert.equal(p.browser.name, expected[key], ua);
            assert.equal(p.device.type, device, ua);
            assert.equal(p.isBot, false, ua);
            assert.ok(p.os.name && p.browser.version, ua);
          }
        }
      }
    }
    assert.throws(() => randomUA({ device: 'desktop', browser: 'uc' }), { status: 400 });
  });

  test('GET /api/ua/parse：参数优先，否则用请求头', async () => {
    const r = route(uaModule, '/api/ua/parse');
    const req = { headers: { 'user-agent': UA_CASES[10][0] } };
    const own = (await r.handler({ query: q(), req })).data;
    assert.equal(own.ua, UA_CASES[10][0]);
    assert.equal(own.browser.name, 'WeChat');
    const given = (await r.handler({ query: q({ ua: `  ${UA_CASES[31][0]} ` }), req })).data;
    assert.equal(given.bot, 'Googlebot');
    assert.equal(given.ua, UA_CASES[31][0]);
    const none = (await r.handler({ query: q(), req: { headers: {} } })).data;
    assert.equal(none.ua, '');
    await assert.rejects(r.handler({ query: q({ ua: 'x'.repeat(2001) }), req }), { status: 400 });
    checkFields(r, own, given, none);
  });

  test('GET /api/ua/random', async () => {
    const r = route(uaModule, '/api/ua/random');
    const all = (await r.handler({ query: q({ count: '30' }) })).data;
    assert.equal(all.length, 30);
    const mobile = (await r.handler({ query: q({ device: 'mobile', browser: 'wechat', count: '5' }) })).data;
    for (const x of mobile) {
      assert.equal(x.device, 'mobile');
      assert.equal(x.browser, 'WeChat');
      assert.match(x.ua, /MicroMessenger\//);
    }
    const desktop = (await r.handler({ query: q({ device: 'desktop' }) })).data;
    assert.equal(desktop.length, 1);
    assert.equal(desktop[0].device, 'desktop');
    await assert.rejects(r.handler({ query: q({ device: 'desktop', browser: 'quark' }) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ browser: 'netscape' }) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ device: 'tablet' }) }), { status: 400 });
    await assert.rejects(r.handler({ query: q({ count: '51' }) }), { status: 400 });
    checkFields(r, all, mobile, desktop);
  });
});

// ---------------- 图形验证码 ----------------

const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function solve(chars) {
  const s = chars.join('').replace(/加/, '+').replace(/减/, '-').replace(/乘/, '×').replace(/等于？$/, '=?')
    .replace(/[一二三四五六七八九十]/g, (c) => String(CN[c]));
  const m = /^(\d+)([+\-×])(\d+)=\?$/.exec(s);
  assert.ok(m, `题目格式不对：${chars.join('')}`);
  const [a, b] = [Number(m[1]), Number(m[3])];
  return String(m[2] === '+' ? a + b : m[2] === '-' ? a - b : a * b);
}
const svgOf = (image) => Buffer.from(image.replace(/^data:image\/svg\+xml;base64,/, ''), 'base64').toString('utf8');
const answerOf = (token) => captchaStore.map.get(token).answer;

describe('图形验证码', () => {
  test('题目生成：字符集、长度与算术答案', () => {
    for (let i = 0; i < 200; i++) {
      const a = makeChallenge('alnum', 6);
      assert.match(a.chars.join(''), /^[2-9A-HJ-NP-Z]{6}$/);
      assert.equal(a.answer, a.chars.join('').toLowerCase());
      const n = makeChallenge('number', 4);
      assert.match(n.answer, /^\d{4}$/);
      const m = makeChallenge('math');
      assert.match(m.chars.join(''), /^\d{1,2}[+\-×]\d{1,2}=\?$/);
      assert.equal(m.answer, solve(m.chars));
      assert.ok(Number(m.answer) >= 0);
      const c = makeChallenge('chinese_math');
      assert.match(c.chars.join(''), /^[一二三四五六七八九十][加减乘][一二三四五六七八九十]等于？$/);
      assert.equal(c.answer, solve(c.chars));
      assert.ok(Number(c.answer) >= 0);
    }
  });

  test('每个可能出现的字符都有字形', () => {
    const needed = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ0123456789+-×=?一二三四五六七八九十加减乘等于？';
    for (const ch of needed) assert.ok(GLYPHS[ch], ch);
  });

  test('SVG：只有路径没有 <text>，带干扰线、噪点，每次渲染都不同', () => {
    const chars = ['A', '7', 'K', '3'];
    const a = renderCaptcha(chars);
    const b = renderCaptcha(chars);
    assert.notEqual(a.svg, b.svg);
    assert.equal(a.height, 50);
    for (const { svg, width } of [a, b]) {
      assert.match(svg, new RegExp(`^<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="50" viewBox="0 0 ${width} 50">`));
      assert.doesNotMatch(svg, /<text|<script|<foreignObject|href=/i);
      assert.equal((svg.match(/<path /g) ?? []).length, chars.length + 3); // 每个字一条 path + 3 条干扰曲线
      assert.ok((svg.match(/<circle /g) ?? []).length >= 20, '噪点');
      assert.ok(width >= 90 && width <= 240, `width ${width}`);
    }
    // 中文题最宽
    const wide = renderCaptcha(['十', '乘', '十', '等', '于', '？']);
    assert.ok(wide.width <= 240, `width ${wide.width}`);
  });

  test('答案规整：忽略大小写、首尾空格、全角，中文数字转阿拉伯数字', () => {
    assert.equal(normalizeAnswer('  AbC9 ', 'alnum'), 'abc9');
    assert.equal(normalizeAnswer('ＡＢ１２', 'alnum'), 'ab12');
    assert.equal(normalizeAnswer(' 八 ', 'chinese_math'), '8');
    assert.equal(normalizeAnswer('八', 'alnum'), '八');
    for (const [cn, n] of [['零', '0'], ['十', '10'], ['十二', '12'], ['二十', '20'], ['二十一', '21'], ['八十一', '81'], ['两', '2'], ['12', '12'], ['一百', '一百']]) {
      assert.equal(chineseToNumber(cn), n, cn);
    }
    assert.equal(chineseToNumber('constructor'), 'constructor');
  });

  test('存储：一次有效、过期、容量上限淘汰最旧、定时清理', () => {
    let now = 1_000_000;
    const s = new CaptchaStore({ ttlMs: 1000, max: 3, graceMs: 5000, now: () => now });
    const t1 = s.add('abcd', 'alnum');
    const t2 = s.add('12', 'math');
    const t3 = s.add('x', 'alnum');
    assert.equal(s.size, 3);
    const t4 = s.add('y', 'alnum'); // 超出上限，淘汰最旧的 t1
    assert.equal(s.size, 3);
    assert.deepEqual(s.verify(t1, 'abcd'), { valid: false, reason: 'not_found' });
    assert.deepEqual(s.verify(t2, ' 十二 '), { valid: true, reason: 'ok' });
    assert.deepEqual(s.verify(t2, '12'), { valid: false, reason: 'not_found' });
    now += 1000; // 正好到期
    assert.deepEqual(s.verify(t3, 'x'), { valid: false, reason: 'expired' });
    assert.equal(s.sweep(), 0, '过期不足 graceMs 的先保留');
    now += 5000;
    const t5 = s.add('z', 'alnum');
    assert.equal(s.sweep(), 1, '只清理过期超过 graceMs 的 t4');
    assert.deepEqual(s.verify(t4, 'y'), { valid: false, reason: 'not_found' });
    assert.deepEqual(s.verify(t5, 'Z'), { valid: true, reason: 'ok' });
    assert.equal(s.size, 0);
  });

  test('完整流程：答对、答错、重复校验、过期（mock.timers 推进时间）', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-24T08:00:00Z') });
    const gen = route(captchaModule, '/api/captcha');
    const verify = route(captchaModule, '/api/captcha/verify');
    const check = async (token, answer) => (await verify.handler({ query: q({ token, answer }) })).data;

    const samples = [];
    for (const type of ['alnum', 'number', 'math', 'chinese_math']) {
      const { data } = await gen.handler({ query: q({ type, length: '5' }) });
      assert.equal(data.type, type);
      assert.equal(data.expiresIn, TTL_MS / 1000);
      assert.match(data.token, /^[A-Za-z0-9_-]{24}$/);
      assert.match(data.image, /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+=*$/);
      assert.match(svgOf(data.image), /^<svg[^>]*>.*<\/svg>$/s);
      if (type === 'alnum' || type === 'number') assert.equal(answerOf(data.token).length, 5);
      samples.push(data);
    }
    const defaults = (await gen.handler({ query: q() })).data;
    assert.equal(defaults.type, 'alnum');
    assert.equal(answerOf(defaults.token).length, 4);

    // 答对：大小写和首尾空格无所谓；校验后 token 作废
    const ok = await check(samples[0].token, `  ${answerOf(samples[0].token).toUpperCase()}  `);
    assert.deepEqual(ok, { valid: true, reason: 'ok' });
    const again = await check(samples[0].token, 'whatever');
    assert.deepEqual(again, { valid: false, reason: 'not_found' });

    // 答错：同样作废，之后再用正确答案也不行
    const right = answerOf(samples[1].token);
    const wrong = await check(samples[1].token, right === '0000' ? '1111' : '0000');
    assert.deepEqual(wrong, { valid: false, reason: 'wrong' });
    assert.deepEqual(await check(samples[1].token, right), { valid: false, reason: 'not_found' });

    // 算术题
    assert.deepEqual(await check(samples[2].token, answerOf(samples[2].token)), { valid: true, reason: 'ok' });
    assert.deepEqual(await check(samples[3].token, ` ${answerOf(samples[3].token)}`), { valid: true, reason: 'ok' });

    // 过期：2 分钟内有效，超过即 expired
    const fresh = (await gen.handler({ query: q({ type: 'number' }) })).data;
    const late = (await gen.handler({ query: q({ type: 'number' }) })).data;
    t.mock.timers.tick(TTL_MS - 1);
    assert.deepEqual(await check(fresh.token, answerOf(fresh.token)), { valid: true, reason: 'ok' });
    t.mock.timers.tick(1);
    const expired = await check(late.token, answerOf(late.token));
    assert.deepEqual(expired, { valid: false, reason: 'expired' });

    // 过期很久的会被定时清理，之后校验返回 not_found
    const old = (await gen.handler({ query: q({ type: 'math' }) })).data;
    const oldAnswer = answerOf(old.token);
    t.mock.timers.tick(TTL_MS + EXPIRED_GRACE_MS + 1);
    assert.ok(captchaStore.sweep() >= 1);
    const notFound = await check(old.token, oldAnswer);
    assert.deepEqual(notFound, { valid: false, reason: 'not_found' });
    assert.deepEqual(await check('no-such-token', '1234'), { valid: false, reason: 'not_found' });

    // 参数校验
    await assert.rejects(gen.handler({ query: q({ type: 'emoji' }) }), { status: 400 });
    await assert.rejects(gen.handler({ query: q({ length: '3' }) }), { status: 400 });
    await assert.rejects(gen.handler({ query: q({ length: '9' }) }), { status: 400 });
    await assert.rejects(verify.handler({ query: q({ answer: '1' }) }), { status: 400 });
    await assert.rejects(verify.handler({ query: q({ token: 'abc' }) }), { status: 400 });

    checkFields(gen, ...samples, defaults);
    checkFields(verify, ok, wrong, expired, notFound);
  });

  test('createCaptcha 可以写入指定的存储', () => {
    const s = new CaptchaStore({ ttlMs: 30_000 });
    const c = createCaptcha('math', 4, s);
    assert.equal(c.expiresIn, 30);
    assert.equal(s.size, 1);
    assert.equal(captchaStore.map.has(c.token), false);
  });
});

// ---------------- 颜色 ----------------

describe('颜色工具', () => {
  test('格式识别', () => {
    const cases = [
      ['#fff', 'hex3', [255, 255, 255, 1]],
      ['FFF', 'hex3', [255, 255, 255, 1]],
      ['#1E90FF', 'hex6', [30, 144, 255, 1]],
      ['#ffffffaa', 'hex8', [255, 255, 255, 170 / 255]],
      ['#f008', 'hex4', [255, 0, 0, 136 / 255]],
      ['rgb(30, 144, 255)', 'rgb', [30, 144, 255, 1]],
      ['RGBA(255,0,0,0.5)', 'rgba', [255, 0, 0, 0.5]],
      ['rgb(255 0 0 / 50%)', 'rgb', [255, 0, 0, 0.5]],
      ['rgb(100%, 50%, 0%)', 'rgb', [255, 128, 0, 1]],
      ['hsl(120, 100%, 25%)', 'hsl', [0, 128, 0, 1]],
      ['hsla(240, 100%, 50%, .25)', 'hsla', [0, 0, 255, 0.25]],
      ['hsl(0.5turn 50% 50%)', 'hsl', [64, 191, 191, 1]],
      ['hsl(-120deg, 100%, 50%)', 'hsl', [0, 0, 255, 1]],
    ];
    for (const [input, format, [r, g, b, a]] of cases) {
      const c = parseColor(input);
      assert.equal(c.format, format, input);
      assert.deepEqual([c.r, c.g, c.b], [r, g, b], input);
      assert.ok(Math.abs(c.a - a) < 1e-9, input);
    }
    for (const bad of ['', 'red', '#12345', '#ggg', 'rgb(256, 0, 0)', 'rgb(1, 2)', 'rgb(1, 2, 3, 4, 5)', 'rgba(1, 2, 3, 1.5)', 'hsl(10, 120%, 50%)', 'rgb(1, 2, 3 / 0.5)', 'rgb(a, b, c)']) {
      assert.throws(() => parseColor(bad), { status: 400 }, bad);
    }
  });

  test('转换结果：HEX / RGB / HSL / HSV / CMYK', () => {
    const d = convertColor('#1e90ff');
    assert.equal(d.hex, '#1e90ff');
    assert.equal(d.hex8, '#1e90ffff');
    assert.deepEqual(d.rgb, { r: 30, g: 144, b: 255, css: 'rgb(30, 144, 255)' });
    assert.deepEqual(d.hsl, { h: 209.6, s: 100, l: 55.9, css: 'hsl(209.6, 100%, 55.9%)' });
    assert.deepEqual(d.hsv, { h: 209.6, s: 88.2, v: 100 });
    assert.deepEqual(d.cmyk, { c: 88.2, m: 43.5, y: 0, k: 0 });
    assert.equal(d.brightness, 122.6);
    assert.equal(d.alpha, 1);

    const red = convertColor('hsl(0, 100%, 50%)');
    assert.equal(red.hex, '#ff0000');
    assert.deepEqual(red.cmyk, { c: 0, m: 100, y: 100, k: 0 });
    assert.deepEqual(red.hsv, { h: 0, s: 100, v: 100 });

    const half = convertColor('rgba(255, 0, 0, 0.5)');
    assert.equal(half.hex8, '#ff000080');
    assert.equal(half.rgba, 'rgba(255, 0, 0, 0.5)');
    assert.equal(half.hsla, 'hsla(0, 100%, 50%, 0.5)');

    const black = convertColor('#000');
    assert.deepEqual(black.cmyk, { c: 0, m: 0, y: 0, k: 100 });
    assert.deepEqual(black.hsl, { h: 0, s: 0, l: 0, css: 'hsl(0, 0%, 0%)' });

    // hsl 输入沿用原值，不因 RGB 取整产生偏差
    assert.deepEqual(convertColor('hsl(210, 100%, 56%)').hsl, { h: 210, s: 100, l: 56, css: 'hsl(210, 100%, 56%)' });
    // 各格式互相转换后得到同一个颜色
    for (const v of ['#336699', '#abc', 'rgb(12, 200, 99)', 'hsl(300, 40%, 70%)']) {
      const c = convertColor(v);
      for (const alt of [c.hex, c.rgb.css, c.hsl.css, c.hex8, c.rgba]) {
        const back = convertColor(alt);
        for (const k of ['r', 'g', 'b']) assert.ok(Math.abs(back.rgb[k] - c.rgb[k]) <= 1, `${v} → ${alt}`);
      }
    }
  });

  test('亮度与 WCAG 对比度', () => {
    assert.equal(relativeLuminance(255, 255, 255), 1);
    assert.equal(relativeLuminance(0, 0, 0), 0);
    assert.equal(contrastRatio(1, 0), 21);
    const white = convertColor('#ffffff');
    assert.deepEqual(white.contrast, { white: 1, black: 21 });
    assert.equal(white.luminance, 1);
    assert.equal(white.textColor, 'black');
    const black = convertColor('#000000');
    assert.deepEqual(black.contrast, { white: 21, black: 1 });
    assert.equal(black.textColor, 'white');
    // #777777 与白色的对比度约 4.48（WCAG 常见例子）
    const gray = convertColor('#777777');
    assert.equal(gray.contrast.white, 4.48);
    assert.equal(gray.luminance, 0.1845);
    const red = convertColor('#ff0000');
    assert.equal(red.luminance, 0.2126);
    assert.deepEqual(red.contrast, { white: 4, black: 5.25 });
    assert.equal(red.textColor, 'black');
    assert.equal(convertColor('#0000ff').textColor, 'white');
    assert.equal(convertColor('#1e90ff').brightness, 122.6);
  });

  test('随机颜色', () => {
    for (let i = 0; i < 50; i++) {
      const h = randomColor('hex');
      assert.match(h.hex, /^#[0-9a-f]{6}$/);
      assert.equal(h.value, h.hex);
      const r = randomColor('rgb');
      assert.equal(convertColor(r.value).hex, r.hex);
      const s = randomColor('hsl');
      assert.match(s.value, /^hsl\(/);
      const back = convertColor(s.value).rgb;
      const orig = convertColor(s.hex).rgb;
      for (const k of ['r', 'g', 'b']) assert.ok(Math.abs(back[k] - orig[k]) <= 1);
      assert.equal(s.textColor, convertColor(s.hex).textColor);
    }
  });

  test('GET /api/color/random、GET /api/color/convert', async () => {
    const rand = route(colorModule, '/api/color/random');
    const conv = route(colorModule, '/api/color/convert');
    const list = (await rand.handler({ query: q({ count: '5', format: 'rgb' }) })).data;
    assert.equal(list.length, 5);
    for (const c of list) assert.match(c.value, /^rgb\(\d+, \d+, \d+\)$/);
    const one = (await rand.handler({ query: q() })).data;
    assert.equal(one.length, 1);
    await assert.rejects(rand.handler({ query: q({ count: '0' }) }), { status: 400 });
    await assert.rejects(rand.handler({ query: q({ format: 'cmyk' }) }), { status: 400 });

    const samples = [];
    for (const value of ['#1e90ff', ' hsla(120, 50%, 50%, 0.3) ', 'fff']) samples.push((await conv.handler({ query: q({ value }) })).data);
    assert.equal(samples[1].input, 'hsla(120, 50%, 50%, 0.3)');
    assert.equal(samples[1].format, 'hsla');
    await assert.rejects(conv.handler({ query: q() }), { status: 400 });
    await assert.rejects(conv.handler({ query: q({ value: 'blue' }) }), { status: 400 });
    checkFields(rand, list, one);
    checkFields(conv, ...samples);
  });
});

// ---------------- BMI ----------------

describe('BMI', () => {
  test('中国标准与 WHO 标准分级', () => {
    const d = calcBMI(175, 70);
    assert.equal(d.bmi, 22.9);
    assert.equal(d.china.code, 'normal');
    assert.equal(d.china.level, '正常');
    assert.equal(d.who.code, 'normal');
    assert.deepEqual(d.normalWeight, { min: 56.7, max: 73.2 });
    assert.equal(d.toNormal, 0);

    // 身高 1 米时 BMI 等于体重，方便测边界
    const at = (w) => calcBMI(100, w);
    assert.equal(at(18.4).china.code, 'underweight');
    assert.equal(at(18.5).china.code, 'normal');
    assert.equal(at(23.9).china.code, 'normal');
    assert.equal(at(24).china.code, 'overweight');
    assert.equal(at(24).who.code, 'normal');
    assert.equal(at(24.9).who.code, 'normal');
    assert.equal(at(25).who.code, 'overweight');
    assert.equal(at(27.9).china.code, 'overweight');
    assert.equal(at(28).china.code, 'obese');
    assert.equal(at(28).who.code, 'overweight');
    assert.equal(at(30).who.level, 'I 度肥胖');
    assert.equal(at(35).who.code, 'obese_2');
    assert.equal(at(40).who.code, 'obese_3');
    assert.equal(at(40).who.level, 'III 度肥胖');
    // 23.95 四舍五入为 24.0，按 24.0 判为超重，与显示的值一致
    assert.equal(at(23.95).bmi, 24);
    assert.equal(at(23.95).china.code, 'overweight');

    const thin = calcBMI(180, 55);
    assert.equal(thin.bmi, 17);
    assert.equal(thin.china.level, '偏瘦');
    assert.equal(thin.toNormal, 4.9);
    const heavy = calcBMI(160, 80);
    assert.equal(heavy.bmi, 31.3);
    assert.equal(heavy.china.level, '肥胖');
    assert.equal(heavy.who.level, 'I 度肥胖');
    assert.equal(heavy.toNormal, -18.8);
  });

  test('GET /api/bmi', async () => {
    const r = route(bmiModule, '/api/bmi');
    const samples = [];
    for (const [height, weight] of [['175', '70'], ['160.5', '80'], ['180', '55'], ['170', '75']]) {
      samples.push((await r.handler({ query: q({ height, weight }) })).data);
    }
    assert.equal(samples[1].height, 160.5);
    assert.equal(samples[3].china.code, 'overweight');
    for (const bad of [{ height: '49', weight: '60' }, { height: '251', weight: '60' }, { height: '170', weight: '9.9' }, { height: '170', weight: '301' },
      { height: 'abc', weight: '60' }, { height: '1e2', weight: '60' }, { height: '-170', weight: '60' }, { weight: '60' }, { height: '170' }]) {
      await assert.rejects(r.handler({ query: q(bad) }), { status: 400 }, JSON.stringify(bad));
    }
    checkFields(r, ...samples);
  });
});

// ---------------- 摸鱼日历 ----------------

describe('摸鱼日历', () => {
  test('发薪日倒计时：月末、小月、闰年、跨年', () => {
    const p = (today, day) => paydayCountdown(today, day);
    assert.deepEqual(p('2026-09-24', 10), { day: 10, date: '2026-10-10', daysUntil: 16, isToday: false, monthEnd: false });
    assert.deepEqual(p('2026-09-10', 10), { day: 10, date: '2026-09-10', daysUntil: 0, isToday: true, monthEnd: false });
    // 31 号遇到小月按月末
    assert.deepEqual(p('2026-09-24', 31), { day: 31, date: '2026-09-30', daysUntil: 6, isToday: false, monthEnd: true });
    assert.deepEqual(p('2026-09-30', 31), { day: 31, date: '2026-09-30', daysUntil: 0, isToday: true, monthEnd: true });
    assert.deepEqual(p('2026-10-01', 31), { day: 31, date: '2026-10-31', daysUntil: 30, isToday: false, monthEnd: false });
    assert.deepEqual(p('2026-01-31', 31), { day: 31, date: '2026-01-31', daysUntil: 0, isToday: true, monthEnd: false });
    // 2 月：平年 28 天、闰年 29 天
    assert.deepEqual(p('2026-01-31', 30), { day: 30, date: '2026-02-28', daysUntil: 28, isToday: false, monthEnd: true });
    assert.deepEqual(p('2026-02-01', 29), { day: 29, date: '2026-02-28', daysUntil: 27, isToday: false, monthEnd: true });
    assert.deepEqual(p('2028-02-01', 30), { day: 30, date: '2028-02-29', daysUntil: 28, isToday: false, monthEnd: true });
    assert.deepEqual(p('2028-02-01', 29), { day: 29, date: '2028-02-29', daysUntil: 28, isToday: false, monthEnd: false });
    // 跨年
    assert.deepEqual(p('2026-12-15', 10), { day: 10, date: '2027-01-10', daysUntil: 26, isToday: false, monthEnd: false });
    assert.deepEqual(p('2026-12-31', 1), { day: 1, date: '2027-01-01', daysUntil: 1, isToday: false, monthEnd: false });
  });

  test('周末倒计时', () => {
    assert.deepEqual(weekendCountdown('2026-09-24'), { isWeekend: false, daysUntil: 2 }); // 周四
    assert.deepEqual(weekendCountdown('2026-09-25'), { isWeekend: false, daysUntil: 1 }); // 周五
    assert.deepEqual(weekendCountdown('2026-09-26'), { isWeekend: true, daysUntil: 0 }); // 周六
    assert.deepEqual(weekendCountdown('2026-09-27'), { isWeekend: true, daysUntil: 0 }); // 周日
    assert.deepEqual(weekendCountdown('2026-09-28'), { isWeekend: false, daysUntil: 5 }); // 周一
  });

  test('摸鱼语不少于 30 条且不重复', () => {
    assert.ok(QUOTES.length >= 30);
    assert.equal(new Set(QUOTES).size, QUOTES.length);
  });

  test('upcomingHolidays 去重、排序、限量', () => {
    const y1 = { days: [{ name: 'A', date: '2030-01-01', isOffDay: true }, { name: 'B', date: '2030-05-01', isOffDay: true }] };
    const list = upcomingHolidays([y1, y1], '2029-12-31', 5);
    assert.deepEqual(list.map((h) => [h.name, h.daysUntil]), [['A', 1], ['B', 121]]);
    assert.equal(upcomingHolidays([y1], '2029-12-31', 1).length, 1);
    assert.deepEqual(upcomingHolidays([y1], '2030-01-01', 5).map((h) => h.name), ['B']);
  });

  const samples = [];

  test('节假日数据正常：放假判断与节假日倒计时', async (t) => {
    const calls = mockFetch(t, { '/2026.json': fixture('holiday-cn-2026.json'), '/2027.json': 404 });
    const d = await loadMoyu({ now: Date.parse('2026-09-24T02:00:00Z'), pick: () => 0 });
    assert.ok(calls.some((u) => u.endsWith('/2026.json')));
    assert.equal(d.date, '2026-09-24');
    assert.equal(d.weekday, '星期四');
    assert.equal(d.lunar.monthDay, '八月十四');
    assert.equal(d.lunar.yearName, '丙午马年');
    assert.deepEqual(d.today, { isOffDay: false, type: 'normal', name: null, note: '工作日' });
    assert.deepEqual(d.weekend, { isWeekend: false, daysUntil: 2 });
    assert.equal(d.payday.daysUntil, 16);
    assert.deepEqual(d.holidays, [
      { name: '中秋节', start: '2026-09-25', end: '2026-09-27', days: 3, daysUntil: 1 },
      { name: '国庆节', start: '2026-10-01', end: '2026-10-07', days: 7, daysUntil: 7 },
    ]);
    assert.equal(d.holidaySource, 'holiday-cn');
    assert.equal(d.degraded, false);
    assert.equal(d.notice, null);
    assert.equal(d.quote, QUOTES[0]);
    samples.push(d);

    // 国庆当天：放假，接下来今年已没有假期，明年未公布 → 空数组
    const holiday = await loadMoyu({ now: Date.parse('2026-09-30T16:00:00Z'), payday: 1 });
    assert.equal(holiday.date, '2026-10-01');
    assert.deepEqual(holiday.today, { isOffDay: true, type: 'holiday', name: '国庆节', note: '国庆节假期' });
    assert.ok(holiday.festivals.includes('国庆节'));
    assert.deepEqual(holiday.holidays, []);
    assert.equal(holiday.payday.isToday, true);
    assert.ok(QUOTES.includes(holiday.quote));
    samples.push(holiday);

    // 调休上班的周六：日历上是周末，但要上班
    const workday = await loadMoyu({ now: Date.parse('2026-10-10T01:00:00Z') });
    assert.equal(workday.today.type, 'workday');
    assert.equal(workday.today.isOffDay, false);
    assert.equal(workday.weekend.isWeekend, true);
  });

  test('节假日数据获取失败时降级：只保留周末和发薪倒计时', async (t) => {
    // 2031 年没有内置数据，上游又连不上
    const calls = mockFetch(t, {});
    const d = await loadMoyu({ now: Date.parse('2031-03-05T04:00:00Z'), payday: 31 });
    assert.ok(calls.some((u) => u.endsWith('/2031.json')));
    assert.equal(d.degraded, true);
    assert.equal(d.date, '2031-03-05');
    assert.equal(d.holidays, null);
    assert.equal(d.holidaySource, null);
    assert.deepEqual(d.today, { isOffDay: null, type: null, name: null, note: '节假日数据暂缺，无法判断今天是否放假' });
    assert.match(d.notice, /节假日数据获取失败/);
    assert.deepEqual(d.weekend, { isWeekend: false, daysUntil: 3 });
    assert.deepEqual(d.payday, { day: 31, date: '2031-03-31', daysUntil: 26, isToday: false, monthEnd: false });
    assert.ok(d.lunar.text.startsWith('二〇三一年'));
    samples.push(d);

    // 上游返回非 JSON 同样降级
    mockFetch(t, { '/2032.json': () => new Response('<html>', { status: 200 }), '/2033.json': 500 });
    const bad = await loadMoyu({ now: Date.parse('2032-06-01T04:00:00Z') });
    assert.equal(bad.degraded, true);
  });

  test('今年安排尚未公布：只按周末判断并提示', async (t) => {
    mockFetch(t, { '/2029.json': 404, '/2030.json': 404 });
    const d = await loadMoyu({ now: Date.parse('2029-07-07T04:00:00Z') });
    assert.equal(d.degraded, false);
    assert.equal(d.holidaySource, 'none');
    assert.deepEqual(d.holidays, []);
    assert.deepEqual(d.today, { isOffDay: true, type: 'weekend', name: null, note: '周末' });
    assert.match(d.notice, /2029 年放假安排尚未公布/);
    samples.push(d);
  });

  test('GET /api/moyu', async (t) => {
    // 按实际日期运行：任何年份都返回一份含元旦和国庆的安排
    mockFetch(t, {
      '.json': (url) => {
        const y = Number(/\/(\d{4})\.json$/.exec(url)[1]);
        const days = [{ name: '元旦', date: `${y}-01-01`, isOffDay: true }];
        for (let d = 1; d <= 7; d++) days.push({ name: '国庆节', date: `${y}-10-0${d}`, isOffDay: true });
        return Response.json({ year: y, papers: [], days });
      },
    });
    const r = route(moyuModule, '/api/moyu');
    const { data } = await r.handler({ query: q({ payday: '15' }) });
    assert.equal(data.payday.day, 15);
    assert.match(data.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(data.payday.daysUntil >= 0 && data.payday.daysUntil <= 31);
    assert.ok(data.weekend.daysUntil >= 0 && data.weekend.daysUntil <= 5);
    assert.equal((await r.handler({ query: q() })).data.payday.day, 10);
    for (const bad of ['0', '32', 'abc', '1.5']) await assert.rejects(r.handler({ query: q({ payday: bad }) }), { status: 400 }, bad);
    checkFields(r, data, ...samples);
  });
});

// ---------------- 访客信息 ----------------

const CHROME_UA = UA_CASES[0][0];

describe('访客信息', () => {
  test('Accept-Language 解析', () => {
    assert.deepEqual(parseAcceptLanguage('zh-CN,zh;q=0.9,en;q=0.8'), ['zh-CN', 'zh', 'en']);
    assert.deepEqual(parseAcceptLanguage('en;q=0.5, fr-CA ,*;q=0.1, de;q=0'), ['fr-CA', 'en']);
    assert.deepEqual(parseAcceptLanguage('ja;q=0.8,zh-TW;q=0.8,ko'), ['ko', 'ja', 'zh-TW']);
    assert.deepEqual(parseAcceptLanguage('<script>,zh'), ['zh']);
    assert.deepEqual(parseAcceptLanguage(undefined), []);
  });

  test('归属地：内网不查询，失败和超时返回 null', async (t) => {
    const calls = mockFetch(t, { '/json/113.88.1.1?': fixture('ipapi-success.json'), '/json/1.2.4.8?': 500 });
    assert.equal((await lookupLocation('113.88.1.1')).location, '中国 广东 深圳');
    assert.equal(await lookupLocation('::ffff:192.168.1.10'), null);
    assert.equal(await lookupLocation('127.0.0.1'), null);
    assert.equal(await lookupLocation(''), null);
    assert.equal(await lookupLocation('not-an-ip'), null);
    assert.equal(calls.length, 1);
    assert.equal(await lookupLocation('1.2.4.8'), null);
    assert.equal(await lookupLocation('9.9.9.9'), null); // 网络错误

    t.mock.method(globalThis, 'fetch', () => new Promise(() => {}));
    const started = Date.now();
    assert.equal(await lookupLocation('223.5.5.5', 50), null);
    assert.ok(Date.now() - started < 2000);
  });

  test('GET /api/visitor', async (t) => {
    // 归属地按 IP 缓存 6 小时，每个用例用不同的 IP
    const calls = mockFetch(t, { '/json/14.215.177.39?': fixture('ipapi-success.json') });
    const r = route(visitorModule, '/api/visitor');
    const req = { headers: { 'user-agent': ` ${CHROME_UA} `, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' } };
    const before = Date.now();
    const pub = (await r.handler({ query: q(), ip: '::ffff:14.215.177.39', req })).data;
    assert.equal(pub.ip, '14.215.177.39');
    assert.deepEqual(pub.location, { text: '中国 广东 深圳', country: '中国', region: '广东', city: '深圳', isp: 'Chinanet', timezone: 'Asia/Shanghai' });
    assert.equal(pub.ua, CHROME_UA);
    assert.deepEqual(pub.browser, { name: 'Chrome', version: '128.0.0.0', major: '128' });
    assert.deepEqual(pub.os, { name: 'Windows', version: '10/11' });
    assert.equal(pub.device.type, 'desktop');
    assert.equal(pub.engine.name, 'Blink');
    assert.equal(pub.isBot, false);
    assert.equal(pub.bot, null);
    assert.equal(pub.language, 'zh-CN');
    assert.deepEqual(pub.languages, ['zh-CN', 'zh', 'en']);
    assert.ok(Date.parse(pub.time) >= before - 1);
    assert.match(pub.beijingTime, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // 内网 IP：location 为 null，不报错也不查询
    const lan = (await r.handler({ query: q(), ip: '192.168.1.10', req: { headers: { 'user-agent': UA_CASES[33][0] } } })).data;
    assert.equal(lan.location, null);
    assert.equal(lan.isBot, true);
    assert.equal(lan.device.type, 'bot');
    assert.equal(lan.language, null);
    assert.deepEqual(lan.languages, []);

    // geo=0 不查询；没有 UA、没有 IP
    const bare = (await r.handler({ query: q({ geo: '0' }), ip: '', req: undefined })).data;
    assert.equal(bare.ip, null);
    assert.equal(bare.location, null);
    assert.equal(bare.ua, '');
    assert.equal(bare.bot, 'unknown');
    assert.equal(calls.length, 1);
    await assert.rejects(r.handler({ query: q({ geo: 'yes' }), ip: '1.1.1.1', req }), { status: 400 });

    const fixed = await visitorInfo({ ip: '10.0.0.1', headers: {}, now: Date.parse('2026-09-24T08:00:00Z') });
    assert.equal(fixed.time, '2026-09-24T08:00:00.000Z');
    assert.equal(fixed.beijingTime, '2026-09-24 16:00:00');
    checkFields(r, pub, lan, bare);
  });
});

// ---------------- IP 签名档 ----------------

const ALLOWED_TAGS = new Set(['svg', 'defs', 'linearGradient', 'stop', 'clipPath', 'rect', 'g', 'circle', 'path', 'text', 'line']);
function assertSafeSvg(svg) {
  const tags = [...svg.matchAll(/<\/?([^\s/>]+)/g)].map((m) => m[1]);
  const unknown = tags.filter((tag) => !ALLOWED_TAGS.has(tag));
  assert.deepEqual(unknown, [], `出现了意外的标签：${unknown.join(', ')}`);
  assert.doesNotMatch(svg, /&(?!(?:amp|lt|gt|quot|apos);)/, '存在未转义的 &');
  assert.doesNotMatch(svg, /<script|on\w+="|javascript:/i);
  // 文本节点里不能有 < 或 >（都应被转义）
  for (const m of svg.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)) assert.doesNotMatch(m[1], /[<>]/);
}

describe('IP 签名档', () => {
  test('escapeXml 与截断', () => {
    assert.equal(escapeXml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;');
    assert.equal(escapeXml('a\u0000b\u0008c\u001Fd\te'), 'abcd\te');
    assert.equal(escapeXml('x\uD800y'), 'x�y');
    assert.equal(escapeXml('😀'), '😀');
    assert.equal(escapeXml(null), '');
    assert.equal(fit('短文字', 100, 12), '短文字');
    const long = fit('United States California Mountain View', 100, 13);
    assert.ok(long.endsWith('…') && long.length < 30);
    // 先截断再转义，不会切断实体
    assert.equal(escapeXml(fit('<<<<<<<<<<<<<<<<<<<<', 40, 13)).includes('&l…'), false);
  });

  test('问候语与时区', () => {
    const titles = [[0, '夜深了'], [4, '夜深了'], [5, '早上好'], [9, '上午好'], [12, '中午好'], [15, '下午好'], [20, '晚上好'], [23, '夜深了']];
    for (const [h, title] of titles) assert.equal(greetingFor(h, () => 0).title, title, String(h));
    const now = Date.parse('2026-09-24T23:30:00Z');
    assert.deepEqual(localParts(now), { year: 2026, month: 9, day: 25, hour: 7, weekday: '星期五' });
    assert.deepEqual(localParts(now, 'America/New_York'), { year: 2026, month: 9, day: 24, hour: 19, weekday: '星期四' });
    assert.deepEqual(localParts(now, 'Mars/Olympus'), localParts(now));
  });

  test('SVG 内容与两种主题', () => {
    const now = Date.parse('2026-09-24T12:30:00Z'); // 北京时间 20:30
    const light = renderIpCard({ ip: '113.88.1.1', location: '中国 广东 深圳', ua: CHROME_UA, now, rand: () => 0 });
    assert.match(light, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="480" height="160" viewBox="0 0 480 160"/);
    for (const s of ['113.88.1.1', '中国 广东 深圳', 'Windows 10/11', 'Chrome 128', '2026年9月24日 星期四', '晚上好，朋友！', 'rx="16"', 'linearGradient', 'WenQuanYi']) {
      assert.ok(light.includes(s), s);
    }
    assertSafeSvg(light);
    const dark = renderIpCard({ ip: '2408:8456:3a01:1234:5678:9abc:def0:1234', location: null, ua: UA_CASES[10][0], theme: 'dark', now });
    assert.ok(dark.includes('#0f172a'));
    assert.ok(dark.includes('WeChat 8'));
    assert.ok(dark.includes('iOS 17.4.1'));
    assert.match(dark, />未知<\/text>/);
    assert.ok(dark.includes('2408:8456:3a01:1234:5678:9abc:def0:1234'));
    assertSafeSvg(dark);
    // 两张卡片的 id 不同，内联到同一页面不冲突
    const ids = (svg) => [...svg.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    assert.notDeepEqual(ids(renderIpCard({ ip: '1.1.1.1', ua: '' })), ids(renderIpCard({ ip: '1.1.1.1', ua: '' })));
  });

  test('SVG 注入：UA 与归属地里的标签、引号、& 都被转义', () => {
    const evil = [
      '<script>alert(1)</script>',
      '"><svg onload=alert(1)>',
      "MyApp/1.0'\"&<img src=x onerror=alert(1)>",
      '</text><script>alert(document.cookie)</script><text>',
      ']]><![CDATA[<script>x</script>',
    ];
    for (const ua of evil) {
      const svg = renderIpCard({ ip: '8.8.8.8', location: '<b onmouseover="x">中国</b>&amp;', ua, now: 0 });
      assertSafeSvg(svg);
      assert.ok(!svg.includes('<script'), ua);
      assert.ok(!svg.includes('<img'), ua);
      assert.ok(!svg.includes('<b '), ua);
    }
    const svg = renderIpCard({ ip: '8.8.8.8', location: null, ua: '<script>alert(1)</script>', now: 0 });
    assert.ok(svg.includes('&lt;script&gt;alert(1)'));
  });

  test('GET /api/ipcard（mock 归属地查询）', async (t) => {
    const calls = mockFetch(t, { '/json/183.2.172.185?': fixture('ipapi-success.json') });
    const r = route(ipcardModule, '/api/ipcard');
    assert.equal(r.raw, true);
    assert.equal(r.fields, undefined);
    assert.ok(typeof r.returns === 'string' && r.returns.length > 20);

    const res = await r.handler({ query: q({ theme: 'dark' }), ip: '183.2.172.185', req: { headers: { 'user-agent': CHROME_UA } } });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/svg+xml; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.ok(res.body.includes('中国 广东 深圳'));
    assert.ok(res.body.includes('#0f172a'));
    assertSafeSvg(res.body);

    const lan = await r.handler({ query: q(), ip: '10.1.2.3', req: { headers: { 'user-agent': '<script>alert(1)</script>' } } });
    assert.match(lan.body, />未知<\/text>/);
    assert.ok(lan.body.includes('10.1.2.3'));
    assert.ok(!lan.body.includes('<script'));
    assertSafeSvg(lan.body);

    const noIp = await r.handler({ query: q(), ip: undefined, req: undefined });
    assertSafeSvg(noIp.body);
    assert.equal(calls.length, 1);
    await assert.rejects(r.handler({ query: q({ theme: 'blue' }), ip: '1.1.1.1', req: {} }), { status: 400 });
  });
});

// ---------------- 覆盖检查 ----------------

test('本批新增的每个非 raw 路由都做了字段双向校验，raw 路由都有 returns', () => {
  const routes = MODULES.flatMap((m) => m.routes);
  const expected = routes.filter((r) => !r.raw).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(expected.filter((k) => !checked.has(k)), []);
  for (const r of routes.filter((x) => x.raw)) {
    assert.ok(typeof r.returns === 'string' && r.returns.length > 20, `${r.path} 缺少 returns`);
    assert.equal(r.fields, undefined, `${r.path} 是 raw 路由，用 returns 而不是 fields`);
  }
});

import { randomInt } from 'node:crypto';
import { HttpError, param } from '../../lib/http.js';
import { parseUA } from '../../lib/ua.js';

const pick = (arr) => arr[randomInt(arr.length)];
const r = (min, max) => randomInt(min, max + 1);
const hex = (n) => Array.from({ length: n }, () => '0123456789ABCDEF'[randomInt(16)]).join('');

// Chrome / Edge 主版本对应的真实构建号
const CHROME_BUILD = { 120: 6099, 121: 6167, 122: 6261, 123: 6312, 124: 6367, 125: 6422, 126: 6478, 127: 6533, 128: 6613, 129: 6668, 130: 6723, 131: 6778 };
const EDGE_BUILD = { 120: 2210, 121: 2277, 122: 2365, 123: 2420, 124: 2478, 125: 2535, 126: 2592, 127: 2651, 128: 2739, 129: 2792, 130: 2849, 131: 2903 };
const chromeMajor = () => r(120, 131);
const chromeFull = (m = chromeMajor()) => `${m}.0.${CHROME_BUILD[m]}.${r(40, 200)}`;
const android = () => pick(['10', '11', '12', '13', '14']);
const IOS = [['16_7_8', '16.6'], ['17_4_1', '17.4.1'], ['17_5_1', '17.5'], ['17_6_1', '17.6'], ['18_0_1', '18.0.1'], ['18_1', '18.1']];
const ios = () => pick(IOS);

const MODELS = {
  xiaomi: ['2211133C', '23013RK75C', '2304FPN6DC', '23116PN5BC', '2311DRK48C', '24031PN0DC', 'M2012K11AC', '22041211AC'],
  huawei: ['NOH-AN00', 'ANA-AN00', 'ELS-AN00', 'JAD-AL50', 'ALN-AL00', 'BRA-AL00'],
  vivo: ['V2227A', 'V2309A', 'V2324A', 'V2203A'],
  samsung: ['SM-S9180', 'SM-S9210', 'SM-S9280', 'SM-G9910', 'SM-A5360'],
  any: ['2211133C', '23116PN5BC', 'V2227A', 'V2309A', 'SM-S9210', 'PGT-AN10', 'CPH2581', 'RMX3706'],
};
const BUILD = ['TP1A.220624.014', 'UKQ1.230804.001', 'SP1A.210812.016', 'UP1A.230905.011', 'TKQ1.221114.001'];

const WIN = 'Windows NT 10.0; Win64; x64';
const MAC = 'Macintosh; Intel Mac OS X 10_15_7';
const LINUX = 'X11; Linux x86_64';
const desktopOS = () => pick([WIN, WIN, WIN, MAC, LINUX]);

const chromeDesktop = (os = desktopOS(), m = chromeMajor()) => `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${m}.0.0.0 Safari/537.36`;
const chromeAndroid = (m = chromeMajor()) => `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${m}.0.0.0 Mobile Safari/537.36`;
// 国产浏览器与 App 内置浏览器常见的"Linux; U; Android x; zh-CN; 型号 Build/..."格式
const androidU = (models = MODELS.any) => `Linux; U; Android ${android()}; zh-CN; ${pick(models)} Build/${pick(BUILD)}`;
const iPhone = ([v]) => `iPhone; CPU iPhone OS ${v} like Mac OS X`;

// 每个浏览器在 desktop / mobile 下的模板
export const TEMPLATES = {
  chrome: {
    desktop: [() => chromeDesktop()],
    mobile: [() => chromeAndroid(), () => `Mozilla/5.0 (${iPhone(ios())}) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/${chromeFull()} Mobile/15E148 Safari/604.1`],
  },
  edge: {
    desktop: [() => { const m = chromeMajor(); return `${chromeDesktop(pick([WIN, WIN, MAC]), m)} Edg/${m}.0.${EDGE_BUILD[m]}.${r(40, 120)}`; }],
    mobile: [
      () => { const m = chromeMajor(); return `${chromeAndroid(m)} EdgA/${m}.0.${EDGE_BUILD[m]}.${r(40, 120)}`; },
      () => { const m = chromeMajor(); const v = ios(); return `Mozilla/5.0 (${iPhone(v)}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v[1].split('.').slice(0, 2).join('.')} EdgiOS/${m}.0.${EDGE_BUILD[m]}.${r(40, 120)} Mobile/15E148 Safari/605.1.15`; },
    ],
  },
  firefox: {
    desktop: [() => {
      const v = r(115, 132);
      const os = pick(['Windows NT 10.0; Win64; x64', 'Macintosh; Intel Mac OS X 10.15', 'X11; Linux x86_64', 'X11; Ubuntu; Linux x86_64']);
      return `Mozilla/5.0 (${os}; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`;
    }],
    mobile: [
      () => { const v = r(115, 132); return `Mozilla/5.0 (Android ${android()}; Mobile; rv:${v}.0) Gecko/${v}.0 Firefox/${v}.0`; },
      () => `Mozilla/5.0 (${iPhone(ios())}) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/${r(125, 132)}.${r(0, 2)} Mobile/15E148 Safari/605.1.15`,
    ],
  },
  safari: {
    desktop: [() => `Mozilla/5.0 (${MAC}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${pick(['16.6', '17.4.1', '17.5', '17.6', '18.0', '18.1'])} Safari/605.1.15`],
    mobile: [() => { const v = ios(); return `Mozilla/5.0 (${iPhone(v)}) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v[1]} Mobile/15E148 Safari/604.1`; }],
  },
  opera: {
    desktop: [() => { const m = chromeMajor(); return `${chromeDesktop(pick([WIN, WIN, MAC]), m)} OPR/${m - 14}.0.0.0`; }],
    mobile: [() => `Mozilla/5.0 (Linux; Android ${android()}; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor()}.0.0.0 Mobile Safari/537.36 OPR/${r(80, 85)}.${r(0, 9)}.${r(4000, 4500)}.${r(70000, 82000)}`],
  },
  wechat: {
    desktop: [() => `Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.138 Safari/537.36 NetType/WIFI MicroMessenger/7.0.20.1781(0x6700143B) WindowsWechat(0x63090${hex(3).toLowerCase()}) XWEB/${r(9000, 11500)} Flue`],
    mobile: [
      () => `Mozilla/5.0 (Linux; Android ${android()}; ${pick(MODELS.any)} Build/${pick(BUILD)}; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/${r(111, 126)}.0.0.0 Mobile Safari/537.36 XWEB/${r(1100000, 1300000)} MMWEBSDK/20240404 MMWEBID/${r(1000, 9999)} MicroMessenger/8.0.${r(40, 50)}.${r(2400, 2800)}(0x28003${hex(3)}) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64`,
      () => `Mozilla/5.0 (${iPhone(ios())}) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.${r(40, 50)}(0x18003${hex(3)}) NetType/${pick(['WIFI', '4G', '5G'])} Language/zh_CN`,
    ],
  },
  qq: {
    desktop: [() => `Mozilla/5.0 (${WIN}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${r(118, 123)}.0.0.0 Safari/537.36 Core/1.116.${r(400, 480)}.400 QQBrowser/${r(12, 13)}.${r(0, 9)}.${r(5000, 6500)}.400`],
    mobile: [() => `Mozilla/5.0 (${androidU()}) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/109.0.5414.86 MQQBrowser/${r(13, 15)}.${r(0, 9)} Mobile Safari/537.36 COVC/0469${r(10, 99)}`],
  },
  uc: {
    mobile: [
      () => `Mozilla/5.0 (${androidU(MODELS.xiaomi)}) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.58 UWS/3.22.2.${r(40, 70)} UCBrowser/${r(15, 17)}.${r(0, 9)}.${r(0, 9)}.${r(1000, 1400)} Mobile Safari/537.36`,
      () => { const v = ios(); return `Mozilla/5.0 (iPhone; CPU iPhone OS ${v[0]} like Mac OS X; zh-CN) AppleWebKit/537.51.1 (KHTML, like Gecko) Mobile/20G75 UCBrowser/${r(15, 17)}.${r(0, 9)}.${r(0, 9)}.${r(1000, 2200)} Mobile AliApp(TUnionSDK/0.1.20.4)`; },
    ],
  },
  quark: {
    mobile: [
      () => `Mozilla/5.0 (${androidU(MODELS.xiaomi)}) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.58 Quark/${r(6, 7)}.${r(0, 9)}.${r(0, 9)}.${r(100, 700)} Mobile Safari/537.36`,
      () => `Mozilla/5.0 (${iPhone(ios())}) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Quark/${r(6, 7)}.${r(0, 9)}.${r(0, 9)}.${r(1000, 2200)} Mobile`,
    ],
  },
  baidu: {
    mobile: [
      () => `Mozilla/5.0 (Linux; Android ${android()}; ${pick(MODELS.huawei)} Build/HUAWEI${pick(MODELS.huawei)}; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/97.0.4692.98 Mobile Safari/537.36 T7/13.${r(40, 60)} SP-engine/2.91.0 baiduboxapp/13.${r(40, 60)}.0.10 (Baidu; P1 12) NABar/1.0`,
      () => { const v = ios(); return `Mozilla/5.0 (${iPhone(v)}) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 SP-engine/2.93.0 main%2F1.0 baiduboxapp/13.${r(40, 60)}.0.10 (Baidu; P2 ${v[1]}) NABar/1.0`; },
    ],
  },
  huawei: {
    mobile: [
      () => `Mozilla/5.0 (Linux; Android 12; HarmonyOS; ${pick(MODELS.huawei)}; HMSCore 6.13.0.${r(300, 330)}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.5735.196 HuaweiBrowser/${r(14, 15)}.${r(0, 1)}.${r(0, 9)}.${r(300, 320)} Mobile Safari/537.36`,
      () => `Mozilla/5.0 (Phone; OpenHarmony ${pick(['4.1', '5.0'])}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile HuaweiBrowser/5.0.${r(4, 9)}.300`,
    ],
  },
  xiaomi: {
    mobile: [() => `Mozilla/5.0 (${androidU(MODELS.xiaomi)}) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/115.0.5790.168 Mobile Safari/537.36 XiaoMi/MiuiBrowser/${r(17, 19)}.${r(0, 9)}.${r(40000, 99999)}`],
  },
  samsung: {
    mobile: [() => `Mozilla/5.0 (Linux; Android ${pick(['13', '14'])}; SAMSUNG ${pick(MODELS.samsung)}) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/${r(23, 26)}.0 Chrome/${r(115, 125)}.0.0.0 Mobile Safari/537.36`],
  },
};
export const BROWSER_KEYS = Object.keys(TEMPLATES);

export function randomUA({ device, browser } = {}) {
  const pool = [];
  for (const [key, byDevice] of Object.entries(TEMPLATES)) {
    if (browser && key !== browser) continue;
    for (const [dev, fns] of Object.entries(byDevice)) {
      if (device && dev !== device) continue;
      for (const fn of fns) pool.push([dev, fn]);
    }
  }
  if (!pool.length) {
    const has = Object.keys(TEMPLATES[browser] ?? {});
    throw new HttpError(400, `${browser} 没有 ${device} 的 UA 模板（可用：${has.join(' / ')}）`);
  }
  const [dev, fn] = pick(pool);
  const ua = fn();
  const p = parseUA(ua);
  return { ua, device: dev, browser: p.browser.name, version: p.browser.version, os: p.os.name };
}

const UA_FIELDS = [
  { name: 'browser', type: 'object', desc: '浏览器（含微信、QQ 等 App 内置浏览器）' },
  {
    name: 'browser.name',
    type: 'string|null',
    desc: '浏览器名称：Chrome、Edge、Firefox、Safari、Opera、Opera Mini、WeChat（微信）、WeCom（企业微信）、QQ（手机 QQ）、QQ Browser、UC Browser、Quark（夸克）、Baidu App（百度 App）、'
      + 'Huawei Browser、Mi Browser（小米）、Samsung Internet、vivo Browser、OPPO Browser、360 Browser、Sogou Explorer、DingTalk、Alipay、Yandex、Vivaldi、IE、IE Mobile、Chromium、'
      + 'Android WebView、WebView（iOS App 内嵌网页）；识别不出（包括 curl 等非浏览器客户端）时为 null',
  },
  { name: 'browser.version', type: 'string|null', desc: 'UA 中的完整版本号，如 128.0.6613.120；Chrome 等启用了 UA 精简的浏览器只给出主版本（如 128.0.0.0）；没有版本号时为 null' },
  { name: 'browser.major', type: 'string|null', desc: '主版本号（version 第一个点之前的部分），如 128；没有版本号时为 null' },
  { name: 'engine', type: 'object', desc: '渲染引擎' },
  { name: 'engine.name', type: 'string|null', desc: '引擎名称：Blink（Chrome 28 起及其衍生浏览器）、WebKit（Safari 以及 iOS 上的所有浏览器）、Gecko（Firefox）、Trident（IE）、EdgeHTML（旧版 Edge）、Presto（旧版 Opera）；识别不出时为 null' },
  { name: 'engine.version', type: 'string|null', desc: '引擎版本：Blink 取 Chrome 版本号，WebKit 取 AppleWebKit 版本号，Gecko 取 rv 版本号；识别不出时为 null' },
  { name: 'os', type: 'object', desc: '操作系统' },
  { name: 'os.name', type: 'string|null', desc: '系统名称：Windows、Windows Phone、macOS、iOS、iPadOS（iPad 且系统版本 ≥ 13）、Android、HarmonyOS（鸿蒙，含基于 Android 的 2~4 版和 OpenHarmony 内核的 NEXT）、Linux、ChromeOS；识别不出时为 null' },
  {
    name: 'os.version',
    type: 'string|null',
    desc: '系统版本（点分隔）：Windows 按内核版本映射，NT 10.0 → 10/11（UA 无法区分 10 和 11）、6.3 → 8.1、6.2 → 8、6.1 → 7、6.0 → Vista、5.1/5.2 → XP；'
      + 'macOS 如 10.15.7（新版 Safari、Chrome 固定报告 10.15.7，不代表真实版本）；HarmonyOS NEXT 为 OpenHarmony 版本号；ChromeOS 为平台版本号；Linux 和没有版本号时为 null',
  },
  { name: 'device', type: 'object', desc: '设备' },
  { name: 'device.type', type: 'string', desc: '设备类型：desktop（电脑，也是无法判断时的默认值）、mobile（手机）、tablet（平板：iPad、不带 Mobile 标记的 Android/鸿蒙设备等；iPadOS 13+ 默认请求桌面版网页时会被识别为 desktop）、bot（爬虫或脚本）' },
  { name: 'device.vendor', type: 'string|null', desc: '设备厂商：Apple、Samsung、Google、Huawei、Honor、Xiaomi、OPPO、vivo、OnePlus、realme、Meizu、Motorola；按型号前缀和 UA 特征推断，识别不出时为 null' },
  { name: 'device.model', type: 'string|null', desc: '设备型号：iPhone、iPad、iPod touch、Mac，或 Android UA 中的型号（如 SM-S9210、23116PN5BC）；Chrome 精简 UA 中的占位型号 K 和识别不出时为 null' },
  { name: 'isBot', type: 'boolean', desc: '是否为爬虫或脚本：搜索引擎爬虫（Googlebot、Baiduspider、bingbot、YandexBot、Sogou Spider、360Spider、Bytespider 等）、社交/AI 爬虫（facebookexternalhit、GPTBot、ClaudeBot 等）、无头浏览器、curl、python-requests 等 HTTP 库，以及名称以 bot/spider/crawler 结尾的未知爬虫；UA 为空时也为 true' },
  { name: 'bot', type: 'string|null', desc: '爬虫或脚本名称，如 Googlebot、Baiduspider、bingbot、curl；UA 为空时为 unknown；isBot 为 false 时为 null' },
];

export default {
  name: 'useragent',
  category: 'tools',
  title: 'User-Agent 工具',
  description: '解析 User-Agent（浏览器、系统、设备、爬虫），随机生成真实格式的 UA',
  source: '本地计算',
  routes: [
    {
      method: 'GET',
      path: '/api/ua/parse',
      summary: '解析 User-Agent（默认解析调用者自己的）',
      params: [{ name: 'ua', required: false, desc: '要解析的 User-Agent（最多 2000 个字符），留空为请求头里调用者自己的 UA', example: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1' }],
      fields: [
        { name: 'ua', type: 'string', desc: '被解析的 User-Agent 原文（去掉首尾空白）；没传 ua 参数且请求头里也没有时为空字符串' },
        ...UA_FIELDS,
      ],
      async handler({ query, req }) {
        const ua = (param(query, 'ua', { max: 2000 }) ?? String(req?.headers?.['user-agent'] ?? '').slice(0, 2000)).trim();
        return { data: { ua, ...parseUA(ua) } };
      },
    },
    {
      method: 'GET',
      path: '/api/ua/random',
      summary: '随机生成真实格式的 User-Agent',
      params: [
        { name: 'device', required: false, desc: '设备类型 desktop / mobile，留空为两者随机', example: 'mobile' },
        { name: 'browser', required: false, desc: `浏览器，留空为随机：${BROWSER_KEYS.join(' / ')}（uc、quark、baidu、huawei、xiaomi、samsung 只有 mobile）`, example: 'wechat' },
        { name: 'count', required: false, default: '1', desc: '数量（1~50）', example: '5' },
      ],
      fields: [
        { name: '[]', type: 'object', desc: 'data 是数组，长度等于 count，每项是一个随机生成的 UA。模板取自各浏览器真实 UA 的格式，版本号、系统版本和手机型号在常见范围内随机' },
        { name: '[].ua', type: 'string', desc: 'User-Agent 字符串' },
        { name: '[].device', type: 'string', desc: '模板所属设备类型：desktop 或 mobile（mobile 均为手机，不含平板）' },
        { name: '[].browser', type: 'string', desc: '用 /api/ua/parse 同一套规则解析出的浏览器名称，如 Chrome、WeChat、UC Browser' },
        { name: '[].version', type: 'string', desc: '解析出的浏览器版本号，如 128.0.0.0' },
        { name: '[].os', type: 'string', desc: '解析出的操作系统名称：Windows、macOS、Linux、Android、iOS、HarmonyOS' },
      ],
      async handler({ query }) {
        const device = param(query, 'device', { oneOf: ['desktop', 'mobile'] });
        const browser = param(query, 'browser', { oneOf: BROWSER_KEYS });
        const count = param(query, 'count', { default: 1, int: true, min: 1, max: 50 });
        return { data: Array.from({ length: count }, () => randomUA({ device, browser })) };
      },
    },
  ],
};

export { UA_FIELDS };

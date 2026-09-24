// 轻量 User-Agent 解析：浏览器、渲染引擎、操作系统、设备类型与爬虫识别。
// 只看 UA 字符串本身（不查 Client Hints），规则按"越具体越靠前"排列，第一个命中的生效。

// ---------------- 爬虫与脚本 ----------------
// [正则, 名称]；正则的第一个捕获组是版本号（可选）
const BOTS = [
  [/Googlebot-(?:Image|News|Video)\/([\d.]+)/, (m) => m[0].split('/')[0]],
  [/Googlebot\/([\d.]+)/, 'Googlebot'],
  [/AdsBot-Google(?:-Mobile)?|Mediapartners-Google|Google-InspectionTool|GoogleOther|Storebot-Google|FeedFetcher-Google|APIs-Google/, (m) => m[0]],
  [/Baiduspider(?:-[a-z]+)?(?:\/([\d.]+))?/i, 'Baiduspider'],
  [/bingbot\/([\d.]+)/i, 'bingbot'],
  [/BingPreview\/([\d.]+)/, 'BingPreview'],
  [/YandexBot\/([\d.]+)/, 'YandexBot'],
  [/DuckDuckBot(?:-Https)?\/([\d.]+)/, 'DuckDuckBot'],
  [/Sogou (?:web|inst|Pic|News|Orion) spider\/([\d.]+)/i, 'Sogou Spider'],
  [/360Spider|HaoSouSpider/, '360Spider'],
  [/YisouSpider/, 'YisouSpider'],
  [/Bytespider/, 'Bytespider'],
  [/Applebot\/([\d.]+)/, 'Applebot'],
  [/PetalBot/, 'PetalBot'],
  [/Yahoo! Slurp/, 'Yahoo! Slurp'],
  [/facebookexternalhit\/([\d.]+)/, 'facebookexternalhit'],
  [/meta-externalagent\/([\d.]+)/, 'meta-externalagent'],
  [/Twitterbot\/([\d.]+)/, 'Twitterbot'],
  [/LinkedInBot\/([\d.]+)/, 'LinkedInBot'],
  [/Slackbot(?:-LinkExpanding)?(?: ([\d.]+))?/, 'Slackbot'],
  [/Discordbot\/([\d.]+)/, 'Discordbot'],
  [/TelegramBot/, 'TelegramBot'],
  [/^WhatsApp\/([\d.]+)/, 'WhatsApp'],
  [/GPTBot\/([\d.]+)/, 'GPTBot'],
  [/ChatGPT-User\/([\d.]+)/, 'ChatGPT-User'],
  [/OAI-SearchBot\/([\d.]+)/, 'OAI-SearchBot'],
  [/ClaudeBot\/([\d.]+)/, 'ClaudeBot'],
  [/Claude-(?:User|SearchBot|Web)(?:\/([\d.]+))?/, (m) => m[0].split('/')[0]],
  [/PerplexityBot\/([\d.]+)/, 'PerplexityBot'],
  [/CCBot\/([\d.]+)/, 'CCBot'],
  [/Amazonbot\/([\d.]+)/, 'Amazonbot'],
  [/AhrefsBot\/([\d.]+)/, 'AhrefsBot'],
  [/SemrushBot(?:-[A-Za-z]+)?(?:\/([\d.~a-z]+))?/, 'SemrushBot'],
  [/MJ12bot\/v?([\d.]+)/, 'MJ12bot'],
  [/DotBot\/([\d.]+)/, 'DotBot'],
  [/SeznamBot\/([\d.]+)/, 'SeznamBot'],
  [/Yeti\/([\d.]+)/, 'Yeti'],
  [/coccocbot(?:-[a-z]+)?\/([\d.]+)/, 'coccocbot'],
  [/ia_archiver|archive\.org_bot/, 'Internet Archive'],
  [/HeadlessChrome\/([\d.]+)/, 'HeadlessChrome'],
  [/PhantomJS\/([\d.]+)/, 'PhantomJS'],
  [/Scrapy\/([\d.]+)/, 'Scrapy'],
  // 命令行工具与 HTTP 库
  [/^curl\/([\d.]+)/i, 'curl'],
  [/^Wget\/([\d.]+)/i, 'Wget'],
  [/python-requests\/([\d.]+)/, 'python-requests'],
  [/Python-urllib\/([\d.]+)/i, 'Python-urllib'],
  [/python-httpx\/([\d.]+)/, 'httpx'],
  [/aiohttp\/([\d.]+)/, 'aiohttp'],
  [/Go-http-client\/([\d.]+)/, 'Go-http-client'],
  [/okhttp\/([\d.]+)/i, 'okhttp'],
  [/Apache-HttpClient\/([\d.]+)/, 'Apache-HttpClient'],
  [/^Java\/([\d._]+)/, 'Java'],
  [/PostmanRuntime\/([\d.]+)/, 'PostmanRuntime'],
  [/axios\/([\d.]+)/, 'axios'],
  [/node-fetch(?:\/([\d.]+))?/, 'node-fetch'],
  [/^(?:node|undici)$/, 'Node.js'],
];

// 未收录的爬虫：名字以 bot/spider/crawler 结尾，并且带版本号或者带 http 链接 / "compatible;"（避免把 Cubot 之类的手机型号当成爬虫）
const GENERIC_BOT = /([A-Za-z][\w.-]*?(?:bot|spider|crawler))(?:\/v?([\d.]+))?/i;

function detectBot(ua) {
  for (const [re, name] of BOTS) {
    const m = re.exec(ua);
    if (m) return { name: typeof name === 'function' ? name(m) : name, version: m[1] ?? null };
  }
  const g = GENERIC_BOT.exec(ua);
  if (g && (g[2] || /https?:\/\/|compatible;/i.test(ua))) return { name: g[1], version: g[2] ?? null };
  return null;
}

// ---------------- 浏览器 ----------------
// [名称, 正则]；取第一个非空捕获组为版本号
const BROWSERS = [
  ['WeCom', /wxwork\/([\d.]+)/i],
  ['WeChat', /MicroMessenger\/([\d.]+)/i],
  ['QQ', /\sQQ\/([\d.]+)/],
  ['DingTalk', /DingTalk\/([\d.]+)/i],
  ['Alipay', /AlipayClient\/([\d.]+)/i],
  ['Baidu App', /baiduboxapp\/([\d.]+)/i],
  ['Quark', /Quark(?:PC)?\/([\d.]+)/],
  ['UC Browser', /UC ?Browser\/([\d.]+)|UBrowser\/([\d.]+)|UCWEB\/?([\d.]+)?/],
  ['QQ Browser', /M?QQBrowser\/([\d.]+)/],
  ['Huawei Browser', /HuaweiBrowser\/([\d.]+)/],
  ['Mi Browser', /MiuiBrowser\/([\d.]+)/],
  ['Samsung Internet', /SamsungBrowser\/([\d.]+)/],
  ['vivo Browser', /VivoBrowser\/([\d.]+)/],
  ['OPPO Browser', /HeyTapBrowser\/([\d.]+)|OppoBrowser\/([\d.]+)/],
  ['360 Browser', /QIHU 360(?:SE|EE)|\b360(?:SE|EE)\b/],
  ['Sogou Explorer', /SogouMobileBrowser\/([\d.]+)|\bMetaSr\b/],
  ['Opera Mini', /Opera Mini\/([\d.]+)/],
  ['Opera', /OPR\/([\d.]+)|OPiOS\/([\d.]+)|OPT\/([\d.]+)|Opera\/.*Version\/([\d.]+)|Opera[/ ]([\d.]+)/],
  ['Edge', /Edg(?:e|A|iOS)?\/([\d.]+)/],
  ['Yandex', /YaBrowser\/([\d.]+)/],
  ['Vivaldi', /Vivaldi\/([\d.]+)/],
  ['Firefox', /Firefox\/([\d.]+)|FxiOS\/([\d.]+)/],
  ['IE Mobile', /IEMobile\/([\d.]+)/],
  ['IE', /MSIE ([\d.]+)|Trident\/.*rv:([\d.]+)/],
  ['Android WebView', /; wv\).*Chrome\/([\d.]+)/],
  ['Chromium', /Chromium\/([\d.]+)/],
  ['Chrome', /(?:Chrome|CriOS)\/([\d.]+)/],
  ['Safari', /Version\/([\d.]+).*Safari\//],
  ['WebView', /(?:iPhone|iPad|iPod).*AppleWebKit(?!.*Safari)/],
];

function detectBrowser(ua) {
  for (const [name, re] of BROWSERS) {
    const m = re.exec(ua);
    if (m) {
      const version = m.slice(1).find(Boolean) ?? null;
      return { name, version, major: version ? version.split('.')[0] : null };
    }
  }
  return { name: null, version: null, major: null };
}

// ---------------- 渲染引擎 ----------------
function detectEngine(ua) {
  let m;
  if ((m = /Trident\/([\d.]+)/.exec(ua))) return { name: 'Trident', version: m[1] };
  if ((m = /Edge\/([\d.]+)/.exec(ua))) return { name: 'EdgeHTML', version: m[1] };
  if ((m = /Presto\/([\d.]+)/.exec(ua))) return { name: 'Presto', version: m[1] };
  // iOS 上的所有浏览器都必须用 WebKit，UA 里不带 Chrome/ 字样（CriOS、FxiOS、EdgiOS）
  m = /Chrome\/(\d+)(?:\.[\d.]+)?/.exec(ua);
  if (m && Number(m[1]) >= 28) return { name: 'Blink', version: m[0].slice(7) };
  if ((m = /AppleWebKit\/([\d.]+)/.exec(ua))) return { name: 'WebKit', version: m[1] };
  if (/Gecko\/[\d.]+/.test(ua) && (m = /rv:([\d.]+)/.exec(ua))) return { name: 'Gecko', version: m[1] };
  return { name: null, version: null };
}

// ---------------- 操作系统 ----------------
// Windows NT 内核版本 → 系统版本。NT 10.0 同时用于 Windows 10 与 11，仅凭 UA 无法区分
export const WINDOWS_VERSIONS = {
  '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7', '6.0': 'Vista', '5.2': 'XP', '5.1': 'XP', '5.0': '2000',
};

const dots = (v) => (v ? v.replace(/_/g, '.') : null);

function detectOS(ua) {
  let m;
  if ((m = /Windows Phone(?: OS)? ([\d.]+)/.exec(ua))) return { name: 'Windows Phone', version: m[1] };
  if ((m = /Windows NT ([\d.]+)/.exec(ua))) return { name: 'Windows', version: WINDOWS_VERSIONS[m[1]] ?? m[1] };
  if (/Windows (?:98|95|ME|CE)|Win(?:98|95)/.test(ua)) return { name: 'Windows', version: null };
  // 鸿蒙：HarmonyOS 2–4 的 UA 基于 Android 并带 HarmonyOS 字样；HarmonyOS NEXT（5.0 起）的 UA 写作 OpenHarmony <版本>
  if ((m = /OpenHarmony ([\d.]+)|HarmonyOS(?:[ /]([\d.]+))?/.exec(ua))) return { name: 'HarmonyOS', version: m[1] ?? m[2] ?? null };
  if ((m = /CrOS \S+ ([\d.]+)/.exec(ua))) return { name: 'ChromeOS', version: m[1] };
  if (/iPad/.test(ua)) {
    const v = dots(/CPU OS ([\d_]+)/.exec(ua)?.[1]);
    // iPadOS 从 13 开始独立命名
    return { name: v && Number(v.split('.')[0]) >= 13 ? 'iPadOS' : 'iOS', version: v };
  }
  if (/iPhone|iPod/.test(ua)) return { name: 'iOS', version: dots(/OS ([\d_]+) like Mac/.exec(ua)?.[1]) };
  if ((m = /Android(?:[ /]([\d.]+))?/.exec(ua))) return { name: 'Android', version: m[1] ?? null };
  if (/Macintosh|Mac OS X/.test(ua)) return { name: 'macOS', version: dots(/Mac OS X ([\d_.]+)/.exec(ua)?.[1]) };
  if (/Linux|X11/.test(ua)) return { name: 'Linux', version: null };
  return { name: null, version: null };
}

// ---------------- 设备 ----------------
const VENDORS = [
  [/^(?:SAMSUNG|SM-|GT-|SCH-|SGH-)/i, 'Samsung'],
  [/^(?:Pixel|Nexus)/, 'Google'],
  [/^HUAWEI/i, 'Huawei'],
  [/^HONOR/i, 'Honor'],
  [/^(?:Mi |MI |Redmi|POCO|M\d{4}[A-Z]\d+[A-Z]*$|2\d{3}[0-9A-Z]{4,}$)/, 'Xiaomi'],
  [/^(?:OPPO|CPH\d{4})/i, 'OPPO'],
  [/^(?:vivo|V\d{4}[A-Z]{0,2}$)/i, 'vivo'],
  [/^ONEPLUS/i, 'OnePlus'],
  [/^RMX\d{4}/, 'realme'],
  [/^MEIZU/i, 'Meizu'],
  [/^moto/i, 'Motorola'],
];

// 从 Android UA 的括号段里取型号：去掉 Linux、U、Android x、语言、wv、Build/... 等
function androidModel(ua) {
  const paren = /\(([^)]*Android[^)]*)\)/.exec(ua)?.[1];
  if (!paren) return null;
  for (const raw of paren.split(';')) {
    const s = raw.trim().replace(/\s*Build\/.*$/, '');
    if (!s || /^(?:Linux|U|Mobile|Tablet|wv|K|HarmonyOS|arm64|x86_64)$/i.test(s)) continue;
    if (/^Android\b|^[a-z]{2}(?:[-_][a-z]{2,4})?$|^HMSCore|^rv:/i.test(s)) continue;
    return s.replace(/^SAMSUNG\s+/i, '') || null;
  }
  return null;
}

function detectDevice(ua, os, bot) {
  let type;
  if (bot) type = 'bot';
  else if (/\(PC;/.test(ua)) type = 'desktop'; // 鸿蒙电脑：(PC; OpenHarmony x)
  else if (/iPad|Tablet|PlayBook|Kindle|Silk\//i.test(ua) || (['Android', 'HarmonyOS'].includes(os.name) && !/Mobi|Phone/i.test(ua))) type = 'tablet';
  else if (/Mobi|iPhone|iPod|Windows Phone|Opera Mini|IEMobile|\bPhone;/.test(ua)) type = 'mobile';
  else type = 'desktop';

  let vendor = null;
  let model = null;
  if (/iPhone/.test(ua)) [vendor, model] = ['Apple', 'iPhone'];
  else if (/iPad/.test(ua)) [vendor, model] = ['Apple', 'iPad'];
  else if (/iPod/.test(ua)) [vendor, model] = ['Apple', 'iPod touch'];
  else if (os.name === 'macOS') [vendor, model] = ['Apple', 'Mac'];
  else if (/Android/.test(ua)) {
    model = androidModel(ua);
    vendor = (model && VENDORS.find(([re]) => re.test(model))?.[1]) ?? null;
    if (!vendor && /SAMSUNG|SamsungBrowser/i.test(ua)) vendor = 'Samsung';
    if (!vendor && /Build\/HUAWEI|HMSCore|HuaweiBrowser|HarmonyOS/.test(ua)) vendor = 'Huawei';
    if (!vendor && /XiaoMi\/|MiuiBrowser/.test(ua)) vendor = 'Xiaomi';
    if (!vendor && /HeyTapBrowser|OppoBrowser/.test(ua)) vendor = 'OPPO';
    if (!vendor && /VivoBrowser/.test(ua)) vendor = 'vivo';
  } else if (os.name === 'HarmonyOS') vendor = 'Huawei';
  return { type, vendor, model };
}

/**
 * 解析 User-Agent。
 * @param {string} ua
 * @returns {{
 *   browser: { name: string|null, version: string|null, major: string|null },
 *   engine: { name: string|null, version: string|null },
 *   os: { name: string|null, version: string|null },
 *   device: { type: 'desktop'|'mobile'|'tablet'|'bot', vendor: string|null, model: string|null },
 *   isBot: boolean,
 *   bot: string|null,
 * }}
 */
export function parseUA(ua) {
  const s = String(ua ?? '').trim().slice(0, 2000);
  // 空 UA 几乎只会来自脚本
  const botHit = s ? detectBot(s) : { name: 'unknown', version: null };
  const os = detectOS(s);
  return {
    browser: detectBrowser(s),
    engine: detectEngine(s),
    os,
    device: detectDevice(s, os, botHit),
    isBot: Boolean(botHit),
    bot: botHit?.name ?? null,
  };
}

// 便于展示的一行文字，如 "Chrome 128"、"Windows 10/11"
export const browserLabel = (p) => (p.browser.name ? `${p.browser.name}${p.browser.major ? ` ${p.browser.major}` : ''}` : (p.bot ?? null));
export const osLabel = (p) => (p.os.name ? `${p.os.name}${p.os.version ? ` ${p.os.version}` : ''}` : null);

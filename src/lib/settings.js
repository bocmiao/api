// 后台「系统设置」：保存在数据库，启动时及保存后写入 process.env，优先级高于环境变量。
import { sql } from '../db.js';
import { HttpError } from './http.js';

// type: text | secret | int | bool | url | emails
export const SETTING_GROUPS = [
  {
    id: 'basic', title: '基础',
    fields: [
      { key: 'PUBLIC_URL', label: '站点地址', type: 'url', placeholder: 'https://api.miao.club', help: '用于生成短链接等完整网址，以及判断是否启用安全 Cookie' },
      { key: 'TRUST_PROXY', label: '信任反向代理', type: 'bool', default: '0', help: '部署在 Nginx / 1Panel / CDN 后面时必须开启，否则拿不到访客真实 IP' },
      { key: 'REGISTRATION_OPEN', label: '开放注册', type: 'bool', default: '1' },
      { key: 'ADMIN_EMAILS', label: '额外管理员邮箱', type: 'emails', placeholder: 'a@example.com, b@example.com', help: '这些邮箱登录后也拥有管理员权限；第一个注册的账号始终是管理员' },
    ],
  },
  {
    id: 'limits', title: '调用额度',
    fields: [
      { key: 'ANON_DAILY_LIMIT', label: '未登录每天', type: 'int', default: '100', min: 0, max: 1e9, help: '按 IP 计算' },
      { key: 'ANON_MINUTE_LIMIT', label: '未登录每分钟', type: 'int', default: '20', min: 1, max: 1e6 },
      { key: 'USER_DAILY_LIMIT', label: '注册用户每天', type: 'int', default: '10000', min: 0, max: 1e9, help: '按账号计算，同一账号的所有 Key 共享；可在用户列表里给单个用户单独设置' },
      { key: 'USER_MINUTE_LIMIT', label: '注册用户每分钟', type: 'int', default: '120', min: 1, max: 1e6 },
      { key: 'MAX_KEYS_PER_USER', label: '每个账号最多 Key 数', type: 'int', default: '10', min: 1, max: 1000 },
      { key: 'MAX_CHANNELS_PER_USER', label: '每个账号最多推送渠道数', type: 'int', default: '10', min: 1, max: 1000 },
    ],
  },
  {
    id: 'mail', title: '邮件（注册验证 / 找回密码 / 邮件推送）',
    fields: [
      { key: 'SMTP_HOST', label: 'SMTP 服务器', type: 'text', placeholder: 'smtp.exmail.qq.com', help: '填写后开启注册邮箱验证、邮箱找回密码和邮件推送' },
      { key: 'SMTP_PORT', label: 'SMTP 端口', type: 'int', default: '465', min: 1, max: 65535, help: '465 使用 SSL；587 / 25 使用 STARTTLS' },
      { key: 'SMTP_USER', label: '邮箱账号', type: 'text', placeholder: 'i@miao.club' },
      { key: 'SMTP_PASS', label: '邮箱密码', type: 'secret', help: '腾讯企业邮建议使用「客户端专用密码」' },
      { key: 'SMTP_FROM', label: '发件人名称', type: 'text', placeholder: 'Miao API', help: '收件人看到的发件人名字；发信地址始终使用上面的邮箱账号' },
      { key: 'EMAIL_VERIFY', label: '注册需要邮箱验证', type: 'bool', default: '1', help: '仅在配置了 SMTP 服务器时生效' },
      { key: 'EMAIL_CODE_COOLDOWN_SEC', label: '验证码发送间隔（秒）', type: 'int', default: '60', min: 10, max: 3600 },
      { key: 'EMAIL_CODE_PER_EMAIL_DAILY', label: '每个邮箱每天最多', type: 'int', default: '10', min: 1, max: 1000 },
      { key: 'EMAIL_CODE_PER_IP_DAILY', label: '每个 IP 每天最多', type: 'int', default: '20', min: 1, max: 10000 },
    ],
  },
  {
    id: 'keys', title: '第三方接口密钥',
    fields: [
      { key: 'KUAIDI100_KEY', label: '快递100 授权 Key', type: 'secret', help: '快递查询必需，在 api.kuaidi100.com 企业管理后台获取' },
      { key: 'KUAIDI100_CUSTOMER', label: '快递100 Customer', type: 'secret' },
      { key: 'DEEPL_API_KEY', label: 'DeepL API Key', type: 'secret', help: '翻译三选一，免费版 Key 以 :fx 结尾（deepl.com/pro-api）' },
      { key: 'BAIDU_TRANSLATE_APPID', label: '百度翻译 APP ID', type: 'text', help: 'fanyi-api.baidu.com 开发者信息' },
      { key: 'BAIDU_TRANSLATE_KEY', label: '百度翻译密钥', type: 'secret' },
      { key: 'YOUDAO_APP_KEY', label: '有道应用 ID', type: 'text', help: 'ai.youdao.com 应用管理' },
      { key: 'YOUDAO_APP_SECRET', label: '有道应用密钥', type: 'secret' },
      { key: 'QWEATHER_KEY', label: '和风天气 Key', type: 'secret', help: '可选，填写后天气改用和风天气（dev.qweather.com）' },
      { key: 'QWEATHER_HOST', label: '和风天气 API Host', type: 'text', placeholder: 'xxxx.re.qweatherapi.com', help: '和风控制台「设置」里的专属 API Host' },
      { key: 'ITAD_API_KEY', label: 'IsThereAnyDeal Key', type: 'secret', help: '可选，Steam 游戏详情附带史低价（isthereanydeal.com/apps）' },
      { key: 'COINGECKO_API_KEY', label: 'CoinGecko Demo Key', type: 'secret', help: '可选，提高加密货币接口限额' },
      { key: 'GLOBALPING_TOKEN', label: 'Globalping Token', type: 'secret', help: '可选，多节点检测（/api/probe/*）使用；不填也可用（匿名约每小时 250 次），在 globalping.io 注册后创建 Token 可提高额度' },
    ],
  },
  {
    id: 'ai', title: 'AI',
    fields: [
      { key: 'LLM_BASE_URL', label: '大模型接口地址', type: 'url', default: 'https://api.deepseek.com/v1', placeholder: 'https://api.deepseek.com/v1', help: '兼容 OpenAI 接口格式即可，如 DeepSeek、通义千问 DashScope 兼容模式（https://dashscope.aliyuncs.com/compatible-mode/v1）、Moonshot（https://api.moonshot.cn/v1）、硅基流动（https://api.siliconflow.cn/v1）等' },
      { key: 'LLM_API_KEY', label: '大模型 API Key', type: 'secret', help: '填写后开启 AI 分类接口；未填写时 AI 接口返回 503' },
      { key: 'LLM_MODEL', label: '模型名称', type: 'text', default: 'deepseek-chat', placeholder: 'deepseek-chat', help: '需与接口地址对应，如 qwen-plus、moonshot-v1-8k、Qwen/Qwen2.5-7B-Instruct' },
      { key: 'AI_DAILY_LIMIT', label: '每个用户每天 AI 调用次数', type: 'int', default: '20', min: 0, max: 1e6, help: 'AI 接口只对登录用户开放，所有 AI 接口共享此额度，另外仍计入普通调用额度；设为 0 相当于关闭' },
      { key: 'AI_MAX_CHARS', label: 'AI 单次最大字数', type: 'int', default: '3000', min: 100, max: 30000, help: '单次请求输入文本的最大字数（问答按所有消息合计），超出返回 400' },
    ],
  },
  {
    id: 'update', title: '在线更新',
    fields: [
      { key: 'UPDATE_REPO', label: 'GitHub 仓库', type: 'text', default: 'bocmiao/api', placeholder: 'owner/repo' },
      { key: 'UPDATE_BRANCH', label: '分支', type: 'text', placeholder: '留空使用仓库默认分支' },
      { key: 'GITHUB_TOKEN', label: 'GitHub Token', type: 'secret', help: '建议填写：不填时 GitHub 接口每小时只能调用 60 次，检查几次更新就会用完；填写后每小时 5000 次。公开仓库只需一个无任何权限的 Token；私有仓库必填' },
      { key: 'UPDATE_UPLOAD_VERIFY', label: '上传更新包时核对官方代码', type: 'bool', default: '1', help: '开启后，上传的更新包必须是 GitHub 上本仓库分支的原始代码（每个文件都会比对官方指纹），被改动过的代码一律拒绝。建议保持开启' },
      { key: 'UPDATE_MIRROR', label: 'GitHub 下载加速地址', type: 'url', placeholder: 'https://ghfast.top', help: '国内服务器下载 GitHub 很慢或超时时填写，例如 https://ghfast.top 。下载的每个文件都会和 GitHub 官方记录逐一核对，被改动就拒绝更新；加速失败会自动改为直连。私有仓库无法通过加速地址下载，会自动直连' },
    ],
  },
  {
    id: 'other', title: '其他',
    fields: [
      { key: 'LOG_RETENTION_DAYS', label: '调用日志保留天数', type: 'int', default: '30', min: 1, max: 3650 },
      { key: 'NOTIFY_INTERVAL_MIN', label: '推送检查间隔（分钟）', type: 'int', default: '15', min: 1, max: 1440, restart: true },
      { key: 'CRAWL_MAX_PAGES', label: '整站抓取单任务页面上限', type: 'int', default: '50', min: 1, max: 50, help: '登录用户每个抓取任务最多抓取的页面数；未登录用户另有 20 页的上限' },
    ],
  },
];

const FIELDS = new Map(SETTING_GROUPS.flatMap((g) => g.fields.map((f) => [f.key, f])));
const ENV_AT_START = Object.fromEntries([...FIELDS.keys()].map((k) => [k, process.env[k]]));
const stored = () => new Map(sql('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));

// 启动时把数据库里的设置写入 process.env
export function applySettings() {
  for (const [k, v] of stored()) if (FIELDS.has(k)) process.env[k] = v;
}

function validate(f, raw) {
  const v = String(raw).trim();
  if (v.length > 2000) throw new HttpError(400, `${f.label}过长`);
  switch (f.type) {
    case 'int': {
      const n = Number(v);
      if (!Number.isInteger(n) || n < (f.min ?? -Infinity) || n > (f.max ?? Infinity)) throw new HttpError(400, `${f.label}须为 ${f.min}~${f.max} 的整数`);
      return String(n);
    }
    case 'bool':
      if (!['0', '1'].includes(v)) throw new HttpError(400, `${f.label}只能是开或关`);
      return v;
    case 'url': {
      let u;
      try { u = new URL(v); } catch { throw new HttpError(400, `${f.label}不是合法网址`); }
      if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, `${f.label}须以 http:// 或 https:// 开头`);
      return v.replace(/\/+$/, '');
    }
    case 'emails': {
      const list = v.split(/[,，\s]+/).filter(Boolean);
      if (list.some((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) throw new HttpError(400, `${f.label}里有格式不正确的邮箱`);
      return list.join(',');
    }
    default:
      if (/[\r\n]/.test(v)) throw new HttpError(400, `${f.label}不能包含换行`);
      return v;
  }
}

// 给后台展示：密钥类只返回是否已设置
export function listSettings() {
  const db = stored();
  return SETTING_GROUPS.map((g) => ({
    id: g.id,
    title: g.title,
    fields: g.fields.map((f) => {
      const source = db.has(f.key) ? 'panel' : ENV_AT_START[f.key] ? 'env' : 'default';
      const value = process.env[f.key] ?? '';
      return {
        key: f.key, label: f.label, type: f.type, help: f.help ?? null, placeholder: f.placeholder ?? null,
        default: f.default ?? null, restart: Boolean(f.restart), min: f.min ?? null, max: f.max ?? null,
        source,
        ...(f.type === 'secret' ? { isSet: Boolean(value) } : { value }),
      };
    }),
  }));
}

// changes: { KEY: 'value' | null }；null 或空字符串表示清除（恢复为环境变量或默认值）
export function saveSettings(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new HttpError(400, '参数格式错误');
  const entries = Object.entries(changes);
  for (const [k] of entries) if (!FIELDS.has(k)) throw new HttpError(400, `未知设置项：${k}`);
  const normalized = entries.map(([k, v]) => [k, v == null || String(v).trim() === '' ? null : validate(FIELDS.get(k), v)]);
  for (const [k, v] of normalized) {
    if (v == null) {
      sql('DELETE FROM settings WHERE key = ?').run(k);
      if (ENV_AT_START[k] != null) process.env[k] = ENV_AT_START[k];
      else delete process.env[k];
    } else {
      sql(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(k, v);
      process.env[k] = v;
    }
  }
  return normalized.map(([k]) => k);
}

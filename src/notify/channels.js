import { createHmac } from 'node:crypto';
import { HttpError } from '../lib/http.js';
import { assertPublicUrl, safePostJson } from '../lib/netguard.js';
import { config } from '../config.js';
import { sendMail } from './smtp.js';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

function str(v, name, { required = true, max = 500, pattern } = {}) {
  if (v == null || v === '') {
    if (required) throw new HttpError(400, `请填写${name}`);
    return undefined;
  }
  if (typeof v !== 'string' || v.length > max || (pattern && !pattern.test(v))) throw new HttpError(400, `${name}格式不正确`);
  return v.trim();
}

function hostIn(url, name, hosts) {
  let u;
  try { u = new URL(url); } catch { throw new HttpError(400, `${name}不是合法链接`); }
  if (u.protocol !== 'https:' || !hosts.includes(u.hostname)) throw new HttpError(400, `${name}必须是 ${hosts[0]} 的 https 地址`);
  return u.toString();
}

async function post(url, body, { form = false } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  return json;
}

const plain = (m) => [m.title, '', m.text, m.url ? `\n${m.url}` : ''].join('\n').trim();

// 每种渠道：fields 用于前端表单；validate 返回规范化配置；send 发送消息
// 消息结构 m = { title, text (Markdown), url? }
export const channelTypes = {
  serverchan: {
    title: 'Server酱（微信）',
    fields: [{ name: 'sendkey', label: 'SendKey', placeholder: 'SCT... 或 sctp...' }],
    validate: (c) => ({ sendkey: str(c.sendkey, 'SendKey', { max: 100, pattern: /^[A-Za-z0-9_-]+$/ }) }),
    async send({ sendkey }, m) {
      const turbo = sendkey.match(/^sctp(\d+)t/i);
      const url = turbo ? `https://${turbo[1]}.push.ft07.com/send/${sendkey}.send` : `https://sctapi.ftqq.com/${sendkey}.send`;
      const r = await post(url, { title: m.title.slice(0, 32), desp: m.text + (m.url ? `\n\n[查看详情](${m.url})` : '') }, { form: true });
      if (r?.code !== 0) throw new Error(r?.message || 'Server酱返回错误');
    },
  },
  bark: {
    title: 'Bark（iOS）',
    fields: [
      { name: 'key', label: '设备 Key' },
      { name: 'server', label: '服务器（可选）', placeholder: 'https://api.day.app', required: false },
    ],
    async validate(c) {
      const server = (str(c.server, '服务器', { required: false, max: 200 }) || 'https://api.day.app').replace(/\/+$/, '');
      await assertPublicUrl(server);
      return { key: str(c.key, '设备 Key', { max: 100, pattern: /^[A-Za-z0-9_-]+$/ }), server };
    },
    async send({ key, server }, m) {
      const r = await safePostJson(`${server}/${key}`, { title: m.title, body: m.text.replace(/[*_`#>]/g, ''), url: m.url, group: 'API Hub' });
      if (r?.code !== 200) throw new Error(r?.message || 'Bark 返回错误');
    },
  },
  telegram: {
    title: 'Telegram',
    fields: [
      { name: 'botToken', label: 'Bot Token', placeholder: '123456:ABC-DEF...' },
      { name: 'chatId', label: 'Chat ID' },
    ],
    validate: (c) => ({
      botToken: str(c.botToken, 'Bot Token', { max: 100, pattern: /^\d+:[A-Za-z0-9_-]+$/ }),
      chatId: str(c.chatId, 'Chat ID', { max: 50, pattern: /^(-?\d+|@[A-Za-z0-9_]{4,})$/ }),
    }),
    async send({ botToken, chatId }, m) {
      const r = await post(`https://api.telegram.org/bot${botToken}/sendMessage`, { chat_id: chatId, text: plain(m) });
      if (!r?.ok) throw new Error(r?.description || 'Telegram 返回错误');
    },
  },
  dingtalk: {
    title: '钉钉机器人',
    fields: [
      { name: 'webhook', label: 'Webhook 地址', placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=...' },
      { name: 'secret', label: '加签密钥（可选）', placeholder: 'SEC...', required: false },
    ],
    validate: (c) => ({
      webhook: hostIn(str(c.webhook, 'Webhook 地址'), 'Webhook 地址', ['oapi.dingtalk.com']),
      secret: str(c.secret, '加签密钥', { required: false, max: 100 }),
    }),
    async send({ webhook, secret }, m) {
      let url = webhook;
      if (secret) {
        const ts = Date.now();
        const sign = createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64');
        url += `&timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
      }
      const text = `### ${m.title}\n\n${m.text}${m.url ? `\n\n[查看详情](${m.url})` : ''}`;
      const r = await post(url, { msgtype: 'markdown', markdown: { title: m.title, text } });
      if (r?.errcode !== 0) throw new Error(r?.errmsg || '钉钉返回错误');
    },
  },
  feishu: {
    title: '飞书机器人',
    fields: [
      { name: 'webhook', label: 'Webhook 地址', placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/...' },
      { name: 'secret', label: '签名密钥（可选）', required: false },
    ],
    validate: (c) => ({
      webhook: hostIn(str(c.webhook, 'Webhook 地址'), 'Webhook 地址', ['open.feishu.cn', 'open.larksuite.com']),
      secret: str(c.secret, '签名密钥', { required: false, max: 100 }),
    }),
    async send({ webhook, secret }, m) {
      const body = { msg_type: 'text', content: { text: plain(m) } };
      if (secret) {
        const ts = Math.floor(Date.now() / 1000);
        body.timestamp = String(ts);
        body.sign = createHmac('sha256', `${ts}\n${secret}`).update('').digest('base64');
      }
      const r = await post(webhook, body);
      if ((r?.code ?? r?.StatusCode) !== 0) throw new Error(r?.msg || '飞书返回错误');
    },
  },
  wecom: {
    title: '企业微信机器人',
    fields: [{ name: 'webhook', label: 'Webhook 地址', placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...' }],
    validate: (c) => ({ webhook: hostIn(str(c.webhook, 'Webhook 地址'), 'Webhook 地址', ['qyapi.weixin.qq.com']) }),
    async send({ webhook }, m) {
      const content = `**${m.title}**\n${m.text}${m.url ? `\n[查看详情](${m.url})` : ''}`;
      const r = await post(webhook, { msgtype: 'markdown', markdown: { content } });
      if (r?.errcode !== 0) throw new Error(r?.errmsg || '企业微信返回错误');
    },
  },
  webhook: {
    title: '自定义 Webhook',
    fields: [{ name: 'url', label: 'POST 地址', placeholder: 'https://example.com/hook' }],
    async validate(c) {
      const url = str(c.url, 'POST 地址', { max: 500 });
      await assertPublicUrl(url);
      return { url };
    },
    async send({ url }, m) {
      await safePostJson(url, { title: m.title, text: m.text, url: m.url ?? null, topic: m.topic, sentAt: new Date().toISOString() });
    },
  },
  email: {
    title: '邮件',
    fields: [{ name: 'to', label: '收件邮箱' }],
    get available() { return Boolean(config.smtp.host); },
    validate(c) {
      if (!config.smtp.host) throw new HttpError(400, '服务端未配置 SMTP，暂不支持邮件推送');
      return { to: str(c.to, '收件邮箱', { max: 254, pattern: EMAIL_RE }) };
    },
    send: ({ to }, m) => sendMail({ ...config.smtp, to, subject: m.title, text: plain(m) }),
  },
};

export function channelCatalog() {
  return Object.entries(channelTypes).map(([id, t]) => ({
    id, title: t.title, available: t.available ?? true,
    fields: t.fields.map((f) => ({ required: true, ...f })),
  }));
}

export async function validateChannel(type, cfg) {
  const t = channelTypes[type];
  if (!t) throw new HttpError(400, '不支持的推送渠道');
  return t.validate(cfg && typeof cfg === 'object' ? cfg : {});
}

export async function sendToChannel(channel, message) {
  const t = channelTypes[channel.type];
  await t.send(JSON.parse(channel.config), message);
}

// 前端展示用：隐藏密钥类字段。URL 保留域名与路径，只遮住查询参数和 Bot Token 等敏感部分。
const maskStr = (v) => (v.length > 10 ? `${v.slice(0, 4)}…${v.slice(-4)}` : '••••');
export function maskConfig(type, cfg) {
  const out = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (v == null) continue;
    if (/^https?:\/\//.test(v)) {
      const u = new URL(v);
      for (const [qk, qv] of u.searchParams) u.searchParams.set(qk, maskStr(qv));
      const path = type === 'feishu' ? u.pathname.replace(/[^/]+$/, (t) => maskStr(t)) : u.pathname;
      out[k] = decodeURIComponent(`${u.origin}${path}${u.search}`);
    } else {
      out[k] = /key|token|secret|sendkey/i.test(k) ? maskStr(v) : v;
    }
  }
  return out;
}

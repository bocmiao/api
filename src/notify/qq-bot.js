import { createHash } from 'node:crypto';
import { HttpError } from '../lib/http.js';
import { encryptionAvailable } from './secrets.js';

const API = 'https://api.bot.qq.com';
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const tokens = new Map();
const targetPattern = /^[A-Za-z0-9_-]{16,128}$/;
const failCode = (value) => Number.isInteger(value) && value >= 0 && value <= 99999999 ? value : 'unknown';

async function call(url, body, token) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `QQBot ${token}` } : {}) }, body: JSON.stringify(body) });
  } catch { throw new HttpError(502, 'QQ 机器人平台连接失败或超时'); }
  let result;
  try { result = await res.json(); } catch { throw new HttpError(502, 'QQ 机器人平台返回无效响应'); }
  if (res.status === 429) throw new HttpError(503, 'QQ 机器人平台限流，请稍后重试');
  if (!res.ok || (Number.isInteger(result?.err_code) && result.err_code !== 0) || (Number.isInteger(result?.code) && result.code !== 0))
    throw new HttpError(502, `QQ 机器人平台拒绝请求（HTTP ${res.status}，错误码 ${failCode(result?.err_code ?? result?.code)}）；请检查目标关系与权限`);
  return result;
}

export function validateQqBot(c) {
  const appId = c?.appId;
  const clientSecret = c?.clientSecret;
  const targetType = c?.targetType;
  const targetOpenid = c?.targetOpenid;
  if (typeof appId !== 'string' || !/^\d{5,20}$/.test(appId)) throw new HttpError(400, 'AppID 格式不正确');
  if (typeof clientSecret !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(clientSecret)) throw new HttpError(400, 'ClientSecret 格式不正确');
  if (!['user', 'group'].includes(targetType)) throw new HttpError(400, '目标类型只能是 user / group');
  if (typeof targetOpenid !== 'string' || !targetPattern.test(targetOpenid)) throw new HttpError(400, '目标 OpenID 格式不正确，不能填普通 QQ 号或群号');
  return { appId, clientSecret, targetType, targetOpenid };
}

async function accessToken({ appId, clientSecret }) {
  const cacheKey = createHash('sha256').update(`${appId}:${clientSecret}`).digest('hex');
  const hit = tokens.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.token;
  const data = await call(TOKEN_URL, { appId, clientSecret });
  if (typeof data?.access_token !== 'string' || !data.access_token || !Number.isFinite(Number(data.expires_in)))
    throw new HttpError(503, 'QQ 机器人凭据未获授权或资格未开通');
  tokens.set(cacheKey, { token: data.access_token, expires: Date.now() + Math.max(0, Number(data.expires_in) - 120) * 1000 });
  return data.access_token;
}

export const qqBotChannel = {
  title: 'QQ 官方机器人',
  get available() { return encryptionAvailable(); },
  fields: [
    { name: 'appId', label: '官方机器人 AppID' },
    { name: 'clientSecret', label: 'ClientSecret' },
    { name: 'targetType', label: '目标类型 user / group' },
    { name: 'targetOpenid', label: '已与机器人建立关系的目标 OpenID' },
  ],
  validate: validateQqBot,
  async send(cfg, m) {
    const token = await accessToken(cfg);
    const target = cfg.targetType === 'group' ? 'groups' : 'users';
    const content = [m.title, m.text, m.url].filter(Boolean).join('\n').slice(0, 1500);
    await call(`${API}/v2/${target}/${cfg.targetOpenid}/messages`, { msg_type: 0, content }, token);
  },
};

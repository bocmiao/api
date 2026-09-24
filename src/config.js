// 未显式设置时区时默认北京时间：不带时区的日期字符串一律按北京时间理解
process.env.TZ ||= 'Asia/Shanghai';

// 配置一律在读取时从 process.env 取值：后台「系统设置」保存后写入 process.env，即时生效
const int = (name, def) => {
  const v = process.env[name];
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) ? n : def;
};
const env = (name) => process.env[name] || undefined;
const bool = (name, def) => {
  const v = process.env[name];
  if (v == null || v === '') return def;
  return v === '1' || v === 'true';
};

export const config = {
  get port() { return int('PORT', 3000); },
  get publicUrl() { return (process.env.PUBLIC_URL || '').replace(/\/+$/, ''); },
  // 部署在 Nginx / CDN 后面时设为 1，才会从 X-Forwarded-For 读取真实 IP
  get trustProxy() { return bool('TRUST_PROXY', false); },
  get registrationOpen() { return bool('REGISTRATION_OPEN', true); },
  get adminEmails() { return (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean); },

  limits: {
    get anonDaily() { return int('ANON_DAILY_LIMIT', 100); },
    get anonMinute() { return int('ANON_MINUTE_LIMIT', 20); },
    get userDaily() { return int('USER_DAILY_LIMIT', 10000); },
    get userMinute() { return int('USER_MINUTE_LIMIT', 120); },
    get maxKeys() { return int('MAX_KEYS_PER_USER', 10); },
    get maxChannels() { return int('MAX_CHANNELS_PER_USER', 10); },
  },

  // 配置了 SMTP 时默认开启注册邮箱验证；EMAIL_VERIFY=0 可关闭
  get emailVerify() {
    return Boolean(this.smtp.host) && bool('EMAIL_VERIFY', true);
  },
  emailCode: {
    get ttlMin() { return int('EMAIL_CODE_TTL_MIN', 10); },
    get cooldownSec() { return int('EMAIL_CODE_COOLDOWN_SEC', 60); },
    get perEmailDaily() { return int('EMAIL_CODE_PER_EMAIL_DAILY', 10); },
    get perIpDaily() { return int('EMAIL_CODE_PER_IP_DAILY', 20); },
  },

  get logRetentionDays() { return int('LOG_RETENTION_DAYS', 30); },
  get notifyIntervalMin() { return int('NOTIFY_INTERVAL_MIN', 15); },

  smtp: {
    get host() { return env('SMTP_HOST'); },
    get port() { return int('SMTP_PORT', 465); },
    get user() { return env('SMTP_USER'); },
    get pass() { return env('SMTP_PASS'); },
    get from() { return env('SMTP_FROM') || env('SMTP_USER'); },
  },
};

// 未显式设置时区时默认北京时间：不带时区的日期字符串一律按北京时间理解
process.env.TZ ||= 'Asia/Shanghai';

const int = (name, def) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && process.env[name] !== '' && process.env[name] != null ? n : def;
};

export const config = {
  port: int('PORT', 3000),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  // 部署在 Nginx / CDN 后面时设为 1，才会从 X-Forwarded-For 读取真实 IP
  trustProxy: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
  registrationOpen: process.env.REGISTRATION_OPEN !== '0',
  adminEmails: (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),

  limits: {
    anonDaily: int('ANON_DAILY_LIMIT', 100),
    anonMinute: int('ANON_MINUTE_LIMIT', 20),
    userDaily: int('USER_DAILY_LIMIT', 10000),
    userMinute: int('USER_MINUTE_LIMIT', 120),
    maxKeys: int('MAX_KEYS_PER_USER', 10),
    maxChannels: int('MAX_CHANNELS_PER_USER', 10),
  },

  logRetentionDays: int('LOG_RETENTION_DAYS', 30),
  notifyIntervalMin: int('NOTIFY_INTERVAL_MIN', 15),

  smtp: {
    host: process.env.SMTP_HOST,
    port: int('SMTP_PORT', 465),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
  },
};

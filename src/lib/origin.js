// 站点地址（单独成文件，接口模块引用它时不会和 seo.js 形成循环依赖）
import { config } from '../config.js';

// 站点地址：优先用后台配置的 PUBLIC_URL，否则按请求头推断（只接受合法的主机名，防止注入）
export function siteOrigin(req) {
  if (config.publicUrl) return config.publicUrl;
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || 'localhost').split(',')[0].trim();
  const proto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ? 'https' : 'http';
  return /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? `${proto}://${host}` : 'http://localhost';
}

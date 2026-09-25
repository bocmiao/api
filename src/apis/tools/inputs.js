// tools 分类内共用的小工具（不是接口模块，index.js 不注册它）
import { HttpError } from '../../lib/http.js';

// 把 POST 的 JSON 请求体转成与 URLSearchParams 相同接口的对象，便于统一用 param() 读取和校验。
// 只接受 JSON 对象；字符串原样使用，数字 / 布尔值转成字符串，null 视为没传，其他类型报 400。
export function bodyParams(body) {
  const out = new URLSearchParams();
  if (body == null) return out;
  if (typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '请求体须为 JSON 对象');
  for (const [k, v] of Object.entries(body)) {
    if (v == null) continue;
    if (typeof v === 'string') out.set(k, v);
    else if (typeof v === 'number' || typeof v === 'boolean') out.set(k, String(v));
    else throw new HttpError(400, `${k} 须为字符串`);
  }
  return out;
}

// GET 读查询参数，POST 读 JSON 请求体
export const inputOf = (method, { query, body }) => (method === 'POST' ? bodyParams(body) : (query ?? new URLSearchParams()));

// 同一个接口同时提供 GET 与 POST：POST 的参数写在 JSON 请求体里（in: 'body'），其余定义相同
export function getAndPost(route, handler) {
  return ['GET', 'POST'].map((method) => ({
    ...route,
    method,
    summary: method === 'POST' ? `${route.summary}（POST JSON 请求体，参数不进网址）` : route.summary,
    params: route.params.map((p) => (method === 'POST' ? { ...p, in: 'body' } : p)),
    handler: (ctx) => handler(inputOf(method, ctx), ctx, method),
  }));
}

// 统一的布尔参数：1 / true 为真
export const truthy = (v) => v === '1' || v === 'true';

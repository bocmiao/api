// 校验接口返回字段是否都有说明。
// 路径写法：对象属性用 a.b，数组元素用 items[].title，data 本身是数组时用 [].title，
// 键名不固定的对象（如汇率表）用 rates.* 表示任意键。
import assert from 'node:assert/strict';

export function collectPaths(value, prefix = '', out = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, `${prefix}[]`, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.add(p);
      collectPaths(v, p, out);
    }
  }
  return out;
}

// 把文档里的 rates.* 这类通配写法转成正则
export function matcher(name) {
  const re = name.split('*').map((s) => s.replace(/[.[\]]/g, '\\$&')).join('[^.\\[\\]]+');
  return new RegExp(`^${re}$`);
}

export function undocumented(fields, data) {
  const patterns = fields.map((f) => matcher(f.name));
  return [...collectPaths(data)].filter((p) => !patterns.some((re) => re.test(p)));
}

// route：模块里的路由定义；data：该路由 handler 返回的 data
export function assertFieldsDocumented(route, data) {
  assert.ok(Array.isArray(route.fields) && route.fields.length, `${route.path} 缺少 fields 字段说明`);
  const missing = undocumented(route.fields, data);
  assert.deepEqual(missing, [], `${route.path} 返回了未说明的字段：${missing.join(', ')}`);
}

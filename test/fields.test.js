import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modules } from '../src/apis/index.js';
import { matcher } from './helpers/fields.js';

const TYPES = /^(string|number|boolean|object|array|null)(\|(string|number|boolean|object|array|null))*$/;

for (const m of modules) {
  for (const r of m.routes) {
    test(`${r.method} ${r.path} 有返回说明`, () => {
      if (r.raw) {
        assert.ok(typeof r.returns === 'string' && r.returns.length > 0, 'raw 路由需要 returns 说明返回内容');
        return;
      }
      assert.ok(Array.isArray(r.fields) && r.fields.length > 0, '缺少 fields');
      const seen = new Set();
      for (const f of r.fields) {
        assert.ok(f.name && !seen.has(f.name), `字段名为空或重复：${f.name}`);
        seen.add(f.name);
        assert.match(f.type ?? '', TYPES, `${f.name} 的 type 不合法：${f.type}`);
        assert.ok(f.desc && f.desc.trim(), `${f.name} 缺少 desc`);
        // 嵌套字段的父级也要有说明
        const parent = f.name.replace(/(\[\])?\.[^.]+$|\[\]$/, '');
        if (parent !== f.name && parent) {
          assert.ok(r.fields.some((x) => matcher(x.name).test(parent)), `${f.name} 的父级 ${parent} 没有说明`);
        }
      }
    });
  }
}

# API 模块约定

每个分类一个目录（games / hot / life / finance / fun / tools），目录下 `index.js` 默认导出模块数组。

## 模块

```js
import { cache } from '../../lib/cache.js';
import { fetchJSON, fetchText, HttpError, param, requireEnv, stripTags, decodeEntities } from '../../lib/http.js';

export default {
  name: 'weather',                // 唯一 id，小写，可含 -
  category: 'life',               // 与所在目录一致
  title: '天气预报',                // 中文名，显示在 UI
  description: '一句话描述',
  source: 'Open-Meteo',           // 数据来源，显示在 UI
  env: ['KUAIDI100_KEY'],         // 必需的环境变量（缺失时 UI 显示"需配置"）
  // 可选的写成对象：env: [{ name: 'QWEATHER_KEY', optional: true }]
  // isAvailable: () => boolean,  // 可选：自定义"是否可用"判断（如多个密钥任选其一）
  unofficial: true,               // 可选：抓取非官方接口/网页，可能随上游改版失效
  routes: [
    {
      method: 'GET',
      path: '/api/weather',       // 统一 /api/ 前缀，支持 :param 路径参数
      summary: '查询实时天气与 7 天预报',
      params: [
        { name: 'city', required: false, default: '北京', desc: '城市名', example: '上海' },
      ],
      async handler({ query, params, ip }) {
        const city = param(query, 'city', { default: '北京', max: 20 });
        // 返回 { data, cached?, stale?, updatedAt? }。cache.wrap 返回的正是这个结构。
        return cache.wrap(`weather:${city}`, 10 * 60_000, () => loadWeather(city));
      },
    },
  ],
};
```

- 返回值会包成 `{ code: 200, message: 'ok', cached, stale, updatedAt, data }`。直接返回 `{ data }` 也可以。
- 抛 `new HttpError(status, '中文说明')` 返回对应错误。上游请求失败由 `fetchJSON`/`fetchText` 自动转为 502/504。
- 非 JSON 响应（图片、SVG、重定向）：路由加 `raw: true`，handler 返回 `{ status, headers, body }`。
- 解析逻辑写成导出的纯函数（如 `parseXxx(raw)`），在 `test/apis/<分类>.test.js` 里用 `test/fixtures/<分类>/` 下的样例数据测试。
- 需要持久化时可 `import { sql } from '../../db.js'`（SQLite，`sql('SELECT ...').get(...)`）。
- 不引入 npm 依赖。

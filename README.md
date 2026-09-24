# API Hub

聚合 API 平台：统一入口、统一响应格式、内置缓存、支持跨域，按模块扩展新接口。零依赖，只需 Node.js 18+。

## 快速开始

```bash
npm start            # 默认端口 3000，可用 PORT 环境变量修改
npm run dev          # 修改代码自动重启
npm test
```

打开 http://localhost:3000 可以看到接口列表和 Epic 本周免费游戏预览。

Docker：

```bash
docker build -t api-hub . && docker run -p 3000:3000 api-hub
```

## 响应格式

所有接口都返回：

```json
{ "code": 200, "message": "ok", "cached": false, "stale": false, "updatedAt": "2026-09-24T12:00:00.000Z", "data": {} }
```

- `cached`：是否命中缓存
- `stale`：上游暂时不可用时返回的是旧缓存
- 出错时 `code` 为 HTTP 状态码（400 参数错误 / 404 接口不存在 / 502 上游错误 / 504 上游超时），`data` 为 `null`

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api` | 列出全部接口 |
| GET | `/health` | 健康检查 |
| GET | `/api/epic/free` | Epic 每周免费游戏 |

### Epic 每周免费游戏 `GET /api/epic/free`

参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `locale` | `zh-CN` | 语言，如 `en-US` |
| `country` | `CN` | 地区，如 `US` |

示例：

```bash
curl "http://localhost:3000/api/epic/free?locale=zh-CN&country=CN"
```

```json
{
  "code": 200,
  "message": "ok",
  "cached": false,
  "stale": false,
  "updatedAt": "2026-09-24T12:00:00.000Z",
  "data": {
    "current": [
      {
        "id": "…",
        "namespace": "…",
        "title": "游戏名",
        "description": "…",
        "seller": "发行商",
        "originalPrice": "¥88.00",
        "startDate": "2026-09-17T15:00:00.000Z",
        "endDate": "2026-09-24T15:00:00.000Z",
        "url": "https://store.epicgames.com/zh-CN/p/xxx",
        "image": { "wide": "https://…", "tall": "https://…" }
      }
    ],
    "upcoming": []
  }
}
```

- `current`：正在免费领取的游戏；`upcoming`：即将免费的游戏
- 只收录折后价为 0 的促销，普通打折不计入
- 上游数据缓存 10 分钟；是否"正在免费"按请求时刻判断，所以周四切换时不会因为缓存而显示错误

## 添加新接口

1. 在 `src/apis/` 下新建模块，例如 `weather.js`：

   ```js
   import { cache } from '../lib/cache.js';
   import { fetchJSON, HttpError } from '../lib/http.js';

   export default {
     name: 'weather',
     title: '天气',
     routes: [
       {
         method: 'GET',
         path: '/api/weather',
         summary: '查询天气',
         params: [{ name: 'city', default: '北京', desc: '城市' }],
         async handler({ query }) {
           const city = query.get('city') || '北京';
           // 返回 { data, cached, updatedAt }；用 cache.wrap 自动获得缓存、并发合并和失败兜底
           return cache.wrap(`weather:${city}`, 5 * 60_000, () => fetchJSON(`https://…?city=${encodeURIComponent(city)}`));
         },
       },
     ],
   };
   ```

2. 在 `src/apis/index.js` 中注册：`export const modules = [epic, weather];`

新接口会自动出现在 `/api` 和首页的接口列表中。抛出 `new HttpError(400, '说明')` 即可返回对应错误码。

## 目录结构

```
src/
  server.js       启动入口
  app.js          路由、统一响应、错误处理、CORS
  lib/cache.js    TTL 缓存（并发合并、失败时返回旧数据）
  lib/http.js     带超时的 fetch
  apis/index.js   接口模块注册
  apis/epic.js    Epic 每周免费游戏
public/index.html 首页（接口文档 + Epic 免费游戏预览）
test/             测试
```

# 市场层

v0.15 增加了一组面向访客的独立页面，复用原有接口注册表与统计表，不引入构建步骤或新依赖。

## 页面

| 路径 | 文件 | 数据来源 |
| --- | --- | --- |
| `/square` 接口广场 | `public/market.html` + `public/market.js` | `/api`（目录）、`/stats/modules`（调用量/状态）、`/site/overview`（总量） |
| `/tools` 工具箱 | 同上 | 纯浏览器计算，不上传输入 |
| `/ranking` 排行 | 同上 | `/site/overview`、`/stats/modules` |
| `/packages` 套餐 | 同上 | `/api` 的 `limits` 配置 |
| `/nav` 导航 | 同上 | `/site/links` 已审核友链 |

服务端在 `src/app.js` 中把上述路径映射到 `public/market.html`，并用 `renderPage()` 注入标题、描述、canonical 和静态正文；`public/market.js` 按 `location.pathname` 渲染页面，拦截市场内部链接做无刷新切换，其余链接走整页加载。

## 接口

新增 `src/routes/market.js`，挂在 `accountRouter` 上：

- `GET /site/favorites`：当前用户收藏的接口列表（需登录）。
- `POST /site/favorites/:name`：切换收藏（需登录）。
- `POST /site/reports`：提交异常反馈，字段 `module`、`path`、`description`（5–500 字）、`contact`；每用户每天最多 5 条。
- `GET /admin/reports?status=open|closed`：管理员查看反馈。
- `PATCH /admin/reports/:id`：管理员标记 `open` / `closed`，写审计日志。

## 数据表

启动时由 `src/db.js` 自动创建：

- `api_favorites(user_id, module, created_at)`，主键 `(user_id, module)`。
- `api_reports(id, module, path, description, contact, user_id, status, created_at, handled_at)`。

## 工具

工具箱在 `public/market.js` 内以原生 JS + Web Crypto 实现，不依赖 CDN：

JSON 格式化/压缩/校验、Base64、URL 编解码、HTML 转义、JWT 解码、SHA-256、SHA-1、MD5、时间戳、UUID、正则测试、随机密码、文本统计、颜色转换、进制转换、大小写转换。

## 测试

`test/market.test.js` 覆盖：

- 五个市场页面返回 HTML 且标题正确；
- `market.js` / `market.css` 可访问；
- sitemap 包含市场页面；
- `/api` 仍返回 JSON；
- 收藏需要登录并可切换；
- 异常反馈的模块/长度校验、用户频率限制、管理员列表。

# API Hub

聚合 API 平台：一个 Key 调用 46 个模块、67 个常用接口，包括游戏限免、全网热榜、天气节假日、金融行情、壁纸诗词和开发工具。

- **统一格式**：所有接口返回 `{ code, message, data }`，支持跨域调用
- **缓存与容错**：按接口特性缓存；上游故障时返回最近一次成功的数据
- **账号体系**：注册登录，生成多个 API Key，查看用量统计
- **分级额度**：未登录按 IP 每天免费调用 100 次；注册用户每天 10000 次，均可配置
- **订阅推送**：Epic 周免、游戏限免、每日壁纸等内容更新时，推送到 Server酱（微信）、Bark、Telegram、钉钉、飞书、企业微信、自定义 Webhook 或邮件
- **管理后台**：全站调用统计，可调整用户额度、停用用户
- **零依赖**：只需 Node.js 22.13+，不用 `npm install`，数据存在内置 SQLite

## 快速开始

```bash
npm start                  # http://localhost:3000
npm test
```

打开首页即可浏览接口、在线调试。**第一个注册的账号自动成为管理员**，部署后请先注册自己的账号。

Docker：

```bash
docker build -t api-hub .
docker run -d -p 3000:3000 -v api-hub-data:/app/data --env-file .env api-hub
```

## 配置

复制 `.env.example` 为 `.env` 后按需修改（Docker 用 `--env-file`，直接运行可用 `node --env-file=.env src/server.js`）。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 3000 | 监听端口 |
| `PUBLIC_URL` | | 站点公网地址，如 `https://api.example.com`，用于短链与 Cookie 的 Secure 标记 |
| `TRUST_PROXY` | 0 | 部署在 Nginx / CDN 后设为 1，从 `X-Forwarded-For` 读取真实 IP（否则所有人共享一个 IP 的额度） |
| `DATA_DIR` | `./data` | SQLite 数据目录 |
| `ANON_DAILY_LIMIT` / `ANON_MINUTE_LIMIT` | 100 / 20 | 未登录用户（按 IP）每天 / 每分钟额度 |
| `USER_DAILY_LIMIT` / `USER_MINUTE_LIMIT` | 10000 / 120 | 注册用户每天 / 每分钟额度（管理员可给单个用户单独设置） |
| `MAX_KEYS_PER_USER` / `MAX_CHANNELS_PER_USER` | 10 / 10 | 每个账号的 Key、推送渠道数量上限 |
| `REGISTRATION_OPEN` | 1 | 设为 0 关闭注册 |
| `ADMIN_EMAILS` | | 额外的管理员邮箱，逗号分隔 |
| `LOG_RETENTION_DAYS` | 30 | 调用日志保留天数 |
| `NOTIFY_INTERVAL_MIN` | 15 | 推送主题检查间隔（分钟） |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | | 配置后开放邮件推送（465 端口用 TLS，587 用 STARTTLS） |

第三方密钥（都可以不配，对应接口会显示「需配置」或降级）：

| 变量 | 用于 |
| --- | --- |
| `KUAIDI100_KEY` + `KUAIDI100_CUSTOMER` | 快递查询（必需） |
| `DEEPL_API_KEY` / `BAIDU_TRANSLATE_APPID` + `BAIDU_TRANSLATE_KEY` / `YOUDAO_APP_KEY` + `YOUDAO_APP_SECRET` | 翻译（任选其一） |
| `QWEATHER_KEY`（+ `QWEATHER_HOST`） | 天气切换到和风天气（默认用免 Key 的 Open-Meteo） |
| `ITAD_API_KEY` | Steam 游戏详情附带史低价 |
| `COINGECKO_API_KEY` | 提高 CoinGecko 限额 |

## 调用方式

```bash
# 免登录
curl http://localhost:3000/api/epic/free

# 使用 API Key（也可用 Authorization: Bearer 或 ?key=）
curl http://localhost:3000/api/epic/free -H "X-API-Key: ak_xxx"
```

```json
{ "code": 200, "message": "ok", "cached": true, "updatedAt": "2026-09-24T12:00:00.000Z", "data": {} }
```

- 响应头 `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset` 返回额度信息，额度于北京时间 0 点重置。
- 错误码：400 参数错误，401 Key 无效，404 不存在，429 超额，502 上游错误，503 未配置密钥，504 上游超时。
- `GET /api` 返回全部接口的机器可读目录（参数、说明、是否可用）。

## 接口列表

⚠️ 非官方接口或网页抓取，可能随上游改版失效 · 🔑 需要配置密钥 · 🔓 可选配置密钥增强功能

### 游戏

| 接口 | 路径 | 说明 |
| --- | --- | --- |
| 游戏限免汇总 ⚠️ | `/api/games/free` | 汇总各平台当前限免游戏（某个平台失败时返回其余平台数据，并在 errors 中说明） |
| Epic 每周免费游戏 ⚠️ | `/api/epic/free` | 获取 Epic 当前免费领取与即将免费的游戏 |
| Steam 限免与特惠 ⚠️ | `/api/steam/free` | 获取 Steam 当前限时免费（100% 折扣，可永久入库）的游戏 |
|  | `/api/steam/specials` | 获取 Steam 首页精选特惠（折扣、原价/现价、截止时间） |
| GOG 限免 ⚠️ | `/api/gog/free` | 获取 GOG 当前限时免费的游戏 |
| PS Plus 每月会免 ⚠️ | `/api/psplus/monthly` | 获取最新一期 PS Plus 每月会免游戏，history 为 RSS 中更早的几期 |
| Xbox Game Pass ⚠️ | `/api/gamepass` | 获取 Game Pass 游戏列表：最近加入、即将离开、即将加入、最受欢迎 |
| Steam 游戏查询 ⚠️ 🔓 | `/api/steam/app` | 查询 Steam 游戏详情与当前价格（配置 ITAD_API_KEY 时附带史低价） |
|  | `/api/steam/search` | 按关键词搜索 Steam 商店 |
|  | `/api/steam/players` | 查询 Steam 游戏当前在线人数 |

### 热榜

| 接口 | 路径 | 说明 |
| --- | --- | --- |
| 微博热搜 ⚠️ | `/api/hot/weibo` | 获取微博热搜 |
| 知乎热榜 ⚠️ | `/api/hot/zhihu` | 获取知乎热榜 |
| B 站热门 ⚠️ | `/api/hot/bilibili` | 获取B 站热门 |
| 抖音热点 ⚠️ | `/api/hot/douyin` | 获取抖音热点 |
| 百度热搜 ⚠️ | `/api/hot/baidu` | 获取百度热搜 |
| 今日头条热榜 ⚠️ | `/api/hot/toutiao` | 获取今日头条热榜 |
| GitHub Trending ⚠️ | `/api/hot/github` | 获取GitHub Trending |
| V2EX 热门 | `/api/hot/v2ex` | 获取V2EX 热门 |
| 科技资讯 | `/api/hot/news` | 获取科技资讯 |
| Hacker News | `/api/hot/hackernews` | 获取Hacker News |
| 热榜合集 ⚠️ | `/api/hot/all` | 聚合多个平台热榜，返回各来源结果与失败信息 |
|  | `/api/hot/sources` | 列出可用的热榜来源 id 与名称 |

### 生活

| 接口 | 路径 | 说明 |
| --- | --- | --- |
| 天气预报 🔓 | `/api/weather` | 查询实时天气与 7 天预报 |
| 节假日与调休 | `/api/holiday` | 查询某天是否放假/上班及节日名 |
|  | `/api/holiday/next` | 下一个法定假期及倒计时天数 |
|  | `/api/holiday/year` | 某年全部放假安排与调休日 |
| 农历黄历 | `/api/lunar` | 查询某天的农历、干支、节气、节日与宜忌 |
| 今日油价 ⚠️ | `/api/oil` | 查询某省今日油价 |
| 快递查询 🔑 | `/api/express` | 查询快递物流轨迹 |
|  | `/api/express/companies` | 常用快递公司编码列表 |
| IP 归属地 | `/api/ip` | 查询 IP 归属地（默认调用者 IP） |
| 手机号归属地 ⚠️ | `/api/phone` | 查询手机号归属地与运营商 |
| 历史上的今天 ⚠️ | `/api/history/today` | 历史上的今天大事记 |
| 60 秒读懂世界 ⚠️ | `/api/news/60s` | 获取每日 60 秒新闻简报 |

### 金融

| 接口 | 路径 | 说明 |
| --- | --- | --- |
| 汇率 | `/api/fx/rates` | 以指定货币为基准的全部汇率 |
|  | `/api/fx/convert` | 货币换算 |
| 股票行情 ⚠️ | `/api/stock/quote` | 批量查询实时行情 |
|  | `/api/stock/search` | 按名称 / 代码 / 拼音搜索股票、指数、基金 |
| 基金估值与净值 ⚠️ | `/api/fund/estimate` | 基金盘中实时估值与涨跌 |
|  | `/api/fund/history` | 基金历史净值（分页） |
| 加密货币行情 🔓 | `/api/crypto/price` | 查询指定币种价格、24h 涨跌、市值 |
|  | `/api/crypto/markets` | 按市值排行的币种列表 |
| 金价银价 ⚠️ | `/api/metals` | 黄金、白银实时价格（国际 + 国内） |

### 娱乐

| 接口 | 路径 | 说明 |
| --- | --- | --- |
| 一言 | `/api/hitokoto` | 随机一言，上游不可用时返回内置句子 |
| 每日诗词 | `/api/poem` | 随机古诗词名句，上游不可用时返回内置诗句 |
| Bing 每日壁纸 | `/api/bing` | 获取 Bing 每日壁纸（最多往前 7 天） |
|  | `/api/bing/image` | 302 跳转到 Bing 壁纸图片，可直接用作 <img> 地址 |
| 随机壁纸 | `/api/wallpaper/random` | 随机返回一张壁纸的信息与地址 |
|  | `/api/wallpaper/random.jpg` | 302 跳转到一张随机壁纸，可直接用作 <img> 地址 |
| 番剧放送表 | `/api/anime/calendar` | 获取每周番剧放送表，可按星期筛选 |
| 豆瓣电影 ⚠️ | `/api/douban/top250` | 豆瓣电影 Top250，每页 25 部 |
|  | `/api/douban/nowplaying` | 指定城市正在热映的电影 |
| 实时票房 ⚠️ | `/api/boxoffice` | 今日全国实时票房排行 |
| 每日一句英语 | `/api/english/daily` | 获取某天的每日一句英语 |

### 工具

| 接口 | 路径 | 说明 |
| --- | --- | --- |
| 二维码生成 | `/api/qrcode` | 生成二维码图片（直接返回 SVG 或 PNG） |
| 短链接 | `POST /api/shorturl` | 生成短链接（相同网址返回同一个短码） |
|  | `/api/shorturl/stats` | 查询短链接的目标网址与访问次数 |
|  | `/s/:code` | 短链接跳转（302 重定向到目标网址） |
| 网页信息 | `/api/webmeta` | 获取网页标题、描述、og:image、favicon 等信息 |
| 域名 Whois | `/api/whois` | 查询域名注册信息 |
| 翻译 🔑 | `/api/translate` | 翻译文本（自动选择已配置的翻译服务） |
| 开发小工具 | `/api/tools/timestamp` | 时间戳与日期互转（自动识别秒/毫秒/日期字符串） |
|  | `/api/tools/uuid` | 批量生成 UUID v4 |
|  | `/api/tools/hash` | 计算文本的 MD5 / SHA1 / SHA256 / SHA512 摘要 |
|  | `/api/tools/base64` | Base64 编码 / 解码（UTF-8） |
|  | `/api/tools/urlencode` | URL 编码 / 解码（encodeURIComponent） |
|  | `/api/tools/password` | 生成加密安全的随机密码 |

## 推送主题

| 主题 | 触发时机 |
| --- | --- |
| Epic 周免上新 | Epic 当前免费游戏变化 |
| 全平台游戏限免 | Epic / Steam / GOG 出现新的免费游戏 |
| PS Plus 每月会免 | 新一期会免公布 |
| Bing 每日壁纸 / 每日一句英语 / 60 秒读懂世界 | 每天内容更新 |
| 放假 / 调休提醒 | 明天放假或调休上班时，前一天 18 点后 |

主题首次检查时只记录当前状态，之后内容变化才推送；控制台里可以「立即推送」当前内容。新增主题在 `src/notify/topics.js` 中添加。

## 目录结构

```
src/
  server.js           启动入口（定时清理日志、启动推送调度）
  app.js              请求分发：静态页面、账号接口、聚合接口、限流与日志
  config.js           环境变量
  db.js               SQLite 表结构
  registry.js         接口注册表与 /api 目录
  lib/                缓存、HTTP 工具、路由、认证、限流、防 SSRF
  routes/account.js   注册登录、API Key、用量、推送配置、管理后台
  notify/             推送渠道、推送主题、调度器、SMTP
  apis/<分类>/        各分类接口模块（约定见 src/apis/README.md）
public/               前端单页应用（无构建步骤）
test/                 测试与样例数据
```

新增接口：在 `src/apis/<分类>/` 下按 [模块约定](src/apis/README.md) 新建文件，并在该分类的 `index.js` 中注册，会自动出现在 `/api`、首页和在线调试中。

## 已知限制

- 开发环境无法访问外网，各上游接口的请求格式和返回结构是按公开资料编写、用样例数据测试的，**部署后需逐个实测**。标记 ⚠️ 的接口最可能需要调整。
- 缓存和每分钟限流在进程内存中，适合单实例部署。
- 管理员可调整单个用户每日额度；按 IP 的匿名额度对同一出口 IP 下的用户共享。

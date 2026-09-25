# Miao API

聚合 API 平台：一个 Key 调用 69 个模块、94 个常用接口，包括游戏限免、全网热榜、天气节假日、金融行情、壁纸诗词、娱乐趣味、开发工具和网络检测。

- **统一格式**：所有接口返回 `{ code, message, data }`，支持跨域调用；每个返回字段都有类型和中文说明
- **缓存与容错**：按接口特性缓存；上游故障时返回最近一次成功的数据
- **账号体系**：注册登录，生成多个 API Key，查看用量统计
- **分级额度**：未登录按 IP 每天免费调用 100 次；注册用户每天 10000 次，均可配置
- **订阅推送**：Epic 周免、游戏限免、每日壁纸等内容更新时，推送到 Server酱（微信）、Bark、Telegram、钉钉、飞书、企业微信、自定义 Webhook 或邮件
- **管理后台**：全站调用统计，调整用户额度、停用用户，按模块开关接口，在线更新
- **零依赖**：只需 Node.js 22.13+，不用 `npm install`，数据存在内置 SQLite

## 快速开始

```bash
npm start                  # http://localhost:3000
npm test
```

打开首页即可浏览接口、在线调试。**第一个注册的账号自动成为管理员**，部署后请先注册自己的账号。

Docker：

```bash
docker build -t miao-api .
docker run -d -p 3000:3000 -v miao-api-data:/app/data --env-file .env miao-api
```

## 配置

**推荐在网站「管理 → 系统设置」里配置**：下表中的大部分项目（额度、邮件、第三方密钥、在线更新等）都可以在后台填写，保存后立即生效，优先级高于环境变量；密钥类只显示「已设置」，不会回显。以下环境变量适合在首次部署时使用。

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
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | | 配置后开启**注册邮箱验证**、**邮箱找回密码**和邮件推送（465 端口用 TLS，587 用 STARTTLS） |
| `EMAIL_VERIFY` | 1 | 配置了 SMTP 时默认要求注册邮箱验证，设为 0 关闭 |
| `EMAIL_CODE_COOLDOWN_SEC` / `EMAIL_CODE_PER_EMAIL_DAILY` / `EMAIL_CODE_PER_IP_DAILY` | 60 / 10 / 20 | 邮箱验证码防刷：同一邮箱发送间隔、每个邮箱每天上限、每个 IP 每天上限 |
| `UPDATE_REPO` / `UPDATE_BRANCH` / `GITHUB_TOKEN` | bocmiao/api / 默认分支 / 空 | 在线更新的来源仓库与分支；私有仓库需要 Token |

第三方密钥（都可以不配，对应接口会显示「需配置」或降级）：

| 变量 | 用于 |
| --- | --- |
| `KUAIDI100_KEY` + `KUAIDI100_CUSTOMER` | 快递查询（必需） |
| `DEEPL_API_KEY` / `BAIDU_TRANSLATE_APPID` + `BAIDU_TRANSLATE_KEY` / `YOUDAO_APP_KEY` + `YOUDAO_APP_SECRET` | 翻译（任选其一） |
| `QWEATHER_KEY`（+ `QWEATHER_HOST`） | 天气切换到和风天气（默认用免 Key 的 Open-Meteo） |
| `ITAD_API_KEY` | Steam 游戏详情附带史低价 |
| `COINGECKO_API_KEY` | 提高 CoinGecko 限额 |
| `LLM_API_KEY`（+ `LLM_BASE_URL` / `LLM_MODEL`） | AI 分类接口，兼容 OpenAI 格式的任意服务，默认 DeepSeek（`https://api.deepseek.com/v1`、`deepseek-chat`）；`AI_DAILY_LIMIT`（默认 20）为每个账号每天可用次数 |

## 接口开关

管理后台的「接口开关」可以按模块关闭接口：关闭后所有人（包括管理员）调用都返回 403「该接口已被管理员关闭」（已生成的短链接也会停止跳转），普通用户在首页和 `/api` 目录中看不到；管理员仍能看到并带有「已关闭」标记。依赖该接口的推送主题会暂停推送。开关状态保存在数据库中，重启和在线更新后保持不变。

## 在线更新

管理后台的「系统更新」可以检查 GitHub 上的新提交，并一键下载更新：

- 下载指定仓库分支的最新代码，先在独立进程里完整加载一遍，确认无误后才替换。
- `data/` 目录和 `.env` 不会被改动；旧代码自动备份（保留最近 3 份，位于 `.update-backup/`）。
- 服务需要通过 `npm start`（守护进程 `src/launcher.js`）启动。更新后守护进程自动重启服务；新版本在 20 秒内崩溃会自动回滚到旧版本。
- 以 `package.json` 的 `version` 判断是否有新版本，并展示 `CHANGELOG.md` 中比当前版本新的中文更新内容。**发布新版本时记得同时修改这两个文件。**
- 相关设置（可在「系统设置 → 在线更新」中修改）：`UPDATE_REPO`（默认 `bocmiao/api`）、`UPDATE_BRANCH`（默认仓库的默认分支）、`GITHUB_TOKEN`（私有仓库或提高 GitHub 接口限额时填写）。
- 程序需要对项目目录有写权限。

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

**GET 和 POST**：绝大多数接口是 GET，参数放在网址 `?` 后面，可以直接在浏览器打开、写进 `<img src>` 或用 `fetch(url)` 读取；少数接口（短链接生成、AI 系列）是 POST，参数放在 JSON 请求体里：

```js
// GET：在自己网页里读取 Epic 周免（免 Key，已开启跨域）
const res = await fetch('https://api.example.com/api/epic/free');
const { data } = await res.json();

// POST：生成短链接
await fetch('https://api.example.com/api/shorturl', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-API-Key': 'ak_xxx' },
  body: JSON.stringify({ url: 'https://example.com' }),
});
```

网站「开发文档」页有 HTML、jQuery、Python、PHP、curl 等更多写法，每个接口详情页也有可复制的示例代码。**不要把 API Key 写进公开网页的前端代码**，网页里直接免 Key 调用即可（按访客 IP 计算额度）。

## 接口列表

⚠️ 非官方接口或网页抓取，可能随上游改版失效 · 🔑 需要配置密钥 · 🔓 可选配置密钥增强功能

每个接口的请求参数和**返回字段说明**（字段名、类型、单位、含义）见网站上的接口详情页，或 `GET /api` 返回的 `fields`。

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
| 摸鱼日历 | `/api/moyu` | 摸鱼日历：周末、发薪日与节假日倒计时 |
| BMI 计算 | `/api/bmi` | 计算身体质量指数（BMI） |
| 个税计算 | `/api/tax/income` | 按月累计预扣或年度汇算，支持五险一金、专项附加扣除、年终奖单独计税 |
| 身份证校验 | `/api/idcard/check` | 校验位、出生日期、省份、性别与周岁（只校验，不生成） |
| 经纬度距离 | `/api/geo/distance` | 球面距离与方位角 |
| 单位换算 | `/api/unit` | 11 类单位，含斤、两、亩、里、时辰等市制 |
|  | `/api/unit/list` | 列出全部单位与别名 |
| 年龄生肖 | `/api/age` | 周岁、虚岁、生肖、星座、农历生日与倒计时 |
| 工作日计算 | `/api/workdays` | 区间工作日数（含调休），或推算 N 个工作日后的日期 |
| 健康指标 | `/api/health/calc` | 基础代谢、每日热量、理想体重、体脂率、心率区间 |
| 数独 | `/api/sudoku` | 按难度生成唯一解数独，或传入题目求解 |

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
| 答案之书 | `/api/answer` | 随机返回一句答案，可传入问题固定当天答案 |
| 今日运势 | `/api/fortune` | 今日运势（同一名字同一天结果固定，仅供娱乐） |
| 号码吉凶 | `/api/numerology` | 手机号 / QQ 号 81 数理吉凶（仅供娱乐） |
| 语录合集 | `/api/quotes` | 按分类随机取语录，一次 1~10 条 |
|  | `/api/quotes/types` | 列出语录分类及条数 |
| 温馨提示 | `/api/greeting` | 当前时段的问候语和提示语（北京时间） |
| 随机头像 | `/api/avatar` | 生成 SVG 头像（直接返回图片） |
| 汉字字典 | `/api/hanzi` | 拼音（多音）、部首、笔画、繁体、释义，约 1.4 万字 |
| 古诗词检索 | `/api/poem/search` | 唐诗三百首、宋词三百首按作者 / 朝代 / 关键词检索 |
|  | `/api/poem/random` | 随机一首 |

### AI

需要登录，并在「系统设置 → AI」里填写 `LLM_API_KEY`。

| 接口 | 路径 | 说明 |
| --- | --- | --- |
| 文本摘要 🔑 | `POST /api/ai/summary` | 提炼长文要点 |
| 情感分析 🔑 | `POST /api/ai/sentiment` | 判断文本情绪倾向 |
| AI 翻译 🔑 | `POST /api/ai/translate` | 用大模型翻译文本 |
| AI 对话 🔑 | `POST /api/ai/chat` | 多轮对话 |

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
| 图形验证码 | `/api/captcha` | 生成图形验证码（SVG，2 分钟内有效） |
|  | `/api/captcha/verify` | 校验验证码（每个 token 只能校验一次） |
| 访客信息 | `/api/visitor` | 查看我的 IP、归属地与浏览器信息 |
| User-Agent 工具 | `/api/ua/parse` | 解析 User-Agent（默认解析调用者自己的） |
|  | `/api/ua/random` | 随机生成真实格式的 User-Agent |
| 颜色工具 | `/api/color/random` | 生成随机颜色 |
|  | `/api/color/convert` | 颜色格式转换与对比度计算 |
| IP 签名档 | `/api/ipcard` | IP 签名档图片（SVG） |
| 子网计算 | `/api/tools/cidr` | IPv4 / IPv6 子网、掩码、地址范围 |
| IP 与整数 | `/api/tools/ip-int` | IP 与十进制 / 十六进制 / 二进制互转 |
| 进制转换 | `/api/tools/radix` | 2~36 进制，支持大数 |
| Unicode 转换 | `/api/tools/unicode` | \uXXXX、&#x;、U+ 等格式互转 |
| 经典密码 | `/api/tools/cipher` | 凯撒、ROT13、摩斯电码、维吉尼亚、栅栏等 |
| JWT | `/api/tools/jwt` | 解码并验证 HS256/384/512 签名（GET / POST） |
| 两步验证码 | `/api/tools/totp` | 生成 TOTP 密钥与 6 位验证码（GET / POST） |
| 密码强度 | `POST /api/tools/password-strength` | 评估密码强度（只接受 POST） |
| 请求回显 | `/api/tools/echo` | 回显请求方法、头、参数（去掉敏感信息） |
| 测试数据 | `/api/tools/mock` | 生成明显虚构的姓名、手机号、邮箱、地址等 |
| 文本统计 | `/api/tools/text-stat` | 字数、词数、标点、段落、阅读时长 |
| 人民币大写 | `/api/tools/rmb` | 金额转中文大写 |
| JSON 工具 | `POST /api/tools/json` | 格式化、压缩、校验（给出错误行列） |
| Cron 解析 | `/api/tools/cron` | 中文描述与未来执行时间 |
| 正则测试 | `/api/tools/regex` | 匹配、替换、分割，带超时防卡死 |
| 占位图 | `/api/placeholder` | 生成 SVG 占位图 |
| 徽章 | `/api/badge` | 生成 shields 风格 SVG 徽章 |
| 文字转图片 | `/api/text-image` | 文字生成 SVG 图片 |

### 网络

| 接口 | 路径 | 说明 |
| --- | --- | --- |
| DNS 查询 | `/api/dns` | 查询域名的 DNS 记录，可选公共 DNS 服务器 |
| SSL 证书查询 | `/api/ssl` | 查询网站 SSL/TLS 证书信息 |
| 网站检测 | `/api/site/check` | 检测网站可达性、响应时间与跳转 |
| TCPing | `/api/tcping` | TCP 端口连通性与延迟测试（每次只测一个端口） |
| Ping | `/api/ping` | ICMP Ping 延迟与丢包测试 |
| 域名注册查询 | `/api/domain/available` | 查询域名是否已被注册 |
| Robots 分析 | `/api/robots` | 解析 robots.txt，判断爬虫能否抓取某路径 |
| 网站图标 | `/api/favicon` | 获取网站图标（直接返回图片） |
| 死链检测 | `/api/links/check` | 检测网页中的死链 |
| 域名后缀列表 | `/api/tld` | 查询顶级域名后缀列表 |
| 安全头检测 | `/api/site/headers` | HSTS、CSP 等安全响应头评分，附跳转链与压缩方式 |
| 邮件安全检测 | `/api/email/security` | SPF、DMARC、DKIM、MX 配置检查与建议 |
| 邮箱有效性 | `/api/email/check` | 语法、MX、一次性邮箱、拼写纠错 |
| RSS 转 JSON | `/api/rss` | RSS / Atom 订阅源解析，普通网页自动发现订阅源 |
| 网页正文 | `/api/web/text` | 提取网页正文纯文本 |
| 网页转 Markdown | `/api/web/markdown` | 网页转 Markdown |
| 整站文字抓取 | `POST /api/crawl` | 沿站内链接抓取多个页面的文字，遵守 robots.txt（后台任务） |
|  | `/api/crawl/result` | 查询抓取进度与结果（不计调用次数） |
| 苹果应用搜索 | `/api/appstore/search` | App Store 应用搜索与详情 |

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
- 缓存、每分钟限流和验证码答案保存在进程内存中，适合单实例部署；重启后未使用的验证码失效。
- `/api/ping` 调用系统 ping 命令。Docker（alpine）镜像以非 root 用户运行时，需要宿主允许非特权 ICMP（`sysctl -w net.ipv4.ping_group_range="0 2147483647"`），否则返回 503，可改用 `/api/tcping`。
- 访客信息、IP 签名档显示调用者的 IP，部署在反向代理后必须设置 `TRUST_PROXY=1`。
- 观音 / 文昌灵签的代码已完成，但签文尚未对照可靠底本校订，暂未上线（`src/apis/fun/index.js` 中未注册）。
- 管理员可调整单个用户每日额度；按 IP 的匿名额度对同一出口 IP 下的用户共享。

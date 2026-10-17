# 60 秒简报：自有存储与受控更新

`GET /api/news/60s`、`?date=YYYY-MM-DD` 与 `news-60s` 推送继续使用原返回字段。现在读取的是 `DATA_DIR/news60s` 的已发布内容；访客、预热、巡检和订阅读取均不访问作者公共 API，也不再暗中回退知乎。空库返回 `503 NEWS60S_NOT_READY`，缺失历史返回 `404 NEWS60S_DATE_NOT_FOUND`。

本实现没有解决同款微信文章的无人值守发现。目前没有启用文章列表抓取、付费 AI 或其他泛新闻替代源。操作员须提供核对过的结构化 JSON、公开文章 URL，或配置自己可维护的 JSON 数据源。定时运行更新命令不会自动产生这些输入。同步别人的 JSON、原文或图片属于镜像，不代表本站生产了这些内容；原始 `source`、`link` 和 `provenance` 一起保留。

## 1. 持久目录

运行要求与主项目一致：Node.js >= 22.13，零 npm 依赖；使用内置 `node:sqlite`。设置持久数据目录，例如：

```dotenv
DATA_DIR=/var/lib/miao-api
PUBLIC_URL=https://api.example.com
# 可选：自己维护的兼容服务，或静态文件模板
# NEWS_60S_SOURCE_URL=https://news.example.com/v2/60s
# NEWS_60S_SOURCE_URL=https://news.example.com/{date}.json
```

后台「系统设置 → 60 秒简报」也可设置 JSON 来源，保存后优先于环境变量。这个地址只在管理员/CLI 主动更新时使用。没有默认公共来源，不需要增加任何 API key。URL 不接受账号密码、密钥参数、内网、回环或保留地址；配置项不是任意网络代理。

使用本地可持久写入的文件系统，CLI 与服务用同一操作系统用户及同一 `DATA_DIR`。Docker 须把数据目录挂载到持久卷。目录包含 `index.sqlite`（及 WAL 文件）和 `revisions/<UUID>/record.json`、按 SHA-256 命名的图片。在线更新保留原项目的 `data` 目录；自定义绝对目录应放在代码发布目录外。

每个版本的 JSON、图片和目录项先落盘，再用 SQLite FULL-synchronous 事务一次切换日期索引。更新失败不会替换旧版本；进程崩溃由 SQLite 恢复事务锁。不同进程同日并发更新采用期望版本检查，冲突返回 409（CLI 退出 75），不静默覆盖。旧图片地址保留有效；相同内容重复同步不新增版本。历史回填不会降低 latest 的日期。

备份时应停止服务与更新任务后复制整个目录，或使用 SQLite 一致性备份并同时保存其引用的不可变版本目录，不能只复制正在写入的 `.sqlite` 文件。本版本不自动清理历史版本/崩溃遗留的未发布目录；请监控磁盘容量，勿删除仍被索引或旧图片 URL 引用的目录。不要在 NFS 上共享 SQLite WAL。

## 2. 可立即使用的人工 JSON 路径

```json
{
  "date": "2026-01-02",
  "news": ["已经核对来源的第一条新闻", "第二条新闻"],
  "tip": "每日微语",
  "source": "原内容作者或来源名称",
  "link": "https://example.com/original-article",
  "image": "https://images.example.com/daily/2026-01-02.png",
  "cover": null,
  "weekday": "星期五",
  "lunarDate": null
}
```

`date` 必须是真实完整日期且不晚于北京时间当天；不会用当前日期替换来源日期。新闻须为 1—60 条非空、不重复字符串，每条最多 2000 字符。也接受 `{ "data": { ... } }` 包装，及 `day_of_week` / `lunar_date` 字段别名。未提供的星期按日期计算，农历/微语/图片允许为空。图片 URL 必须可公开读取；更新会镜像实际字节，任一图片失败则整期不发布，不留下远程图片当作已镜像。

```sh
cd /opt/miao-api
node scripts/news60s-update.js --json /var/lib/miao-input/2026-01-02.json --date 2026-01-02
node scripts/news60s-update.js --status
```

也接受 `--json -` 从标准输入读入。`--date` 是核对条件，不是重写内容日期。CLI JSON/远程 JSON 上限 256 KiB；管理员 HTTP 请求沿用主项目 100,000 字节上限。小型本地 raster 图片可用 `data:image/png;base64,...` 等内嵌形式，正式大图建议用公开 URL。仓库的 `examples/news60s/manual.json` 包含明确标注的假新闻和 1px PNG，只用于本地演示，不应发布到生产。

## 3. 自有服务与静态 JSON 同步

```sh
# 使用已配置的 NEWS_60S_SOURCE_URL，读取最新 JSON
node scripts/news60s-update.js
# 从兼容服务查询指定日期，自动附加/替换 date 查询参数
node scripts/news60s-update.js --url https://news.example.com/v2/60s --date 2026-01-02
# 静态模板；无 --date 时替换为 latest，有日期时替换为该日期
node scripts/news60s-update.js --url 'https://news.example.com/{date}.json' --date 2026-01-02
```

来源必须返回 `application/json`（或 `text/json`）、合法 UTF-8、上节所示结构，且正文 `date` 必须与指定历史日期一致。相对图片/原文链接按实际 JSON URL 解析。静态源不能仅有图片、没有日期与新闻 JSON；其他静态项目若格式不同，需要操作员转换成上述结构，不能把一个不兼容的仓库地址当作已接通。镜像上游 JSON 不等于完成自主文章生产/发现。

## 4. 人工指定微信文章 URL

```sh
node scripts/news60s-update.js --article-url 'https://mp.weixin.qq.com/s/公开文章标识' --date 2026-01-02
# 多图文章可明确选择整期图/封面，避免把二维码当作新闻图
node scripts/news60s-update.js --article-url 'https://mp.weixin.qq.com/s/公开文章标识' --date 2026-01-02 \
  --image-url 'https://mmbiz.qpic.cn/公开图片路径'
```

只接受公开 HTTPS `mp.weixin.qq.com` 文章，整个跳转链仍须是此站点；验证页、登录页、正文缺失会失败。解析器仅支持 `js_content` 正文中从 1 连续编号的新闻段落，且标题/首条新闻前必须有唯一、完整的年月日。只有“1月2日”、没有年份时，即使传了 `--date` 也不会猜年份；此时请人工整理 JSON。它不执行页面脚本，也不把内容/凭证发送给 Gemini 或其他 AI。

单图正文可自动选择该图；多图正文不猜哪张是整期图，可用 `--image-url` 指定。`og:image` 可作为封面。选中的所有图片都必须成功镜像后才发布。页面其他图片不会自动下载。

## 5. 管理员入口与读取

现有管理员网页登录会话可访问：

- `GET /admin/news/60s`：日期列表、latest、过期状态及人工发现边界。
- `POST /admin/news/60s/update`：同源 JSON，三种互斥输入 `{ "data": {...}, "date": "..." }`、`{ "url": "...", "date": "..." }`、`{ "articleUrl": "...", "date": "...", "image": "..." }`。空对象表示同步已配置 JSON 来源。

沿用项目管理员会话与 CSRF 校验；普通用户及普通 API Key（包括管理员创建的 API Key）不能更新。没有新增无人知晓的更新令牌。CLI 权限由操作系统对数据目录的写权限控制。后台设置 URL 只配置来源，不会自动启动抓取任务。

读取 `/api/news/60s` 返回最大已发布且不晚于北京时间当天的来源日期；不是“最新导入时间”。若该日期早于当天，响应外层带 `stale: true`，`data.date` 保持真实来源日期，`updatedAt` 是该版本发布时间。明确历史日期查询只返回该日期，不回退最新。现有字段仍在；新增 `provenance` 记录导入方法、实际读取 URL 和原图归属。`image/cover` 是本站不可变图片路径，配置 `PUBLIC_URL` 时为绝对 URL；原文 `link` 不被冒充为本站原创。

公开图片路径也经过该模块的开放状态和调用限流，支持 `ETag` / 304、`nosniff`、长期缓存；静态资源 CDN 应按这个明确路径配置，不要缓存管理接口。

## 6. Linux 调度（文档示例，尚未部署）

以下任务只能同步已经配置并可维护的 JSON 源；没有来源就会明确失败并保留旧版，不会自行发现微信文章。人工 JSON 文件也可由编辑独立准备后定时导入。第一次运行先手动检查退出码与 `--status`，不要把命令成功误当作内容真实性审核。

### cron

以服务的同一用户安装任务；下例 07:30 按 cron 守护进程所在机器的时区执行，若要北京时间须先确认服务器时区：

```cron
30 7 * * * cd /opt/miao-api && /usr/bin/node scripts/news60s-update.js >> /var/log/miao-api-news60s.log 2>&1
```

日志目录须已对该用户可写。CLI 从项目 `.env` 读取环境并应用后台保存的设置，输出只含日期、版本与结果，不输出来源正文、图片或凭证。失败退出 1；同日更新冲突退出 75，稍后人工检查/重试。

### systemd timer

`/etc/systemd/system/miao-news60s-update.service`：

```ini
[Unit]
Description=Update published Miao 60s news
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=miao
Group=miao
WorkingDirectory=/opt/miao-api
Environment=DATA_DIR=/var/lib/miao-api
ExecStart=/usr/bin/node /opt/miao-api/scripts/news60s-update.js
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/miao-api
```

`/etc/systemd/system/miao-news60s-update.timer`：

```ini
[Unit]
Description=Daily Miao 60s synchronization

[Timer]
OnCalendar=*-*-* 07:30:00 Asia/Shanghai
Persistent=true
Unit=miao-news60s-update.service

[Install]
WantedBy=timers.target
```

上述路径、Node 可执行文件位置、操作系统用户与读写权限须按实际服务器调整。确认来源和首次导入后，操作员才执行 `systemctl daemon-reload`、`systemctl enable --now miao-news60s-update.timer`。本变更没有执行这些部署命令，没有启用任何 GitHub Actions/CNB 调度。

## 7. 安全与验证边界

下载只允许无凭据的公开 HTTP/HTTPS，连接时检查全部 DNS 结果，拒绝内网/保留 IP，逐跳重新校验，最多 3 次重定向且拒绝 HTTPS 降级。单次来源读取共享 10 秒总时限（含跳转与正文）；JSON 256 KiB、文章 2 MiB、每张图片 5 MiB。图片只接受文件头和 MIME 匹配的 PNG/JPEG/WebP/GIF，不允许 SVG/HTML。下载不使用可能绕过连接检查的出站代理；若服务器无法安全直连，请通过人工 JSON 路径导入，不要关闭 SSRF 防护。

实现为本项目原创代码，未复制上游 `60s-static-host` parser 或其 AI/日志客户端；沿用项目 `LICENSE`。输入的文章、新闻文本、图片仍由操作员核实使用许可并保留来源归属。

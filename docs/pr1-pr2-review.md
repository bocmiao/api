# API PR #1 / #2 联合审查与修复（2026-10-18）

基线 `2a3ff580f883b00ec3097ef953bc86b36030ec28`；PR #1原始head `6f64019dd44dcc6371cb1f6f79366b927c36f1b3`；PR #2原始head `abeac6d966ad62f77000e7b69bcb3b2c89a99bed`。本报告覆盖两PR的实际代码修复和联合回归，合并状态以GitHub最终回读为准。没有生产部署、Actions/CNB调用、购买服务或凭证/权限修改。

## PR #1：实时票房

- 上游改为猫眼专业版网页端。影片box/splitBox按分→万元换算，大盘综合/分账各自保留万/亿单位，累计票房保持文本；接口路径、字段和limit保持兼容。
- 拒绝只有空list、却没有有效统计日期及任何大盘金额的空壳响应；不让异常刷新覆盖旧缓存。日期有效且至少一个大盘为0的合法零票房空榜仍返回0。
- 布尔、空白、数组、对象等金额输入转为null，不伪造0；合法数值继续换算。坏日期、无效/超范围时间戳及未知单位返回502，避免RangeError变成内部500。
- 补回暂停模块的目录状态、巡检跳过、预热排除及503通用回归，使用合成模块，不再绑死恢复后的boxoffice。
- 版本0.13.1、中文CHANGELOG和原始无正文提交的UPDATE_NOTES映射齐备；旧版真实更新读取函数与新旧页面都能显示恢复说明。

代码：`src/apis/fun/boxoffice.js`、`test/boxoffice.test.js`、`test/inspect.test.js`。详细边界见[票房恢复说明](boxoffice-restoration.md)。旧来源审计文档固定到旧基准，旧URL是历史证据；当前目录已无暂停标记，来源仍是“平台网页源”。

## PR #2：受控重试

原实现会在预算已经耗尽后再等待200ms并开始新尝试，等待期间不能及时取消；错误响应体只释放了中间5xx。仅凭GET/HEAD判断无副作用也会扩大上游配额使用。

修复后的行为：

| 情形 | 行为 |
| --- | --- |
| 未显式启用retry的GET | 只尝试一次，不根据方法名推断可重放 |
| retry=true的无body GET/HEAD | 瞬时网络错误或502/503/504后最多再试一次 |
| POST或任何带请求体的请求 | 一次；不重用已消费的流 |
| 429、其他4xx、Retry-After响应 | 不自动重试 |
| 证书、配置、代理拒绝等永久错误 | 不自动重试 |
| 用户取消或总预算用完 | 等待立即停止，不再发下一次请求 |
| 最终/中间错误响应 | 发起body.cancel并处理失败，不无限等待不可信cancel钩子 |

一个AbortSignal总预算覆盖首请求、200ms退避、第二次请求及正文读取；额外用单调时钟检查截止时间。不是把每次尝试重开一个timeout。真实本地HTTP服务验证了等待响应头及读取未结束正文的超时行为。

当前只有猫眼公开榜单和IANA静态列表显式开启重试。快递识别、带Key的其他数据服务及未知GET没有被全局重放。上游故障时这两项读取的请求量最多增加一次；429和Retry-After继续尊重。JSON解析失败/业务格式不符不通过重试掩盖。

仍使用原outboundFetch传输，未改netguard、DNS解析或连接时地址校验，没有新增DNS缓存或SSRF入口。HTTP客户端错误响应体需要消费或取消以释放连接，参见[Undici官方说明](https://github.com/nodejs/undici#garbage-collection)。

代码：`src/lib/http.js`、`src/apis/net/tld.js`、`src/apis/fun/boxoffice.js`、`test/http-retry.test.js`、`test/api-validation.test.js`。版本0.13.2和中文说明覆盖启用范围、预算、取消、限流及无需迁移。

## 验证记录

环境：Linux、Node24.19.0。使用原生node --test，隔离脚本阻断外部HTTP连接、只放行经校验的本地测试服务器；上游数据用模拟响应，不消耗真实付费API额度。未安装项目依赖。

| 检查 | 通过 / 总数 | 失败 |
| --- | ---: | ---: |
| 原基线复核 | 1242 / 1242 | 0 |
| PR #1原始head复核 | 1245 / 1245 | 0 |
| PR #1修复后的全量 | 1250 / 1250 | 0 |
| PR #2修复专项（含网络/参数校验） | 97 / 97 | 0 |
| 两PR联合专项 | 162 / 162 | 0 |
| 最终联合全量 | 1270 / 1270 | 0 |
| 新旧更新页，1360/390/320px | 6 / 6 | 0 |
| 来源/详情页，含票房恢复卡片，1360/390/320px | 36 / 36 | 0 |

专项覆盖：分到万元及大盘独立单位、缺失/零值、空壳缓存污染、日期/时间戳、共享limit缓存、通用暂停行为、瞬时网络重试、未知GET不重放、POST/流体单次消费、退避取消、总预算、响应体释放、Retry-After/429/证书错误、本地真实传输正文超时及中文发布说明。

命令：`node --test`；专项`node --test test/http-retry.test.js test/api-validation.test.js test/apis/net.test.js test/boxoffice.test.js test/apis/fun.test.js test/inspect.test.js test/updater.test.js test/update-release-notes.test.js`；浏览器使用仓库`scripts/check-release-notes-ui.js`与`scripts/check-api-sources-ui.js`，仅喂本地合成目录和更新响应。

没有复现作者所述15个失败，且没有Windows环境，不能据此断言那些失败都属于Windows。首次用git archive快照时有3个依赖.git的测试失败，已改为完整隔离Git检出后复核通过；并发跑两套全量时出现过未改动爬虫测试的计时断言，独立复跑通过，未把它当作PR引入问题。

## 在线验证边界

作者给出过猫眼免签响应及fixture；本环境对`https://piaofang.maoyan.com/dashboard-ajax/movie`的无凭据读取在代理CONNECT阶段被403拒绝（curl退出56、目标HTTP000），未取得猫眼实时响应。没有绕过签名、验证码或网络拒绝，也没有把fixture或本地HTTP测试当作实时验源。平台接口仍可能随改版失效。

## 写远端与合并前的触发核查

- 原基线及两PR原始head均只有`.github/workflows/ci.yml`，事件仅`workflow_dispatch`；无push、pull_request、workflow_run等自动触发，未新增或修改工作流。
- 树内未发现CNB配置；原工作区及隔离检出没有启用的本地Git hooks。
- 远端仓库hooks尚未能在本执行环境读出：正常CLI `GET /repos/bocmiao/api/hooks`返回Forbidden；GitHub连接器fetch该URL返回“不在允许的endpoint列表”。这不是hooks为空的证据。未试图绕过，也未扩大连接器权限。
- 未完成正常授权的远端hooks核对前，不执行push、PR元数据写入或merge。`[skip ci]`不能代替该核查，尤其不能证明外部CNB/webhook不会触发。

用户已授权正常推送修复和合并两PR；剩余若有阻塞是读取远端触发配置的技术限制，不是再次等待用户许可。应由可正常读取设置的连接器/网页完成核对，确认不会触发被禁止任务，再刷新base/head并执行无force的快进推送和带expected_head_sha的合并。若任何分支有他人新提交，先纳入并重新核验差异，不能覆盖。

最终已测head、tree、两PR状态与远端SHA随交付验收记录回读；本报告不把本地合并或测试通过冒称GitHub已合并。

# 版本身份与更新确认验收

基线：`2f0ded7d62e6c5ec923055812d0a7a041924d7f7`，远端默认分支 `Miao-API`。本次只修复版本身份、更新状态及说明展示，没有重复修改来源追踪功能。`package.json` 仍为 `0.11.1`，未创建 Release 或部署服务。

## 行为与兼容

- 启动时固定 `RUNNING_IDENTITY`：语义版本、经过核验的 SHA 或未知、内容指纹、安装编号、进程随机编号与启动时间。安装记录不再充当旧进程的运行身份。
- `version.json` 新记录含 schema 2、代码内容指纹与独立安装编号。读取时逐文件核验，覆盖新增、删除和等长替换；保留的数据目录、`.env`、依赖、Git 元数据及备份不进入指纹，不跟随代码符号链接。干净 Git 部署可逐文件核验 HEAD，保留的旧 `.git` 不足以证明新代码身份。
- `/admin/version` 返回明确的 `runningIdentity`、`diskIdentity`、重启状态、健康观察状态及回滚结果；保留原有版本字段兼容调用者。`/status.version` 只取启动版本，不从后来替换的磁盘回填。
- 页面主卡显示运行、磁盘、GitHub 目标各自的版本号和短 SHA；安装时间与提交时间分开，提交时间不再叫“发布”。同语义版本不同内容/安装记录同样要求重启。
- 在线与上传流程都返回目标 SHA（仅官方核验后）、内容指纹、安装编号及更新前进程编号。前端成功确认要求目标身份匹配、新进程编号不同、磁盘与运行一致、启动观察标记已清除。旧进程、旧接口、回滚、观察期未结束、身份缺失都不能报成功。未使用 launcher 的安装提示等待手动重启。
- 20 秒启动观察定时器只清除匹配当前进程和磁盘的待确认安装。兼容旧更新器首次安装时没有安装编号的标记，但保留未知 SHA，不用旧记录补造身份。模块测试直接调用确认函数；新增进程测试则由真实 server 定时器等待实际 20 秒确认，没有生产操作。
- 旧记录/无 Git 的手动部署缺少可验证身份时显示未知；可重新安装明确目标来建立新记录。新静态页面与旧服务接口混用时提示重启。已经打开的旧前端不具备新确认逻辑，首次升级后需刷新加载新页面。
- 按实际提交范围优先使用 `UPDATE_NOTES.json`，否则支持提交正文列表及普通段落，排除验证/交付段落。比较失败或本地 SHA 未知时仅展示目标说明，明确完整差异未知；缺失、截断也提示。补齐来源追踪 `2f0ded7` 及两项通知修复的说明，没有将历史 QQ 条目冒作最新来源功能。

## 验证

环境：Node `v24.19.0`，Chromium `154.0.8037.57`，临时数据库与合成账号；无新增 npm 依赖。没有运行真实渠道投递、生产数据库迁移或生产服务更新。

| 检查 | 实际结果 |
| --- | --- |
| 完整 `node --test` | 1203 通过，0 失败，0 跳过；包含新增的提交关系与实际进程测试 |
| 身份回归 `test/deployment.test.js` | 相同 SHA、同版本不同 SHA、替换未重启、等长手动覆盖、未知部署、旧记录、保留数据、Git 内容不符与符号链接 |
| 模块流程 `test/update-lifecycle.test.js` | 11 项：增量、完整包、官方核验上传、未核验上传、未知手动部署、同版本旧记录、手动启动、回滚、旧更新器标记兼容、再次覆盖、目标变更；执行 updater/试加载/备份/替换/新进程读身份/恢复，入口 app/server/launcher 为 stub，确认/恢复函数直接调用，不能单独证明 launcher 生命周期 |
| 进程端到端 `test/update-process.test.js` | 3 项实际 launcher/server、本机 HTTP、持久临时 SQLite：未重启保持旧身份；分支前进后上传合法祖先 ZIP、真实重启、实际等待 20 秒健康确认；新进程退出后 launcher 自动回滚。没有直接调用确认或回滚函数，未改写健康场景的 server/launcher |
| 上传祖先关系 `test/upload-update.test.js` | 真实本地 Git 提交图、真实 git archive ZIP、真实文件树；按 BASE...HEAD 计数生成比较响应，再以独立 `git merge-base --is-ancestor` 退出码交叉验证。祖先/当前接受，后继/分叉拒绝；缺失/错误 merge base 及被篡改文件均拒绝 |
| 现有 updater/upload-update 与平台测试 | 实际执行并通过；说明范围、比较失败/分叉/截断、缓存失效、管理员鉴权、Origin、上传密码二次确认、源码包完整性继续覆盖 |
| `scripts/check-update-ui.js` | 实际生产 `app.js` 只在本地附加测试入口，未改写 `followUpdate`；使用浏览器虚拟时钟推进等待，版本/更新响应为合成数据。15 组检查通过，0 页面异常 |
| 浏览器确认场景 | 旧同版本进程、旧实例声称目标 SHA、缺进程编号、观察中、回滚、目标未知均不成功；手动安装等待重启；新目标进程确认成功、重启后进度重置仍保留目标、未核验上传按指纹确认 |
| 界面 | 桌面、390/320px 反复切换，三种身份、来源说明、时间标签、未知/失败/截断提示、转义文本均通过；无页面横向溢出 |
| 静态检查 | 修改脚本 `node --check` 与 `git diff --check` 通过 |

首轮完整测试实际为 1195 通过、1 失败：既有 `user-calls.test.js` 把临时迁移数据库写入未创建的 `data/onboarding/`。仅将测试目录改用系统 `tmpdir()`，业务与来源功能保持原样，随后全量通过。浏览器复跑还抓到缩窄视口时旧图表 SVG 宽度短暂溢出（320px 页面变成 349px）；补充 SVG 宽度约束及更新卡标题换行后，反复切换通过。

首次提交后的干净工作树复验实际为 1196 通过、1 失败：旧测试把“过期记录”一律当作未知，遗漏干净 Git 可核验真实 SHA 的合法路径。改为分别验证过期记录不可冒认与真实 Git 回退；未知手动部署及同版本旧记录的完整检查/重装场景放入移除 `.git` 的隔离仓库，避免测试依赖工作树恰好存在未提交修改。应用实现保持不变。

## 上传方向修复与进程复查

独立复查发现既有 `verifyUploadOfficial` 的比较方向错误。按照 [GitHub 比较接口的 BASE...HEAD 定义](https://docs.github.com/en/rest/commits/commits#compare-two-commits)，此处 BASE 是上传 SHA，HEAD 是配置分支。实际仓库 `b92ad7c...3a216ce` 的 Git 左右计数为 `0 1`，表明配置分支领先祖先提交。

另外在隔离 Git 仓库中，分别运行 `3a216ce` 的旧校验函数和修复后的函数，实际结果如下（不是只把 mock 中的字符串倒置）：

| 上传提交相对分支 | 比较状态 | 原实现 | 修复后 |
| --- | --- | --- | --- |
| 合法祖先 | ahead，右侧多 1 提交 | 误拒绝 | 接受 |
| 当前提交 | identical | 接受 | 接受 |
| 未合入分支的后继 | behind，左侧多 1 提交 | 误接受 | 拒绝 |
| 分叉 | diverged，两侧各 1 提交 | 拒绝 | 拒绝 |

修复保留每文件 Git blob 校验，并额外要求 `merge_base_commit.sha` 等于上传 SHA；缺少祖先证据时拒绝，不放宽信任边界。[复现结果 JSON](update-validation/upload-ancestry-reproduction.json)。当前环境仍无法直接调用仓库 GitHub API；比较响应来自文档定义与真实本地 Git 图，不声称这部分已完成云端 API 联调。

实际进程测试复制真实 `src/`、`public/`、`package.json` 到临时目录，健康场景逐字节核对 server/launcher 未被替换成 stub；正常更新从真实管理员 HTTP 接口发起。合法旧 ZIP 场景在下载包后让配置分支再前进一个提交，验证祖先包仍能通过官方核验流程。崩溃场景只向临时目标 server 追加 1 秒退出的故障，launcher 自己恢复代码与版本记录。各场景都验证合成 `.env`、数据文件保持，进程组在结束时停止并删除临时目录。

全部子进程含试加载进程均加载隔离 preload：GitHub 文件/树响应只读本地构造的包，其余 fetch 拒绝，Socket 限制为本机，未继承生产凭据。真实应用启动的预热外部请求在此被阻断，不访问付费服务、通知设备或其他生产上游。健康确认使用实际时间，不使用浏览器虚拟时钟。[独立进程测试输出](update-validation/process-results.txt)。

首轮进程测试因夹具 `.gitignore` 的未锚定 `data/` 模式漏打包内置 `src/apis/life/data/` 而失败；改用与生产相同的根目录排除后，3 项进程测试通过，随后完整 1203 项通过。这个夹具问题没有通过修改实际应用或降低试加载检查绕过。

复现：

```sh
node --test
node --test test/update-process.test.js test/upload-update.test.js
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM_PATH=/usr/bin/chromium node scripts/check-update-ui.js
```

浏览器依赖由开发环境提供，不加入应用运行依赖。完整临时日志及更多状态截图位于验收环境 `data/update-evidence/`，其中不含生产数据。

- [浏览器结果](update-validation/browser-results.json)
- [桌面合成截图](update-validation/desktop.png)
- [320px 合成截图](update-validation/mobile-320.png)

## 推送边界与未验证事项

推送前已核仓库树，唯一工作流 `.github/workflows/ci.yml` 只有 `workflow_dispatch`；没有 push/PR 触发器、CNB 配置或非示例 Git hook。本次不修改工作流/权限，不执行 dispatch、CNB、Release 或部署操作；提交使用 `[skip ci]`。远端推送结果及回读 SHA 以交付记录为准。

此环境 `gh api repos/bocmiao/api` 返回 Forbidden，无法用该 API 独立列举运行记录；Git 远端读取可用。没有将 API 不可达说成已通过在线集成验证，也不能从仓库文件证明外部未公开的 webhook 状态。逐文件身份核验在启动和管理员版本检查时执行，未做生产磁盘容量/延迟测试；未知旧身份不能无证据恢复。没有改动生产、安全权限、付费设置或凭据。

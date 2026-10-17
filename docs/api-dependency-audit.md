# Miao-API 接口依赖审计与整改记录

审计日期：2026-10-17 UTC。基准代码：`c51fa5140eebc13b179f64eac24f18482c4444ec`，仓库 `bocmiao/api` 的 `Miao-API` 分支。本文描述该基准的真实依赖，并明确列出本轮 v0.13.0 已实施的变化。线上运行 SHA 未从截图推定，代码推送不等于生产服务已更新。

## 结论与已落实改动

当前实际注册 **129 个模块、204 个“方法+路径”调用地址**，包含暂不可用或需配置的模块；管理员启停/合规开关可能使某个部署的公开目录更少。截图129与源码注册数一致，但不能据此确认截图的部署版本。README开头“126 / 199”是静态旧文案，本轮修正为129 / 204：后来新增QQ昵称1模块1地址、QQ资料卡1模块2地址、通知消息JSON构建1模块1地址；60秒简报新增assets地址1条。129指模块数量，不代表129条路由，也不代表每个接口都能离线运行。

“非官方”旧布尔字段不能说明依赖类型。Steam、Epic、Xbox、豆瓣和多数热榜直接访问平台自身；它们的站内接口未公开承诺稳定，与经第三方聚合API中转是两件事。读取第一方RSS、直接TCP/DNS查询、本地生成QQ头像URL也必须分别说明。

本轮已实施：

1. 每日诗词、一言默认使用现有本地有限句库，默认路径不尝试联网；原服务保留显式`provider=jinrishici` / `provider=hitokoto`。一言补一条本站原创“其他”分类，覆盖a–l，不下载或引入新语料库。
2. IP/手机号新增`mode=offline`：只用已有离线库，未命中返回404，不悄悄回在线；默认`auto`继续原先补全，不使正常接口整体失效。
3. 2025/2026年已有内置放假安排优先直接返回，相关工作日、问候语共享受益；跨年/其他年份仍保留在线源。
4. 为129模块增加`sourceInfo`，卡片、详情、服务端文档和诊断显示来源类型及范围；保留`unofficial`兼容字段。来源未登记的新模块显示“待核查”，不会默认声称纯本地。
5. 版本改为0.13.0，补中文升级说明和README计数。未增加npm依赖，不需数据库迁移，保留v0.12.0及所有旧历史说明。

没有重复开发Minecraft、二维码、条码、头像生成、农历/天文、IP/手机号库、诗词搜索、UA分析、TCP/TLS/DNS/HTTP诊断等已有能力。没有把缓存、换代理、换成另一家聚合服务称为独立数据生产。

## 升级与能力边界

- `/api/poem`、`/api/hitokoto`字段保留。默认本地`fallback=true`（兼容原有“来自内置库”语义）；诗词`category=null`，一言`id/uuid/creator/url=null`。本地一言只有约30余条既有引用/原创，不能冒充完整上游语料。需要原服务时显式指定provider。
- `/api/ip?mode=offline`只有IPv4定位库，不含完整ASN、坐标、组织数据；IPv6/无记录404。`/api/phone?mode=offline`号段库数据版本2023-12，未命中404，携号转网不保证准确。默认auto不变。其他复用IP查询的访客卡片/信誉查询仍可能在线补全，不是全站断网开关。
- 内置2025/2026放假安排直接使用，年度官方修订须随代码维护；其他年份保留holiday-cn，未来调休不能用农历/周末算法猜测。`moyu`和`holiday/next`会尝试次年，2026的跨年请求仍可能联网。
- 60秒简报已在v0.12.0实现本站持久读和图片镜像。首次导入前503，历史缺期404；更新源/人工文章仍需自有或获授权数据，可靠的微信文章自动发现尚未完成。
- 真实热度、行情、限免权益、第三方平台评分和正版音源仍须平台或获授权数据。新的Key、付费数据、模型、跨地区探针、服务器部署均未暗中配置。

## 分类统计与方法

下表按一个模块的完整能力分类；混合来源包含备用和显式联网选项，所以“默认本地”的诗词/一言仍列混合。分类讨论的是业务数据，不是Linux、Node.js和数据库等普通运行依赖。

| 类型 | 模块数 | 含义 |
| --- | ---: | --- |
| 混合来源/可选联网 | 22 | 多种来源、在线补全、备用、外部图片或可选提供商。 |
| 第一方网页/未公开稳定接口 | 22 | 平台自有网页/站内接口，无文档化稳定API保证。 |
| 第一方官方公开源 | 5 | 发布者公开API/RSS/列表；公开可读不等于任意再分发许可。 |
| 直接目标协议或网页 | 17 | 本服务器主动探测真实目标，仍依赖网络/DNS，不叫离线。 |
| 第三方数据服务 | 11 | 聚合或社区供数/服务；其API本身可能是供应商正式API。 |
| 本地数据/自有持久数据 | 21 | 已随库提供的表、语料或本站持久发布数据；数据维护仍有边界。 |
| 纯本地计算 | 31 | 处理输入/请求上下文，无业务上游。 |

审计覆盖注册目录、各模块实际加载器与共享依赖、备用分支、重定向和响应中的媒体链接。只加载注册元数据时隔离禁止出网、子进程和文件写入，未调用处理器，记录129/204且拦截尝试为0；实际整改验证使用本地测试/模拟上游，没有调用付费或消耗真实额度的API。静态代码核查不等于远程接口当日可用性测试，不声称全部上游已在线验证。

下文基准证据链接固定到审计SHA，文件行号不会随分支移动。本轮改动可对照同仓库0.13.0提交中的同名文件；报告中的“已改”专指本轮代码。动态媒体域名举例来自解析器及既有夹具，不保证为上游未来返回域名的封闭白名单。

## 共享依赖与容易误判的路径

- `loadIpInfo`被`visitor`、`ipcard`、`ip-reputation`复用。信誉为取ASN传`withAsn=true`，即使国内IPv4已有城市，也会请求ip-api；SVG输出本地不代表归属地一定本地。`svg-image`虽导入ipcard的`escapeXml/textWidth`，其处理器只调用纯函数，不继承访客定位网络请求。
- `holiday`被`workdays`、`moyu`、`greeting`共享；本轮改变加载优先级会同时影响它们，不需给每个模块再写一个节假日实现。
- `games-free`直接复用Epic、Steam、GOG加载器；`hot-all`直接复用15个来源适配器。所谓聚合是本站代码聚合，不表示调用了别人的聚合API。
- `metals`的人民币折算间接请求`fx`的open.er-api.com；`whois`被域名可用性复用；ASN也用IANA引导及RIR官方RDAP，rdap.org只在失败时备用。
- `poem`、`pinyin`、`hanzi`、`idiom`等从仓库本地数据按需读文件。`news60s.js`保留旧Viki/知乎解析纯函数供兼容测试，但真实公开读取函数只读本站store，不能因代码中的来源字符串把它判作仍在请求作者公共API。
- `src/lib/http.js`/`src/lib/proxy.js`允许站长已有的出站代理配置：数据仍属原平台，但网络路径可能经站长代理。本轮没有创建、修改代理/Key/凭证，也没有绕过访问限制。
- 返回HTTP302或外部图片地址不能称为图片已自托管：QQ头像、Bing、Wallhaven/Picsum、Steam封面、豆瓣海报、网易云音频均须客户端继续访问外部源。60秒assets、生成SVG、Minecraft目标返回data URI应分别对待。

共享证据：
- [src/apis/life/ip.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/ip.js#L1), [src/apis/life/ip.js:69](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/ip.js#L69), [src/apis/life/ip.js:100](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/ip.js#L100), [src/apis/life/ip.js:124](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/ip.js#L124), [src/apis/life/ip.js:135](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/ip.js#L135)
- [src/apis/tools/visitor.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/visitor.js#L1), [src/apis/tools/visitor.js:19](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/visitor.js#L19), [src/apis/tools/visitor.js:77](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/visitor.js#L77)
- [src/apis/tools/ipcard.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/ipcard.js#L1), [src/apis/tools/ipcard.js:142](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/ipcard.js#L142), [src/apis/tools/ipcard.js:181](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/ipcard.js#L181)
- [src/apis/tools/svgimage.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/svgimage.js#L1), [src/apis/tools/svgimage.js:30](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/svgimage.js#L30), [src/apis/tools/svgimage.js:79](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/svgimage.js#L79), [src/apis/tools/svgimage.js:134](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/svgimage.js#L134), [src/apis/tools/svgimage.js:147](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/svgimage.js#L147)
- [src/apis/net/iprep.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/iprep.js#L1), [src/apis/net/iprep.js:163](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/iprep.js#L163), [src/apis/net/iprep.js:208](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/iprep.js#L208)
- [src/apis/life/holiday.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/holiday.js#L1), [src/apis/life/holiday.js:7](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/holiday.js#L7), [src/apis/life/holiday.js:54](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/holiday.js#L54), [src/apis/life/holiday.js:57](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/holiday.js#L57), [src/apis/life/holiday.js:60](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/holiday.js#L60)
- [src/apis/life/moyu.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/moyu.js#L1), [src/apis/life/moyu.js:83](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/moyu.js#L83), [src/apis/life/moyu.js:88](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/moyu.js#L88), [src/apis/life/moyu.js:131](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/moyu.js#L131), [src/apis/life/moyu.js:175](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/moyu.js#L175)
- [src/apis/finance/metals.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/metals.js#L1), [src/apis/finance/metals.js:5](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/metals.js#L5), [src/apis/finance/metals.js:6](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/metals.js#L6), [src/apis/finance/metals.js:88](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/metals.js#L88), [src/apis/finance/metals.js:136](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/metals.js#L136)
- [src/apis/games/free.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/free.js#L1), [src/apis/games/free.js:44](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/free.js#L44), [src/apis/games/free.js:45](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/free.js#L45), [src/apis/games/free.js:46](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/free.js#L46), [src/apis/games/free.js:61](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/free.js#L61)
- [src/apis/hot/sources.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L1), [src/apis/hot/sources.js:15](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L15), [src/apis/hot/sources.js:16](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L16), [src/apis/hot/sources.js:24](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L24), [src/apis/hot/sources.js:34](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L34)
- [src/apis/life/news60s.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/news60s.js#L1), [src/apis/life/news60s.js:20](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/news60s.js#L20), [src/apis/life/news60s.js:42](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/news60s.js#L42), [src/apis/life/news60s.js:47](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/news60s.js#L47), [src/apis/life/news60s.js:59](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/news60s.js#L59)
- [src/lib/proxy.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/lib/proxy.js#L1), [src/lib/proxy.js:2](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/lib/proxy.js#L2), [src/lib/proxy.js:136](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/lib/proxy.js#L136), [src/lib/proxy.js:138](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/lib/proxy.js#L138)

## 游戏与热榜的优先结论

Minecraft已经是Java版Server List Ping实现，不使用mcstatus.io等状态代理。它解析DNS/SRV并检查所有结果、拒绝内网/保留IP，固定连接所验证IP，约束端口/时限/包长，favicon来自被测服务器。只能直查Java服务器；Bedrock UDP不是已实现能力。现有防护不应在“自建”重构时删除。

Steam限免是商店搜索结果中的100%折扣候选，不能等同所有Free to Keep活动，也不能将免费本体/试玩周末/普通特惠混为永久限免。已检视的Steam官方文档没有给出通用集中全量限免列表；发行商`IStoreService/GetAppPriceInfo`要求publisher访问语境，不是为所有游戏提供的通用公开商店API。史低价目前只有配置现有ITAD Key才补；自己的价格采样仅能声称从记录日起的最低，不能回填未知全历史。参见[Steam Free to Keep文档](https://partner.steamgames.com/doc/marketing/discounts/freetokeep)、[IStoreService文档](https://partner.steamgames.com/doc/webapi/IStoreService)。

Epic/GOG/Xbox仍直接接平台；PS Plus直接读PlayStation Blog RSS，来源本身是第一方公开发布。GOG当前第一页最多48个候选，不承诺所有地区全量覆盖。热榜除HN的Algolia备用外，多数已直连平台；GitHub Trending抓HTML，改成自己按Star算榜会改变口径。HN主源是官方Firebase，Algolia备用排序不完全等同主站。CSDN失败应如实提示平台访问限制，不通过换代理宣称“消除了上游依赖”。[HN官方API说明](https://github.com/HackerNews/API)支持其主源身份。

## 逐模块清单

优先级：P0=已有本地或第一方直连，不重复开发；P1已改=本轮安全落地；P2=可自备数据/快照，须维护与许可；P3=实时、平台独有、模型、多地服务或授权数据依赖。本报告不把P2/P3描述为已经部署。

### games · 8模块 / 11地址

#### 游戏限免汇总 · `games-free`

- 调用：`GET /api/games/free`。
- 类型：混合来源/可选联网（界面“混合来源”；联网范围`required`）。本站并行调用Epic/Steam/GOG加载器，继承各平台第一方接口及封面依赖，不是第三方聚合API。
- 主/备/间接来源：`store-site-backend-static-ipv4.ak.epicgames.com`、`store.steampowered.com`、`catalog.gog.com`。媒体/静态资源：三平台返回封面/CDN地址，未镜像。
- 整改与优先级：**P0 已有直连**。保留平台直连；自建聚合逻辑已经存在。实时限免仍须平台或经授权来源。
- 数据、许可、资源：地区/领取时段/价格口径和图片使用条款；单平台失败返回其余与errors。
- 基准证据：[src/apis/games/free.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/free.js#L1), [src/apis/games/free.js:44](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/free.js#L44), [src/apis/games/free.js:45](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/free.js#L45), [src/apis/games/free.js:46](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/free.js#L46), [src/apis/games/free.js:61](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/free.js#L61)。

#### Epic 每周免费游戏 · `epic`

- 调用：`GET /api/epic/free`。
- 类型：第一方网页/未公开稳定接口（界面“平台网页源”；联网范围`required`）。直接调用Epic商店freeGamesPromotions站内接口。
- 主/备/间接来源：`store-site-backend-static-ipv4.ak.epicgames.com`。媒体/静态资源：Epic上游keyImages返回的images*.epicgames.com等CDN。
- 整改与优先级：**P0 已有直连**。主路径已经第一方；没有可本地推算的实时周免数据，不换代理。
- 数据、许可、资源：Epic地区、推广时间和内容权利；站内接口无公开稳定服务承诺。
- 基准证据：[src/apis/games/epic.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/epic.js#L1), [src/apis/games/epic.js:4](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/epic.js#L4), [src/apis/games/epic.js:33](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/epic.js#L33), [src/apis/games/epic.js:35](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/epic.js#L35), [src/apis/games/epic.js:84](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/epic.js#L84)。

#### Steam 限免与特惠 · `steam`

- 调用：`GET /api/steam/free`；`GET /api/steam/specials`。
- 类型：第一方网页/未公开稳定接口（界面“平台网页源”；联网范围`required`）。Steam商店搜索HTML片段/featuredcategories站内接口；仅100%折扣候选。
- 主/备/间接来源：`store.steampowered.com`。媒体/静态资源：上游Steam封面/CDN如shared*.steamstatic.com，未镜像。
- 整改与优先级：**P0 已有直连**。保留平台直接采集；不能以价格0或特惠榜当成完整Free to Keep。
- 数据、许可、资源：地区价格、永久入库/试玩/本来免费区别；未有通用官方全量限免列表可等价替代。
- 基准证据：[src/apis/games/steam.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/steam.js#L1), [src/apis/games/steam.js:4](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/steam.js#L4), [src/apis/games/steam.js:105](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/steam.js#L105), [src/apis/games/steam.js:107](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/steam.js#L107), [src/apis/games/steam.js:110](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/steam.js#L110)。

#### GOG 限免 · `gog`

- 调用：`GET /api/gog/free`。
- 类型：第一方网页/未公开稳定接口（界面“平台网页源”；联网范围`required`）。直接查询GOG Catalog站内接口，只返回原价>0且现价=0候选，最多第一页48项。
- 主/备/间接来源：`catalog.gog.com`。媒体/静态资源：GOG返回coverHorizontal/coverVertical（常见images*.gog-statics.com）。
- 整改与优先级：**P0 已有直连**。保留平台直连；非通用公开稳定API，不能靠本地算法生成当前促销。
- 数据、许可、资源：分页/地区/商品类型覆盖边界；图片与数据条款。
- 基准证据：[src/apis/games/gog.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/gog.js#L1), [src/apis/games/gog.js:4](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/gog.js#L4), [src/apis/games/gog.js:20](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/gog.js#L20), [src/apis/games/gog.js:30](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/gog.js#L30), [src/apis/games/gog.js:43](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/gog.js#L43)。

#### PS Plus 每月会免 · `psplus`

- 调用：`GET /api/psplus/monthly`。
- 类型：第一方官方公开源（界面“官方公开源”；联网范围`required`）。直接读取PlayStation Blog公开RSS并解析月度会免公告。
- 主/备/间接来源：`blog.playstation.com`。媒体/静态资源：Blog上游RSS图片域名（通常blog.playstation.com/uploads），未镜像。
- 整改与优先级：**P0 已有直连**。已经使用第一方RSS，无需替换；不等于所有地区实时订阅权益清单。
- 数据、许可、资源：RSS时间/地区口径和公告图片权利；保留来源链接。
- 基准证据：[src/apis/games/psplus.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/psplus.js#L1), [src/apis/games/psplus.js:6](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/psplus.js#L6), [src/apis/games/psplus.js:7](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/psplus.js#L7), [src/apis/games/psplus.js:78](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/psplus.js#L78), [src/apis/games/psplus.js:82](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/psplus.js#L82)。

#### Xbox Game Pass · `gamepass`

- 调用：`GET /api/gamepass`。
- 类型：第一方网页/未公开稳定接口（界面“平台网页源”；联网范围`required`）。直接调用Xbox catalog.gamepass.com列表和Microsoft Store displaycatalog商品详情。
- 主/备/间接来源：`catalog.gamepass.com`、`displaycatalog.mp.microsoft.com`。媒体/静态资源：Microsoft返回LocalizedProperties.Images.Uri（动态CDN，未镜像）。
- 整改与优先级：**P0 已有直连**。已经第一方直连，不需要第三方API代理；无法离线推断新入库/离库名单。
- 数据、许可、资源：市场与语言、站内列表ID变化、图片权利。
- 基准证据：[src/apis/games/gamepass.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/gamepass.js#L1), [src/apis/games/gamepass.js:53](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/gamepass.js#L53), [src/apis/games/gamepass.js:58](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/gamepass.js#L58), [src/apis/games/gamepass.js:60](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/gamepass.js#L60), [src/apis/games/gamepass.js:61](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/gamepass.js#L61)。

#### Steam 游戏查询 · `steam-info`

- 调用：`GET /api/steam/app`；`GET /api/steam/search`；`GET /api/steam/players`。
- 类型：混合来源/可选联网（界面“混合来源”；联网范围`required`）。app/search用Steam商店未公开稳定接口；players用Steam Web API；史低仅已有ITAD Key时请求。
- 主/备/间接来源：`store.steampowered.com`、`api.steampowered.com`、`api.isthereanydeal.com`。媒体/静态资源：Steam头图/截图/CDN，未镜像。
- 整改与优先级：**P2 需历史数据**。官方players已经直连；史低可自采样但仅从记录日起算，不能冒充全历史最低；本轮保留可选ITAD。
- 数据、许可、资源：ITAD真实现有Key及条款；publisher GetAppPriceInfo不是通用公开商店接口。
- 基准证据：[src/apis/games/steam-info.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/steam-info.js#L1), [src/apis/games/steam-info.js:5](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/steam-info.js#L5), [src/apis/games/steam-info.js:6](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/steam-info.js#L6), [src/apis/games/steam-info.js:90](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/steam-info.js#L90), [src/apis/games/steam-info.js:93](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/steam-info.js#L93)。

#### Minecraft 服务器状态 · `mc-server`

- 调用：`GET /api/mc/server`。
- 类型：直接目标协议或网页（界面“目标直查”；联网范围`target`）。已经原生Java版Server List Ping：DNS/SRV解析、TCP状态握手、延迟与服务器返回favicon。
- 主/备/间接来源：`{目标Minecraft服务器}`、`{DNS/SRV解析器}`。媒体/静态资源：favicon为目标服务器返回的PNG data URI，无外部图片代理。
- 整改与优先级：**P0 已有**。已实现，不列为待开发；Bedrock UDP是另一个功能，当前未支持。
- 数据、许可、资源：现有SSRF防护、解析所有地址并固定连接IP、端口1024–65535、总5秒/64KB限制。
- 基准证据：[src/apis/games/mc-server.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/mc-server.js#L1), [src/apis/games/mc-server.js:329](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/games/mc-server.js#L329)。

### hot · 14模块 / 15地址

#### 微博热搜 · `hot-weibo`

- 调用：`GET /api/hot/weibo`。
- 类型：第一方网页/未公开稳定接口（界面“平台网页源”；联网范围`required`）。微博站内热搜JSON；直接访问平台，不经第三方热榜服务。
- 主/备/间接来源：`weibo.com`。媒体/静态资源：当前标准化条目无媒体图片字段；文章/讨论url仍是外部链接。
- 整改与优先级：**P0 已有直连**。已经第一方直连；自建采集只减少中转，不能独立产生该平台的真实热度。
- 数据、许可、资源：平台访问条款、结构变化、频率与封面权利；不能绕过访问限制。
- 基准证据：[src/apis/hot/index.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L1), [src/apis/hot/index.js:41](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L41), [src/apis/hot/index.js:42](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L42), [src/apis/hot/index.js:47](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L47), [src/apis/hot/index.js:53](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L53)。
- 共享/解析证据：[src/apis/hot/sources.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L1), [src/apis/hot/sources.js:15](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L15), [src/apis/hot/sources.js:16](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L16), [src/apis/hot/sources.js:24](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L24), [src/apis/hot/sources.js:34](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L34)；[src/apis/hot/parsers.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L1), [src/apis/hot/parsers.js:52](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L52), [src/apis/hot/parsers.js:73](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L73), [src/apis/hot/parsers.js:94](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L94), [src/apis/hot/parsers.js:117](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L117)。
- 对应网络路径：[src/apis/hot/sources.js:134](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L134)。

#### 知乎热榜 · `hot-zhihu`

- 调用：`GET /api/hot/zhihu`。
- 类型：第一方网页/未公开稳定接口（界面“平台网页源”；联网范围`required`）。知乎站内hot-lists JSON；直接访问平台，不经第三方热榜服务。
- 主/备/间接来源：`api.zhihu.com`。媒体/静态资源：cover来自target缩略图/image_area（常见zhimg.com），未镜像。
- 整改与优先级：**P0 已有直连**。已经第一方直连；自建采集只减少中转，不能独立产生该平台的真实热度。
- 数据、许可、资源：平台访问条款、结构变化、频率与封面权利；不能绕过访问限制。
- 基准证据：[src/apis/hot/index.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L1), [src/apis/hot/index.js:41](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L41), [src/apis/hot/index.js:42](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L42), [src/apis/hot/index.js:47](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L47), [src/apis/hot/index.js:53](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L53)。
- 共享/解析证据：[src/apis/hot/sources.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L1), [src/apis/hot/sources.js:15](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L15), [src/apis/hot/sources.js:16](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L16), [src/apis/hot/sources.js:24](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L24), [src/apis/hot/sources.js:34](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L34)；[src/apis/hot/parsers.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L1), [src/apis/hot/parsers.js:52](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L52), [src/apis/hot/parsers.js:73](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L73), [src/apis/hot/parsers.js:94](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L94), [src/apis/hot/parsers.js:117](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L117)。
- 对应网络路径：[src/apis/hot/sources.js:144](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L144)。

#### B 站热门 · `hot-bilibili`

- 调用：`GET /api/hot/bilibili`。
- 类型：第一方网页/未公开稳定接口（界面“平台网页源”；联网范围`required`）。B站nav取WBI签名后请求popular/ranking，同平台签名重试；直接访问平台，不经第三方热榜服务。
- 主/备/间接来源：`api.bilibili.com`。媒体/静态资源：cover来自v.pic（常见biliimg.com），未镜像。
- 整改与优先级：**P0 已有直连**。已经第一方直连；自建采集只减少中转，不能独立产生该平台的真实热度。
- 数据、许可、资源：平台访问条款、结构变化、频率与封面权利；不能绕过访问限制。
- 基准证据：[src/apis/hot/index.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L1), [src/apis/hot/index.js:41](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L41), [src/apis/hot/index.js:42](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L42), [src/apis/hot/index.js:47](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L47), [src/apis/hot/index.js:53](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L53)。
- 共享/解析证据：[src/apis/hot/sources.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L1), [src/apis/hot/sources.js:15](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L15), [src/apis/hot/sources.js:16](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L16), [src/apis/hot/sources.js:24](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L24), [src/apis/hot/sources.js:34](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L34)；[src/apis/hot/parsers.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L1), [src/apis/hot/parsers.js:52](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L52), [src/apis/hot/parsers.js:73](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L73), [src/apis/hot/parsers.js:94](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L94), [src/apis/hot/parsers.js:117](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L117)。
- 对应网络路径：[src/apis/hot/sources.js:24](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L24), [src/apis/hot/sources.js:50](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L50), [src/apis/hot/sources.js:52](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L52), [src/apis/hot/sources.js:53](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L53), [src/apis/hot/sources.js:56](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L56), [src/apis/hot/sources.js:152](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L152)。

#### 抖音热点 · `hot-douyin`

- 调用：`GET /api/hot/douyin`。
- 类型：第一方网页/未公开稳定接口（界面“平台网页源”；联网范围`required`）。抖音站内热点JSON，匿名Cookie辅助；未绕过付费/登录；直接访问平台，不经第三方热榜服务。
- 主/备/间接来源：`www.douyin.com`。媒体/静态资源：cover来自word_cover.url_list[0]（动态图片CDN），未镜像。
- 整改与优先级：**P0 已有直连**。已经第一方直连；自建采集只减少中转，不能独立产生该平台的真实热度。
- 数据、许可、资源：平台访问条款、结构变化、频率与封面权利；不能绕过访问限制。
- 基准证据：[src/apis/hot/index.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L1), [src/apis/hot/index.js:41](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L41), [src/apis/hot/index.js:42](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L42), [src/apis/hot/index.js:47](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L47), [src/apis/hot/index.js:53](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L53)。
- 共享/解析证据：[src/apis/hot/sources.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L1), [src/apis/hot/sources.js:15](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L15), [src/apis/hot/sources.js:16](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L16), [src/apis/hot/sources.js:24](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L24), [src/apis/hot/sources.js:34](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L34)；[src/apis/hot/parsers.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L1), [src/apis/hot/parsers.js:52](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L52), [src/apis/hot/parsers.js:73](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L73), [src/apis/hot/parsers.js:94](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L94), [src/apis/hot/parsers.js:117](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L117)。
- 对应网络路径：[src/apis/hot/sources.js:63](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L63), [src/apis/hot/sources.js:80](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L80)。

#### 百度热搜 · `hot-baidu`

- 调用：`GET /api/hot/baidu`。
- 类型：第一方网页/未公开稳定接口（界面“平台网页源”；联网范围`required`）。百度热搜HTML；直接访问平台，不经第三方热榜服务。
- 主/备/间接来源：`top.baidu.com`。媒体/静态资源：cover来自v.img（动态图片URL），未镜像。
- 整改与优先级：**P0 已有直连**。已经第一方直连；自建采集只减少中转，不能独立产生该平台的真实热度。
- 数据、许可、资源：平台访问条款、结构变化、频率与封面权利；不能绕过访问限制。
- 基准证据：[src/apis/hot/index.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L1), [src/apis/hot/index.js:41](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L41), [src/apis/hot/index.js:42](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L42), [src/apis/hot/index.js:47](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L47), [src/apis/hot/index.js:53](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L53)。
- 共享/解析证据：[src/apis/hot/sources.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L1), [src/apis/hot/sources.js:15](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L15), [src/apis/hot/sources.js:16](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L16), [src/apis/hot/sources.js:24](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L24), [src/apis/hot/sources.js:34](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L34)；[src/apis/hot/parsers.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L1), [src/apis/hot/parsers.js:52](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L52), [src/apis/hot/parsers.js:73](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L73), [src/apis/hot/parsers.js:94](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L94), [src/apis/hot/parsers.js:117](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L117)。
- 对应网络路径：[src/apis/hot/sources.js:160](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L160)。

#### 今日头条热榜 · `hot-toutiao`

- 调用：`GET /api/hot/toutiao`。
- 类型：第一方网页/未公开稳定接口（界面“平台网页源”；联网范围`required`）。头条站内热榜JSON；直接访问平台，不经第三方热榜服务。
- 主/备/间接来源：`www.toutiao.com`。媒体/静态资源：cover来自Image.url（动态图片URL），未镜像。
- 整改与优先级：**P0 已有直连**。已经第一方直连；自建采集只减少中转，不能独立产生该平台的真实热度。
- 数据、许可、资源：平台访问条款、结构变化、频率与封面权利；不能绕过访问限制。
- 基准证据：[src/apis/hot/index.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L1), [src/apis/hot/index.js:41](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L41), [src/apis/hot/index.js:42](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L42), [src/apis/hot/index.js:47](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L47), [src/apis/hot/index.js:53](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L53)。
- 共享/解析证据：[src/apis/hot/sources.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L1), [src/apis/hot/sources.js:15](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L15), [src/apis/hot/sources.js:16](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L16), [src/apis/hot/sources.js:24](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L24), [src/apis/hot/sources.js:34](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L34)；[src/apis/hot/parsers.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L1), [src/apis/hot/parsers.js:52](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L52), [src/apis/hot/parsers.js:73](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L73), [src/apis/hot/parsers.js:94](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L94), [src/apis/hot/parsers.js:117](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L117)。
- 对应网络路径：[src/apis/hot/sources.js:170](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L170)。

#### GitHub Trending · `hot-github`

- 调用：`GET /api/hot/github`。
- 类型：第一方网页/未公开稳定接口（界面“平台网页源”；联网范围`required`）。GitHub Trending HTML；不是GitHub文档化趋势API；直接访问平台，不经第三方热榜服务。
- 主/备/间接来源：`github.com`。媒体/静态资源：当前标准化条目无媒体图片字段；文章/讨论url仍是外部链接。
- 整改与优先级：**P0 已有直连**。已经第一方直连；自建采集只减少中转，不能独立产生该平台的真实热度。
- 数据、许可、资源：平台访问条款、结构变化、频率与封面权利；不能绕过访问限制。
- 基准证据：[src/apis/hot/index.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L1), [src/apis/hot/index.js:41](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L41), [src/apis/hot/index.js:42](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L42), [src/apis/hot/index.js:47](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L47), [src/apis/hot/index.js:53](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L53)。
- 共享/解析证据：[src/apis/hot/sources.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L1), [src/apis/hot/sources.js:15](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L15), [src/apis/hot/sources.js:16](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L16), [src/apis/hot/sources.js:24](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L24), [src/apis/hot/sources.js:34](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L34)；[src/apis/hot/parsers.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L1), [src/apis/hot/parsers.js:52](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L52), [src/apis/hot/parsers.js:73](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L73), [src/apis/hot/parsers.js:94](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L94), [src/apis/hot/parsers.js:117](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L117)。
- 对应网络路径：[src/apis/hot/sources.js:183](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L183)。

#### V2EX 热门 · `hot-v2ex`

- 调用：`GET /api/hot/v2ex`。
- 类型：第一方官方公开源（界面“官方公开源”；联网范围`required`）。V2EX官方公开topics/hot.json API。
- 主/备/间接来源：`www.v2ex.com`。媒体/静态资源：当前解析器不返回头像/封面；保留主题和作者信息及外部讨论链接。
- 整改与优先级：**P0 已有直连**。已第一方公开API，无需替换；自建论坛热度不等于V2EX。
- 数据、许可、资源：V2EXAPI条款与访问频率。
- 基准证据：[src/apis/hot/index.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L1), [src/apis/hot/index.js:41](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L41), [src/apis/hot/index.js:42](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L42), [src/apis/hot/index.js:47](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L47), [src/apis/hot/index.js:53](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L53)。
- 共享/解析证据：[src/apis/hot/sources.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L1), [src/apis/hot/sources.js:15](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L15), [src/apis/hot/sources.js:16](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L16), [src/apis/hot/sources.js:24](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L24), [src/apis/hot/sources.js:34](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L34)；[src/apis/hot/parsers.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L1), [src/apis/hot/parsers.js:52](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L52), [src/apis/hot/parsers.js:73](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L73), [src/apis/hot/parsers.js:94](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L94), [src/apis/hot/parsers.js:117](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L117)。
- 对应网络路径：[src/apis/hot/sources.js:194](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L194)。

#### 科技资讯 · `hot-news`

- 调用：`GET /api/hot/news`。
- 类型：第一方官方公开源（界面“官方公开源”；联网范围`required`）。IT之家/36氪/少数派各自公开RSS，直接读取发布者源；不是热度排名。
- 主/备/间接来源：`www.ithome.com`、`36kr.com`、`sspai.com`。媒体/静态资源：当前热榜RSS解析器不返回图片字段；url指向发布者文章，摘要去HTML。
- 整改与优先级：**P0 已有直连**。已直接RSS；自建抓取与缓存仍依赖编辑部发布。
- 数据、许可、资源：三发布者RSS、文章与封面许可；保持最新资讯与热榜语义区分。
- 基准证据：[src/apis/hot/index.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L1), [src/apis/hot/index.js:41](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L41), [src/apis/hot/index.js:42](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L42), [src/apis/hot/index.js:47](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L47), [src/apis/hot/index.js:53](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L53)。
- 共享/解析证据：[src/apis/hot/sources.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L1), [src/apis/hot/sources.js:15](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L15), [src/apis/hot/sources.js:16](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L16), [src/apis/hot/sources.js:24](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L24), [src/apis/hot/sources.js:34](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L34)；[src/apis/hot/parsers.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L1), [src/apis/hot/parsers.js:52](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L52), [src/apis/hot/parsers.js:73](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L73), [src/apis/hot/parsers.js:94](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L94), [src/apis/hot/parsers.js:117](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L117)。
- 对应网络路径：[src/apis/hot/sources.js:110](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L110), [src/apis/hot/sources.js:111](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L111), [src/apis/hot/sources.js:112](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L112)。

#### Hacker News · `hot-hackernews`

- 调用：`GET /api/hot/hackernews`。
- 类型：混合来源/可选联网（界面“混合来源”；联网范围`required`）。主路径HN官方Firebase topstories+item；失败退Algolia的front_page搜索，排序口径可能不同。
- 主/备/间接来源：`hacker-news.firebaseio.com`、`hn.algolia.com`。媒体/静态资源：无。
- 整改与优先级：**P0 已有直连**。主路径已官方；保留可用备用并标明差异，不把Algolia误标完全官方或同序。
- 数据、许可、资源：HN API与Algolia条款；文章链接指向外部投稿网站。
- 基准证据：[src/apis/hot/index.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L1), [src/apis/hot/index.js:41](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L41), [src/apis/hot/index.js:42](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L42), [src/apis/hot/index.js:47](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L47), [src/apis/hot/index.js:53](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L53)。
- 共享/解析证据：[src/apis/hot/sources.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L1), [src/apis/hot/sources.js:15](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L15), [src/apis/hot/sources.js:16](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L16), [src/apis/hot/sources.js:24](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L24), [src/apis/hot/sources.js:34](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L34)；[src/apis/hot/parsers.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L1), [src/apis/hot/parsers.js:52](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L52), [src/apis/hot/parsers.js:73](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L73), [src/apis/hot/parsers.js:94](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L94), [src/apis/hot/parsers.js:117](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L117)。
- 对应网络路径：[src/apis/hot/sources.js:90](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L90), [src/apis/hot/sources.js:101](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L101)。

#### 掘金热榜 · `hot-juejin`

- 调用：`GET /api/hot/juejin`。
- 类型：第一方网页/未公开稳定接口（界面“平台网页源”；联网范围`required`）。掘金站内文章热度榜；直接访问平台，不经第三方热榜服务。
- 主/备/间接来源：`api.juejin.cn`。媒体/静态资源：当前标准化条目无媒体图片字段；文章/讨论url仍是外部链接。
- 整改与优先级：**P0 已有直连**。已经第一方直连；自建采集只减少中转，不能独立产生该平台的真实热度。
- 数据、许可、资源：平台访问条款、结构变化、频率与封面权利；不能绕过访问限制。
- 基准证据：[src/apis/hot/index.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L1), [src/apis/hot/index.js:41](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L41), [src/apis/hot/index.js:42](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L42), [src/apis/hot/index.js:47](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L47), [src/apis/hot/index.js:53](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L53)。
- 共享/解析证据：[src/apis/hot/sources.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L1), [src/apis/hot/sources.js:15](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L15), [src/apis/hot/sources.js:16](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L16), [src/apis/hot/sources.js:24](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L24), [src/apis/hot/sources.js:34](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L34)；[src/apis/hot/parsers.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L1), [src/apis/hot/parsers.js:52](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L52), [src/apis/hot/parsers.js:73](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L73), [src/apis/hot/parsers.js:94](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L94), [src/apis/hot/parsers.js:117](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L117)。
- 对应网络路径：[src/apis/hot/sources.js:206](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L206)。

#### CSDN 热榜 · `hot-csdn`

- 调用：`GET /api/hot/csdn`。
- 类型：第一方网页/未公开稳定接口（界面“平台网页源”；联网范围`required`）。CSDN站内榜单；521/403等访问限制返回错误；直接访问平台，不经第三方热榜服务。
- 主/备/间接来源：`blog.csdn.net`。媒体/静态资源：cover来自picList首个有效HTTP图片URL（常见csdnimg.cn），未镜像。
- 整改与优先级：**P0 已有直连**。已经第一方直连；自建采集只减少中转，不能独立产生该平台的真实热度。
- 数据、许可、资源：平台访问条款、结构变化、频率与封面权利；不能绕过访问限制。
- 基准证据：[src/apis/hot/index.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L1), [src/apis/hot/index.js:41](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L41), [src/apis/hot/index.js:42](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L42), [src/apis/hot/index.js:47](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L47), [src/apis/hot/index.js:53](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L53)。
- 共享/解析证据：[src/apis/hot/sources.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L1), [src/apis/hot/sources.js:15](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L15), [src/apis/hot/sources.js:16](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L16), [src/apis/hot/sources.js:24](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L24), [src/apis/hot/sources.js:34](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L34)；[src/apis/hot/parsers.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L1), [src/apis/hot/parsers.js:52](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L52), [src/apis/hot/parsers.js:73](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L73), [src/apis/hot/parsers.js:94](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L94), [src/apis/hot/parsers.js:117](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L117)。
- 对应网络路径：[src/apis/hot/sources.js:216](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L216)。

#### 百度贴吧热议 · `hot-tieba`

- 调用：`GET /api/hot/tieba`。
- 类型：第一方网页/未公开稳定接口（界面“平台网页源”；联网范围`required`）。贴吧热议HTML/兼容旧JSON；直接访问平台，不经第三方热榜服务。
- 主/备/间接来源：`tieba.baidu.com`。媒体/静态资源：cover来自topic_pic或picList（动态百度图片URL），未镜像。
- 整改与优先级：**P0 已有直连**。已经第一方直连；自建采集只减少中转，不能独立产生该平台的真实热度。
- 数据、许可、资源：平台访问条款、结构变化、频率与封面权利；不能绕过访问限制。
- 基准证据：[src/apis/hot/index.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L1), [src/apis/hot/index.js:41](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L41), [src/apis/hot/index.js:42](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L42), [src/apis/hot/index.js:47](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L47), [src/apis/hot/index.js:53](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L53)。
- 共享/解析证据：[src/apis/hot/sources.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L1), [src/apis/hot/sources.js:15](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L15), [src/apis/hot/sources.js:16](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L16), [src/apis/hot/sources.js:24](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L24), [src/apis/hot/sources.js:34](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L34)；[src/apis/hot/parsers.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L1), [src/apis/hot/parsers.js:52](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L52), [src/apis/hot/parsers.js:73](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L73), [src/apis/hot/parsers.js:94](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L94), [src/apis/hot/parsers.js:117](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L117)。
- 对应网络路径：[src/apis/hot/sources.js:233](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L233)。

#### 热榜合集 · `hot-all`

- 调用：`GET /api/hot/all`；`GET /api/hot/sources`。
- 类型：混合来源/可选联网（界面“混合来源”；联网范围`required`）。本站调用15个来源适配器（含3个RSS源）；只HN备用用Algolia，无不明第三方热榜聚合代理。
- 主/备/间接来源：`weibo.com`、`api.zhihu.com`、`api.bilibili.com`、`www.douyin.com`、`top.baidu.com`、`www.toutiao.com`、`github.com`、`www.v2ex.com`、`www.ithome.com`、`36kr.com`、`sspai.com`、`api.juejin.cn`、`blog.csdn.net`、`tieba.baidu.com`、`hacker-news.firebaseio.com`、`hn.algolia.com`。媒体/静态资源：继承所选来源返回的封面/链接；没有统一本地图片镜像。
- 整改与优先级：**P0 已有直连**。多来源聚合已经自建；不能将5分钟缓存称独立热榜数据生产。
- 数据、许可、资源：各平台条款和错误隔离；source启停与限流规则保持。
- 基准证据：[src/apis/hot/index.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L1), [src/apis/hot/index.js:41](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L41), [src/apis/hot/index.js:42](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L42), [src/apis/hot/index.js:47](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L47), [src/apis/hot/index.js:53](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/index.js#L53)。
- 共享/解析证据：[src/apis/hot/sources.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L1), [src/apis/hot/sources.js:15](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L15), [src/apis/hot/sources.js:16](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L16), [src/apis/hot/sources.js:24](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L24), [src/apis/hot/sources.js:34](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/sources.js#L34)；[src/apis/hot/parsers.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L1), [src/apis/hot/parsers.js:52](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L52), [src/apis/hot/parsers.js:73](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L73), [src/apis/hot/parsers.js:94](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L94), [src/apis/hot/parsers.js:117](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/hot/parsers.js#L117)。

### life · 24模块 / 33地址

#### 天气预报 · `weather`

- 调用：`GET /api/weather`；`GET /api/weather/city`。
- 类型：第三方数据服务（界面“第三方数据”；联网范围`required`）。Open-Meteo公开天气/地理编码；配置和风时改用和风API，并非天气观测自产。
- 主/备/间接来源：`api.open-meteo.com`、`geocoding-api.open-meteo.com`、`{QWEATHER_API_HOST}`。媒体/静态资源：无。
- 整改与优先级：**P3 需基础数据**。可自建Open-Meteo服务与地理编码，但仍要模型/观测输入、抓取更新；本轮保留正常接入。
- 数据、许可、资源：Open-Meteo自托管许可、气象数据许可、存储带宽与定时数据同步；和风真实Key/服务域名，不能暗配。
- 基准证据：[src/apis/life/weather.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/weather.js#L1), [src/apis/life/weather.js:135](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/weather.js#L135), [src/apis/life/weather.js:137](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/weather.js#L137), [src/apis/life/weather.js:146](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/weather.js#L146), [src/apis/life/weather.js:147](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/weather.js#L147)。

#### 节假日与调休 · `holiday`

- 调用：`GET /api/holiday`；`GET /api/holiday/next`；`GET /api/holiday/year`。
- 类型：混合来源/可选联网（界面“本地优先”；联网范围`conditional`）。2025/2026直接使用内置安排；其他年份调用第三方整理的holiday-cn，并非国务院官方API。
- 主/备/间接来源：`cdn.jsdelivr.net`。媒体/静态资源：无。
- 整改与优先级：**P1 已改**。本轮已将已内置年份改为直接返回；其余年份保留服务，未来安排不能靠算法推断。
- 数据、许可、资源：现有2025/2026表已核对官方安排；年度维护/通知来源与数据许可，未知年份不可冒充已发布。
- 基准证据：[src/apis/life/holiday.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/holiday.js#L1), [src/apis/life/holiday.js:7](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/holiday.js#L7), [src/apis/life/holiday.js:54](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/holiday.js#L54), [src/apis/life/holiday.js:57](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/holiday.js#L57), [src/apis/life/holiday.js:60](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/holiday.js#L60)。

#### 农历黄历 · `lunar`

- 调用：`GET /api/lunar`。
- 类型：本地数据/自有持久数据（界面“本地数据”；联网范围`none`）。本地农历表、行政区表与算法；有日期和区划覆盖边界。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有内置表；行政区变动、农历1900–2100范围需随版本维护。
- 基准证据：[src/apis/life/lunar.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/lunar.js#L1), [src/apis/life/lunar.js:324](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/lunar.js#L324)。

#### 今日油价 · `oil`

- 调用：`GET /api/oil`。
- 类型：第三方数据服务（界面“第三方数据”；联网范围`required`）。直接抓取汽油价格网价格表；第三方数据网站，不是其他API代理。
- 主/备/间接来源：`www.qiyoujiage.com`。媒体/静态资源：无。
- 整改与优先级：**P2 需数据**。可自采省级油价通知并维护结构化表，须核对生效日期与地区；当前无可靠同义全量本地数据。
- 数据、许可、资源：各地发改委公告与持续人工/采集维护，保存来源与适用日期。
- 基准证据：[src/apis/life/oil.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/oil.js#L1), [src/apis/life/oil.js:44](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/oil.js#L44), [src/apis/life/oil.js:47](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/oil.js#L47), [src/apis/life/oil.js:55](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/oil.js#L55), [src/apis/life/oil.js:78](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/oil.js#L78)。

#### 快递查询 · `express`

- 调用：`GET /api/express`；`GET /api/express/companies`。
- 类型：第三方数据服务（界面“第三方数据”；联网范围`required`）。快递100官方查询服务/自动识别；相对于物流承运商是聚合数据。
- 主/备/间接来源：`poll.kuaidi100.com`、`www.kuaidi100.com`。媒体/静态资源：无。
- 整改与优先级：**P3 需授权**。可接各承运商授权API；不能本地算法生成真实轨迹，保留现有可用查询。
- 数据、许可、资源：真实快递100 Key/customer或各承运商合同与授权；不要购买/配置。
- 基准证据：[src/apis/life/express.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/express.js#L1), [src/apis/life/express.js:5](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/express.js#L5), [src/apis/life/express.js:6](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/express.js#L6), [src/apis/life/express.js:104](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/express.js#L104), [src/apis/life/express.js:109](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/express.js#L109)。

#### IP 归属地 · `ip`

- 调用：`GET /api/ip`。
- 类型：混合来源/可选联网（界面“本地优先”；联网范围`conditional`）。国内IPv4城市命中可全本地；其他/IPv6/ASN仍用ip-api补全，失败可退本地。
- 主/备/间接来源：`ip-api.com`。媒体/静态资源：无。
- 整改与优先级：**P1 已改**。已有IPv4离线库；本轮新增mode=offline确保不联网，无记录404。IPv6/ASN需另备许可数据库。
- 数据、许可、资源：现有11.1MB ip2region IPv4（2026-09-01，Apache-2.0/MIT）；未含IPv6、坐标和ASN，HTTP免费在线源有额度/商业条款限制。
- 基准证据：[src/apis/life/ip.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/ip.js#L1), [src/apis/life/ip.js:69](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/ip.js#L69), [src/apis/life/ip.js:100](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/ip.js#L100), [src/apis/life/ip.js:124](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/ip.js#L124), [src/apis/life/ip.js:135](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/ip.js#L135)。
- 共享/解析证据：[src/apis/life/offline-db.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/offline-db.js#L1)；[src/apis/life/data/README.md:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/data/README.md#L1), [src/apis/life/data/README.md:7](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/data/README.md#L7), [src/apis/life/data/README.md:17](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/data/README.md#L17)。

#### 手机号归属地 · `phone`

- 调用：`GET /api/phone`。
- 类型：混合来源/可选联网（界面“本地优先”；联网范围`conditional`）。现有本地手机号段库优先，未命中才调用360非正式号码归属查询。
- 主/备/间接来源：`cx.shouji.360.cn`。媒体/静态资源：无。
- 整改与优先级：**P1 已改**。本轮新增mode=offline确保不联网，无记录404；不重复开发已有号段解析。
- 数据、许可、资源：现有4.5MB lovedboy/phone MIT号段库版本2312（2023-12）；新号段、携号转网需维护，不能当实时实名信息。
- 基准证据：[src/apis/life/phone.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/phone.js#L1), [src/apis/life/phone.js:41](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/phone.js#L41), [src/apis/life/phone.js:59](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/phone.js#L59), [src/apis/life/phone.js:64](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/phone.js#L64), [src/apis/life/phone.js:70](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/phone.js#L70)。
- 共享/解析证据：[src/apis/life/offline-db.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/offline-db.js#L1)；[src/apis/life/data/README.md:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/data/README.md#L1), [src/apis/life/data/README.md:7](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/data/README.md#L7), [src/apis/life/data/README.md:17](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/data/README.md#L17)。

#### 历史上的今天 · `history-today`

- 调用：`GET /api/history/today`。
- 类型：第一方网页/未公开稳定接口（界面“平台网页源”；联网范围`required`）。百度百科站内历史事件JSON，未见公开稳定API规范。
- 主/备/间接来源：`baike.baidu.com`。媒体/静态资源：百度百科pic_share外部图片URL（上游动态域名），未镜像。
- 整改与优先级：**P2 需数据**。可用获授权的历史事件数据集本地日期索引；需逐条校对、来源与许可，不直接镜像百科内容冒充自由数据。
- 数据、许可、资源：可再分发历史事件表及校对；事实可核对，但原文与图片版权须分别处理。
- 基准证据：[src/apis/life/history.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/history.js#L1), [src/apis/life/history.js:33](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/history.js#L33), [src/apis/life/history.js:37](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/history.js#L37), [src/apis/life/history.js:46](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/history.js#L46), [src/apis/life/history.js:71](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/history.js#L71)。

#### 60 秒读懂世界 · `news-60s`

- 调用：`GET /api/news/60s`；`GET /api/news/60s/assets/:revision/:file`。
- 类型：本地数据/自有持久数据（界面“本地数据”；联网范围`none`）。公开读取只访问本站持久JSON/SQLite和镜像图片；内容须先导入。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：已发布图片由本站assets路由提供；来源文章link仍为外部链接。
- 整改与优先级：**P0 已有**。已在v0.12.0实现持久读取/受控导入，无需重做；可靠自动文章发现仍待解决。
- 数据、许可、资源：自有可编辑内容或获授权来源、持久磁盘与管理员导入/自建调度；空库503、历史缺期404。
- 基准证据：[src/apis/life/news60s.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/news60s.js#L1), [src/apis/life/news60s.js:20](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/news60s.js#L20), [src/apis/life/news60s.js:42](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/news60s.js#L42), [src/apis/life/news60s.js:47](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/news60s.js#L47), [src/apis/life/news60s.js:59](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/news60s.js#L59)。
- 共享/解析证据：[src/lib/news60s/store.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/lib/news60s/store.js#L1)；[src/lib/news60s/update.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/lib/news60s/update.js#L1)；[src/lib/news60s/download.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/lib/news60s/download.js#L1), [src/lib/news60s/download.js:9](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/lib/news60s/download.js#L9), [src/lib/news60s/download.js:53](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/lib/news60s/download.js#L53)。

#### 摸鱼日历 · `moyu`

- 调用：`GET /api/moyu`。
- 类型：混合来源/可选联网（界面“本地优先”；联网范围`conditional`）。本地日历和文案；会加载当年与次年安排，已内置2025/2026无需请求，其余年份仍可能联网。
- 主/备/间接来源：`cdn.jsdelivr.net`。媒体/静态资源：无。
- 整改与优先级：**P1 已改**。本轮已将已内置年份改为直接返回；其余年份保留服务，未来安排不能靠算法推断。
- 数据、许可、资源：现有2025/2026表已核对官方安排；年度维护/通知来源与数据许可，未知年份不可冒充已发布。
- 基准证据：[src/apis/life/moyu.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/moyu.js#L1), [src/apis/life/moyu.js:83](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/moyu.js#L83), [src/apis/life/moyu.js:88](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/moyu.js#L88), [src/apis/life/moyu.js:131](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/moyu.js#L131), [src/apis/life/moyu.js:175](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/moyu.js#L175)。
- 共享/解析证据：[src/apis/life/holiday.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/holiday.js#L1), [src/apis/life/holiday.js:7](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/holiday.js#L7), [src/apis/life/holiday.js:54](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/holiday.js#L54), [src/apis/life/holiday.js:57](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/holiday.js#L57), [src/apis/life/holiday.js:60](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/holiday.js#L60)。

#### BMI 计算 · `bmi`

- 调用：`GET /api/bmi`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/life/bmi.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/bmi.js#L1), [src/apis/life/bmi.js:66](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/bmi.js#L66)。

#### 垃圾分类 · `garbage`

- 调用：`GET /api/garbage`。
- 类型：本地数据/自有持久数据（界面“本地数据”；联网范围`none`）。本地分类词库，不访问在线垃圾分类接口。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有整理词库，依据GB/T 19095-2019与上海指引；分类随地区政策不同。
- 基准证据：[src/apis/life/garbage.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/garbage.js#L1), [src/apis/life/garbage.js:88](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/garbage.js#L88)。

#### 个人所得税计算 · `tax`

- 调用：`GET /api/tax/income`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/life/tax.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/tax.js#L1), [src/apis/life/tax.js:111](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/tax.js#L111)。

#### 身份证号校验 · `idcard`

- 调用：`GET /api/idcard/check`。
- 类型：本地数据/自有持久数据（界面“本地数据”；联网范围`none`）。本地农历表、行政区表与算法；有日期和区划覆盖边界。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有内置表；行政区变动、农历1900–2100范围需随版本维护。
- 基准证据：[src/apis/life/idcard.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/idcard.js#L1), [src/apis/life/idcard.js:87](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/idcard.js#L87)。

#### 经纬度距离 · `geo`

- 调用：`GET /api/geo/distance`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/life/geo.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/geo.js#L1), [src/apis/life/geo.js:48](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/geo.js#L48)。

#### 单位换算 · `unit`

- 调用：`GET /api/unit`；`GET /api/unit/list`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/life/unit.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/unit.js#L1), [src/apis/life/unit.js:175](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/unit.js#L175)。

#### 年龄 / 生肖 / 星座 · `age`

- 调用：`GET /api/age`。
- 类型：本地数据/自有持久数据（界面“本地数据”；联网范围`none`）。本地农历表、行政区表与算法；有日期和区划覆盖边界。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有内置表；行政区变动、农历1900–2100范围需随版本维护。
- 基准证据：[src/apis/life/age.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/age.js#L1), [src/apis/life/age.js:106](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/age.js#L106)。

#### 工作日计算 · `workdays`

- 调用：`GET /api/workdays`。
- 类型：混合来源/可选联网（界面“本地优先”；联网范围`conditional`）。计算在本地；2025/2026内置调休安排，其余年份按需查holiday-cn，不能保证所有日期全离线。
- 主/备/间接来源：`cdn.jsdelivr.net`。媒体/静态资源：无。
- 整改与优先级：**P1 已改**。本轮已将已内置年份改为直接返回；其余年份保留服务，未来安排不能靠算法推断。
- 数据、许可、资源：现有2025/2026表已核对官方安排；年度维护/通知来源与数据许可，未知年份不可冒充已发布。
- 基准证据：[src/apis/life/workdays.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/workdays.js#L1), [src/apis/life/workdays.js:23](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/workdays.js#L23), [src/apis/life/workdays.js:31](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/workdays.js#L31), [src/apis/life/workdays.js:116](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/workdays.js#L116)。
- 共享/解析证据：[src/apis/life/holiday.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/holiday.js#L1), [src/apis/life/holiday.js:7](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/holiday.js#L7), [src/apis/life/holiday.js:54](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/holiday.js#L54), [src/apis/life/holiday.js:57](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/holiday.js#L57), [src/apis/life/holiday.js:60](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/holiday.js#L60)。

#### 健康指标计算 · `health`

- 调用：`GET /api/health/calc`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/life/health.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/health.js#L1), [src/apis/life/health.js:98](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/health.js#L98)。

#### 数独 · `sudoku`

- 调用：`GET /api/sudoku`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/life/sudoku.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/sudoku.js#L1), [src/apis/life/sudoku.js:126](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/sudoku.js#L126)。

#### 二十四节气 · `jieqi`

- 调用：`GET /api/jieqi`；`GET /api/jieqi/next`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/life/jieqi.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/jieqi.js#L1), [src/apis/life/jieqi.js:100](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/jieqi.js#L100)。

#### 日出日落与月相 · `sun`

- 调用：`GET /api/sun`；`GET /api/moon`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/life/sun.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/sun.js#L1), [src/apis/life/sun.js:292](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/sun.js#L292)。

#### 世界时间 · `worldtime`

- 调用：`GET /api/time/world`；`GET /api/time/convert`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/life/worldtime.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/worldtime.js#L1), [src/apis/life/worldtime.js:149](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/worldtime.js#L149)。

#### 时间进度 · `progress`

- 调用：`GET /api/progress`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/life/progress.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/progress.js#L1), [src/apis/life/progress.js:128](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/progress.js#L128)。

### finance · 5模块 / 9地址

#### 汇率 · `fx`

- 调用：`GET /api/fx/rates`；`GET /api/fx/convert`。
- 类型：第三方数据服务（界面“第三方数据”；联网范围`required`）。ExchangeRate-API汇率聚合服务。
- 主/备/间接来源：`open.er-api.com`。媒体/静态资源：无。
- 整改与优先级：**P3 需实时源**。保留实时源；自建只能采集有授权汇率，缓存不是自产。
- 数据、许可、资源：交易日/报价时点、覆盖币种、供应商许可和更新服务。
- 基准证据：[src/apis/finance/fx.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/fx.js#L1), [src/apis/finance/fx.js:4](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/fx.js#L4), [src/apis/finance/fx.js:29](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/fx.js#L29), [src/apis/finance/fx.js:31](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/fx.js#L31), [src/apis/finance/fx.js:56](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/fx.js#L56)。

#### 股票行情 · `stock`

- 调用：`GET /api/stock/quote`；`GET /api/stock/search`。
- 类型：第三方数据服务（界面“第三方数据”；联网范围`required`）。腾讯财经行情与证券搜索，非交易所直接授权行情。
- 主/备/间接来源：`qt.gtimg.cn`、`smartbox.gtimg.cn`。媒体/静态资源：无。
- 整改与优先级：**P3 需授权**。可接交易所/券商授权行情；不能靠算法替代实时报价。
- 数据、许可、资源：市场行情授权、实时订阅和证券主数据；现接口非正式、可能延迟或变更。
- 基准证据：[src/apis/finance/stock.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/stock.js#L1), [src/apis/finance/stock.js:4](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/stock.js#L4), [src/apis/finance/stock.js:5](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/stock.js#L5), [src/apis/finance/stock.js:6](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/stock.js#L6), [src/apis/finance/stock.js:167](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/stock.js#L167)。

#### 基金估值与净值 · `fund`

- 调用：`GET /api/fund/estimate`；`GET /api/fund/history`。
- 类型：第三方数据服务（界面“第三方数据”；联网范围`required`）。东方财富/天天基金估值、净值与搜索；多个第一方站内端点，同一供应商。
- 主/备/间接来源：`fundgz.1234567.com.cn`、`api.fund.eastmoney.com`、`fundsuggest.eastmoney.com`。媒体/静态资源：无。
- 整改与优先级：**P3 需授权**。可按基金公司披露自建已公布净值；盘中估值不能等同真实净值，保留原服务。
- 数据、许可、资源：公司披露/授权数据及每日维护；站内接口不构成再分发许可。
- 基准证据：[src/apis/finance/fund.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/fund.js#L1), [src/apis/finance/fund.js:58](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/fund.js#L58), [src/apis/finance/fund.js:59](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/fund.js#L59), [src/apis/finance/fund.js:66](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/fund.js#L66), [src/apis/finance/fund.js:73](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/fund.js#L73)。

#### 加密货币行情 · `crypto`

- 调用：`GET /api/crypto/price`；`GET /api/crypto/markets`。
- 类型：第三方数据服务（界面“第三方数据”；联网范围`required`）。CoinGecko公开行情API，非交易所原始成交数据。
- 主/备/间接来源：`api.coingecko.com`。媒体/静态资源：CoinGecko markets返回image（如coin-images.coingecko.com），未镜像。
- 整改与优先级：**P3 需实时源**。可接交易所公开API自建自己的价格口径，须标明平台和计算口径；不能冒充CoinGecko全量口径。
- 数据、许可、资源：供应商条款、额度和持续行情采集；未调用真实额度。
- 基准证据：[src/apis/finance/crypto.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/crypto.js#L1), [src/apis/finance/crypto.js:4](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/crypto.js#L4), [src/apis/finance/crypto.js:65](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/crypto.js#L65), [src/apis/finance/crypto.js:100](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/crypto.js#L100), [src/apis/finance/crypto.js:140](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/crypto.js#L140)。

#### 金价银价 · `metals`

- 调用：`GET /api/metals`。
- 类型：混合来源/可选联网（界面“混合来源”；联网范围`required`）。新浪金属行情；人民币折算间接调用fx的ExchangeRate-API。
- 主/备/间接来源：`hq.sinajs.cn`、`open.er-api.com`。媒体/静态资源：无。
- 整改与优先级：**P3 需授权**。可接交易场所授权行情与汇率；不能只删除汇率回退并声称全部本地。
- 数据、许可、资源：行情/汇率授权与同步；折算仅参考。
- 基准证据：[src/apis/finance/metals.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/metals.js#L1), [src/apis/finance/metals.js:5](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/metals.js#L5), [src/apis/finance/metals.js:6](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/metals.js#L6), [src/apis/finance/metals.js:88](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/metals.js#L88), [src/apis/finance/metals.js:136](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/metals.js#L136)。
- 共享/解析证据：[src/apis/finance/fx.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/fx.js#L1), [src/apis/finance/fx.js:4](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/fx.js#L4), [src/apis/finance/fx.js:29](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/fx.js#L29), [src/apis/finance/fx.js:31](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/fx.js#L31), [src/apis/finance/fx.js:56](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/finance/fx.js#L56)。

### fun · 24模块 / 35地址

#### 一言 · `hitokoto`

- 调用：`GET /api/hitokoto`。
- 类型：混合来源/可选联网（界面“默认本地”；联网范围`optional`）。默认现有有限句库，覆盖a–l；仅provider=hitokoto访问一言服务。
- 主/备/间接来源：`v1.hitokoto.cn`。媒体/静态资源：外部模式返回hitokoto.cn句子链接。
- 整改与优先级：**P1 已改**。本轮已改默认本地并补齐g分类；不冒充完整一言语料。
- 数据、许可、资源：现有约30余条引用与原创句子；本地id/uuid/creator/url=null，fallback=true；扩充语料需逐条核对作品权利。
- 基准证据：[src/apis/fun/hitokoto.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/hitokoto.js#L1), [src/apis/fun/hitokoto.js:3](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/hitokoto.js#L3), [src/apis/fun/hitokoto.js:72](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/hitokoto.js#L72), [src/apis/fun/hitokoto.js:87](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/hitokoto.js#L87), [src/apis/fun/hitokoto.js:89](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/hitokoto.js#L89)。

#### 每日诗词 · `poem`

- 调用：`GET /api/poem`。
- 类型：混合来源/可选联网（界面“默认本地”；联网范围`optional`）。默认本地名句/唐诗对句；仅provider=jinrishici显式访问原服务，失败仍本地返回。
- 主/备/间接来源：`v1.jinrishici.com`。媒体/静态资源：无。
- 整改与优先级：**P1 已改**。本轮已改默认本地；原服务保留显式选项，响应字段不删。
- 数据、许可、资源：复用现有古诗词库与chinese-poetry MIT；本地category=null、fallback=true。
- 基准证据：[src/apis/fun/poem.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/poem.js#L1), [src/apis/fun/poem.js:5](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/poem.js#L5), [src/apis/fun/poem.js:94](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/poem.js#L94), [src/apis/fun/poem.js:96](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/poem.js#L96), [src/apis/fun/poem.js:107](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/poem.js#L107)。
- 共享/解析证据：[src/apis/fun/poetry.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/poetry.js#L1), [src/apis/fun/poetry.js:77](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/poetry.js#L77)。

#### Bing 每日壁纸 · `bing`

- 调用：`GET /api/bing`；`GET /api/bing/image`。
- 类型：第一方网页/未公开稳定接口（界面“平台网页源”；联网范围`required`）。直接访问微软Bing壁纸站内接口，图片由Bing提供。
- 主/备/间接来源：`cn.bing.com`、`www.bing.com`。媒体/静态资源：Bing th?图片与版权链接，302仍访问Bing。
- 整改与优先级：**P2 可建自有图库**。可另设自有合法壁纸集合，但不能称为Bing每日壁纸；保留接口语义。
- 数据、许可、资源：图片权利/署名和磁盘带宽；Bing返回版权信息不等于可任意再分发。
- 基准证据：[src/apis/fun/bing.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/bing.js#L1), [src/apis/fun/bing.js:7](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/bing.js#L7), [src/apis/fun/bing.js:43](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/bing.js#L43), [src/apis/fun/bing.js:44](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/bing.js#L44), [src/apis/fun/bing.js:48](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/bing.js#L48)。

#### 随机壁纸 · `wallpaper`

- 调用：`GET /api/wallpaper/random`；`GET /api/wallpaper/random.jpg`。
- 类型：第三方数据服务（界面“第三方数据”；联网范围`required`）。Wallhaven API取图，失败/指定时使用Picsum；后者是另一个在线图源。
- 主/备/间接来源：`wallhaven.cc`、`picsum.photos`。媒体/静态资源：w.wallhaven.cc、th.wallhaven.cc和Picsum重定向目标（常见fastly.picsum.photos），未镜像。
- 整改与优先级：**P2 可建自有图库**。可建自有授权图库；当前Picsum不是离线兜底，保留可用路径。
- 数据、许可、资源：图库图片许可、存储、缩略图与更新。
- 基准证据：[src/apis/fun/wallpaper.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/wallpaper.js#L1), [src/apis/fun/wallpaper.js:5](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/wallpaper.js#L5), [src/apis/fun/wallpaper.js:42](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/wallpaper.js#L42), [src/apis/fun/wallpaper.js:52](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/wallpaper.js#L52), [src/apis/fun/wallpaper.js:53](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/wallpaper.js#L53)。

#### 番剧放送表 · `anime-calendar`

- 调用：`GET /api/anime/calendar`。
- 类型：第三方数据服务（界面“第三方数据”；联网范围`required`）。Bangumi社区番剧日历公开API，非播出机构原始排期。
- 主/备/间接来源：`api.bgm.tv`。媒体/静态资源：lain.bgm.tv等上游images字段，外部封面。
- 整改与优先级：**P2 需数据**。可用自有授权番剧排期库；需维护真实播出时间和番组元数据。
- 数据、许可、资源：BangumiAPI条款/数据与封面权利，持续排期维护。
- 基准证据：[src/apis/fun/anime.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/anime.js#L1), [src/apis/fun/anime.js:4](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/anime.js#L4), [src/apis/fun/anime.js:7](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/anime.js#L7), [src/apis/fun/anime.js:10](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/anime.js#L10), [src/apis/fun/anime.js:34](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/anime.js#L34)。

#### 豆瓣电影 · `douban`

- 调用：`GET /api/douban/top250`；`GET /api/douban/nowplaying`。
- 类型：第一方网页/未公开稳定接口（界面“平台网页源”；联网范围`required`）。直接抓取豆瓣Top250/正在上映网页，无外部中转。
- 主/备/间接来源：`movie.douban.com`。媒体/静态资源：img*.doubanio.com海报（由上游字段返回）。
- 整改与优先级：**P3 平台独有数据**。可建自有电影资料库，不能替代豆瓣评分口径；保留现有语义。
- 数据、许可、资源：评分/上映排片与图片权利；无需换代理，不绕过站点访问限制。
- 基准证据：[src/apis/fun/douban.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/douban.js#L1), [src/apis/fun/douban.js:4](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/douban.js#L4), [src/apis/fun/douban.js:5](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/douban.js#L5), [src/apis/fun/douban.js:6](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/douban.js#L6), [src/apis/fun/douban.js:73](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/douban.js#L73)。

#### 实时票房 · `boxoffice`

- 调用：`GET /api/boxoffice`。
- 类型：第一方网页/未公开稳定接口（界面“平台网页源”；联网范围`required`）。直接访问猫眼专业版站内票房接口，不是第三方API中转。
- 主/备/间接来源：`box.maoyan.com`。媒体/静态资源：无。
- 整改与优先级：**P3 需授权**。实时票房需授权来源；自建数据仓库仍依赖供数。
- 数据、许可、资源：票房数据授权与更新；保留可用现状。
- 基准证据：[src/apis/fun/boxoffice.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/boxoffice.js#L1), [src/apis/fun/boxoffice.js:6](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/boxoffice.js#L6), [src/apis/fun/boxoffice.js:43](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/boxoffice.js#L43), [src/apis/fun/boxoffice.js:48](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/boxoffice.js#L48), [src/apis/fun/boxoffice.js:49](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/boxoffice.js#L49)。

#### 每日一句英语 · `english-daily`

- 调用：`GET /api/english/daily`。
- 类型：第一方网页/未公开稳定接口（界面“平台网页源”；联网范围`required`）。金山词霸每日一句站内接口。
- 主/备/间接来源：`open.iciba.com`。媒体/静态资源：上游picture/picture2/tts等字段的图片音频CDN，未镜像。
- 整改与优先级：**P2 需数据**。可建立原创或获授权双语句库及自行录音/TTS；不能复制整套编辑内容默认无权利限制。
- 数据、许可、资源：中英文本/翻译/录音版权、存储或本地语音模型资源。
- 基准证据：[src/apis/fun/english.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/english.js#L1), [src/apis/fun/english.js:4](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/english.js#L4), [src/apis/fun/english.js:6](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/english.js#L6), [src/apis/fun/english.js:26](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/english.js#L26), [src/apis/fun/english.js:30](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/english.js#L30)。

#### 答案之书 · `answer`

- 调用：`GET /api/answer`。
- 类型：本地数据/自有持久数据（界面“本地数据”；联网范围`none`）。现有本地文案或传统规则库；不调用AI或第三方文案服务。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有整理/原创数据；传统数理和运势仅娱乐，非事实预测。
- 基准证据：[src/apis/fun/answer.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/answer.js#L1), [src/apis/fun/answer.js:41](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/answer.js#L41)。

#### 今日运势 · `fortune`

- 调用：`GET /api/fortune`。
- 类型：本地数据/自有持久数据（界面“本地数据”；联网范围`none`）。现有本地文案或传统规则库；不调用AI或第三方文案服务。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有整理/原创数据；传统数理和运势仅娱乐，非事实预测。
- 基准证据：[src/apis/fun/fortune.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/fortune.js#L1), [src/apis/fun/fortune.js:48](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/fortune.js#L48)。

#### 号码吉凶 · `numerology`

- 调用：`GET /api/numerology`。
- 类型：本地数据/自有持久数据（界面“本地数据”；联网范围`none`）。现有本地文案或传统规则库；不调用AI或第三方文案服务。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有整理/原创数据；传统数理和运势仅娱乐，非事实预测。
- 基准证据：[src/apis/fun/numerology.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/numerology.js#L1), [src/apis/fun/numerology.js:54](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/numerology.js#L54)。

#### 语录合集 · `quotes`

- 调用：`GET /api/quotes`；`GET /api/quotes/types`。
- 类型：本地数据/自有持久数据（界面“本地数据”；联网范围`none`）。现有本地文案或传统规则库；不调用AI或第三方文案服务。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有整理/原创数据；传统数理和运势仅娱乐，非事实预测。
- 基准证据：[src/apis/fun/quotes.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/quotes.js#L1), [src/apis/fun/quotes.js:29](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/quotes.js#L29)。

#### 温馨提示 · `greeting`

- 调用：`GET /api/greeting`。
- 类型：混合来源/可选联网（界面“本地优先”；联网范围`conditional`）。本地问候文案；当天年份2025/2026用内置安排，其他年份按需查holiday-cn，失败时按普通周末处理。
- 主/备/间接来源：`cdn.jsdelivr.net`。媒体/静态资源：无。
- 整改与优先级：**P1 已改**。本轮已将已内置年份改为直接返回；其余年份保留服务，未来安排不能靠算法推断。
- 数据、许可、资源：现有2025/2026表已核对官方安排；年度维护/通知来源与数据许可，未知年份不可冒充已发布。
- 基准证据：[src/apis/fun/greeting.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/greeting.js#L1), [src/apis/fun/greeting.js:65](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/greeting.js#L65), [src/apis/fun/greeting.js:76](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/greeting.js#L76), [src/apis/fun/greeting.js:111](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/greeting.js#L111)。
- 共享/解析证据：[src/apis/life/holiday.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/holiday.js#L1), [src/apis/life/holiday.js:7](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/holiday.js#L7), [src/apis/life/holiday.js:54](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/holiday.js#L54), [src/apis/life/holiday.js:57](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/holiday.js#L57), [src/apis/life/holiday.js:60](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/holiday.js#L60)。

#### 随机头像 · `avatar`

- 调用：`GET /api/avatar`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/fun/avatar.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/avatar.js#L1), [src/apis/fun/avatar.js:48](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/avatar.js#L48), [src/apis/fun/avatar.js:71](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/avatar.js#L71), [src/apis/fun/avatar.js:122](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/avatar.js#L122)。

#### 成语词典 · `idiom`

- 调用：`GET /api/idiom`；`GET /api/idiom/chain`。
- 类型：本地数据/自有持久数据（界面“本地数据”；联网范围`none`）。本地词库与chinese-xinhua数据，按需读文件；不请求字典API。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：仓库内chinese-xinhua MIT许可与整理数据；保留署名及许可证。
- 基准证据：[src/apis/fun/idiom.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/idiom.js#L1), [src/apis/fun/idiom.js:117](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/idiom.js#L117)。

#### 歇后语 · `xiehouyu`

- 调用：`GET /api/xiehouyu`。
- 类型：本地数据/自有持久数据（界面“本地数据”；联网范围`none`）。本地词库与chinese-xinhua数据，按需读文件；不请求字典API。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：仓库内chinese-xinhua MIT许可与整理数据；保留署名及许可证。
- 基准证据：[src/apis/fun/xiehouyu.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/xiehouyu.js#L1), [src/apis/fun/xiehouyu.js:30](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/xiehouyu.js#L30)。

#### 脑筋急转弯 · `brain-teaser`

- 调用：`GET /api/brain-teaser`；`GET /api/brain-teaser/answer`。
- 类型：本地数据/自有持久数据（界面“本地数据”；联网范围`none`）。现有本地文案或传统规则库；不调用AI或第三方文案服务。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有整理/原创数据；传统数理和运势仅娱乐，非事实预测。
- 基准证据：[src/apis/fun/brain-teaser.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/brain-teaser.js#L1), [src/apis/fun/brain-teaser.js:23](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/brain-teaser.js#L23)。

#### 冷知识 · `cold-fact`

- 调用：`GET /api/cold-fact`。
- 类型：本地数据/自有持久数据（界面“本地数据”；联网范围`none`）。现有本地文案或传统规则库；不调用AI或第三方文案服务。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有整理/原创数据；传统数理和运势仅娱乐，非事实预测。
- 基准证据：[src/apis/fun/cold-fact.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/cold-fact.js#L1), [src/apis/fun/cold-fact.js:20](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/cold-fact.js#L20)。

#### 彩虹屁 · `compliment`

- 调用：`GET /api/compliment`。
- 类型：本地数据/自有持久数据（界面“本地数据”；联网范围`none`）。现有本地文案或传统规则库；不调用AI或第三方文案服务。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有整理/原创数据；传统数理和运势仅娱乐，非事实预测。
- 基准证据：[src/apis/fun/compliment.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/compliment.js#L1), [src/apis/fun/compliment.js:16](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/compliment.js#L16)。

#### 笑话 · `joke`

- 调用：`GET /api/joke`。
- 类型：本地数据/自有持久数据（界面“本地数据”；联网范围`none`）。现有本地文案或传统规则库；不调用AI或第三方文案服务。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有整理/原创数据；传统数理和运势仅娱乐，非事实预测。
- 基准证据：[src/apis/fun/joke.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/joke.js#L1), [src/apis/fun/joke.js:16](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/joke.js#L16)。

#### 汉字字典 · `hanzi`

- 调用：`GET /api/hanzi`。
- 类型：本地数据/自有持久数据（界面“本地数据”；联网范围`none`）。本地词库与chinese-xinhua数据，按需读文件；不请求字典API。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：仓库内chinese-xinhua MIT许可与整理数据；保留署名及许可证。
- 基准证据：[src/apis/fun/hanzi.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/hanzi.js#L1), [src/apis/fun/hanzi.js:37](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/hanzi.js#L37)。

#### 古诗词库 · `poetry`

- 调用：`GET /api/poem/search`；`GET /api/poem/random`。
- 类型：本地数据/自有持久数据（界面“本地数据”；联网范围`none`）。现有600首唐诗/宋词全文库与本地搜索、随机抽取。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：chinese-poetry MIT数据约240KB；古典作品与整理数据许可分别保留。
- 基准证据：[src/apis/fun/poetry.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/poetry.js#L1), [src/apis/fun/poetry.js:77](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/poetry.js#L77)。

#### 网易云音乐榜单 · `music`

- 调用：`GET /api/music/toplist`。
- 类型：第一方网页/未公开稳定接口（界面“平台网页源”；联网范围`required`）。直接调用网易云站内搜索/歌单/歌曲/歌词接口；搜索/歌单有同平台备用端点。
- 主/备/间接来源：`music.163.com`。媒体/静态资源：封面p*.music.126.net等上游字段；播放跳转music.163.com再到音频CDN，非本站音源。
- 整改与优先级：**P3 需授权**。已有本地播放器和LRC解析，无需重做；音乐数据/歌词/音源需合法授权，不能本地计算替代。
- 数据、许可、资源：歌曲、歌词、封面与音源权利；不绕过会员、区域和付费限制。
- 基准证据：[src/apis/fun/music.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/music.js#L1), [src/apis/fun/music.js:8](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/music.js#L8), [src/apis/fun/music.js:19](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/music.js#L19), [src/apis/fun/music.js:50](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/music.js#L50), [src/apis/fun/music.js:62](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/music.js#L62)。

#### 网易云音乐播放 · `music-play`

- 调用：`GET /api/music/search`；`GET /api/music/song`；`GET /api/music/lyric`；`GET /api/music/url`；`GET /api/music/player`。
- 类型：第一方网页/未公开稳定接口（界面“平台网页源”；联网范围`required`）。直接调用网易云站内搜索/歌单/歌曲/歌词接口；搜索/歌单有同平台备用端点。
- 主/备/间接来源：`music.163.com`。媒体/静态资源：封面p*.music.126.net等上游字段；播放跳转music.163.com再到音频CDN，非本站音源。
- 整改与优先级：**P3 需授权**。已有本地播放器和LRC解析，无需重做；音乐数据/歌词/音源需合法授权，不能本地计算替代。
- 数据、许可、资源：歌曲、歌词、封面与音源权利；不绕过会员、区域和付费限制。
- 基准证据：[src/apis/fun/music-play.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/music-play.js#L1), [src/apis/fun/music-play.js:11](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/music-play.js#L11), [src/apis/fun/music-play.js:39](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/music-play.js#L39), [src/apis/fun/music-play.js:57](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/music-play.js#L57), [src/apis/fun/music-play.js:60](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/fun/music-play.js#L60)。

### ai · 1模块 / 4地址

#### AI 助手 · `ai`

- 调用：`POST /api/ai/summary`；`POST /api/ai/sentiment`；`POST /api/ai/translate`；`POST /api/ai/chat`。
- 类型：混合来源/可选联网（界面“混合来源”；联网范围`required`）。OpenAI兼容接口，默认DeepSeek；LLM_BASE_URL可指向自有服务，但当前仍要求已有LLM_API_KEY。
- 主/备/间接来源：`api.deepseek.com`、`{LLM_BASE_URL}`。媒体/静态资源：无。
- 整改与优先级：**P3 需模型服务**。已有自定义兼容地址能力；可接自托管模型但未部署/未配置，也未调用真实模型。
- 数据、许可、资源：模型许可、内存/GPU、兼容服务与现有Key配置；不得说当前AI已离线。
- 基准证据：[src/apis/ai/ai.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/ai/ai.js#L1), [src/apis/ai/ai.js:133](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/ai/ai.js#L133)。
- 共享/解析证据：[src/apis/ai/llm.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/ai/llm.js#L1), [src/apis/ai/llm.js:7](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/ai/llm.js#L7), [src/apis/ai/llm.js:108](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/ai/llm.js#L108)。

### tools · 31模块 / 64地址

#### 二维码生成 · `qrcode`

- 调用：`GET /api/qrcode`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/tools/qrcode.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/qrcode.js#L1), [src/apis/tools/qrcode.js:341](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/qrcode.js#L341), [src/apis/tools/qrcode.js:405](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/qrcode.js#L405)。

#### 短链接 · `shorturl`

- 调用：`POST /api/shorturl`；`GET /api/shorturl/stats`；`GET /s/:code`。
- 类型：本地数据/自有持久数据（界面“本地数据”；联网范围`none`）。本站SQLite生成和保存短链，访问短链时跳转用户目标。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：短链最终目标由用户提供。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：持久SQLite与备份；跳转仍依赖目标网站可达。
- 基准证据：[src/apis/tools/shorturl.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/shorturl.js#L1), [src/apis/tools/shorturl.js:79](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/shorturl.js#L79)。

#### 网页信息 · `webmeta`

- 调用：`GET /api/webmeta`。
- 类型：直接目标协议或网页（界面“目标直查”；联网范围`target`）。本服务器直接连接被测目标/订阅源，保留DNS解析、超时、限速与内网地址防护；非检测API中转。
- 主/备/间接来源：`{用户目标}`、`{DNS解析器}`。媒体/静态资源：favicon/网页正文/RSS可能返回目标或其CDN资源链接；直查不等于离线。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有TCP/TLS/HTTP/DNS代码；ping需系统命令、缺失时有TCP后备；不需新服务。
- 基准证据：[src/apis/tools/webmeta.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/webmeta.js#L1), [src/apis/tools/webmeta.js:79](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/webmeta.js#L79), [src/apis/tools/webmeta.js:202](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/webmeta.js#L202), [src/apis/tools/webmeta.js:203](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/webmeta.js#L203), [src/apis/tools/webmeta.js:213](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/webmeta.js#L213)。

#### 域名 Whois · `whois`

- 调用：`GET /api/whois`。
- 类型：混合来源/可选联网（界面“混合来源”；联网范围`required`）。IANA RDAP引导后直接查询对应注册局；失败时rdap.org备用跳转。
- 主/备/间接来源：`data.iana.org`、`{注册局RDAP}`、`rdap.org`。媒体/静态资源：无。
- 整改与优先级：**P2 可本地引导**。主路径已经直查权威注册局；可本地维护引导快照，备用重定向不应误称主数据聚合代理。
- 数据、许可、资源：引导更新与注册局访问；404不绝对等于可以买到域名，DNS存在不等于注册状态。
- 基准证据：[src/apis/tools/whois.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/whois.js#L1), [src/apis/tools/whois.js:70](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/whois.js#L70), [src/apis/tools/whois.js:88](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/whois.js#L88), [src/apis/tools/whois.js:106](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/whois.js#L106), [src/apis/tools/whois.js:111](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/whois.js#L111)。

#### 翻译 · `translate`

- 调用：`GET /api/translate`。
- 类型：第三方数据服务（界面“第三方数据”；联网范围`required`）。DeepL/百度/有道官方翻译服务，按已有配置选择；不是不明翻译代理。
- 主/备/间接来源：`api-free.deepl.com`、`api.deepl.com`、`fanyi-api.baidu.com`、`openapi.youdao.com`。媒体/静态资源：无。
- 整改与优先级：**P3 需模型服务**。可部署获许可翻译模型并设计适配器；当前无本地模型服务，保留已有提供商。
- 数据、许可、资源：真实已有提供商Key，或模型权重许可/CPU-GPU/内存与独立模型部署；本轮不配置。
- 基准证据：[src/apis/tools/translate.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/translate.js#L1), [src/apis/tools/translate.js:44](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/translate.js#L44), [src/apis/tools/translate.js:62](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/translate.js#L62), [src/apis/tools/translate.js:84](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/translate.js#L84), [src/apis/tools/translate.js:109](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/translate.js#L109)。

#### 开发小工具 · `devtools`

- 调用：`GET /api/tools/timestamp`；`GET /api/tools/uuid`；`GET /api/tools/hash`；`GET /api/tools/base64`；`GET /api/tools/urlencode`；`GET /api/tools/password`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/tools/devtools.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/devtools.js#L1), [src/apis/tools/devtools.js:115](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/devtools.js#L115)。

#### 图形验证码 · `captcha`

- 调用：`GET /api/captcha`；`GET /api/captcha/verify`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/tools/captcha.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/captcha.js#L1), [src/apis/tools/captcha.js:221](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/captcha.js#L221), [src/apis/tools/captcha.js:306](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/captcha.js#L306)。

#### 访客信息 · `visitor`

- 调用：`GET /api/visitor`。
- 类型：混合来源/可选联网（界面“混合来源”；联网范围`conditional`）。本地解析UA/生成SVG；位置复用loadIpInfo，境外/IPv6等仍可能请求ip-api。
- 主/备/间接来源：`ip-api.com`。媒体/静态资源：无。
- 整改与优先级：**P2 需数据**。已有本地UA/SVG与IPv4查询；visitor支持geo=0关闭归属地。完整位置独立需IPv6/坐标数据。
- 数据、许可、资源：复用IP库；客户端SVG无额外图片源，不能将本地渲染等同全部字段本地产生。
- 基准证据：[src/apis/tools/visitor.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/visitor.js#L1), [src/apis/tools/visitor.js:19](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/visitor.js#L19), [src/apis/tools/visitor.js:77](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/visitor.js#L77)。
- 共享/解析证据：[src/apis/life/ip.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/ip.js#L1), [src/apis/life/ip.js:69](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/ip.js#L69), [src/apis/life/ip.js:100](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/ip.js#L100), [src/apis/life/ip.js:124](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/ip.js#L124), [src/apis/life/ip.js:135](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/ip.js#L135)。

#### User-Agent 工具 · `useragent`

- 调用：`GET /api/ua/parse`；`GET /api/ua/random`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/tools/useragent.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/useragent.js#L1), [src/apis/tools/useragent.js:168](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/useragent.js#L168)。

#### 颜色工具 · `color`

- 调用：`GET /api/color/random`；`GET /api/color/convert`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/tools/color.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/color.js#L1), [src/apis/tools/color.js:191](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/color.js#L191)。

#### IP 签名档 · `ipcard`

- 调用：`GET /api/ipcard`。
- 类型：混合来源/可选联网（界面“混合来源”；联网范围`conditional`）。本地解析UA/生成SVG；位置复用loadIpInfo，境外/IPv6等仍可能请求ip-api。
- 主/备/间接来源：`ip-api.com`。媒体/静态资源：无。
- 整改与优先级：**P2 需数据**。已有本地UA/SVG与IPv4查询；visitor支持geo=0关闭归属地。完整位置独立需IPv6/坐标数据。
- 数据、许可、资源：复用IP库；客户端SVG无额外图片源，不能将本地渲染等同全部字段本地产生。
- 基准证据：[src/apis/tools/ipcard.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/ipcard.js#L1), [src/apis/tools/ipcard.js:142](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/ipcard.js#L142), [src/apis/tools/ipcard.js:181](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/ipcard.js#L181)。
- 共享/解析证据：[src/apis/life/ip.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/ip.js#L1), [src/apis/life/ip.js:69](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/ip.js#L69), [src/apis/life/ip.js:100](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/ip.js#L100), [src/apis/life/ip.js:124](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/ip.js#L124), [src/apis/life/ip.js:135](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/ip.js#L135)。

#### 子网与 IP 计算 · `netcalc`

- 调用：`GET /api/tools/cidr`；`GET /api/tools/ip-int`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/tools/netcalc.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/netcalc.js#L1), [src/apis/tools/netcalc.js:198](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/netcalc.js#L198)。

#### 进制 / Unicode / 经典密码 · `codec`

- 调用：`GET /api/tools/radix`；`GET /api/tools/unicode`；`GET /api/tools/cipher`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/tools/codec.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/codec.js#L1), [src/apis/tools/codec.js:173](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/codec.js#L173)。

#### JWT / TOTP / 密码强度 · `security-tools`

- 调用：`GET /api/tools/jwt`；`POST /api/tools/jwt`；`GET /api/tools/totp`；`POST /api/tools/totp`；`POST /api/tools/password-strength`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/tools/security.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/security.js#L1), [src/apis/tools/security.js:357](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/security.js#L357)。

#### 请求回显与测试数据 · `debug-tools`

- 调用：`GET /api/tools/echo`；`POST /api/tools/echo`；`GET /api/tools/mock`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/tools/debug.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/debug.js#L1), [src/apis/tools/debug.js:29](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/debug.js#L29), [src/apis/tools/debug.js:111](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/debug.js#L111)。

#### 文本统计 / 人民币大写 / JSON · `text-tools`

- 调用：`GET /api/tools/text-stat`；`POST /api/tools/text-stat`；`GET /api/tools/rmb`；`POST /api/tools/json`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/tools/texttools.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/texttools.js#L1), [src/apis/tools/texttools.js:191](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/texttools.js#L191)。

#### 占位图 / 徽章 / 文字图片 · `svg-image`

- 调用：`GET /api/placeholder`；`GET /api/badge`；`GET /api/text-image`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/tools/svgimage.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/svgimage.js#L1), [src/apis/tools/svgimage.js:30](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/svgimage.js#L30), [src/apis/tools/svgimage.js:79](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/svgimage.js#L79), [src/apis/tools/svgimage.js:134](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/svgimage.js#L134), [src/apis/tools/svgimage.js:147](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/svgimage.js#L147)。
- 共享/解析证据：[src/apis/tools/ipcard.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/ipcard.js#L1), [src/apis/tools/ipcard.js:142](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/ipcard.js#L142), [src/apis/tools/ipcard.js:181](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/ipcard.js#L181)。

#### Cron 表达式解析 · `cron`

- 调用：`GET /api/tools/cron`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/tools/cron.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/cron.js#L1), [src/apis/tools/cron.js:223](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/cron.js#L223)。

#### 正则表达式测试 · `regex`

- 调用：`GET /api/tools/regex`；`POST /api/tools/regex`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/tools/regex.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/regex.js#L1), [src/apis/tools/regex.js:144](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/regex.js#L144)。

#### 汉字转拼音 · `pinyin`

- 调用：`GET /api/pinyin`。
- 类型：本地数据/自有持久数据（界面“本地数据”；联网范围`none`）。本地词库与chinese-xinhua数据，按需读文件；不请求字典API。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：仓库内chinese-xinhua MIT许可与整理数据；保留署名及许可证。
- 基准证据：[src/apis/tools/pinyin.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/pinyin.js#L1), [src/apis/tools/pinyin.js:132](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/pinyin.js#L132)。

#### 简繁转换 · `chinese-convert`

- 调用：`GET /api/chinese/convert`。
- 类型：本地数据/自有持久数据（界面“本地数据”；联网范围`none`）。现有OpenCC字表本地转换，无在线转换服务。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：内置OpenCC Apache-2.0字表与许可证。
- 基准证据：[src/apis/tools/chinese-convert.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/chinese-convert.js#L1), [src/apis/tools/chinese-convert.js:173](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/chinese-convert.js#L173)。

#### 条形码生成 · `barcode`

- 调用：`GET /api/barcode`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/tools/barcode.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/barcode.js#L1), [src/apis/tools/barcode.js:191](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/barcode.js#L191), [src/apis/tools/barcode.js:237](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/barcode.js#L237)。

#### 随机工具 · `random`

- 调用：`GET /api/random/number`；`GET /api/random/pick`；`GET /api/random/shuffle`；`GET /api/random/string`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/tools/random.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/random.js#L1), [src/apis/tools/random.js:81](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/random.js#L81)。

#### 文本对比 · `diff`

- 调用：`GET /api/tools/diff`；`POST /api/tools/diff`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/tools/diff.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/diff.js#L1), [src/apis/tools/diff.js:277](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/diff.js#L277)。

#### 格式转换 · `format-convert`

- 调用：`POST /api/tools/convert`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/tools/convert.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/convert.js#L1), [src/apis/tools/convert.js:825](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/convert.js#L825)。

#### Markdown 转 HTML · `markdown`

- 调用：`POST /api/tools/markdown`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/tools/markdown.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/markdown.js#L1), [src/apis/tools/markdown.js:447](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/markdown.js#L447), [src/apis/tools/markdown.js:869](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/markdown.js#L869), [src/apis/tools/markdown.js:876](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/markdown.js#L876)。

#### 开发速查 · `devref`

- 调用：`GET /api/devref/http-status`；`GET /api/devref/mime`；`GET /api/devref/port`。
- 类型：本地数据/自有持久数据（界面“本地数据”；联网范围`none`）。本地HTTP/MIME/端口等参考表；不实时查询IANA。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有参考表；标准变化随代码维护。
- 基准证据：[src/apis/tools/devref.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/devref.js#L1), [src/apis/tools/devref.js:454](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/devref.js#L454)。

#### QQ 头像 · `qq-avatar`

- 调用：`GET /api/qq/avatar`；`GET /api/qq/avatar/urls`。
- 类型：混合来源/可选联网（界面“外部图片”；联网范围`client`）。服务器仅拼接/跳转腾讯q1.qlogo.cn头像URL；客户端最终仍访问腾讯图片服务。
- 主/备/间接来源：`q1.qlogo.cn`。媒体/静态资源：腾讯头像CDN；本地URL生成不等于图片已本地。
- 整改与优先级：**P3 平台独有数据**。已有本地生成avatar接口可用于自有头像，但不是QQ真实头像的等价替代。
- 数据、许可、资源：头像权利/用户授权；不下载或镜像全部QQ头像。
- 基准证据：[src/apis/tools/qq-avatar.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/qq-avatar.js#L1), [src/apis/tools/qq-avatar.js:10](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/qq-avatar.js#L10), [src/apis/tools/qq-avatar.js:20](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/qq-avatar.js#L20)。

#### QQ 昵称 · `qq-nickname`

- 调用：`GET /api/qq/nickname`。
- 类型：第一方网页/未公开稳定接口（界面“平台网页源”；联网范围`required`）。腾讯Qzone公开portrait站内端点，非稳定公开API；依赖编码解析，返回不确定时拒绝乱码。
- 主/备/间接来源：`users.qzone.qq.com`。媒体/静态资源：无。
- 整改与优先级：**P3 平台独有数据**。可由用户自填昵称作为自有账号资料，但不能替代QQ公开昵称查询。
- 数据、许可、资源：平台可达性与公开资料限制；不绕过登录、不查询非公开资料。
- 基准证据：[src/apis/tools/qq-nickname.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/qq-nickname.js#L1), [src/apis/tools/qq-nickname.js:5](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/qq-nickname.js#L5), [src/apis/tools/qq-nickname.js:48](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/qq-nickname.js#L48), [src/apis/tools/qq-nickname.js:55](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/qq-nickname.js#L55), [src/apis/tools/qq-nickname.js:117](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/qq-nickname.js#L117)。

#### QQ 资料卡链接 · `qq-profile`

- 调用：`GET /api/qq/profile`；`GET /api/qq/profile/open`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。仅本地拼接mqqapi客户端资料卡链接/打开页，不查询QQ用户资料。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：用户设备需安装并允许QQ客户端唤起。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有本地模板；mqqapi不是腾讯公开稳定规范，不能承诺所有设备唤起。
- 基准证据：[src/apis/tools/qq-profile.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/qq-profile.js#L1), [src/apis/tools/qq-profile.js:27](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/qq-profile.js#L27)。

#### 通知消息构建 · `notify-message`

- 调用：`POST /api/notify/message`。
- 类型：纯本地计算（界面“本地计算”；联网范围`none`）。服务器本地计算、校验或生成，不请求业务上游。
- 主/备/间接来源：无固定业务外网请求。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：随仓库数据与运行时；无需新密钥。
- 基准证据：[src/apis/tools/notify-message.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/notify-message.js#L1), [src/apis/tools/notify-message.js:24](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/notify-message.js#L24)。

### net · 22模块 / 33地址

#### DNS 查询 · `dns`

- 调用：`GET /api/dns`。
- 类型：直接目标协议或网页（界面“目标直查”；联网范围`target`）。服务器通过DNS协议查询固定公共解析器，不调用DNS检测代理；仍依赖解析器和权威DNS。
- 主/备/间接来源：`1.1.1.1`、`8.8.8.8`、`223.5.5.5`、`119.29.29.29`、`114.114.114.114`。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已经是协议查询；邮箱安全/有效性只检查格式和DNS，不保证邮箱存在。自建解析器需另行部署且保留内网防护。
- 数据、许可、资源：DNS网络与现有内置一次性邮箱名单；不能任意开放用户DNS服务器造成SSRF/反射。
- 基准证据：[src/apis/net/dns.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/dns.js#L1), [src/apis/net/dns.js:180](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/dns.js#L180)。

#### SSL 证书查询 · `ssl-cert`

- 调用：`GET /api/ssl`。
- 类型：直接目标协议或网页（界面“目标直查”；联网范围`target`）。本服务器直接连接被测目标/订阅源，保留DNS解析、超时、限速与内网地址防护；非检测API中转。
- 主/备/间接来源：`{用户目标}`、`{DNS解析器}`。媒体/静态资源：favicon/网页正文/RSS可能返回目标或其CDN资源链接；直查不等于离线。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有TCP/TLS/HTTP/DNS代码；ping需系统命令、缺失时有TCP后备；不需新服务。
- 基准证据：[src/apis/net/ssl.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/ssl.js#L1), [src/apis/net/ssl.js:255](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/ssl.js#L255)。

#### 网站检测 · `site-check`

- 调用：`GET /api/site/check`。
- 类型：直接目标协议或网页（界面“目标直查”；联网范围`target`）。本服务器直接连接被测目标/订阅源，保留DNS解析、超时、限速与内网地址防护；非检测API中转。
- 主/备/间接来源：`{用户目标}`、`{DNS解析器}`。媒体/静态资源：favicon/网页正文/RSS可能返回目标或其CDN资源链接；直查不等于离线。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有TCP/TLS/HTTP/DNS代码；ping需系统命令、缺失时有TCP后备；不需新服务。
- 基准证据：[src/apis/net/site.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/site.js#L1), [src/apis/net/site.js:47](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/site.js#L47), [src/apis/net/site.js:119](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/site.js#L119)。

#### TCPing · `tcping`

- 调用：`GET /api/tcping`。
- 类型：直接目标协议或网页（界面“目标直查”；联网范围`target`）。本服务器直接连接被测目标/订阅源，保留DNS解析、超时、限速与内网地址防护；非检测API中转。
- 主/备/间接来源：`{用户目标}`、`{DNS解析器}`。媒体/静态资源：favicon/网页正文/RSS可能返回目标或其CDN资源链接；直查不等于离线。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有TCP/TLS/HTTP/DNS代码；ping需系统命令、缺失时有TCP后备；不需新服务。
- 基准证据：[src/apis/net/tcping.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/tcping.js#L1), [src/apis/net/tcping.js:59](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/tcping.js#L59)。

#### Ping · `ping`

- 调用：`GET /api/ping`。
- 类型：直接目标协议或网页（界面“目标直查”；联网范围`target`）。本服务器直接连接被测目标/订阅源，保留DNS解析、超时、限速与内网地址防护；非检测API中转。
- 主/备/间接来源：`{用户目标}`、`{DNS解析器}`。媒体/静态资源：favicon/网页正文/RSS可能返回目标或其CDN资源链接；直查不等于离线。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有TCP/TLS/HTTP/DNS代码；ping需系统命令、缺失时有TCP后备；不需新服务。
- 基准证据：[src/apis/net/ping.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/ping.js#L1), [src/apis/net/ping.js:124](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/ping.js#L124)。

#### 域名注册查询 · `domain-available`

- 调用：`GET /api/domain/available`。
- 类型：混合来源/可选联网（界面“混合来源”；联网范围`required`）。IANA RDAP引导后直接查询对应注册局；失败时rdap.org备用跳转。
- 主/备/间接来源：`data.iana.org`、`{注册局RDAP}`、`rdap.org`。媒体/静态资源：无。
- 整改与优先级：**P2 可本地引导**。主路径已经直查权威注册局；可本地维护引导快照，备用重定向不应误称主数据聚合代理。
- 数据、许可、资源：引导更新与注册局访问；404不绝对等于可以买到域名，DNS存在不等于注册状态。
- 基准证据：[src/apis/net/domain.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/domain.js#L1), [src/apis/net/domain.js:102](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/domain.js#L102)。
- 共享/解析证据：[src/apis/tools/whois.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/whois.js#L1), [src/apis/tools/whois.js:70](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/whois.js#L70), [src/apis/tools/whois.js:88](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/whois.js#L88), [src/apis/tools/whois.js:106](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/whois.js#L106), [src/apis/tools/whois.js:111](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/tools/whois.js#L111)。

#### Robots 分析 · `robots`

- 调用：`GET /api/robots`。
- 类型：直接目标协议或网页（界面“目标直查”；联网范围`target`）。本服务器直接连接被测目标/订阅源，保留DNS解析、超时、限速与内网地址防护；非检测API中转。
- 主/备/间接来源：`{用户目标}`、`{DNS解析器}`。媒体/静态资源：favicon/网页正文/RSS可能返回目标或其CDN资源链接；直查不等于离线。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有TCP/TLS/HTTP/DNS代码；ping需系统命令、缺失时有TCP后备；不需新服务。
- 基准证据：[src/apis/net/robots.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/robots.js#L1), [src/apis/net/robots.js:180](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/robots.js#L180), [src/apis/net/robots.js:246](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/robots.js#L246)。

#### 网站图标 · `favicon`

- 调用：`GET /api/favicon`。
- 类型：直接目标协议或网页（界面“目标直查”；联网范围`target`）。本服务器直接连接被测目标/订阅源，保留DNS解析、超时、限速与内网地址防护；非检测API中转。
- 主/备/间接来源：`{用户目标}`、`{DNS解析器}`。媒体/静态资源：favicon/网页正文/RSS可能返回目标或其CDN资源链接；直查不等于离线。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有TCP/TLS/HTTP/DNS代码；ping需系统命令、缺失时有TCP后备；不需新服务。
- 基准证据：[src/apis/net/favicon.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/favicon.js#L1), [src/apis/net/favicon.js:104](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/favicon.js#L104), [src/apis/net/favicon.js:107](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/favicon.js#L107), [src/apis/net/favicon.js:142](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/favicon.js#L142), [src/apis/net/favicon.js:153](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/favicon.js#L153)。

#### 死链检测 · `link-check`

- 调用：`GET /api/links/check`。
- 类型：直接目标协议或网页（界面“目标直查”；联网范围`target`）。本服务器直接连接被测目标/订阅源，保留DNS解析、超时、限速与内网地址防护；非检测API中转。
- 主/备/间接来源：`{用户目标}`、`{DNS解析器}`。媒体/静态资源：favicon/网页正文/RSS可能返回目标或其CDN资源链接；直查不等于离线。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有TCP/TLS/HTTP/DNS代码；ping需系统命令、缺失时有TCP后备；不需新服务。
- 基准证据：[src/apis/net/links.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/links.js#L1), [src/apis/net/links.js:78](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/links.js#L78), [src/apis/net/links.js:81](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/links.js#L81), [src/apis/net/links.js:112](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/links.js#L112), [src/apis/net/links.js:134](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/links.js#L134)。

#### 域名后缀列表 · `tld`

- 调用：`GET /api/tld`。
- 类型：第一方官方公开源（界面“官方公开源”；联网范围`required`）。直接读取IANA公开顶级域列表。
- 主/备/间接来源：`data.iana.org`。媒体/静态资源：无。
- 整改与优先级：**P2 可本地快照**。可打包带版本的IANA快照本地读，但需更新；目前保留直接权威源。
- 数据、许可、资源：IANA列表与更新日期；静态快照不保证实时委派状态。
- 基准证据：[src/apis/net/tld.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/tld.js#L1), [src/apis/net/tld.js:5](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/tld.js#L5), [src/apis/net/tld.js:107](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/tld.js#L107), [src/apis/net/tld.js:108](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/tld.js#L108), [src/apis/net/tld.js:113](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/tld.js#L113)。

#### HTTP 安全头检测 · `site-headers`

- 调用：`GET /api/site/headers`。
- 类型：直接目标协议或网页（界面“目标直查”；联网范围`target`）。本服务器直接连接被测目标/订阅源，保留DNS解析、超时、限速与内网地址防护；非检测API中转。
- 主/备/间接来源：`{用户目标}`、`{DNS解析器}`。媒体/静态资源：favicon/网页正文/RSS可能返回目标或其CDN资源链接；直查不等于离线。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有TCP/TLS/HTTP/DNS代码；ping需系统命令、缺失时有TCP后备；不需新服务。
- 基准证据：[src/apis/net/headers.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/headers.js#L1), [src/apis/net/headers.js:132](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/headers.js#L132), [src/apis/net/headers.js:172](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/headers.js#L172)。

#### 邮件安全检测 · `email-security`

- 调用：`GET /api/email/security`。
- 类型：直接目标协议或网页（界面“目标直查”；联网范围`target`）。服务器通过DNS协议查询固定公共解析器，不调用DNS检测代理；仍依赖解析器和权威DNS。
- 主/备/间接来源：`1.1.1.1`、`8.8.8.8`、`223.5.5.5`、`119.29.29.29`、`114.114.114.114`。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已经是协议查询；邮箱安全/有效性只检查格式和DNS，不保证邮箱存在。自建解析器需另行部署且保留内网防护。
- 数据、许可、资源：DNS网络与现有内置一次性邮箱名单；不能任意开放用户DNS服务器造成SSRF/反射。
- 基准证据：[src/apis/net/email.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/email.js#L1), [src/apis/net/email.js:219](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/email.js#L219), [src/apis/net/email.js:412](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/email.js#L412)。

#### 邮箱有效性检测 · `email-check`

- 调用：`GET /api/email/check`。
- 类型：直接目标协议或网页（界面“目标直查”；联网范围`target`）。服务器通过DNS协议查询固定公共解析器，不调用DNS检测代理；仍依赖解析器和权威DNS。
- 主/备/间接来源：`1.1.1.1`、`8.8.8.8`、`223.5.5.5`、`119.29.29.29`、`114.114.114.114`。媒体/静态资源：无。
- 整改与优先级：**P0 已有**。已经是协议查询；邮箱安全/有效性只检查格式和DNS，不保证邮箱存在。自建解析器需另行部署且保留内网防护。
- 数据、许可、资源：DNS网络与现有内置一次性邮箱名单；不能任意开放用户DNS服务器造成SSRF/反射。
- 基准证据：[src/apis/net/email.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/email.js#L1), [src/apis/net/email.js:219](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/email.js#L219), [src/apis/net/email.js:412](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/email.js#L412)。

#### RSS 转 JSON · `rss`

- 调用：`GET /api/rss`。
- 类型：直接目标协议或网页（界面“目标直查”；联网范围`target`）。本服务器直接连接被测目标/订阅源，保留DNS解析、超时、限速与内网地址防护；非检测API中转。
- 主/备/间接来源：`{用户目标}`、`{DNS解析器}`。媒体/静态资源：favicon/网页正文/RSS可能返回目标或其CDN资源链接；直查不等于离线。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有TCP/TLS/HTTP/DNS代码；ping需系统命令、缺失时有TCP后备；不需新服务。
- 基准证据：[src/apis/net/rss.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/rss.js#L1), [src/apis/net/rss.js:388](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/rss.js#L388), [src/apis/net/rss.js:389](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/rss.js#L389), [src/apis/net/rss.js:395](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/rss.js#L395), [src/apis/net/rss.js:433](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/rss.js#L433)。

#### 网页正文提取 · `web-content`

- 调用：`GET /api/web/text`；`GET /api/web/markdown`。
- 类型：直接目标协议或网页（界面“目标直查”；联网范围`target`）。本服务器直接连接被测目标/订阅源，保留DNS解析、超时、限速与内网地址防护；非检测API中转。
- 主/备/间接来源：`{用户目标}`、`{DNS解析器}`。媒体/静态资源：favicon/网页正文/RSS可能返回目标或其CDN资源链接；直查不等于离线。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有TCP/TLS/HTTP/DNS代码；ping需系统命令、缺失时有TCP后备；不需新服务。
- 基准证据：[src/apis/net/webpage.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/webpage.js#L1), [src/apis/net/webpage.js:13](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/webpage.js#L13), [src/apis/net/webpage.js:14](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/webpage.js#L14), [src/apis/net/webpage.js:31](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/webpage.js#L31), [src/apis/net/webpage.js:32](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/webpage.js#L32)。

#### 整站文字抓取 · `crawl`

- 调用：`POST /api/crawl`；`GET /api/crawl/result`。
- 类型：直接目标协议或网页（界面“目标直查”；联网范围`target`）。本服务器直接连接被测目标/订阅源，保留DNS解析、超时、限速与内网地址防护；非检测API中转。
- 主/备/间接来源：`{用户目标}`、`{DNS解析器}`。媒体/静态资源：favicon/网页正文/RSS可能返回目标或其CDN资源链接；直查不等于离线。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有TCP/TLS/HTTP/DNS代码；ping需系统命令、缺失时有TCP后备；不需新服务。
- 基准证据：[src/apis/net/crawl.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/crawl.js#L1), [src/apis/net/crawl.js:166](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/crawl.js#L166), [src/apis/net/crawl.js:243](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/crawl.js#L243), [src/apis/net/crawl.js:420](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/crawl.js#L420)。

#### 苹果应用搜索 · `appstore`

- 调用：`GET /api/appstore/search`。
- 类型：第一方官方公开源（界面“官方公开源”；联网范围`required`）。Apple公开iTunes Search/Lookup API。
- 主/备/间接来源：`itunes.apple.com`。媒体/静态资源：Apple上游artworkUrl*图片CDN与商店链接。
- 整改与优先级：**P3 平台独有数据**。保留第一方公开接口；自有索引仍需Apple元数据更新，不能自产App Store价格/评分。
- 数据、许可、资源：AppleAPI条款、区域差异和图片权利；无需另换API代理。
- 基准证据：[src/apis/net/appstore.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/appstore.js#L1), [src/apis/net/appstore.js:40](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/appstore.js#L40), [src/apis/net/appstore.js:41](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/appstore.js#L41), [src/apis/net/appstore.js:44](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/appstore.js#L44), [src/apis/net/appstore.js:59](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/appstore.js#L59)。

#### 多节点检测 · `probe`

- 调用：`GET /api/probe/ping`；`GET /api/probe/http`；`GET /api/probe/dns`；`GET /api/probe/traceroute`。
- 类型：第三方数据服务（界面“第三方数据”；联网范围`required`）。Globalping分布式探针API；不同地点测量不能由本站单点ping等价替代。
- 主/备/间接来源：`api.globalping.io`。媒体/静态资源：无。
- 整改与优先级：**P3 需多地服务**。已有本站单点ping/tcping等；分布式能力需自建多地节点/服务，保留Globalping。
- 数据、许可、资源：多个合法探针节点、协调服务、网络资源与额度；本轮不部署。
- 基准证据：[src/apis/net/probe.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/probe.js#L1), [src/apis/net/probe.js:9](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/probe.js#L9), [src/apis/net/probe.js:50](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/probe.js#L50), [src/apis/net/probe.js:102](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/probe.js#L102), [src/apis/net/probe.js:453](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/probe.js#L453)。

#### DNS 传播检测 · `dns-propagation`

- 调用：`GET /api/dns/propagation`。
- 类型：混合来源/可选联网（界面“混合来源”；联网范围`required`）。同时比较多家公共DoH结果，部分JSON端点未有文档确认；不是本站独立DNS数据。
- 主/备/间接来源：`dns.google`、`cloudflare-dns.com`、`dns.alidns.com`、`doh.pub`、`dns.quad9.net`、`unfiltered.adguard-dns.com`、`dns.nextdns.io`。媒体/静态资源：无。
- 整改与优先级：**P3 测量对象依赖**。保留多解析器对照语义；换为本站单一解析器无法检测公共DNS传播差异。
- 数据、许可、资源：多公共解析器可达性与格式兼容；现有代码将未验证DNSPod/NextDNS源标为可能失败。
- 基准证据：[src/apis/net/propagation.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/propagation.js#L1), [src/apis/net/propagation.js:15](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/propagation.js#L15), [src/apis/net/propagation.js:16](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/propagation.js#L16), [src/apis/net/propagation.js:17](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/propagation.js#L17), [src/apis/net/propagation.js:18](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/propagation.js#L18)。

#### 批量检测 · `batch-check`

- 调用：`GET /api/batch/tcping`；`POST /api/batch/tcping`；`GET /api/batch/http`；`POST /api/batch/http`；`GET /api/batch/ping`；`POST /api/batch/ping`。
- 类型：直接目标协议或网页（界面“目标直查”；联网范围`target`）。本服务器直接连接被测目标/订阅源，保留DNS解析、超时、限速与内网地址防护；非检测API中转。
- 主/备/间接来源：`{用户目标}`、`{DNS解析器}`。媒体/静态资源：favicon/网页正文/RSS可能返回目标或其CDN资源链接；直查不等于离线。
- 整改与优先级：**P0 已有**。已有本地能力，无需重复开发。
- 数据、许可、资源：现有TCP/TLS/HTTP/DNS代码；ping需系统命令、缺失时有TCP后备；不需新服务。
- 基准证据：[src/apis/net/batch.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/batch.js#L1), [src/apis/net/batch.js:50](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/batch.js#L50), [src/apis/net/batch.js:53](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/batch.js#L53), [src/apis/net/batch.js:313](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/batch.js#L313)。

#### IP 信誉查询 · `ip-reputation`

- 调用：`GET /api/ip/reputation`。
- 类型：混合来源/可选联网（界面“混合来源”；联网范围`required`）。本地风险规则+DNSBL/PTR查询+loadIpInfo(withAsn=true)在线补ASN。
- 主/备/间接来源：`{系统DNS}`、`bl.spamcop.net`、`b.barracudacentral.org`、`dnsbl-1.uceprotect.net`、`psbl.surriel.com`、`all.s5h.net`、`bl.blocklist.de`、`dnsbl.dronebl.org`、`zen.spamhaus.org`、`ip-api.com`。媒体/静态资源：无。
- 整改与优先级：**P3 需数据授权**。规则已本地；自主信誉需自有遥测/获授权名单与ASN库，DNSBL不能凭空自产。
- 数据、许可、资源：各DNSBL使用条款；Spamhaus默认不查、显式请求可能需DQS授权；未知/拒查不能记为安全。
- 基准证据：[src/apis/net/iprep.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/iprep.js#L1), [src/apis/net/iprep.js:163](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/iprep.js#L163), [src/apis/net/iprep.js:208](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/iprep.js#L208)。
- 共享/解析证据：[src/apis/life/ip.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/ip.js#L1), [src/apis/life/ip.js:69](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/ip.js#L69), [src/apis/life/ip.js:100](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/ip.js#L100), [src/apis/life/ip.js:124](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/ip.js#L124), [src/apis/life/ip.js:135](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/life/ip.js#L135)。

#### IP 网段与 ASN · `asn`

- 调用：`GET /api/ip/asn`；`GET /api/asn`。
- 类型：混合来源/可选联网（界面“混合来源”；联网范围`required`）。IANA IPv4/IPv6/ASN引导到五大RIR的RDAP；失败时rdap.org备用。
- 主/备/间接来源：`data.iana.org`、`{RIR的RDAP}`、`rdap.org`。媒体/静态资源：无。
- 整改与优先级：**P2 需数据**。已经优先权威RDAP；要完全离线需持续同步RIR委派/注册数据，非简单删除备用。
- 数据、许可、资源：APNIC/ARIN/RIPE/LACNIC/AFRINIC数据许可、更新与索引。
- 基准证据：[src/apis/net/asn.js:1](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/asn.js#L1), [src/apis/net/asn.js:12](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/asn.js#L12), [src/apis/net/asn.js:13](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/asn.js#L13), [src/apis/net/asn.js:14](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/asn.js#L14), [src/apis/net/asn.js:241](https://github.com/bocmiao/api/blob/c51fa5140eebc13b179f64eac24f18482c4444ec/src/apis/net/asn.js#L241)。

## 本轮代码位置

- [来源元数据](../src/lib/api-sources.js)、[目录兼容输出](../src/registry.js)、[前端标签与详情](../public/app.js)、[移动端样式](../public/styles.css)。
- [诗词默认本地](../src/apis/fun/poem.js)、[一言默认本地](../src/apis/fun/hitokoto.js)、[节假日优先级](../src/apis/life/holiday.js)、[IP离线模式](../src/apis/life/ip.js)、[手机号离线模式](../src/apis/life/phone.js)。
- [来源与离线专项](../test/api-sources.test.js)、[真实前端验收脚本](../scripts/check-api-sources-ui.js)、[升级说明](../CHANGELOG.md)。

## 外部文档与数据许可核对

- [Open-Meteo官方项目](https://github.com/open-meteo/open-meteo)提供自托管路径，但模型/天气数据仍须同步；许可和机器资源要单独核对，不能把部署Web接口等同拥有气象观测。[官方API文档](https://open-meteo.com/en/docs)仅用于确认产品与接口，不曾发起天气业务查询。
- [Apple iTunes Search API官方概览](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/index.html)支持其公开API分类。
- [国务院2026年安排原文（国务院新闻办公室转载）](https://www.scio.gov.cn/zdgz/jj/202511/t20251110_938367.html)与已有内置2026表核对相符；[holiday-cn项目](https://github.com/NateScarlet/holiday-cn)是第三方整理与更新项目，不能直接标成国务院官方API。
- 既有离线库的来源、大小、版本、哈希和许可证在`src/apis/life/data/README.md`；字典MIT、诗词MIT、OpenCC Apache-2.0许可证都保留。项目本身当前为GPL-3.0-only；不能从旧文档“项目MIT”的过时文字推断新数据可任意并入。
- 平台网页可访问、API正式公开、历史事实可引用，均不自动授予整套正文/封面/歌词/音源再分发权。拟扩充数据需按实际来源处理，不推测许可。

## 验证、交付与仍需的数据

验证结果：全量1242项测试通过（0失败、0跳过）；真实前端配本地合成目录通过33个场景（11页面×1360/390/320px），均无整页横向溢出、无页面脚本错误、无外部浏览器请求。旧版真实解析/渲染函数与新版更新页另通过6个场景，能显示v0.13.0及15条两版本说明。修复320px导航挤出屏幕问题。上游业务测试使用模拟数据；外网拦截器放行经校验的本地测试服务器，最终全量运行无额外外网拦截尝试。测试不会替代真实业务的线上可用性核查；线上SHA/生产重启尚未据此确认。本轮未运行工作流、CNB或生产部署，不购买服务，不创建/修改凭证或扩大权限。

尚未具备的依赖是具体的数据/服务，而不是未完成的本地算法：IPv6/完整ASN定位库、更新后的号段库、后续年度调休安排、合法自有图片/双语内容、平台实时热度与权益、授权金融/音乐数据、本地翻译/LLM服务、多地区探针，以及可靠的同款微信文章自动发现。本轮保留这些接口的现有正常接入，明确标注边界，不静默清空或删除功能。

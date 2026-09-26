# 离线数据文件

`../offline-db.js` 首次查询时把这里的文件整个读入内存，零依赖解析。文件缺失或损坏时自动退回在线接口。

## ip2region_v4.xdb（IP 归属地，IPv4）

- 来源：<https://github.com/lionsoul2014/ip2region> 的 `data/ip2region_v4.xdb`
  （提交 c1a1fc7d5941760db3f8431dc05c48cf7f0e30a1，2026-09-01）
- 许可：Apache-2.0 或 MIT 双许可，任选其一，全文见 `LICENSE-ip2region.md`
- 大小：11,122,036 字节；SHA-256 `8e31bbdccb5bf21028af10592d4312ec975da0bffa108c0c5d862a12190f9ad3`
- 格式：xdb 结构版本 3，region 为 `国家|省份|城市|ISP|ISO 两位代码`
- 未接入 IPv6 库（`ip2region_v6.xdb` 约 37 MB，体积过大），IPv6 仍查 ip-api.com
- 更新：用上游新版 `ip2region_v4.xdb` 直接替换本文件即可

## phone.dat（手机号段归属地）

- 来源：<https://github.com/lovedboy/phone>（即 ls0f/phone）的 `phone/phone.dat`
  （提交 bfbfe19cfe5024616a28327e81178d289bc7720d，数据版本 2312，即 2023 年 12 月，499,527 条号段）
- 许可：MIT（该仓库 README 的 License 一节注明 MIT，setup.py 的 classifier 为 MIT License；仓库没有单独的
  LICENSE 文件）。作者 ls0f <admin@lovedboy.com>。MIT 许可全文：

  > Copyright (c) ls0f (lovedboy)
  >
  > Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
  > documentation files (the "Software"), to deal in the Software without restriction, including without limitation
  > the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
  > permit persons to whom the Software is furnished to do so, subject to the following conditions:
  >
  > The above copyright notice and this permission notice shall be included in all copies or substantial portions of
  > the Software.
  >
  > THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
  > THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  > AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
  > TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  > SOFTWARE.

- 大小：4,505,816 字节；SHA-256 `cb17a69eafa68d7706cfcc68d47cdf165ea916e9d5c476b4dd5f06cf74aed23d`
- 未采用 xluohome/phonedata：其格式相同，但仓库许可为 GPL-3.0，与本项目的 MIT 许可不兼容
- 格式：8 字节头（4 字节版本号 + u32 首条索引偏移）、记录区 `省份|城市|邮编|区号\0`、
  索引区每条 9 字节（u32 号段前 7 位 + u32 记录偏移 + u8 卡类型），小端

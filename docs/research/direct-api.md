# 直接 HTTP 调研归档

2026-10-05 核对了 GitHub 源码、淘宝模块提交时间及失败反馈，并用原生 Node HTTP 探测三个 MTOP 接口。匿名请求没有商品数据；用户随后选择 **Playwright JavaScript 常驻服务**，作为当前实现。

| 项目 | 核对结果 |
|---|---|
| [cn-scraper-mcp](https://github.com/goesByhc/cn-scraper-mcp/blob/b6576e43b4d33e27b27a3b563d23d104c72e7881/src/cn_scraper_mcp/engines/taobao.py) | MIT；Python HTTP 搜索与基础详情，依赖 Cookie 和 curl_cffi；没有完整规格核价接口。淘宝引擎提交 2026-07-17 |
| [Crawler](https://github.com/ShilongLee/Crawler/tree/main/service/taobao/logic) | 淘宝模块是 Python HTTP；搜索文件提交 2024-08-13、详情 2024-07-22；许可证限定非商业使用 |
| [Crawler Issue #92](https://github.com/ShilongLee/Crawler/issues/92) | 搜索 `RGV587_ERROR` 反馈，调研时仍 open；具体失败案例，不证明所有会话失败 |
| [tmallSign](https://github.com/cclient/tmallSign) | JS 签名帮助服务，最后提交 2018-03-08；不是完整商品查询实现 |
| [TaoBaoApis](https://github.com/cv-cat/TaoBaoApis/blob/master/taobao_apis.py) | 主体为 IM 等接口；商品详情实际上是闲鱼接口，与目标不符 |

匿名探测：`mtop.taobao.wsearch.appsearch/1.0` 和 `mtop.taobao.pcdetail.data.get/1.0` 返回 HTTP 200 + `RGV587_ERROR`；`mtop.taobao.detail.getdetail/6.0` 返回非 JSON。报告位于 `artifacts/research/2026-10-05-anonymous-mtop.json`，脚本为 `scripts/probe-mtop.js`。没有读取用户 Cookie或尝试解决页面验证。

没有在已登录会话中验证纯 HTTP 路线，不能据此宣布它完全不可用或无需登录。当前不使用这些项目代码作为业务依赖；保留调研记录供未来评估。

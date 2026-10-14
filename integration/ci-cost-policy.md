# GitHub 免费优先验证安排

客户于 2026-10-14 授权：审查敏感内容和许可证后，将
`knight-bili/codeg-rovai-workbench` 从私有改为公开，以使用标准 GitHub 托管 runner。
公开操作的实际结果与验证记录见[执行证据](execution/ci-free-result.json)。不调整付款方式、订阅或账号支出上限。

## 执行场景

| 场景 | 执行方式 | 保留的验证范围 |
| --- | --- | --- |
| 日常修改 | 本机按改动运行检查、测试和自审 | 沿用开发与测试规范，未通过不得报告完成 |
| 草稿 PR 更新 | Integration scaffold 自动运行一次，不再同时由 push 重复启动 | 来源、计划、文档治理、差异检查 |
| PR 准备验收 | CI 自动快速门禁；草稿可手动运行 | 按路径识别的类型、Rust 生产目标、文档及技能检查 |
| Core 跨平台 | 手动 Core integration，默认 Linux，可选 Windows 或 all | 全部原有测试命令保留；里程碑选择 all |
| Desktop/Web 原生联调 | 手动 Workbench native Desktop and Web，默认 arm64，可选 x64 或 all | 两种 macOS 架构均保留；里程碑选择 all |
| 源应用 Mac/iOS/Android 基线 | 手动 Foundation cross-platform，默认 Android，可选 macos、ios 或 all | 双应用双架构、iOS 模拟器、Android 单测及模拟器仍保留 |
| Codeg Windows Server 基线 | 手动 Codeg source baseline | 原生编译、隔离认证和健康检查保留 |
| 完整回归、Windows 包、签名与发布 | 既有手动工作流 | 完整回归按里程碑执行；签名与发布仍须客户授权 |

手动运行须指定待验阶段分支和提交。重型非发布任务收到同一范围的新运行时取消旧运行，避免旧提交排队消耗资源。
手动检查未运行或被取消时必须记录为未验证，不能作为通过证据。平台编译和模拟器不替代真机验收。

## 存储与运行边界

- 使用标准 Linux、Windows、macOS runner，不增加 larger runner、常驻云主机或第三方付费服务。
- 所有普通 `upload-artifact` 产物显式保留 1 天，包括完整回归和经客户授权后才执行的签名流程中间产物；不沿用默认长期保留。Foundation 默认保存日志、阶段结果和截图；重建包仍生成、校验和启动，但只有显式选择 `upload_packages` 才上传。
- 公开前，将现存 Actions 产物全部备份到仓库外本地审计目录，核对哈希，再清理云端副本。历史运行日志先检查，避免公开敏感内容。
- 本地证据和下载产物不提交仓库；长期保留必要的摘要、来源提交、哈希与验收结论。
- 公开标准 runner 的计算免费，不代表所有 GitHub 服务或存储无限免费。存储仍受计划与账号内其他仓库共同使用量影响。账号账单和硬预算未能读取时，明确记为未核实，不能承诺账户零扣费。
- 不把 GitHub Actions 用作持续服务，不轮换仓库或账户规避限制。若公开后仍被账单状态阻止，保留证据、继续本机工作，不自动提高额度。

## 公开前审查

审查远端全部分支、标签及 PR 头提交的历史、文件类型、密钥告警、PR/议题/评审文本、可下载的运行日志，以及许可证保留情况。
发现真实秘密先暂停公开并处理；不通过删除当前文件掩盖历史泄露，不自行重写公共供体历史。
根 MIT 及移植模块 Apache-2.0、MIT 等通知分别保留。此项公开准入核查不替代 I12 发布包的完整依赖和通知验收。

官方依据（核实于 2026-10-14）：[Actions 计费与免费范围](https://docs.github.com/en/billing/concepts/product-billing/github-actions)、
[标准 runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、
[公开仓库的影响](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)。

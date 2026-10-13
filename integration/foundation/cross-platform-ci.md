# GitHub跨平台验证

客户于2026-10-13明确要求先利用GitHub编译测试，Mac和移动真机运行可以后置。执行入口是.github/workflows/foundation-cross-platform.yml，阶段分支第一次推送自动触发；日常文档变化不触发这一组昂贵构建。

| 任务 | 标准运行机 | 实际安排 | 尚不覆盖 |
|---|---|---|---|
| Rovai macOS arm64/x64 | macos-26 / macos-26-intel | 原生Core/Host/CLI、Electron、开发预览.app、架构及ad-hoc签名检查、两个真实Electron组件夹具 | 正式证书、公证、硬件交互、真实Agent |
| Codeg macOS arm64/x64 | 同上 | 固定供体、原生MCP/电脑helper、Tauri Debug.app，无Updater签名和发布 | 电脑权限/TCC、应用整体验收、真实Agent |
| Codeg iOS | macos-26 / Xcode26.6 | 原固定Swift源码和SwiftTerm1.13.0，禁用开发者签名构建，iOS26模拟器安装/启动/截图 | 源无单测target；不虚报单测。真机、后台及签名分发未验收 |
| Codeg Android | Ubuntu24.04 / JDK21 / SDK36 | Debug APK、源JUnit、lint、API36模拟器安装/启动/UI树及截图 | 源无androidTest用例，不虚报instrumentation。实际手机权限、网络及后台待验收 |

构建来自当前阶段Rovai骨架和sources.lock.json内固定的三个公开供体SHA。源下载只提取到本次RUNNER_TEMP，ZIP路径/链接及前缀先检查后写入；个人签名配置、日常数据和用户凭据不引入CI。

每项用record-ci-stage.py分开记录已实际完成的步骤。编译通过而启动失败时保留编译通过事实及失败步骤，不把整个源构建抹掉，也不把安装当作运行通过。模拟器/组件测试不替代真机和完整融合产品验收。测试数量来自JUnit或现有测试日志，不预设通过数。

源Mac生成的是开发预览：Rovai使用ad-hoc签名，Codeg禁用正式签名和更新包签名；不发布Release、不安装客户日常应用、不导入签名秘密。

首次运行38390762574在工作流解析阶段失败，未执行构建。runner.temp必须在运行步骤或step上下文读取；已修正并启动38391085273。

Android首轮APK/176项单测/lint通过，但AVD目录不一致；38393571184统一目录后仍因默认Google镜像数据分区7372.80MB大于可用空间失败。38396171258清理本次Gradle构建目录和缩分区配置后，默认分区下限仍未改变，另外发现adb没有在PATH中。不能将该次超时只归因为adb，或宣称磁盘问题已修。

69118e6e改用官方可用的同API36标准AOSP x86_64镜像，显式安装platform-tools并加入PATH，先校验adb和模拟器进程再等待启动。38399456358模拟器已启动、APK安装/应用进程通过，但系统UI无响应弹窗挡住前台检查，不能当成界面通过。

b0856806降低模拟器屏幕和内存占用、等待系统稳定，先保存截图/活动/崩溃诊断再断言；只识别确切的System UI系统弹窗，保留一次等待恢复证据，应用错误或仍未恢复必须失败。38401285968最终编译、176源单测、lint、模拟器安装启动及前台检查全部通过，人工核查Codeg首配页；本次没有系统ANR，未触发恢复。标准AOSP镜像不验证Google服务行为，需要时另补Google镜像或真机。

## 实际结果

| 固定源码任务 | 编译与产物 | 可用测试/启动 | GitHub任务状态 |
|---|---|---|---|
| Rovai Mac arm64 | Core/Host/CLI、Electron预览包通过 | ad-hoc签名/架构、2真实Electron夹具通过 | success |
| Rovai Mac x64 | 同上 | 同上，2真实Electron夹具通过 | success |
| Codeg Mac arm64 | MCP/电脑helper、Tauri Debug预览包，arm64通过 | 不宣称电脑操作或真实Agent通过 | success |
| Codeg Mac x64 | 同上，x86_64通过，包已保存 | 构建、打包、上传和收尾步骤均success | cancelled：GitHub明确报告超过90分钟任务上限 |
| Codeg iOS | 无开发者签名模拟器.app通过 | iPhone iOS26模拟器首屏通过；无源单测target | success |
| Codeg Android | Debug APK、SDK36构建通过 | 176单测，失败/错误/跳过0；lint及API36模拟器首屏通过 | success（最终仅Android重试） |

Codeg Intel冷构建的release sidecar耗时47分52秒、Debug应用31分31秒，整个任务90分钟后取消。实际编译/包通过与GitHub任务取消分别记录，不把任务或首次整个run写成success。配置仅为后续Codeg Intel构建加至120分钟，其余Mac仍90分钟；本次不重复已经通过的原生编译，配置及报告另跑scaffold。新的120分钟上限尚未执行一次完整原生任务。

逐项源SHA、产物文件SHA256、步骤、测试数量及失败历史见[cross-platform-result.json](cross-platform-result.json)。这些验证的是固定源码基线，324融合产品验收仍全部not_run，真机、生产旧库导入、真实Agent和正式签名分发均待验收。

## 编译资源与验收资源

没有客户本地Mac并不阻止GitHub提供的原生macOS编译。没有手机也不阻止构建APK和iOS模拟器.app。Xcode/SDK和运行机版本保存到artifact，官方镜像会更新，日志中的实际版本才是本次证据。
真实设备验收仍包含文件权限、系统授权、键盘/触控、相机/照片、后台、局域网、共享桌面和签名安装。设备暂缺只推迟这些项目，不减少一期范围。

## 资源约束

使用标准GitHub-hosted runner，不申请大型运行机或新增设备。私有仓使用账号的Actions额度及既有计费设置，不声称免费或无限；保存产物3日，Codeg Intel原生构建上限120分钟、其他Mac90分钟，iOS40分钟，Android50分钟，失败互不取消。现按变动脚本选平台；共享提取/报告脚本或仅改工作流时验证全平台。仅改文档不触发此矩阵。此次只有时间余量及报告变化，提交注明skip ci并单独运行scaffold，不重复六平台编译。尚未添加原生构建缓存，后续按实测耗时安排。

运行机依据：[GitHub标准runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[macOS26软件列表](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-arm64-Readme.md)、[Ubuntu24.04软件列表](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md)。

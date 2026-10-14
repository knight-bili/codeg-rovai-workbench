# I02-T02 Runtime 移植边界

当前融合源码目录为21种：Gemini、Hermes与OpenClaw均接入Core及共享客户端；Migration197/198/199依次从146升级至149。
Windows默认500项、定向51项及成员设置38项通过；数据库107个owner有通过证据（106全量＋1修复定向，未在修夹具后再跑一次全套）。原生OpenClaw协议11项及Core Gateway控制面已验，均没有模型推理。
完整Runtime原生兼容、真实工具/模型、Bootstrap、停止恢复与四平台资格仍在实施，不代表21种Runtime已验收。证据见[i02-openclaw-core-result.json](i02-openclaw-core-result.json)，前批Gemini/Hermes记录保留；当前合同见[OpenClaw Runtime v1](../../docs/contracts/openclaw-runtime-v1.md)。

后续补验已通过正式Adapter/Fleet/ACP Host的新建、暖进程复用、重建Native进程和管理器后的精确恢复、缺失Binding拒绝与配对进程清理；历史Agent列表只转换私有配置，原文件字节未变。详情见[会话与原生配置记录](i02-openclaw-session-result.json)。没有发送prompt或推理请求，不能当作完整Core进程/业务数据库重启、认证导入、Bootstrap或真实工具通过。

2026-10-14。盘点结果见 [i02-runtime-inventory-result.json](i02-runtime-inventory-result.json)。这是源码差异和研发顺序，不代表 Runtime 已通过准入或执行。

一期保留规划中的21种 Runtime。固定 Rovai 来源的 `AdapterKind::ALL` 声明18种；Codeg另有 Gemini、Hermes、OpenClaw。融合源码目录已加入三种新增类型，差异控制面与原生兼容继续验证。不能删掉来源入口，也不能启动 Codeg 的 Tauri 执行层形成第二个业务权威。移植发生在 Core 的 Runtime 适配、Host 合同和共享成员设置页面内。

| 来源 | 当前源码差异 | 下一步实现及验收 |
| --- | --- | --- |
| Core 已声明18种 | 发现、产品检查、模型目录、成员配置和执行合同已有骨架；源码声明不等于本机准入 | 保留原 AdapterKind 与成员配置；使用隔离安装/环境测试发现、模型、权限、真实流式、停止、恢复、工具及错误路径 |
| Gemini | 固定 Core 来源缺少该产品；融合源码已加入目录、专用ACP实例、生命周期、模型/权限/Skills映射和schema147迁移 | 先完成真实Rust编译、迁移保留/回滚及既有合同回归，再验证发现、认证、模型执行、停止恢复与工具；共享成员设置已接入，运行资格仍未授予 |
| Hermes | 固定来源与包内Python3.14/uv已隔离安装；Core目录、专用ACP生命周期、原生Session模式与148迁移已接入 | 实际缺会话load返回空对象，Core拒绝确认并隔离重放；补成功Session/真实模型/停止恢复/MCP、原生工程信任与跨Run计量 |
| OpenClaw | 固定2026.9.8；已在工作区Node24.21隔离安装并取得真实版本输出，Core已接入配对Gateway控制面；ACP拒绝非空 `mcpServers` | Core管理独立Gateway、配置与认证，兼容原生模型设置及Gateway级MCP；不把思考模式当权限，不把版本输出当执行资格 |

自审后的实施顺序：

1. 先为三种新增产品核对固定源码的发行、协议、模型、权限、认证及恢复字段，列明真实支持与不支持的能力。当前产品命令别名仅用于发现候选，须由 Core 核验产品与可执行完整性。
2. 在 Core 扩展适配与序列化合同，梳理涉及的数据库约束/迁移；沿现有 `runtime.installations.*`、`runtime.product.*` 和成员配置操作，不给 Renderer 独立进程控制权。
3. 移植 Codeg ACP 解析及事件语义，继续由 Core 管理 Run、Usage、批准、取消、恢复与内置工具权限。不能用两套 Session/Run 状态相互抄写。
4. 共享成员设置明确产品、模型、环境、权限和实际能力；新增来源的安装、更新、来源说明、错误及重开一致性均纳入一期。
5. 先在无凭据、无推理的协议夹具检查配置/事件/错误，再使用独立开发身份跑真实模型、流式、停止、恢复与 Skill/MCP。没有账号或外部资源的项目登记客户待办；可修的协议/构建问题由研发继续处理。

当前本机仅发现 Codex、Claude Code、OpenClaw 三个入口。Codex 登录状态已只读核实有效，未复制凭据；其余认证未检查。18个入口没有出现在当前 PATH，不能推断未安装。全部21种 Core 准入及真实模型验证仍为 `not_run`，Mac/Linux 与客户实机仍须补齐。

等待投递撤回成功路径依赖可控的领取前窗口，保留在 [研发待办](development-todos.json)。阅读记录没有投递；正式发布的快速领取试验产生了一条失败 Run，没有真实模型运行证明。不能以这两种数据替代撤回成功、真实流式或恢复验收。

## Gemini固定版本的已验证输入

固定Codeg使用@google/gemini-cli@0.60.0，官方tag对应733edcb597ce690ac2e2fe3b3b3690b60a4c8f27。已在独立安装和GEMINI_CLI_HOME验证真实--acp --skip-trust进程：initialize返回协议1、gemini-cli/0.60.0及四种认证方法；刻意空认证的session/new返回-32000，没有成功Session。强制独立文件凭据存储、未继承认证环境，进程正常退出。见[i02-gemini-native-result.json](i02-gemini-native-result.json)。

上游session/new/load成功响应包含models.availableModels/currentModelId和modes.availableModes/currentModeId；plan仅在原生启用时出现。融合源码已沿Core既有ACP模型映射及会话生命周期接入，产品启动使用已验证的两个参数，没有复用Qwen的--mcp-config启动参数；显式模型使用原生session/set_model。初始化中的loadSession/图片音频/MCP是宣告，真实模型、流式、停止、恢复和工具均未通过；Windows Rust编译与迁移回归已通过，跨平台和真实资格待补，移植任务保持实施中。

Hermes来源审查保留[i02-hermes-source-result.json](i02-hermes-source-result.json)的历史快照。后续已隔离安装、接入Core并取得安全原生协议9项证据：没有创建成功Session、状态库0会话、没有模型请求；不能把它当作真实执行资格。项目Skills信任与会话累计用量归属留在[研发待办](development-todos.json)，仍属一期。

## OpenClaw固定版本的已验证输入

固定2026.9.8对应官方提交`fc23bc864e4553c2d215e479eeec47b67a0bf943`。99个源码文件已按Git blob核对；npm元数据没有gitHead，实际发行包的`dist/build-info.json`完整提交与官方tag一致，包锁integrity与官方npm元数据一致。独立Node24.21.0归档按官方SHA256核验，未修改全局环境。隔离安装禁止生命周期脚本；真实`--version`返回`OpenClaw 2026.9.8 (fc23bc8)`，见[i02-openclaw-source-result.json](i02-openclaw-source-result.json)。

该ACP进程必须先连接Gateway才能处理请求；`session/set_mode`设置思考强度，固定接口没有显式模型设置方法或model配置项。会话级MCP被拒绝，但发行文档提供Gateway的`mcp.servers`配置入口。后续在Core管理的独立Gateway内核实模型目录/冻结、MCP授权、双层Session与生命周期，不接管日常Gateway。独立Gateway/ACP原生协议11项及Core受管理Gateway控制面已验证，模型推理未运行。Core21/schema149；四平台未授予资格与324场景待验状态不变。原生可写agentDir不能直接挂接，隔离身份导入、Gateway深检/MCP、Bootstrap及完整生命周期仍属一期必做整改。可复测入口为`tools/integration/smoke-openclaw-core-gateway.mjs`，显式传入独立Host、Runtime、Node、构建包装器和证据目录。

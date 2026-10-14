---
document_type: contract
name: OpenClaw Runtime
version: v1
status: accepted
source_version: v1.72
last_updated: 2026-10-14
---

# OpenClaw Runtime v1

一期保留固定 Codeg 的 OpenClaw 入口。产品类型为`openclaw-cli`，发现命令`openclaw`，覆盖键`ROVAI_OPENCLAW_BIN`。固定2026.9.8/官方提交`fc23bc864e4553c2d215e479eeec47b67a0bf943`要求Node `>=24.16.0 <25 || >=26.1.0`。Core业务状态、Run、批准、投递、计量及数据库保持唯一权威；Gateway仅作为该Runtime的原生执行组件。

## 进程与身份

与Hermes共享ACP事件/批准归约器，但不把OpenClaw当作可独立启动的单进程ACP。一个Fleet Host拥有Gateway与ACP两个受管理进程，沿既有camp/member/NativeBinding复用键；不增加Adapter私有进程池。每个绑定使用Core私有持久目录；配置改变后先退休并收敛旧Host，再打开同一原生存储。HTTP ready后仍须用独立随机凭据完成原生控制请求，不能用端口存活代替自己的Gateway就绪。

Gateway与ACP分别记录后代所有权，任一进程异常时该Host不再复用，停止及强制清理必须覆盖两者。Core重启恢复两个所有权账本。凭据只放私有文件和冻结子进程环境，不进入argv、数据库、公开事件、诊断或验收结果。

Core预先分配完整Gateway键`agent:<nativeAgentId>:rovai:<nativeBindingId>`，原生ACP SessionId另行精确绑定。选择一个实际原生Agent；多Agent配置未指定目标时拒绝猜测。原生返回的canonical键必须与已分配键完全一致。新建请求可创建；恢复请求带`_meta.sessionKey`及`requireExistingSession:true`，配置前再次确认目标存在。不能使用最近会话、短ID猜测或错误后静默新建替代会话。

原生Agent名来自互斥的`agents.entries`或历史`agents.list`。固定版本的读取兼容层保留list，但启动Schema只接受entries；Core只在私有受管理副本转换历史列表，原文件字节保持，名称、模型及其他Agent配置保留。列表id转为规范键，历史default标记不写入新Schema，多个Agent仍必须显式选择。唯一Agent明确到该身份，不能凭空增加main；多个Agent不能按数组或目录顺序猜测。声明ID沿原生64字符ASCII语法规范为小写，重复规范身份、双重roster、缺失ID及非法路径拒绝；不把非法输入通过slug回退改绑其他身份。原生Agent名与Core不透明Binding ID分别校验。

## 模型、权限、MCP与原生配置

固定ACP没有`session/set_model`，`session/set_mode`写入thinkingLevel。Core模型目录使用官方`gateway call models.list --json`，显式模型使用`gateway call sessions.patch`并核对`resolved.modelProvider/model`；原生拒绝时保留失败，不切换模型。Rovai模型ID保留`provider/model-id`完整路由，模型本身可以包含斜杠。

权限是原生Gateway的`permissionMode`：`read-only`、`guarded`、`workspace`、`full`，作用域Session。默认最大值为full，建议值guarded；Core强制只读语义必须实际选择read-only。Native敏感批准保持原生optionId并进入共享批准路径，不能因为选择full而在Core伪造批准。思考强度不作为权限选项。

固定ACP的new/load/resume拒绝任何非空`mcpServers`，Core在这些字段始终传空数组；当前Run选择的服务器映射到私有Gateway的`mcp.servers`，保留stdio参数/环境/工作目录或HTTP头，Core同名定义覆盖原生定义。写入配置、发现名字、初始化宣告均不是工具实际可调用的证据。

保留简单原生模型、Provider与所选原生Agent配置；Core拥有的Gateway、工作目录、调度、渠道、更新及网络入口覆盖到受管范围，不能借原生Gateway另起业务执行链。原生认证只属于OpenClaw自身，不能借用其他产品Home或凭据。原生`agentDir`同时拥有可写会话库，当前明确拒绝直接挂接既有目录；隔离身份导入、OAuth/SecretRef、`$include`及多原生Agent选择的完整兼容仍是一期必做项。不能把当前简单JSON5路径声称为全部认证来源可用。

固定版本的认证秘密位于Agent库`auth_profile_store`的JSON单元，或共享状态库`config_machine_state`的`authProfiles.store`；这些库同时承载其他可写状态。原生portability规则默认禁止复制OAuth刷新材料，显式`copyToAgents:false`和未完成的setup也不能被导入绕过。隔离导入必须保留单一刷新所有权并提供完整登录流程，不能复制整个库或强行改写原生复制策略。当前只是核实了来源合同，尚未实现完整认证导入。

## 实现与准入矩阵

最接近的生产实现为共享ACP/RuntimeFleet，新增差异由`openclaw_gateway`拥有。下表分别标明源码/控制面与真实执行，不用单一绿色替代全部轴。

| 能力轴 | 接入策略 | 当前证据与剩余工作 |
| --- | --- | --- |
| Auth/Provider/Model | 原生配置与Gateway目录、精确patch确认 | 本地元数据夹具已确认控制面；真实认证/模型及复杂配置待验 |
| Host/Fleet/LRU | 单个Fleet租约拥有配对进程、绑定私有状态 | 源码接入；Core原生进程树及跨平台清理分别验证 |
| Native Session | 完整分配键与ACP ID绑定、严格存在检查 | 原生冷ACP及Core ACP Host/Fleet新建、暖复用、重建Host恢复和缺失绑定拒绝已验；完整Core进程/业务数据库重启与异常恢复待验 |
| Bootstrap/Context | 沿Core冻结Context与显式发送合同 | 原生System/首包位置、串会话与重开还须资格测试 |
| Compaction | 不伪造压缩完成或上下文刷新 | 当前禁用未验证检测，后续按原生信号验证连续性 |
| Skills | OpenClaw原生skills位置与Core投影分组 | DocumentationOnly；实际发现、信任和内容更新待验 |
| External MCP | Gateway配置映射，ACP字段保持空 | 原生拒绝已验；Core映射/真实工具与同名覆盖待验 |
| Tool/Action/Output | 共享ACP工具事件、批准和输出归约器 | 源码接入，真实工具执行与错误/输出边界待验 |
| Narration/Final | Core显式发送与缺失发送恢复规则 | 不把Gateway内容自动发布，真实完整Run待验 |
| Permission/Workspace | 四种原生权限、Core只读覆盖、精确ack | read-only元数据已验；实际文件/exec/批准边界待验 |
| Built-in CLI | Gateway继承Core冻结BuiltinTool环境 | 真正调用、运行epoch和重试边界待验 |
| Usage/Cost | 只采原生已确认字段，容量指示不当增量 | 未取得细分/金额，不补零、不推算、保留未知 |
| Retry/Cancel/Cleanup | Core控制Run与配对进程；失败后收敛 | 无模型初始化/EOF已验；活动生成取消/重启待验 |
| Ready/Version/Platform | 固定来源、Node范围与每平台证据分别核实 | 四平台NotQualified，不把安装/版本/握手当First-Class |

## 数据与验收

Migration199以精确schema148为来源，原子扩展七张Runtime/Skills闭集到149，与receipt及合同标记同事务，保留所有原值、索引、触发器和外键；失败回滚。197、198各自继续拥有146→147与147→148。旧快照和既有二进制证据不随当前快照升级。

只有当前Checklist各轴达到实际准入证据才授予平台资格。安装、空认证、本地模型元数据、控制面patch、纯函数或源码构建均不能代替真实模型、工具、停止恢复、计量与客户验收。未完成兼容和修复仍属一期，不迁往第二期。

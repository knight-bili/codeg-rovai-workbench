---
document_type: contract
name: Hermes Runtime
version: v1
status: accepted
source_version: v1.72
last_updated: 2026-10-14
---

# Hermes Runtime v1

一期保留固定 Codeg 的 Hermes 能力，Core继续拥有成员、业务状态、Run、批准与会话绑定；Hermes自己的原生状态库只属于Runtime，不形成第二套业务权威。适配沿[Runtime Launch v60](runtime-launch-and-verification-v60.md)。

## 固定来源与启动

产品类型为 `hermes-cli`，发现命令 `hermes`，覆盖键 `ROVAI_HERMES_BIN`，ACP参数为 `acp`。固定社区桥接包是 `hermes-agent@0.21.6`，它不属于Nous Research官方发行；官方v0.21.6提交为 `818c13be1dc4fd28987e1e881a9408224afd4535`。桥接自己的Git checkout、校验uv、Python3.14与venv必须留在受管理安装根，不能改变全局Python或读取开发测试外的日常配置。原生主目录使用 `HERMES_HOME`。

模型ID完整保留原生 `models.availableModels/currentModelId`，包括 `provider:model` 与命名端点。显式模型通过 `session/set_model` 设置；不替换成同名的其他Provider。认证仅依据原生实际宣告与验证结果，`hermes-setup`终端配置入口不能当作已认证。

## 原生模式、批准与恢复

权限字段为 `permission_mode`，作用域Session，三个原生值为 `default`、`accept_edits`、`dont_ask`。模式必须来自当前Session实际目录；缺失、重复或未知值拒绝Ready。Core通过 `session/set_mode` 应用冻结值，不虚构plan/yolo，也不把 `dont_ask` 当作忽略全部原生批准。敏感路径与工具仍会请求批准，保持原生optionId与范围。Hermes没有满足旧Core强制只读工作区语义的原生模式，不能以默认模式冒充只读。

固定来源的 `session/resume` 在ID不存在时会新建Session。Core恢复已存在绑定时改走严格 `session/load`，不将这种隐式新建声明为可信resume；同Host已知Session仍可复用，明确新请求仍可创建。Core能力快照保留load并移除resume，加载失败保持错误与既有绑定。加载中的历史 `session/update` 仍受Core重放隔离，不投影为当前Prompt输出。

## Skills与用量

原生用户Skills在 `HERMES_HOME/skills`；工程目录为 `.hermes/skills` 与 `.agents/skills`，原生仅加载受信任工程。Core发现路径与投影分组不能替代原生 `skills.trusted_project_dirs`，信任交互和真实发现未验证时保持DocumentationOnly，不能宣称已交付可用Skills。

原生PromptResponse的Usage来自 `AIAgent.session_*` 累计计数；上下文 `usage_update` 的size/used另属容量指示。Core记录session累计值，不将它当作每次Prompt的增量。输入缓存归属不确定时保持Unknown，缺少Run基线不补零、不把历史总量计入当前Run；每Run归属基线及真实跨Run计量仍需一期后续验证。原生未报告的金额与缓存写入保持缺失。

## 数据与验证

Migration198从schema147扩展七张Runtime/Skills闭集到148，与receipt和合同标记同事务，保留原值、索引、触发器及外键；失败回滚。schema147标记不能接纳未提交receipt的Hermes闭集。Gemini的Migration197继续只拥有146→147，旧快照与I01二进制仍保持146；当前融合快照另行演进。

复用并扩展原生模式、批准、恢复选择、稀疏用量与迁移owner，不用重复测试或旧来源资格代替验证。四平台运行资格保持未授予，原生初始化、实际模型、流式、停止、恢复、MCP、Skills与累计用量归属分别取证。未通过项留在一期实施与验收队列中。

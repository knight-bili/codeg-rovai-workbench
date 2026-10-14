---
document_type: implementation-proposal
status: confirmed_for_implementation
revision: 1
confirmation_status: confirmed
confirmed_revision: 1
confirmed_by: User
confirmed_at: 2026-10-14T06:22:03Z
implementation_status: not_started_model_delivery
date: 2026-10-14
---

# 技能包队员投递变更方案

r1 已确认；完整模型变更说明及确认记录见 [当前版本正式文件](../../docs/versions/v1.72/model-context-change-skill-pack-member-delivery.md)。下文保留原提案时的状态说明与前后合同。

本方案对应完整一期 I02-T03 的模型输入部分。请确认是否按 r1 接通技能包的队员使用、会话选择、输入冻结与恢复。安装和成员选择保存已独立开发；当前实际投递尚未接入。本方案不改变一期的81来源簇、48工作包、324验收场景及 I00 至 I12 终点，其他模块继续按 v4 推进。

需要这次确认的原因是仓库 `docs/development/model-context-change-governance.md:49-56` 明确要求：开发者看过完整变更说明后同意具体 revision；“原始需求、第一次方案同意”不算二次确认；“Coding Agent、自动化或实现者不能替开发者自我确认”。本文件是提案，不是已经生效的模型合同。确认前不改模型输入实现、格式版本和相关 Schema。

本次仅请求确认输入语义及本地实施。真实模型 Gate 需另行提供专用身份及硬预算；本次确认不授权付费模型调用、采购、main 合入或正式发布。

## 1 当前状态和目标行为

当前 Core 使用 schema151、Migration201 保存包与队员选择。安装不默认勾选，更新保留同包选择，卸载原子清空，重装不恢复。配置接口返回 `memberDeliveryEnabled:false`。本机已取得三个持久化 owner 和19项真实 Core 接口与生产组件检查证据；测试没有 Run 或 ContextManifest，不能当模型可用证据。

确认后，首次准备一个新 Run 时，Core 根据接收队员的当前选择和当前安装状态提供指南索引。模型按需读取版本目录中的 SKILL.md；它不会因为安装发生而自动获得全队配置或工具权限。会话显式选择也只能暴露接收队员已选择、且当时可验证的包。

关闭选择停止后续新输入提供该包的发现入口和消息局部文件链接，不等于抹去模型已读内容或收回底层文件权限。Native Runtime 的文件批准、Core 工具授权和 MCP 授权继续独立执行。

初次覆盖28份固定内嵌指南。以后自定义、导入及 Office 内容在完成真实内容接入、所有权验证和用户选择后，复用同一 Core 安装身份；外部声明、依赖声明和交互指南不能冒充实际执行。OfficeCLI、科研环境、卡片渲染、市场/MCP及其他一期功能仍按独立工作包实施。

## 2 变更前的精确结构

当前 Bootstrap 为 v5、Formatter5、Charter22，Binding compatibility16。相关顺序如下，最后一项按既有条件出现，Single Chat 省略它。四段原文均不在本次修改范围内。

```text
[SESSION_CHARTER]
[MEMBER_IDENTITY]
[ROVAI_PLATFORM_SKILLS]
[MEMORY_ENTRYPOINT]?
```

当前公开批次 Formatter/Manifest33、Profile10、Run Facts9；非批次为28/28、Profile7、Run Facts6。下列问号表示原有出现条件，不是模型可见字符。括号中的二选一仍按原有调用类型决定。

```text
公开批次
[COLLABORATION_STATE]?
[SELF_ACTIVE_TASKS]?
[RUN_FACTS]
[WORKSPACE]?
[ROVAI_ADDITIONAL_SKILLS]
[RUN_INPUT]

非批次
[COLLABORATION_STATE]?
[SELF_ACTIVE_TASKS]?
[SHARED_THREAD]?
[RUN_FACTS]
[WORKSPACE]?
[ROVAI_ADDITIONAL_SKILLS]
[A2A_GUIDANCE | SINGLE_CHAT_GUIDANCE]?
[CURRENT_INPUT]
```

现有动态工具箱段的完整外层文本和对象形状如下。root 来自执行 Host，五项闭集及其完整 YAML description 保持原规则。即使集合为空，也输出该段。

完整索引类型是 `{root:string,skills:Array<{name:string,desc:string}>}`。五项为 campfire、grill-duo、grill-duo-with-docs、member-studio、review-duo；平台两项 cli-operations 和 memory-stewardship 仍独立留在 Bootstrap，不与包合并。

```text
[ROVAI_ADDITIONAL_SKILLS]
Current for this run; replaces any earlier Rovai Additional Skills.
{"root":"<执行Host受管根>","skills":[]}
[/ROVAI_ADDITIONAL_SKILLS]
```

当前 Selection v2 由 Core 在 claim 时按消息/segment 首次出现顺序去重。完整条目字段如下；sourcePath 可为 null，legacy 沿用不可解析的历史身份。

```ts
type SelectionV2 = {
  schemaVersion: 2
  entries: Array<{
    skillId: string
    nameAtSend: string
    source: 'rovai' | 'native' | 'legacy'
    sourcePath: string | null
    firstMessageIndex: number
    firstSegmentIndex: number
  }>
}
```

已解析的模型局部链接为 `{name:string,path:string}`，只出现在本条消息实际选用的 `RUN_INPUT.messages[].skills` 或 `CURRENT_INPUT.skills`，没有链接时省略字段。Skill 结构化消息仍是 `skill_mention {skillId,nameAtSend}`，可见正文为 `/nameAtSend`。

基线源码为 `context.rs::render_payload`、`prepare_additional_skills`、`current_input_skill.rs` 与 `context_contract.rs`。本轮配置实现未修改这四处对应的模型来源文件，真实验证记录保留其摘要；实际变更以本方案确认后的 diff 为准。

## 3 变更后的完整相关结构

新公开批次使用 Formatter/Manifest34，Profile10和Run Facts9；新非批次使用 Formatter/Manifest29，Profile7和Run Facts6。Bootstrap、Charter、Binding compatibility、Profile 和 Run Facts 的结构与版本保持。

旧公开版本29与新非批次29必须通过 Run 类型及 Profile/Run Facts 组合区分，不能仅按数字29选择公开 serializer。兼容测试必须同时保留旧公开29/9/7和新非批次29/7/6；不得把旧记录升级解释成新格式。

新增唯一同级段 ROVAI_SKILL_PACKS，放在 ROVAI_ADDITIONAL_SKILLS 之后。新格式总是输出它，空集合用于明确本 Run 没有可提供的包。完整新增文本如下，正式 JSON 为确定性单行序列化。

```text
[ROVAI_SKILL_PACKS]
Current for this run; replaces any earlier Rovai Skill Packs.
{"skills":[]}
[/ROVAI_SKILL_PACKS]
```

有内容时，JSON 的完整形状如下。数组按 id 排序；id 为稳定包身份，name 为英文目录名，desc 为完整标准 YAML description，path 为执行 Host 已验证的具体版本入口。路径值是示例，不固定为客户端路径。

```json
{
  "skills": [
    {
      "id": "pack:brainstorming",
      "name": "brainstorming",
      "desc": "<从该版本SKILL.md读取的完整description>",
      "path": "C:/Core/skill-packs/versions/V1/brainstorming/SKILL.md"
    }
  ]
}
```

各包可属于不同版本根，因此不将它们塞进现有单 root 工具箱，不扩大 `rovai:` 五项闭集，也不伪装成 Native 来源。新段外的既有段保留原文、顺序及出现条件。

```text
新公开批次
[COLLABORATION_STATE]?
[SELF_ACTIVE_TASKS]?
[RUN_FACTS]
[WORKSPACE]?
[ROVAI_ADDITIONAL_SKILLS]
[ROVAI_SKILL_PACKS]
[RUN_INPUT]

新非批次
[COLLABORATION_STATE]?
[SELF_ACTIVE_TASKS]?
[SHARED_THREAD]?
[RUN_FACTS]
[WORKSPACE]?
[ROVAI_ADDITIONAL_SKILLS]
[ROVAI_SKILL_PACKS]
[A2A_GUIDANCE | SINGLE_CHAT_GUIDANCE]?
[CURRENT_INPUT]
```

## 4 来源身份和消息解析

会话候选增加 pack 来源，稳定 ID 为 `pack:<skillId>`。候选由 Core 从活跃 Thread 的成员选择与实际安装状态聚合；显示相关队员和来源。名称相同的 Native、工具箱与包保持独立 ID。Renderer 只能发送 ID 和发送时名称，不能提交路径、安装版本或快照内容。

`skills.candidates` 参数保留 campId 和可选 refresh，结果保留 skills/errors。候选完整目标形状如下；原有条目省略 displayName，包条目提供目录里的多语言名称供界面显示。name 始终用于稳定发送身份，entryPath 仅供展示与预览，消息提交时不能将它当可信输入。

```ts
type ComposerSkillCandidate = {
  id: string
  name: string
  description: string
  source: 'toolbox' | 'native' | 'pack'
  sourceScope?: 'user' | 'project' | 'installed'
  entryPath: string
  memberIds: string[]
  displayName?: Record<string, string>
}
```

新 claim 使用 Selection v3，完整形状如下。rovai/native/legacy 沿用现有 sourcePath 规则；pack 的 sourcePath 必须为 null，防止消息携带任意路径。nameAtSend 使用包的稳定英文名称。手写斜杠文本仍是正文，不变成选择。

```ts
type SelectionV3 = {
  schemaVersion: 3
  entries: Array<{
    skillId: string
    nameAtSend: string
    source: 'rovai' | 'native' | 'legacy' | 'pack'
    sourcePath: string | null
    firstMessageIndex: number
    firstSegmentIndex: number
  }>
}
```

首次 preparation 统一读取该队员当时的选择与当前安装版本。pack ID、名称、所有权、普通文件树、frontmatter 和完整性均需匹配。修改损坏、缺源、已卸载或未选择的包从本 Run 索引和局部链接省略，保留原消息、结构化事实与 FIFO；不按同名项改绑。

Resolution v3 的 entries 保留下列完整信息；selectionSnapshotDigest 沿用现有字符串关联，不新增独立证明摘要。旧 resolution 按原版本解析。pack 不可用时 sourceVersion/sourcePath 可为空，reason 必须准确；原有遗漏原因完整保留在兼容类型中。

```ts
type ExistingSkillReason =
  | 'not_eligible_at_send' | 'missing_at_start'
  | 'inactive_at_start' | 'disabled_at_start'
  | 'name_mismatch_at_start' | 'runtime_group_unassigned_at_start'
  | 'exposure_missing' | 'exposure_name_mismatch'
  | 'exposure_not_ready' | 'exposure_group_incompatible'
  | 'skill_file_unavailable' | 'source_missing'
  | 'source_unreadable' | 'legacy_unresolved'

type ResolutionV3 = {
  schemaVersion: 3
  selectionSnapshotDigest: string
  entries: Array<{
    skillId: string
    nameAtSend: string
    source: 'rovai' | 'native' | 'legacy' | 'pack'
    sourcePath: string | null
    sourceVersion: string | null
    outcome: 'available' | 'unavailable'
    reason?: ExistingSkillReason | 'pack_not_selected'
      | 'pack_not_installed' | 'pack_changed'
  }>
}
```

对非 pack 来源，sourceVersion 固定为 null，其他既有遗漏原因原样保留。包可用时 sourceVersion 是 Core 的安装观察版本，sourcePath 指向该版本 SKILL.md；它们来自 Core，不能从客户端接受。诊断保留既有解析所需资料，不恢复已退役的重复 proof digest 列。

消息局部链接继续使用同一 `{name,path}` 形状，不增加隐藏正文或工具说明。仅当这条消息显式选择的包对接收队员可用时加链接；长期配置的其他包只在新索引出现，不追加到每条消息的 skills。点击引用复用现有预览句柄，先按活跃 Thread、包身份和受管版本核验，拒绝任意相对路径与同名回退。

## 5 冻结和恢复边界

首次 preparation 的动态索引、消息局部链接及最终 UTF-8 payload 一起冻结进现有最终 Dynamic Context Blob，复用 Run/Binding、源身份、遗漏信息与必要恢复资料。配置和安装变化只影响尚未物化的新输入；相同 Run 的重试、Core 重开和 execution epoch 推进恢复原 Blob，不重算当前队员选择。

更新发布新私有版本，卸载保留旧文件。Core 的这两类操作不能覆盖旧 Run 引用的目录或重写已冻结字节。用户手动损坏或删除保留文件时，不声称模型仍能读取原指南，也不换绑新版本；沿用可观测的文件读取失败处理。保留版本的清理必须核实历史引用，独立实施，不能在新索引中顺便清理。

已有 accepted 或 unknown outcome 不因技能变化重发。Native Session 内原生 compaction 不触发第二条只含技能的任务消息。关闭选择不会抹去旧 Native 会话的既有内容；Core 控制的 Bootstrap 补发仍使用该 Binding 已冻结的 Bootstrap。

所有索引、完整 description、路径和消息内容参加真实 UTF-8 输入预算。超预算继续返回 `context_payload_too_large`，不截断输入、不静默删选中的指南、不跳过 FIFO 前项。个别不可用来源按上节省略并记原因。

## 6 数据迁移和兼容策略

当前安装与成员选择已经由200/201保留。模型实现另追加一个迁移，预计由151升级下一 schema；实际编号在实施时从最新链尾分配并补记，不占用其他模块的迁移号。该迁移扩展 `agent_run_input`、`context_manifest` 等既有新写入版本约束及相应 guard，允许 Selection/Resolution v3、新公开34及非批次29，不增设第二套安装数据库或快照权威。

受支持的旧 RunInput、Manifest、Binding、Blob、命令结果、Revision 和审计行均保留。已经物化的旧28/33及其他仍受支持格式复用原字节；旧未物化 Run 继续按它冻结时的 serializer 重建，不热加新包段。此前已退役的更早公开格式继续不派发，不复活为兼容捷径。新写入必须匹配新 RunInput 版本，失败时整笔迁移回滚。

不复制 OAuth、修改用户原生技能目录或重建全部 Native Session。Core 仍是业务和执行权威；安装目录 marker 只证明归属。模型可见指南不改变消息接收者、工具/MCP授权、权限批准或协作资格。三种新增 Runtime 和各平台的真实资格仍逐项补齐。

## 7 固定验证用例和通过标准

| 编号 | 输入或操作 | 必须观察到的结果 |
| --- | --- | --- |
| SP01 | 无成员选择的新公开与非批次 Run | 新包段存在且 skills 为空，原工具箱和消息原样保留 |
| SP02 | 包只选择队员 A，A/B 分别准备输入 | A 有正确包身份和路径，B 的新索引与局部链接不含该包 |
| SP03 | 伪造 ID、路径或名称，同名不同来源 | 不接受客户端路径，不改绑同名来源；消息本身保留 |
| SP04 | 删除、损坏、改动 frontmatter 或放入外部链接 | 包按准确原因省略，记录遗漏；不遍历外部目录，不丢正文 |
| SP05 | 在首次 preparation 前后分别更新包 | 物化前按当时选择解析；物化后重试复用原 payload 和版本入口 |
| SP06 | 排队期间卸载或取消选择 | 未物化的新输入省略该包，已冻结输入不重写 |
| SP07 | 重装、旧配置命令/旧卸载命令回放 | 不重新赋值，不覆盖新状态；首次结果可查 |
| SP08 | Core 重启、恢复、epoch 推进 | 同 Run 恢复完全相同的最终 Blob 字节，不重读新配置 |
| SP09 | 旧 v1/v2、公开29/9/7与已冻结28/33输入 | 原 serializer 和原字节保持；不误判为新非批次29/7/6，无新段或旧来源改释 |
| SP10 | 中文、换行、引号及低预算完整输入 | JSON 与全量 description 正确计字节，超限明确失败，不截断 |
| SP11 | 公开批次、普通、A2A、Single Chat | 段顺序、选择和局部链接规则一致，固定 Bootstrap 保持 |
| SP12 | 专用身份下的实际指南读取和任务 | 必须有真实 Runtime 输入接受和工具读取证据，不能用模型自述代替 |

确定性部分先覆盖 migration rollback、空集合、成员隔离、精确恢复、重复/冲突命令、路径边界和 UTF-8 预算；模拟运输只证明协议，不能替代 SP12。真实评测复用仓库双轨 Gate，保留变更前后输入、工具与结果证据。先完成代表性 Runtime，再补齐21种来源及平台矩阵；一次运行成功不能代表全矩阵通过。

本地确定性测试无外部模型费用。真实 Gate 的 Case 清单、模型、输入上限和硬额度在取得专用身份后冻结，每套最多两次尝试；额度或身份缺失时标记 not_run。账号付款、平台设备和签名依旧按客户待办后补，不据此缩减一期。没有真实证据时，不将实际模型读取或完整MVP标为完成。

## 8 实施顺序和验收

第一步已经独立完成安装与成员配置保存，不改变当前模型输入。客户确认 r1 后，将本提案转入当前版本的独立模型上下文说明，记录确认人、时间、revision和confirmed_revision，再实施新来源、候选/预览、格式及迁移。接着自审差异、运行确定性与恢复检查，最后以专用身份补真实 Gate、平台与完整融合验收。main 合入和正式发布仍由客户决定。

未确认期间，模型投递保持待办，继续 I03 无限画布及其他独立研发。确认语句可直接使用：

“确认按技能包队员投递变更方案 r1 实施模型输入改动；真实模型测试身份和额度另行提供。”

## 9 研发自审结论

包来源独立于固定工具箱及 Native 来源，避免名字碰撞和单 root 假设；安装与成员选择都由 Core 负责。新格式有明确版本和旧恢复边界，最终 Blob 仍是恢复权威。空索引、配置撤销与已有会话记忆之间的区别已经说明，未承诺不存在的安全隔离。

尚未取得 r1 的二次确认，也没有真实模型或跨平台 Gate 证据。当前已验证的配置保存与本提案的目标投递分开记录；来源声明、指南文件、模拟协议和编译成功都不能替代实际能力。确认及资源欠项保留在一期，研发不为通过现有测试而回避它们。

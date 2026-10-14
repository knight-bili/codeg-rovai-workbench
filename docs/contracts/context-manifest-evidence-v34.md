---
document_type: protocol-contract
contract: context-manifest-evidence-v34
authority: public-multi-input-agent-run-context-evidence
status: accepted
version: 34
last_updated: 2026-10-14
---

# ContextManifest Evidence v34

继承 [v33](context-manifest-evidence-v33.md)，按客户已确认的
[技能包投递 r1](../versions/v1.72/model-context-change-skill-pack-member-delivery.md)
增加独立技能包来源。本文的 accepted 表示合同获确认，交付资格仍以实施记录和测试证据为准。

## 版本和身份

| 输入 | Manifest/Formatter | Profile | Run Facts | Selection/Resolution |
| --- | --- | --- | --- | --- |
| 新公开批次 | 34 | 10 | 9 | 3 |
| 新非批次 | 29 | 7 | 6 | 3 |
| 历史公开29 | 29 | 9 | 7 | 原冻结版本 |

Bootstrap5、Charter22、Binding compatibility16、Profile及Run Facts结构不变。
版本29必须结合Run类型和Profile/Run Facts判断；不把旧公开29解释为新非批次29。
既有26/27/28非批次和29/30/31/32/33公开恢复分支保留原语义。

Migration203从最新schema152/202追加到153；保留旧Run、输入、Manifest、原Blob和原命令结果字节，
只扩大合法格式并设置新Run的空Selection3默认值。三个表的重建、约束、升级回执和版本标记在同一事务中；
任一步失败完整回滚，恢复外键检查。退役证明摘要保持可空，不增加快照真源、安装证明表或新证明摘要。

## 动态段和消息引用

新格式在原 `ROVAI_ADDITIONAL_SKILLS` 后、指导/输入段前总是输出：

```text
[ROVAI_SKILL_PACKS]
Current for this run; replaces any earlier Rovai Skill Packs.
{"skills":[]}
[/ROVAI_SKILL_PACKS]
```

非空项精确为 `{id,name,desc,path}`，按id排序；id为独立 `pack:<skillId>`，
name为稳定英文名称，desc是该版本完整YAML description，path是Core验证的具体受管版本SKILL.md入口。
不同包可来自不同版本根，不扩大五项工具箱、不合并成单root、不伪装Native。
其余动态段的原文、顺序和条件保持；平台两项继续只在Bootstrap。

Selection3的条目为 `{skillId,nameAtSend,source,sourcePath,firstMessageIndex,firstSegmentIndex}`，
source闭集为rovai/native/legacy/pack；pack的sourcePath必须为null。
消息提交仍只有SkillMention身份和发送时名称，不能携带路径、版本、安装内容或客户端快照。
Resolution3条目为 `{skillId,nameAtSend,source,sourcePath,sourceVersion,outcome,reason?}`；
outcome为available/unavailable，非pack的sourceVersion始终null；可用pack含具体版本和入口，
不可用pack的路径、版本均为null。原14种原因保留，增加pack_not_selected、pack_not_installed、pack_changed。

首次preparation读取接收队员当时的选择、安装和受管文件；索引和
`RUN_INPUT.messages[].skills` / `CURRENT_INPUT.skills` 使用同一份事实。
局部链接仍只含 `{name,path}`，按消息位置和身份关联，不能按同名改绑。
写Manifest前在事务内重验成员选择、安装观察版本与可读内容；发生变化则此次物化失败，不写混合版本。
失败原因并入原遗漏证据和Resolution，不创建第二套记录系统。

## 冻结、恢复和预算

最终Dynamic Context Blob为模型输入唯一冻结权威。已物化Run的重试、重启或epoch恢复逐字复用，
不重读当前成员配置重组索引。既有Delivery预览冻结完整payload时，同时保留该payload所需的
Resolution3恢复元数据；实际物化校验冻结身份/结构，不根据后来更新或卸载重算。
更新保留旧版本目录，卸载清除新任务选择但保留旧文件，重装不恢复选择；人为损坏旧目录时如实读取失败。

accepted/unknown输入不因技能改变而重发；Native自身compaction不单独补技能消息。
完整description、真实路径、消息正文和所有原必需段参与实际UTF-8预算，超限沿用
`context_payload_too_large`；不截断、不静默删除指南、不跳过FIFO。

## 候选和预览

`skills.candidates`保留campId/refresh及skills/errors；新增pack/installed来源，
从活跃Thread的活跃队员选择和实际可验证安装聚合memberIds。候选保留稳定name，
displayName可选且为多语言字典，供显示和搜索；entryPath仅为Core观察值，不是消息提交凭据。
工具箱、Native与包的同名项使用不同ID。

包预览复用 `skill_reference`，仅接受skillId及固定SKILL.md引用；验证活跃Thread、
相关活跃队员的选择和当前受管版本。卸载、撤销、改坏后拒绝新预览，不接受客户端任意绝对路径。
安装和配置API的memberDeliveryEnabled表示当前Core已接通此输入格式，不代表模型已经读取或任务执行成功。

真实Runtime读取指南、模型身份及额度的资格见r1的SP12；本地数据库、组件、编译和协议测试均不能替代它。

---
document_type: protocol-contract
contract: skill-pack-members-v1
authority: core-skill-pack-member-configuration
status: accepted
version: 1
last_updated: 2026-10-14
---

# Skill Pack Members v1

本合同拥有技能包的队员选择保存与装卸交互，配合 [Skill Pack Installation v1](skill-pack-installation-v1.md)。当前选择不参与模型索引、结构化消息候选、Native 发现或权限计算；`memberDeliveryEnabled` 固定为 `false`。模型投递是待单独确认的变更，不能以配置保存替代真实使用。

## 保存与并发

Migration201 从 schema150 升级151，创建 `member_skill_pack(skill_id,agent_id,updated_at)`，复合主键为 `(skill_id,agent_id)`，分别引用安装行和队员 Profile，硬删除级联。按队员查询有 `(agent_id,skill_id)` 索引。建表、索引、收据及 marker 同事务；没有迁移默认选择，也不修改原工具箱五项的配置。

安装后只有 User 在全局作用域显式保存才能写入选择。成员必须存在且未被移除；重复 ID 去重并排序。列表过滤已移除 Profile。观察版本由当前安装版本与有效成员 ID 集合共同生成，客户端不能按时间推算；其他位置改变选择、卸载或更新包版本时，旧观察返回冲突，不写部分选择。相同 caller/类型的 commandId 返回首次结果，即使重试 payload 改变。

更新或修复同一包保留队员选择；卸载在同一命令事务删除该包的选择并将安装行改为 removed，命令结果失败则两者一起回滚。重装不恢复旧选择；重放卸载前的旧成员命令只返回历史结果，不再执行写入。已保存选择不是工具授权，当前不触发模型调用。

## API

| 操作 | 参数 | 结果 |
| --- | --- | --- |
| `skillPacks.members.list` | `{}` | 每个安装记录的 `skillId/installed/memberIds/version/memberDeliveryEnabled` |
| `skillPacks.members.set` | `{commandId,command:{skillId,memberIds,expectedVersion}}` | 持久化命令结果；applied 包含当前成员集合与观察版本 |

错误码为 `skill_pack.members.invalid_request`、`skill_pack.members.not_installed`、`skill_pack.members.member_unavailable`、`skill_pack.members.conflict`。未知包、未安装或已卸载包不能保存；Office 外部声明不能绕过实际安装前提。接口同时由 Core 和已登录 Host Web 提供，不提供 Renderer 任意路径输入。

## 界面与验证

设置页交互由 [Skills UI 合同](../ui/components/skills-settings.md) 拥有。新增扩展 owner 的职责与最小命令见 [测试准入](../development/testing.md#rust-测试准入与退役门槛)；`tools/integration/smoke-skill-pack-members.mjs` 验证真实150→151、首次结果和选择重开、配置丢失响应重试、生产组件及真实队员名单。原生发现为空夹具，Run/ContextManifest 为0；不授予真实模型、原生发现、工具或全平台资格。

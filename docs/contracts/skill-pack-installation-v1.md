---
document_type: protocol-contract
contract: skill-pack-installation-v1
authority: installed-skill-pack-state-and-owned-file-versions
status: accepted
version: 1
last_updated: 2026-10-14
---

# Skill Pack Installation v1

本合同拥有一期 I02-T03 的显式安装、刷新修复与卸载。来源与静态预览继续由 [Codeg Skill Packs v1](codeg-skill-packs-v1.md) 拥有；模型、工具箱与原生来源身份仍由 [Skills Rebuild v2](skills-rebuild-v2.md) 拥有。当前安装不向成员投递、不加入消息候选、不创建原生 CLI 链接，也不恢复旧 Library 的数据库权威。

## 数据与文件

Migration200 从 v1.72/schema149 升级150，在同一事务创建 `skill_pack_installation`、写入收据并更新 marker。旧业务数据和命令首次结果保留；创建表或收据失败整体回滚。数据库准入按当前 [结构检查](input-snapshot-storage-v1.md) 验证列、键和当前收据，不比较 CREATE SQL 全文。

`skill_pack_installation` 以 `skill_id` 为主键，记录固定来源 revision/source_digest、当前 `active_version`、content_digest、`installed | removed`、单调 generation 和更新时间。`source_digest` 标识来源文件与执行位；content_digest 使用既有安全文件树读取器的 `sha256:` 内容身份，检测实际文件改动。两者不是模型输入的附加摘要。唯一当前安装状态来自 Core SQLite，目录 marker 只确认文件归属，不能自行启用技能。

文件位于执行 Host 的 `<Core data-dir>/skill-packs/versions/<uuid>/<skillId>/`。同级 `.rovai-skill-pack.json` 记录版本与来源归属，`THIRD_PARTY_NOTICES.json` 保留来源许可。新目录及文件使用现有私有存储准入；拒绝链接、reparse、路径越界和不满足私有条件的对象，不修复未知目录权限。

## 发布与并发

1. Core 在短数据库锁内优先查同一 commandId 的首次结果，并检查 User actor、全局作用域、当前版本和固定来源 revision。拒绝可回放，且不准备文件。
2. 合法请求在数据库锁外的 blocking worker 预备有界文件树。全部字节及归属写完后才可提交；预备中断留下的目录没有数据库指针，启动、读取和扫描不会自动采用它。
3. 提交重新检查观察版本，确认预备内容后，在同一事务切换安装行、发布事件并保存命令结果。预备期间另一个操作先提交时，旧操作返回版本冲突，不能覆盖新状态。事务失败时文件可能已完成，但不会被列为已安装。

命令遵守现有 [Domain Command Result](domain-command-result-v2.md)：同一 caller/类型的 commandId 返回首次结果，即使重试 payload 改变；新操作使用新 commandId。健康且来源相同的显式刷新返回 `skill_pack.already_current`，不创建版本。有效文件已改动、归属损坏或来源更新时，显式刷新发布新版本；不覆盖、删除或移动原版本。

旧版本、用户改动、未提交目录均保留在私有受管根；当前安装列表只暴露数据库选择的版本。保留历史与清理磁盘是不同操作；后续清理必须独立验证归属及历史引用，本版不增加后台扫描或删除框架。

## API

以下操作同时由 Core 和已登录的 Host Web 提供，共用数据库及实现。

| 操作 | 参数 | 返回 |
| --- | --- | --- |
| `skillPacks.installations.list` | `{}` | `SkillPackInstallationView[]` |
| `skillPacks.install` | `{commandId,command:{skillId,sourceRevision,expectedVersion}}` | 持久化命令结果，包含新观察版本、内容路径及旧版本保留信息 |
| `skillPacks.uninstall` | `{commandId,command:{skillId,expectedVersion}}` | 持久化卸载结果及 `retainedContent:true` |

未存在行的 `expectedVersion` 为 `absent`；已存在或已卸载行使用安装列表返回的 opaque `version`，客户端不能用文件时间推算。卸载把当前行改为 `removed`，保留文件和审计结果；重开不重新启用，重新安装需使用卸载后的观察版本。卸载不遍历原版本，归属损坏或含外部链接不导致删除外部目录。

列表返回 `skillId/sourceRevision/status/version/availability/contentPath/retainedContent/memberDeliveryEnabled`。`availability` 为 `available`、`modified`、`unavailable` 或 `removed`；内容路径仅在归属和普通文件树可验证时返回。普通用户改动的树可为 `modified`；缺失、非法 frontmatter、链接或归属不明为 `unavailable`。列表不创建目录、不修复或写回状态。`retainedContent` 表达保留策略，`memberDeliveryEnabled` 当前固定 `false`，不代表 Native 或模型已读取指南。

可安装来源只有已嵌入的28份固定指南。未知 ID 或 OfficeCLI 的外部声明返回 `skill_pack.source_not_bundled`；来源版本不一致返回 `skill_pack.source_changed`；观察版本不一致返回 `skill_pack.version_conflict`。不下载包、不安装 Python/Node 环境或执行脚本；OfficeCLI、市场、自定义创作及成员投递仍继续实施。

## 验证责任

纯来源 owner 继续验证28份嵌入清单和不可安装的 Office 声明。新增扩展 owner `skill_pack_installation::tests::version_publication_preserves_edits_fences_stale_commits_and_replays_across_reopen` 拥有文件预备/数据库发布、竞争提交、用户改动、收据回滚、归属损坏、卸载与重开；纯函数或旧 Library 不能证明这条新持久化路径。新增 `db::tests::skill_pack_migration_preserves_receipts_and_rolls_back_its_table` 拥有149来源、DDL/收据回滚、旧结果保留和150结构拒绝。

`tools/integration/smoke-skill-pack-installation.mjs` 通过旧149和新Host的真实 HTTP 路径验证升级与安装生命周期，数据、Home、Skill Library 和 MCP 全隔离，不发模型请求。设备、其他平台、UI、成员实际输入和外部依赖继续单独验收，不能由这些检查推定完成。

设置页交互由 [Skills 设置 UI 合同](../ui/components/skills-settings.md) 拥有。`tools/integration/smoke-skill-pack-ui.mjs` 使用生产 Skills 组件、真实 Core 技能包 HTTP 和独立浏览器验证装卸、响应丢失后重放、标签状态保留、多语言与日夜/窄屏；原生 Skills 发现返回空夹具，不能作为完整工作台、原生发现或模型投递的验收。

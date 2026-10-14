---
document_type: protocol-contract
contract: codeg-skill-packs-v1
authority: codeg-pack-catalog-and-fixed-source-preview
status: accepted
version: 1
last_updated: 2026-10-14
---

# Codeg Skill Packs v1

本合同拥有一期 I02-T03 的固定来源目录与只读预览，不改变 [Skills Rebuild v2](skills-rebuild-v2.md) 的模型投递、原生来源身份和旧 Run 恢复。显式安装、刷新与卸载见 [Skill Pack Installation v1](skill-pack-installation-v1.md)；按成员投递以及 MCP 市场仍继续实施。

## 来源与资格

固定来源为 Codeg `aff1e6c278453ed8d0b96a5f664edcdca621aa3f`，源锁定见 [sources.lock.json](../../integration/sources.lock.json)。Core 内嵌来源中的普通文件及必要通知，以原字节保存；不跟随供体 symlink、不读取用户 Home、不执行包脚本或下载依赖。`notices` 随目录返回 Codeg Apache-2.0、科研 MIT 通知及补留的 Superpowers MIT；专家资源与上游 v6.3.0 比对52文件中51份相同，另一份为供体声明的独立 ESM marker，记录见 [来源核对](../../integration/licenses/superpowers/source.json)。这不等于全部间接依赖许可审核完成。

目录包含五类来源：14 项 `experts`、13 项 `science`、9 项 `office`、1 项 `ui`；`custom` 表示用户创作来源，没有预造实例。专家/科研元数据保留全部语言、排序、分类、图标、featured/accent、needsKey/needsEnv，条目记录原文件路径、固定 commit 链接。科研所需环境和外部账号不因列入目录而具备。

Office 的九项声明来自固定 `office_tools.rs`，`loadId` 保留 OfficeCLI 的短名称；源仓没有对应静态 Skill 内容。目录用 `contentSource: officecli`、`requiredCapability: officecli` 明确依赖，不执行 `officecli load_skill`、不编造内容。`ui-render` 的指南可预览，但其 `requiredCapability: generative_ui_renderer` 表示还需移植渲染器及交互合同；显示指南不是交互卡片已经可运行。

`skillPacks` 目录 ID 只标识固定来源条目；不是可直接发送的 `rovai:`、`native:` 或旧 Revision ID，不进入固定工具箱、消息候选或模型索引。条目存在不等于已安装、启用、原生加载或实际执行。

## API

两个 API 同时由 Core 进程请求和已登录的 Host Web 通道提供，共用一份源数据，不需要数据库迁移。

| 操作 | 参数 | 返回 |
| --- | --- | --- |
| `skillPacks.list` | `{}` | `SkillPackCatalogView {schemaVersion:1,repository,commit,families,entries,notices}` |
| `skillPacks.read` | `{skillId,path?:string}`，默认 `SKILL.md` | 既有 `SkillContentView {path,content,status,files}` |

条目字段由共享 [contracts](../../packages/contracts/src/index.ts) 的 `SkillPackEntry` 定义。`contentSource` 为 `embedded` 或 `officecli`；没有安装状态字段，不从目录记录推测主机状态。family 描述的 `sourceKind` 还可为 `user_authored`。

预览只接受目录中已登记条目的确切相对文件，不接受绝对路径、空组件、`.`、`..`、反斜线、冒号或未知字段。返回该条目内普通文件清单，不能跨包；不存在条目/文件及 Office 外部内容明确失败。UTF-8 普通文本返回 `text`，含 NUL 或无效 UTF-8 返回 `binary`；超过 1 MiB 返回 `too_large`，后两种不返回正文。读取不写原生路径、安装状态或配置。

## 固定资源维护与验证

`tools/integration/import-codeg-skill-catalog.mjs <绝对供体目录>` 从源锁定的 Git 对象读取资源，逐文件校验 Git blob 与 SHA-256，保留文件模式来源和许可证，生成编译期资源清单。重复导入只核对同一字节；已有内容不一致时拒绝覆盖。修改来源版本需独立更新源锁、许可、清单、API 实现及验收证据，不能从供体工作树的可变文件取内容。

唯一纯函数 owner `codeg_skill_catalog::tests::catalog_preserves_pinned_sources_and_bounds_content_reads` 验证来源摘要、目录/Office 依赖、全部静态指南与越界拒绝。真实 Core 与 HTTP 转发用隔离 smoke 单独验证；目录和预览通过不能替代安装、更新、卸载、成员投递或模型/工具验收。

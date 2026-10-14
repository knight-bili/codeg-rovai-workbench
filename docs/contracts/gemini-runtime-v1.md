---
document_type: contract
name: Gemini Runtime
version: v1
status: accepted
source_version: v1.72
last_updated: 2026-10-14
---

# Gemini Runtime v1

一期来源并集保留 Gemini CLI。业务、Run、Session 绑定、权限与数据库仍由 Rovai Core 管理；不启动 Codeg Tauri 的第二套执行权威。

## 产品与运行

AdapterKind 为 `gemini-cli`，发现命令 `gemini`，显式程序覆盖键 `ROVAI_GEMINI_BIN`。本批依据固定 Codeg 的 `@google/gemini-cli@0.60.0` 和官方同名 tag。ACP 启动为 `--acp --skip-trust`；模型用当前用户选择的原生模型 ID，权限使用 `approval_mode`。配置与 MCP 投递不写全局 settings；后者经既有 ACP session/new/load 合同附加，来源同名服务器被当前投递覆盖。

模型目录从已认证 Session 的 `models.availableModels/currentModelId` 读取，不从初始化宣告虚构模型。显式模型在启动参数 `--model` 之外，经原生 `session/set_model` 确认；不能发送来源未实现的 `session/set_config_option`。原生拒绝后不切换替代模型或新建替代 Session。权限模式只采用原生 Session 实际提供的 `default`、`auto_edit`、`yolo` 和条件性 `plan`；未提供 plan 时不在有效权限目录展示。缺失、重复或不支持的模式拒绝 Ready，不能悄悄套用其他产品的权限配置。

会话恢复、取消、结构化批准、首次正文 Charter 和显式公屏发送沿 [Runtime Launch v60](runtime-launch-and-verification-v60.md) 及当前 ACP 实现。只有实际验证后才能授予平台运行资格；本批初始化/空认证拒绝不等于真实模型、流式、停止、恢复或工具已可用。压缩检测保持未验证禁用，后续须按实际原生信号补齐。

原生结果 `_meta.quota.token_count` 的 input_tokens/output_tokens 分别是该 prompt 汇总的输入/输出；未提供缓存细分与金额时保持缺失，不推算成本。Skills 原址使用当前 `GEMINI_CLI_HOME` 下的 `.gemini/skills` 与 `.agents/skills`，工程范围沿同名目录。原生认证与环境由现有成员环境/启动设置合同管理；兼容整改与实际资格仍属于一期。

## 数据与升级

Migration 197 从 v1.72/schema 146 升级到 schema 147，扩展五张 Runtime 表和两张 Skills 表的闭集；旧行、索引、触发器和外键必须保持。迁移与 receipt/合同标记同一事务提交，失败回滚；不使用 writable_schema。旧 Core 识别不了新的 typed Runtime/Skills 字段，必须拒绝 schema 147，不能当成旧 schema 打开或重置。

固定源接口快照和 I01 二进制证据保留 schema 146；当前融合合同单独记录 schema 147，Host Web 协议4及161个操作保持。CurrentMigrationState 的历史 receipt196 仍只代表 schema146，新147的准入需要receipt197及完整闭集。

## 验证边界

源码/参数/模型权限由低成本 owner 检查，schema146升级的七表逐值保留、rollback、receipt、外键和重开由独立 extended SQLite owner 检查。Windows/Linux 原生 Rust编译与执行由 Core integration 执行；Mac Desktop/Web夹具保持 ready 断言，空库 Debug 初始化使用60秒独立观察预算。任何失败或未运行项都保留待办，不以旧来源资格、宣告或 mock 代替融合验收。

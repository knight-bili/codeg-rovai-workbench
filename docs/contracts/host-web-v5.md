---
document_type: protocol-contract
contract: host-web-v5
authority: shared-host-web-transport
status: accepted
version: 5
source_version: v1.72
last_updated: 2026-10-16
---

# Host Web v5

继承 [v4](host-web-v4.md) 的认证、Owner、allowlist、超时和命令回执。已认证 User 的变更操作新增
`agentRuns.continue`，输入与准入由 [AgentRun Continuation v1](agent-run-continuation-v1.md) 拥有。
Web 仅转发闭合请求并通过既有 `commands.reconcile` 核对原 commandId；不得因运输失败换 ID 重发。
该增量不改变登录与 Session schema，传输 `protocolVersion` 保持 4。Agent 权限不扩大。

## 私聊上传原回执与恢复能力（2026-10-16）

登录及编辑端恢复响应增加可选 `privateUploadRecoveryVersion: 1`；没有该声明的 Host 不启用新的私聊准备接口。
这是 API 能力声明，不新增凭据、持久 Session 字段或传输大版本。旧上传及 reconcile 的请求/响应保持兼容。

新增认证 `POST /api/v1/uploads/receipt`，请求为原 UploadIntent，只准私聊 target。
Host 从已验证 Session 构造 DraftClient，通过内部 `host.upload.receipt` 读取同 UUID 的持久结果；
不查当前草稿、编辑租约或源文件，不登记 scope，不写业务数据，不因原材料移除/编辑取消而换编号。
未知返回 `{state:'unknown'}`，已记录返回 `{state:'recorded',receipt}`；错误返回通用不可核对结果，不降级重放到其他编辑端。
Core 内部入口允许 Host 已验证的 Desktop/Web 编辑端，浏览器 `/request` allowlist 仍不允许直接调用该内部方法。

HTTP receipt 只投影 commandId、commandType、status、code、recordedAt、空 resultEntity，以及 payload 中的 attachmentRefId/revision；
拒绝结果的 payload 为空。即使同编号原结果来自旧公开上传，也不能把 SourceRef、sourcePath、draftId 或内部实体带到此接口。
该值是原结果的安全视图，不伪造新的 Core 回执。归属及首次结果规则继续由 Domain Command Gateway 拥有。

共享 Web 页面通过原准备接口保留 request/intent/phase/receipt，文件字节只留有界内存；刷新或淘汰后显式重选，
名称、大小和 SHA-256 全部一致才可用原 UUID/target/revision 重试。恢复/重复 prepare 只查询，不发送新文件。
首次明确 HTTP 拒绝可记为本次 rejected，不伪装成 Core recorded；已有未知请求的重试拒绝仍保留未知，等待原回执。
准确的输入位置和界面边界见[私聊输入合同](single-chat-composer-scope-v1.md#web-原请求准备与原文件重选2026-10-16)。

已提交上传拒绝通过 `/uploads` 与旧 `/uploads/reconcile` 返回 `409/upload_rejected`，区别于普通 `draft_changed` 或运输未知。
该错误码只来自 Core 原回执，允许旧 transport 结束原 unknown 请求；不能用一次重试的普通错误替代原提交结果。
`/uploads/receipt` 继续返回 recorded/receipt 安全视图。确认拒绝的未绑定临时文件可删除，未知或已绑定的原文件继续保留。
私聊拒绝在原事务的只读业务准入产生，数据库/文件/观察执行错误仍按[Domain Command Result](domain-command-result-v1.md#1-命令结果与事务)回滚。

## 私聊文件准备的明确重试与结束（2026-10-16）

登录及恢复身份增加独立可选 `privateUploadLifecycleVersion: 1`，仅在原恢复能力也为1时启用。
不声明时仍保留原四接口，不显示结束准备入口。
认证 `POST /api/v1/uploads/retry` 和 `/api/v1/uploads/finish` 均接收完整原 UploadIntent，拒绝 Camp target；
Host 从可信 Session 构造编辑端身份，通过私有 `host.upload.retry` / `host.upload.finish` 进入原 Core Gateway。
这两个方法不加入通用 Web RPC 准入，也不接收文件或返回本机路径。

retry 优先返回原首次回执；没有回执时，明确业务失效才记录原 UUID 的真实 rejected，仍就绪则回滚并返回
`{state:"needs_source"}`，不落回执。客户端随后核对原文件并重传；缺文件则要求重选。
finish 只由用户明确点击发起，原首次结果优先；未提交时记录 `attachment.upload_preparation_ended` 的真实 rejected。
已提交结果不变，不删除材料、正文或源文件；后到的原上传只能回放此首次结果。
两者返回 recorded 时沿用原安全回执投影，存储或运输错误仍返回未知，由客户端只读核对，不能本地伪造完成。

本批已编码并完成客户端定向检查；新 Core 与实际 HTTP 路径留待阶段候选编译及运行验证。

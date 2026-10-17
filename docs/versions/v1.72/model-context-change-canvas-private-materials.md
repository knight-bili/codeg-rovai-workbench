---
document_type: model-context-change
version: v1.72
change_id: canvas-private-materials
revision: 1
confirmed_revision: 1
confirmation_status: confirmed
confirmed_by: User
confirmed_at: 2026-10-15T11:58:42Z
authority: confirmed-model-input-change-statement
implementation_baseline: e671ed204aacb8f56c4470a1c8f6e98bd325ba25
implementation_status: in_progress
last_updated: 2026-10-15
---

# 画布私聊材料隔离 r1

## 二次确认与适用范围

客户阅读《私聊材料怎么分开用：客户确认版 r1》16页全文（前三页使用故事，后面完整研发附录）后，在本会话直接回复：“确认，按私聊材料隔离 r1 实施”。此记录来自直接人类回复，不能由自动化代确认。确认时间为回复后首次读取时钟的记录时间。

确认提案提交 `e1284e8898cc7543ab1e95d7b80d00f0fc4b5f23`，批准时提案 SHA-256 为 `3c5a3dcb12a37e8239c23ad9a94aba9361bac72bd57bde1710e11c74b77dd587`。Word SHA-256 `87565f57fa0e994f676139e3376fe14e556ac9862c08f1573798d985f4dcecf7`；PDF SHA-256 `4b3446c0d97f2c6b8529a206d965a60229dcc1e5966e280647856fc88576e8df`。已交付文件保持原字节，确认单独记录。原提案见[批准方案 r1](../../../integration/proposals/canvas-private-materials-r1.md)。

仅授权本 r1 的产品语义与实现，不含付费模型、main合入或发布。完整 I00–I12 + BUF、81功能簇、48工作包、324正式验收及十二个阶段集中验证批次保持。方案语义变化须递增 revision 重新确认。

## 实施状态

Core scope 归属 codec、get 省略/显式 null 的能力协商编码与精确活跃私聊 pin 的只读校验已实现，见[scope合同](../../contracts/single-chat-composer-scope-v1.md)。Schema155/Migration205 已追加：旧草稿原值进入空 scope，新增注册、完整保留输入与排队编辑归属，默认 SQL/quote/资源路径明确围栏。Core 材料七动作、精确读取、有界恢复及按 scope 发送消费已实现；get/mutate/recovery 已接统一 Application、可信 Request、两端封闭准入和共享客户端归属核对；显式 get 回显 scopeVersion，省略保持旧响应。快照草稿和编辑会话按同一归属过滤；材料命令丢回执使用原 UUID 只读核对，不重复派发。Core 编辑租约按 client+scope 接管/轮换 token，完整移回按空目标活动或占用目标完整 retained 提交；缺 targetBody 新请求拒绝，旧摘要形状保持。UI 尚未启用，上传准备、资源授权、Renderer 新移回参数/完整材料选择及本机意图恢复继续。

第一批原文 SQL 的25项读取见证保持原边界。本轮因主键及迁移回滚是后续材料接线的前提，按阶段策略例外做一次本地定向 Rust 编译与 owner，覆盖旧值保留、事务失败回滚、默认读取不漏出其他 scope、pin 删除后保留、重开与 Conversation 删除清理，并补旧回执及准入结构负例。相关旧私聊、引用、资源、目录与升级 owner 也做定向回归；实际结论及初次环境/编译失败见[执行证据](../../../integration/execution/i03-private-scope-storage-result.json)。未运行全仓回归、GitHub Actions、实际模型或真机验证。

材料服务本批因跨 scope 隐私、完整交换回滚与公共命令兼容是运输接线的前提，执行限定 Core lib extended 编译及17项定向检查。
已验证选定材料进入原 Core 消息/FIFO 记录、默认旧 JSON 省略、引用拒绝的持久结果、整份交换回滚及只读分页；
测试未启动真实模型，也未验证最终 Manifest Blob 和实际 Runtime。格式器/预算/版本未变，批准文件与后文原提案快照不改。
证据和初次编译失败见[业务服务执行记录](../../../integration/execution/i03-private-composer-service-result.json)。

应用入口的默认形状、其他位置编辑令牌/未保存正文隔离、可信编辑端注入与原回执核对，以及客户端错绑/旧能力拒绝，见[接线执行证据](../../../integration/execution/i03-private-composer-api-result.json)。Core lib 和模拟客户端结果不替代实际 Host HTTP、Native IPC、模型或最终 Blob；批准原文及文档文件字节保持。

编辑接管、完整移回、回执尾失败回滚与原 UUID 重放的 Core 分项见[排队编辑证据](../../../integration/execution/i03-private-pending-edit-result.json)。现有 SingleChatPanel 尚未提交 targetBody 或处理 placement，按钮流程尚未完成；既存客户端测试不证明新版 UI 可用。

以下24项完整场景仍未执行完毕；本地分项检查不替代正式324场景或实际 Runtime/真机资格。低成本检查按切片运行，编译及完整集成随 I03 候选集中执行。

## 明确不变

保留既有 Host 验证的 DraftClient、Owner 授权、Conversation 单一 FIFO 与编辑租约。默认草稿 scope 为空，旧 get 省略 scope 时维持原响应；网络不能注入可信编辑端身份。Bootstrap v5/Formatter5/Charter22、非批次 Manifest29/Profile7/RunFacts6、公开 Manifest34/Profile10/RunFacts9 与 Skill Selection/Resolution3 保持。已发布消息的模型投影、section 顺序、附件与引用预算、已冻结 Blob 和接受输入恢复边界不因新增 scope 改写。scope、卡片标识和认证证明不进入模型输入。

## 验证

24项 PC01–PC24 的操作、预期结果和失败注入要求保留在下文完整说明中，当前均待执行，不记作通过；模型最终 Blob 与实际 Runtime 分别取证。实施按现有 single_chat、message_quote、DraftClient 与迁移 owner 补必要负例，旧默认字节、旧回执、CAS 冲突、越权、未知结果、迁移回滚和孤立输入恢复必须保持。Rust 编译、完整集成及必要平台验证随 I03 候选集中执行；本次16页文档验版不能替代功能测试。

## 已确认完整说明快照

下文保留客户阅读时的完整产品行为、前后输入示例、API、数据库、兼容与24项要求。文中的“待确认”“当前实现尚未改动”属于方案提出时快照，不表示忽略本页已确认元数据；实际实施进展另行追加。


# 私聊材料怎么分开用
Codeg 与 Rovai 一期融合  客户确认版 r1  待确认

这份方案需要你确认一件事：同一段私聊同时出现在几张画布卡片中时，每张卡片各自准备正文、附件和引用；点击哪张卡片的发送，就使用哪张卡片当前选中的整份输入。聊天记录和排队顺序仍是同一段私聊的。

## 场景一  两张卡片处理两件事
你把与同一位队员的私聊放在甲、乙两张卡片中。甲卡写着“请检查合同第八条”，放入合同.pdf，并引用合同中的说明。乙卡准备计算预算，放入成本.xlsx，并引用一条预算上限。

目前，正文已经分开保存，但同一编辑端的附件和引用仍放在同一个草稿里。这样，甲卡的正文可能带上乙卡准备的材料。这是本次要修复的问题。

按 r1 实施后，甲卡发送时，只提交甲卡当前选中的正文、合同和引用；乙卡的预算材料仍留在乙卡。完整工作区里原来的输入也独立保留。甲卡移到侧边后，继续编辑同一份输入；复制成另一张卡片，则从新的空输入开始。

这项隔离决定本次发送选哪份材料。它不会让模型忘记以前已经收到的消息，也不会撤回已经发生的执行。

## 旧材料先留在原处
升级后，原来共用的附件和引用留在完整工作区的“原未发送材料”中，不自动分配给某张卡片。你可以选择整体移到哪张卡片；默认只移动材料，不擅自带走原正文。目标卡片已有输入时，旧材料成为另一份保留输入，供你切换选择。

# 排队消息移回来时保留两份

## 场景二  正在写新问题时取回旧消息
队员还在执行上一件事，消息丙已经排队等待。你在甲卡又写了新问题，并放入新附件。此时，你决定把丙移回甲卡修改。

如果甲卡当前为空，丙的正文、附件和引用一起回到甲卡。若甲卡已有输入，系统保留两份完整内容：甲卡当前输入不变，丙另存为一份保留输入。不会把丙的附件直接挂到甲卡新正文下面。

你可以查看两份内容，再选择“切换到这份输入”。切换时，原来的整份输入也会被保留下来。每份都带着自己的正文、附件和引用；发送只使用当前选中的一份。

## 排队顺序保持一致
甲、乙两张卡片看到同一段私聊的排队消息，仍按原顺序推进。卡片不会各自启动另一条执行队列。

同一段私聊仍只保留一个排队消息编辑会话。另一张卡片不会自动继承编辑中的内容和操作凭证；需要继续时，明确选择接管。原卡片随后提交的旧修改会被拒绝，并保留本地内容供核对。

若排队消息还在编辑中，先保存或取消编辑，再移回输入框。保存后取回保存过的版本；取消后取回队列原版本，不偷偷丢弃尚未决定的修改。

## 附件失效时先停住
源文件被删除、换掉或失去授权时，保留输入并说明原因；不悄悄跳过失效材料后继续发送，也不改用同名文件。

# 没收到发送结果时先核对

## 场景三  发送后断线
你点击甲卡的发送，连接突然断开。应用暂时不能确定服务端是否已经接受。界面保留这次提交的完整内容和原请求身份，先核对原结果。

若已经接受，就显示原消息或原排队项，不再新建一次发送。若明确拒绝，原输入仍在，可以修正。若仍无法确定，保持“结果待核对”；你选择重试时，重试原请求，不换新身份偷偷再发一次。

这期间，新写的内容单独保留，不会改掉正在核对的那次提交。应用重启后也继续按原身份核对；换到另一个服务或编辑端时，不自动搬运这次私聊提交。

## 关闭卡片不等于删除输入
收起卡片、切换画板或把卡片移到侧边，不自动清除材料。原节点被删除或换绑后，保留输入仍关联原单聊，显示原位置已变化，供你恢复或明确删除。结束或永久删除单聊仍按原规则处理，不自动改发给另一段单聊。

旧客户端可以继续使用原默认草稿。涉及新卡片隔离和完整取回的操作，需要客户端与服务端都支持；缺少支持时明确提示升级，保留输入。我们不会用“按旧方式发送”来绕过隔离。

## 请确认 r1 的三项行为
1. 同一私聊的多张卡片各自准备材料，发送只用当前卡片选中的完整输入；旧共享材料由你选择迁入。
2. 移回消息遇到已有输入时保留两份，切换时整份切换；排队顺序和明确接管规则保持一致。
3. 发送结果不明时保留原请求并核对，重试原请求；关闭、换板和恢复不自动重发。

前三页说明产品行为，后面是完整研发附录。确认仅针对私聊材料隔离 r1，不包含付费模型调用、main 合入或发布授权。方案有语义调整时会递增版本再确认。

# 研发附录  当前源码与问题边界

本方案基于当前融合分支的固定源码快照。当前实现尚未改动；本文是待确认提案。源码摘要和逐项自审见随附自审记录。

| 核查位置 | 现有事实 | 本次处理 |
| --- | --- | --- |
| single-chat-composer-store.ts | 正文按完整卡片上下文保存，主会话 key 保持原样 | 保留原正文格式和归属 |
| single_chat.rs 1770 起 | Core 草稿由 conversation_id 与 client_id 定位 | 增加卡片 scope 维度 |
| draft_client.rs | Web 编辑端身份由 Host 验证；网络不能自行注入 DraftClient | 认证边界不变 |
| single_chat.rs 628 起 | send 以 draftRevision 消费附件和引用，忙时进入同一 FIFO | 精确消费所选 scope |
| single_chat.rs 1147 起 | 编辑租约按 Conversation 持有，移回会替换草稿材料 | scope 围栏及完整保留 |
| context.rs 6183 起 | 已发布私聊消息生成 CURRENT_INPUT，空 quotes 和附件字段省略 | 投影与冻结机制不变 |

因此，不能把问题表述为“所有编辑端共用一份私聊草稿”：不同已验证编辑端已有隔离；本次缺口是同一编辑端的多卡片与默认输入之间的材料归属。

## 方案取舍
选择在 Core 中给草稿增加 scope，并复用原业务对象、队列和执行。仅把附件列表藏在 Renderer 中，无法保证并发消费、移回和重启恢复；给卡片伪造不同 DraftClient 会破坏认证语义；复制 Conversation 又会拆散历史和 FIFO。这三种做法均不采用。

当前只新增提案和交付文件。取得具体 r1 确认后，再在 current 版本下登记正式独立模型变更说明，并实施对应接口、迁移和客户端改动。

# 草稿归属与选择规则

## 变更前
Core 材料键为 conversation_id 加 Host 验证的 client_id；同一键内，附件、quotes、quote trash 和 revision 共用。Renderer 正文已经使用 Host Owner、Core、Board、pin、Thread、Conversation 的规范卡片上下文。

## 变更后
Core 活动草稿键变为 conversation_id、client_id、scope_key。默认输入的 scope_key 为空串；画布 scope 由 Core 根据 boardId、nodeId 和精确 Conversation 绑定派生，不由前端传入 SQL key。Host Owner、Core 实例和已验证 client 仍在可信运输边界中。

```ts
type ComposerScope = {
  kind: 'canvas'; boardId: string; nodeId: string
};
// composerScope 可省略或为 null 表示原默认草稿。
// 缺省值序列化时省略，保持旧命令的规范摘要。
```

首次写入在事务内核对真实节点及私有引用后建立 scope 登记；只读 get 不分配记录、不创建 Conversation、不 enter 或启动 Runtime。已登记 scope 的原节点失配后标为 orphaned，仍关联原 Conversation，不能重绑定到新单聊；后续明确编辑和发送仍校验原单聊和权限。

关闭、布局和 drawer 模式不进入身份。另一 pin、新 Conversation、新 Core 或不同已验证编辑端均不采纳原 scope。新 scope 不自动复制默认材料。卡片标识只决定材料选择，不授予文件访问权。

## 完整保留输入
保留项由 Core 保存正文、源附件引用、quotes、quote trash 和 revision；默认草稿当前正文仍沿用本地编辑器。移回目标是否非空，以冻结的 targetBody 加 Core 当前材料共同判断。非空则创建保留项，活动草稿不变；切换用一次事务交换材料并返回正文，原活动正文随交换存为保留项。

# 模型输入前后对照

以下是同一示例中，甲卡发送“请检查合同第八条”的选择结果。前提为甲卡选择合同和引文 A，乙卡准备成本和引文 B；无 Skill 选择。示例用于确认语义，不是实际模型运行证据。

## 变更前可能取到同一共享草稿的材料
```json
{
  "source": {"type":"user"},
  "message":"请检查合同第八条",
  "mentionsCurrentUser":false,
  "quotes":[
    {"kind":"message_excerpt","source":{
      "scope":"current_messages","messageId":"msg-a",
      "author":{"type":"user","displayName":"你"}},
      "text":"请核对第八条"},
    {"kind":"message_excerpt","source":{
      "scope":"current_messages","messageId":"msg-b",
      "author":{"type":"user","displayName":"你"}},
      "text":"预算上限五千元"}
  ],
  "attachments":["/source/合同.pdf","/source/成本.xlsx"]
}
```

## 变更后只消费甲卡当前选中的整份输入
```json
{
  "source":{"type":"user"},
  "message":"请检查合同第八条",
  "mentionsCurrentUser":false,
  "quotes":[{"kind":"message_excerpt","source":{
    "scope":"current_messages","messageId":"msg-a",
    "author":{"type":"user","displayName":"你"}},
    "text":"请核对第八条"}],
  "attachments":["/source/合同.pdf"]
}
```

# 接口完整增量定义

下列均为提案。threadId、conversationId、source refs、quotes 和 StoredCommandResult 继续使用现有类型；draftClient 不加入网络入参，由可信运输注入。

```ts
type ScopeParam = {composerScope?: ComposerScope | null};
type GetPrivate = {conversationId: string} & ScopeParam;
type SendPrivate = {
  commandId: string;
  command: {threadId: string; conversationId: string;
    body: string; draftRevision: number} & ScopeParam
};
// singleChat.get 仍返回 SingleChatSnapshot | null。
// singleChat.send 仍返回 StoredCommandResult。
type ScopedDraftView = {
  quotes: MessageQuoteSnapshot[]; revision: number;
  attachments: LocalAttachmentSourceView[];
  updatedAt: string | null; scopeKey: string;
  scopeVersion: 1; composerScope: ComposerScope | null
};
type PreparePrivateAttachment = {
  commandId: string; conversationId: string;
  expectedDraftRevision: number
} & ScopeParam;
// File 沿原 Native IPC 或 Host multipart 运输，不进 JSON。
prepare(input: PreparePrivateAttachment, file: File):
  Promise<SingleChatSnapshot>;
```

原 send.command 的四个字段保留，仅增加可选 composerScope；原 get 增加同一可选字段。get 省略该字段时保留原四字段草稿响应，兼容严格旧客户端；显式传 null 或画布描述时，新 Core 才返回上面的 scope 元数据。新客户端核对 scopeVersion、完整 composerScope 回显、Conversation 与既存 scopeKey，不采纳另一 scope 的迟到结果。

新画布材料操作统一通过下一页的 mutate 命令；旧 removeAttachment 和 messageQuotes.mutateDraft 入口继续兼容默认 scope。Native 选文件及 Web 上传的每次附件附加增加 commandId 和 scope；服务端只在校验源和预期版本后提交。上传暂存按原 UUID 和内容摘要恢复，不能因回执丢失重复附加，也不能把重试时已变化的文件冒充原内容。

# 材料变更与恢复接口

新增两项操作：singleChat.composerDraft.mutate 与 singleChat.composerDraft.recovery。正式操作数量与准入清单在实施时更新；本提案不激活入口。

```ts
type DraftAction =
 | {type:'register_scope'}
 | {type:'remove_attachment'; attachmentRefId:string}
 | {type:'reorder_attachments'; attachmentRefIds:string[]}
 | {type:'quote'; action:QuoteAction}
 | {type:'swap_retained'; retainedInputId:string;
     expectedRetainedRevision:number; currentBody:string}
 | {type:'discard_retained'; retainedInputId:string;
     expectedRetainedRevision:number}
 | {type:'adopt_legacy_materials';
     expectedSourceRevision:number; targetBody:string};
type MutateDraft = {commandId:string; command:{
  threadId:string; conversationId:string;
  expectedDraftRevision:number; action:DraftAction
} & ScopeParam};
type QuoteAction =
 | {type:'add'; selection:{messageId:string;
     bodyAtSelection:string; startScalar:number;
     endScalar:number; text:string;
     currentUserDisplayName?:string}}
 | {type:'remove'; quoteId:string}
 | {type:'restore'; quoteId:string};
```

QuoteAction、原捕获摘要和 Unicode scalar 边界逐字继承现约定。mutate 返回 StoredCommandResult，成功 payload 带 draft；需要更新本地正文时附 body，创建或切换保留项时附 retainedInput。所有写入、回执和事件同事务，重复 UUID 返回首次结果。

register_scope 在用户首次编辑该卡片正文时登记一次 Core scope，不运输或保存正文；附件附加或其他首次材料写入也可在自身事务内完成登记。正文先按原本机规则保存，登记失败不丢输入但禁止发送。只读恢复不调用 register_scope。

recovery 请求为 {threadId, conversationId, cursor?: string | null, limit?: number}；limit 默认 50，上限 100。响应为 {items, nextCursor: string | null, complete: boolean, throughGlobalSequence}。items 是 scope 元数据或完整 retained 输入；cursor 为 Core 不透明游标，绑定当前编辑端与 Conversation。分页变化时 complete 为 false 并允许重新读取；不能用不完整列表删除输入。只枚举当前已验证编辑端，不跨编辑端导入。

# 响应结构与能力协商

```ts
type ScopeEntry = {
  scopeKey:string; composerScope:ComposerScope | null;
  orphaned:boolean; draftRevision:number;
  attachmentCount:number; quoteCount:number;
  retainedInputCount:number; updatedAt:string | null
};
type RetainedInput = {
  id:string; conversationId:string; scopeKey:string;
  revision:number; body:string;
  attachments:LocalAttachmentSourceView[];
  quotes:MessageQuoteSnapshot[]; updatedAt:string
};
type RecoveryItem =
  | {kind:'scope'; scope:ScopeEntry}
  | {kind:'retained'; input:RetainedInput};
type RecoveryResult = {
  items:RecoveryItem[]; nextCursor:string | null;
  complete:boolean; throughGlobalSequence:number
};
type DraftMutationPayload = {
  draft:ScopedDraftView; body?:string;
  retainedInput?:RetainedInput
};
```

mutate 成功的 StoredCommandResult.payload 使用上面的完整结构；未改变本地正文时省略 body，未产生或返回保留项时省略 retainedInput。return_to_composer 的成功 payload 另保留 pendingInputId、body、draft，新增 placement 字段；placement 为 retained 时必带 retainedInput，为 active 时省略它。

能力协商使用只读 singleChat.get：新默认输入显式传 composerScope 为 null，画布传完整描述；只有回包 scopeVersion 为 1 且归属回显匹配才启用新操作。旧 Core 忽略或拒绝新参数时，不把缺失元数据当默认支持；可退回省略参数读取原历史，但新材料操作保持禁用。app.info 与旧默认调用响应不变，阶段候选统一升级客户端与服务端。

恢复条目内的附件、quote 视图与限额完整继承原合同，不输出 client 凭证或 quote trash。scopeKey 是草稿识别值，不是认证凭据；quote trash 仅保留在服务端供原撤销规则使用。源材料的访问仍走原资源授权。

# 排队编辑与整份移回

```ts
type PendingAction =
 | {type:'return_to_composer'; expectedDraftRevision:number;
     targetBody:string}
 | {type:'begin' | 'takeover' | 'cancel' | 'delete'}
 | {type:'save'; body:string}
 | {type:'remove_attachment'; attachmentRefId:string}
 | {type:'reorder_attachments'; attachmentRefIds:string[]}
 | {type:'quote'; action:QuoteAction};
type EditPending = {commandId:string; command:{
  threadId:string; conversationId:string;
  pendingInputId:string; expectedRevision:number;
  editToken:string | null; action:PendingAction
} & ScopeParam};
```

现有 Conversation 级单编辑租约和同一 FIFO 保持。租约 ownership 从 client_id 扩为 client_id 加 scope_key；其他 scope 只看到排队项和“正在其他位置编辑”，不获得 editToken 或未保存 working 内容。takeover 必须显式操作并旋转 token；旧 scope 的迟到保存、附件和 quote 操作均拒绝。

return_to_composer 要求先保存或取消该排队项的编辑，读取其当前持久版本。targetBody 是离开锁下冻结的目标原正文，和 expectedDraftRevision 一起防止覆盖。目标完整输入为空时，事务搬入附件和 quotes、返回 body；非空时，创建完整 retained 输入，活动输入不变。两条路径均原子取消原队列项，不新建第二条队列记录。

成功 payload 保留 pendingInputId、body、draft，并新增 placement 为 active 或 retained；retained 路径附完整 retainedInput。本地只按 UUID 幂等应用返回正文；有新正文时保留两份，不覆盖。swap_retained 同时核对两端 revision，保存 currentBody 与原活动材料，再返回另一份 body。交换结果未知时两端锁定，先核对原请求。

新 return 命令缺 targetBody 时以结构化 capability_required 拒绝，不写数据；旧客户端此项提示升级。普通 get、默认草稿和原发送仍保留兼容。旧 Core 不支持 scope 时，新客户端禁用卡片材料发送与迁移，保留正文和历史读取。

adopt_legacy_materials 只允许不同 scope：源固定为原默认草稿并校验其 revision。移动材料不带走默认正文，非空目标则建立另一份保留输入；源与目标及回执同事务。回执丢失也不允许重复搬运。retained 的删除必须核对其 revision，不删除外部源文件。

# 数据库与迁移设计

| 位置 | 拟改字段或约束 | 生命周期 |
| --- | --- | --- |
| single_chat_composer_draft | scope_key TEXT NOT NULL DEFAULT 空串；主键改为 conversation_id、client_id、scope_key | 原 revision 和 JSON 列逐字保留 |
| 新 single_chat_composer_scope | conversation_id、client_id、scope_key 复合主键；board_id、node_id、创建及更新时间；唯一规范 scope | 首次有效写入登记；节点删除不级联 |
| 新 single_chat_retained_input | id 主键；conversation_id、client_id、scope_key、revision、body、source_attachments_json、quotes_json、quote_trash_json、source_pending_id、创建及更新时间 | 私有保留输入，CAS 操作 |
| single_chat_pending_input_edit_session | 新 scope_key 默认空串；原 Conversation 主键和 token 围栏保留 | 显式接管更新 owner scope |

所有 scope/retained 行必须属于原 single_chat Conversation；client 仍由 Host 验证。材料引用、quote 摘要及私有 owner 校验复用现有规则。scope_key 仅为 Core 派生的闭合身份，不接受拼接 SQL；默认空串只代表原输入，不代表通配符。

迁移从最新链尾追加；当前基线为 Schema154、Migration204，预计下一项155与205，若其他工作先推进则顺延。建表、重建主键、索引、触发器和版本号同事务。旧行全进默认 scope；附件、quotes、trash、revision、旧回执及历史冻结内容不改写，不复制到画布。

Conversation 永久删除时按既有规则清理其 scope 和保留项；画板或节点删除保留输入与原归属。结束单聊沿原清理规则，不把留下的本地正文发送到新单聊。外部源文件不因删除引用而被删除。Core 材料为空也可能存在本机正文，因此不自动淘汰 scope 登记；清理须走明确删除与当前输入核对，未知结果不能清理。

只增元数据和源引用，不复制附件文件。恢复列表分页，原附件与 quote 限额、Host 存储及资源策略继续适用；资源不足时拒绝新写并保留原输入，不能靠丢弃其他卡片输入腾空间。

# 未知结果与冻结兼容

| 状态 | 界面和恢复动作 | 禁止发生 |
| --- | --- | --- |
| 未发出 | 保留原输入，确认准备结果后再提交 | 凭空显示已发送 |
| 明确拒绝 | 保留完整输入，修正后建立新提交 | 清掉正文或借别卡材料 |
| 已接受 | 接纳原消息或排队项，只清仍等于冻结值的输入 | 再生成一个消息 |
| 结果未知 | 保存原 UUID、完整参数及归属，先 reconcile；显式重试原请求 | 换 UUID 盲重发 |

Renderer 新增独立版本化 private-send-intent 本机记录，按既有完整 Host Owner Core 卡片上下文保存冻结 body、scope、draftRevision、commandId、摘要及状态；不改变原正文字符串字典，不进入公开草稿归档，也不存私有证明或认证 token。新正文另存，不能改掉在途快照。恢复先核对 Core、Owner、已验证编辑端和原 Conversation；不满足时只保留，不重发或改绑定。

同一 scope 的本机或同源窗口共享在途意图和输入锁，未知结果期间不修改该冻结草稿的材料；新正文保存在另一份待编辑输入中。无法取得共享锁或读取恢复状态时禁写并保留输入，不能以换新 UUID 或新编辑端身份绕过。Core CAS 与原请求幂等仍是最终围栏。

本机另存版本化的卡片正文索引，只记原正文 key 和完整归属，不复制正文或认证数据。恢复入口合并该索引与 Core recovery 页，不能仅凭 Core 材料为空推断本机输入不存在。首次登记前节点已消失时保留本机正文，明确提示重新固定或选择恢复位置，不伪造节点绑定。

Core 已接受后，仍沿 Accepted Input Recovery v8 区分消息受理和 Runtime 输入接受。旧 Command Result 按首次结果回放，旧 Manifest、最终 Blob、Runtime Delivery 与旧 Binding 原样恢复。scope 只作用于消费前选哪份草稿，不参与已冻结输入的重选。


# 版本轴与模型边界

卡片归属只在受理用户提交前决定消费哪份草稿。已经发布的私聊消息，继续沿原投影生成模型输入；已冻结的消息和运行不重新选草稿。

| 版本轴 | 当前与 r1 后拟保持值 | 证明方式 |
| --- | --- | --- |
| Bootstrap | contract v5、formatter5、Charter22 | 固定原文与摘要相同 |
| 私聊非 batch | Formatter Manifest29、Profile7、RunFacts6 | 同一已发布消息字节一致 |
| 公开 batch | Formatter Manifest34、Profile10、RunFacts9 | 原公开 owner 不改 |
| Skill Selection Resolution | v3 | 本次不改技能选择 |
| CURRENT_INPUT | 原 source、message、mentionsCurrentUser；非空才有 quotes、attachments、skills | 无 scope、卡片或认证字段 |

需增新模型字段、改变上述版本或改写旧证据时，停止该部分并递增提案 revision 重新确认；不能以本 r1 授权推导出来。

兼容判定使用 invocation、Manifest、Profile 和 RunFacts 完整元组，不仅看数字 29；当前源码中不同冻结合同可能共用该数字。引用长度、附件数量、section 顺序、截断预算和 Skill 选择均不因 scope 增加而改变。实现回退也不能让旧二进制覆盖新数据，只能使用匹配版本与已留存备份按既有升级规则恢复。

# 技术验收分项  一

以下是拟实施后的验收要求，当前均待执行；不计为已通过，不替代或重编号官方 324 个场景。

| 编号 | 操作 | 必须看到的结果 |
| --- | --- | --- |
| PC01 | 同一私聊双卡分别放附件和引用 | 甲发送只消费甲，乙完整保留 |
| PC02 | 默认输入和画布同时准备材料 | 两处互不串入或清空 |
| PC03 | 同卡原地与侧边切换 | 同正文、材料、revision 与编辑器 |
| PC04 | 另一 Conversation 复用相同节点文本 | 不采纳原私聊 scope |
| PC05 | 另一个已验证编辑端访问同 Conversation | 不看到对方草稿与保留项 |
| PC06 | 网络伪造 draftClient 和恢复证明 | Host 拒绝，无授权提升 |
| PC07 | 伪造 Board pin 或错误私有引用 | 首次写入拒绝并回滚 |
| PC08 | 只读恢复空 scope | 不建表行、不 enter、不执行 |
| PC09 | 同 scope 两次并发 CAS | 仅一笔生效，另一保留输入 |
| PC10 | 上传中切 Core 或结束单聊 | 迟到结果不污染新上下文 |
| PC11 | 移除别 scope 附件或越权 quote | 拒绝，不借用或删除别卡材料 |
| PC12 | 仅附件发送 | 维持原合法行为，使用所选附件 |

实施时复用 single_chat、message_quote、DraftClient 与迁移现有 owner；只在现有 owner 无法拥有该事务不变量时增加测试。先源码审查和定向检查，Rust 编译及完整集成随 I03 候选集中执行。

# 技术验收分项  二

| 编号 | 操作 | 必须看到的结果 |
| --- | --- | --- |
| PC13 | 只有 quote 没有问题正文 | 保留原 question_required 约束 |
| PC14 | 单卡发送并检查最终输入 | 路径、quote 顺序及原 section 正确；无卡片字段 |
| PC15 | 发送前源文件变化或失效 | 明确失败并保留输入，不替换同名源 |
| PC16 | 双卡同 Conversation 连续发送 | 原 FIFO 顺序，无额外执行队列 |
| PC17 | 另一卡查看编辑并明确接管 | 不继承 token；接管后旧写拒绝 |
| PC18 | 排队消息移回空卡 | 正文、附件、quotes 同份返回 |
| PC19 | 移回非空目标 | 两份完整输入，无覆盖或混装 |
| PC20 | 交换保留输入时丢失回执并重试 | 原 UUID 只交换一次，双方均可恢复 |
| PC21 | 发送已接受但响应丢失并重启 | 核对原结果，不换 UUID 重发 |
| PC22 | Core 在输入接受前后分别退出 | 旧冻结 Manifest Blob 与接受边界保持 |
| PC23 | 删除节点或换绑后恢复 | 保留原归属，不自动转发新单聊 |
| PC24 | 升级旧数据与旧客户端及注入迁移失败 | 默认行、旧回执不变；失败全回滚；新功能不降级绕过 |

PC14 和 PC22 需要最终 Blob 与实际 Runtime 的独立证据。受控运输、纯数据库、类型检查和模拟组件只能各自证明对应范围。真实模型身份、硬预算和设备继续作为资源待办，不因本次确认自动调用付费模型。

故障注入覆盖首次 scope 建立、附件附加、返回、保留交换和回执写入的每个事务尾部；未知结果、失败日志和未执行项单独保留。不能删除失败用例或放宽断言换取通过。

# 研发顺序与自审结论

| 顺序 | 工作与交付 | 依赖和检查点 |
| --- | --- | --- |
| 1 | 固定 r1 确认记录和前后样例 | 人工确认后才改实现 |
| 2 | scope 类型、认证运输和迁移 | 默认旧摘要及事务回滚 |
| 3 | Core scope 草稿与 quote Source 接口 | 跨 scope CAS 和归属 |
| 4 | Native IPC 与 Web 上传 | UUID、源摘要、迟到围栏 |
| 5 | get send 与 FIFO 消费 | 精确冻结和已接受边界 |
| 6 | 编辑租约与移回保留两份 | takeover、return、swap 幂等 |
| 7 | Renderer 卡片材料和本机意图恢复 | 原编辑器、草稿、未知结果 |
| 8 | 原材料迁入和 orphan 恢复 | 显式选择与完整输入切换 |
| 9 | 定向验收与 I03 候选集中验证 | PC01 至 PC24 及必要平台资格 |

这些是 I03 内的推进顺序，完整一期范围和十二个正常阶段验证批次保持。每个完成的小功能或缺陷本地提交；I03 功能集齐后集中编译、集成、推送和 Actions。粗估 6 至 10 个研发工作日，不含客户确认和资源等待；该估计在首批 Core 接线后按实际工作量修订，不作为固定交付日期。

## 自审后修正的关键点
已纠正“原草稿没有编辑端隔离”的过宽说法；明确默认材料不自动认领；移回和交换都保留完整材料；保留单一 FIFO 与编辑租约；旧客户端缺能力时明确拒绝；未知结果保存原 UUID；原节点变更不重绑定；模型格式和已冻结证据不改。

本次只交提案。批准后才同步 current 版本的独立说明、合同和 Schema；若方案发生上述产品语义变化，递增 revision 再确认。待确认期间继续独立的对象引用、授权文件、PTY 和兼容整改工作，不阻塞整个持续目标。

确认标识 I03 PRIVATE MATERIALS R1  当前 confirmation_status 为 pending


## 源码索引

- `apps/desktop/src/renderer/src/SingleChatPanel.tsx:774`  `send`
- `apps/desktop/src/renderer/src/single-chat-composer-store.ts:23`  `SingleChatComposerStore`
- `crates/rovai-core/src/draft_client.rs:21`  `verified_web`
- `crates/rovai-core/src/single_chat.rs:628`  `load_single_chat_draft_refs`
- `crates/rovai-core/src/message_quote.rs:159`  `QuoteStorage`
- `crates/rovai-core/src/context.rs:693`  `load_current_input`
- `crates/rovai-core/src/context_contract.rs:7`  `AGENT_RUN_CONTEXT_FORMATTER_VERSION`
- `crates/rovai-core/src/db.rs:4687`  `single_chat_composer_draft_client`
- `apps/desktop/src/main/index.ts:2311`  `rovai:single-chat-attachment-remove`
- `apps/web/src/camp-adapter.ts:57`  `singleChatAttachments`
- `crates/rovai-web/src/operations.rs:96`  `singleChat.get`
- `docs/development/model-context-change-governance.md:47`  `二次确认门槛`

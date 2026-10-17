---
document_type: protocol-contract
contract: single-chat-composer-scope-v1
authority: private-composer-scope-and-material-selection
status: accepted
version: 1
last_updated: 2026-10-16
---

# Single Chat Composer Scope v1

范围和模型输入选择来自客户明确确认的[私聊材料隔离 r1](../versions/v1.72/model-context-change-canvas-private-materials.md)。
本文不替代现有 Single Chat、可信 DraftClient、文件授权、Domain Command Result 或 Accepted Input Recovery。

## 归属类型与兼容编码

卡片描述是闭合对象 `{kind:'canvas',boardId:string,nodeId:string}`。boardId 和 nodeId 使用 Core 创建时的规范小写 UUID；
未知 kind、缺失字段、额外字段及非规范标识拒绝。网络不能用 scopeKey、DraftClient、Owner 或认证证明替代此描述。
Core 对有效描述产生 `canvas:<boardId>:<nodeId>` 闭合存储 key；该值只标识草稿，不授予权限。
原默认草稿 key 为空串，后续存储按 Conversation、Host 验证的 client 与 key 联合定位。

只读 get 的省略与显式 null 不同：省略保留原响应；显式 null 申请默认草稿的 scopeVersion 1 和精确归属回显；
完整描述申请对应卡片回显。`SingleChatComposerScopeRequest` 以 Legacy 和 Explicit 两态保存这一差别。
发送等写命令使用可空 scope，序列化时省略默认值，以维持旧命令规范摘要；不能把 get 的能力协商标记带入旧发送摘要。

## 首次登记的真实 pin 校验

`SingleChatComposerScope::matches_current_pin` 只读精确 Board、pin、Thread 与 Conversation 绑定，要求画板未删、
节点为 conversation、指定私聊未结束、所属 Thread 已激活且未进入删除。公开 pin、同 Thread 的其他私聊、
其他画板或镜像、缺失/已删节点、错绑、结束私聊均不能建立此 scope。
首次写入必须在现有业务写事务内调用，先通过 Host/Owner、可信编辑端和原私聊访问校验，再登记 scope；
函数本身不认证用户、不登记草稿、不 enter、不启动 Runtime，也不删除或重绑既有孤立输入。

现有展开入口使用真实 conversation pin；区域派生 ID 只参与布局，不能冒充 Core pin。
已有 scope 的原 pin 后来失配时保留原 Conversation 并按 r1 标为 orphaned，不用首次 pin 校验清理它或将其绑定到新单聊。

## 实施与证据边界

Schema155/Migration205 从准确 Schema154 来源原子升级：草稿主键加入 scope_key，旧行保持为空 scope；
新 scope 注册和完整 retained input 存储、恢复索引、八个归属约束及排队编辑 scope 字段与 marker/receipt 同事务。
旧正文仍沿原本机存储，不在迁移中复制或自动分配附件、quotes、trash；旧 revision、原始 JSON 和时间值原样保留。

scope 注册必须对应真实活跃 pin；其 Conversation、client、key 和节点身份不可变。新草稿、保留输入和编辑租约
的非默认 scope 必须已登记。Scope 与 retained 仅级联引用原 Conversation，不级联画板或节点，因此删除 pin 不删除输入；
永久删除 Conversation 则清理其数据，结束私聊按原全私聊清理语义清除材料、保留项和 scope，不删除外部源文件。
排队编辑仍以 Conversation 为唯一主键，不增多条 FIFO 或并行租约。

旧默认读取、CAS、消费、引用和 owner-scoped 附件资源明确限定空 scope；同一编辑端的其他 scope 不得到
旧默认编辑 token、working body 或材料。Scope 全部迁移完成并经必需结构/索引/归属约束准入后才可启动业务工作区。
失败回滚同一原库事务，不替换原库、不初始化空库。旧 marker 与已加入新布局的混合来源在迁移入口拒绝。

Core 类型、编码、只读 pin 校验、新存储和材料业务服务已实现。新服务提供精确归属读取及七个闭合动作：登记、
移除/排序附件、引用操作、交换/丢弃保留输入、显式迁入旧默认材料。Host 注入可信编辑端；读取不分配 scope。
写操作先核对当前材料 revision，保留输入另核对自己的 revision。交换同时搬动正文、附件、引用及撤销材料，
任一写入或回执失败回滚双方；原 UUID 回放首次结果。旧材料只移动材料，目标已有正文或材料时另建完整保留项。
明确拒绝也保存结果；普通变更事件只含 Conversation 标识，完整私有结果仍由原命令回执的编辑端边界保护。

现有 Core 发送命令识别可选 composerScope；省略时沿默认路径及原规范序列化。卡片必须先登记，发送才按相同
Conversation/client/scope 读取、验证和消费材料。所有 scope 仍进入原 Conversation 单一 FIFO，不增加执行队列。
引用仍复用原捕获和模型投影；只引用而无问题正文的卡片发送明确拒绝并保留输入。

Core recovery 仅列出当前可信编辑端在指定 Thread/Conversation 的 scope 元数据和完整保留项，每页默认50、最大100。
签名游标绑定上下文、原始状态摘要和遍历位置；所有元数据参与一致性判断，只有本页保留项加载正文及材料。
翻页期间状态变化时 complete 为 false；缺页、未完整或游标失效不能解释成删除。进程重启会使进程期签名游标失效，
客户端重新只读枚举，原输入不受影响。游标不替代 Host 认证；孤立输入仍按原归属保留，不自动绑定或发送。

Application 已接 `singleChat.get`、`singleChat.composerDraft.mutate` 和 `.recovery` 的同一封闭入口；
可信 Request 注入 DraftClient，网络或 Renderer 不能自报编辑端。Web 枚举、Desktop Main 与 TS 准入同步增加两项，
current 操作数180，历史来源161保持。新增材料命令也进入原只读 `commands.reconcile`：原 UUID/完整请求核对原回执，
结果未知时不派发；执行与回查复用同一闭合解析器。重放不再发布变更提示，首次提示只含 Thread/Conversation 标识。

get 省略 composerScope 保留旧四字段 draft 和原 pendingInputs 响应；显式 null 或完整描述才返回 scopeVersion 1、
scopeKey 与完整描述回显，并在 pendingInputs 增加 editingElsewhere 布尔值。draft 和编辑会话都按同一可信 client/scope 读取，
其他位置不返回 editToken、未保存正文或 working quotes。公开历史/原私聊 FIFO 仍由原 snapshot 拥有。
共享只读客户端核对 Thread、Conversation、完整描述、key 和版本；缺失/错误能力回显明确失败，不登记、不发送、不自动降级。

排队编辑已识别可选 composerScope，默认 None 序列化省略，旧规范请求形状保持。单 Conversation 租约继续唯一，
ownership 按可信 client 加 scope；Begin 不能覆盖已有租约，显式 Takeover 可接管相同排队项/版本，
从已保存 Pending 重开并旋转 token，原位置迟到的保存、附件和引用操作均拒绝。工作副本 quote/trash 和附件写入按同一归属保护；
即使已有 scope，也拒绝正在删除或非活跃 Thread 的新编辑。

return_to_composer 必须携带冻结的 targetBody 并核对目标材料 revision；缺字段的新请求持久拒绝 capability_required，
已存旧 UUID 仍沿原 Gateway 回执规则回放。排队项有未完成编辑时须先保存或取消，不用 working 副本覆盖持久版本。
空目标把正文、附件和引用作为一份活动输入返回；目标正文或材料/撤销材料非空时，创建完整 retained 输入并返回 placement=retained，
当前 draft/revision 保持。两条路径与原 Pending 取消、事件和回执同事务，失败全回滚；不创建新 FIFO。
成功 payload 保留 pendingInputId/body/draft，增加 active/retained placement，retained 时带完整 retainedInput；外部变更提示只含 Thread/Conversation。

Renderer 的 SingleChatPanel 已通过 PrivateInputController 提交冻结的 targetBody、材料 revision 与原 UUID，
区分 active/retained，按精确位置列出完整保留输入并整份交换；旧版正文副本明确标注不含附件和引用。
卡片 scoped get 核对回显，quote/remove/send 使用同一 scope；能力不匹配时只展示历史，不以默认材料替代卡片写入。
排队工作副本可保存、放弃或从已保存版本明确接管；不把别位置的令牌或工作正文展示给当前卡片。

本机正文仍用 string-map，增加版本化原请求记录、正文位置索引和空回执标记。写操作先登记正文位置，
再落盘原 UUID/全参数后发出；本机记录失败不提交。移回/交换锁定同位置镜像，其他位置继续编辑。
收到结果先保存回执，再保存正文和标记，最后清原意图；重载只读核对原请求，不自动重发。
结果为 unknown 才提供明确重试，继续原编号/全参数。迟到的移回结果若材料已更新且正文尚未应用，保持待恢复并拒绝拼接新材料；
原连接始终不返回时，只读查询取得的已存结果同样结清原界面等待；不以连接仍未返回为由重发或继续锁住已完成操作。
已存标记的回执不重复恢复旧正文；发送回执只清除仍匹配原发送的正文。Native 默认输入也经现有隔离本机存储落盘。
只读打开不登记 scope；有意义正文编辑先保存本机正文/索引后登记。未完成分页保留已知输入，只在完整枚举后剔除缺席项。

上传 prepare UUID/源摘要、文件资源完整 Host 链路验收、默认材料显式迁入和孤立输入统一恢复界面继续实施。
本批卡片文件添加暂禁用、活动卡片附件只显示文件名并可移除，不借旧默认 locator 读取文件；工作副本也不提供未授权预览。
本机页重载和模拟 Core 挂载不替代实际 HTTP/Native IPC、多窗口恢复、Host 重启、最终 Manifest Blob 或 Runtime/平台验收。

## 私有材料文件定位

新增三个闭合 owner：`single_chat_scoped_composer` 必带卡片描述，
`single_chat_scoped_pending_edit` 另带原 Pending ID 与 editToken，
`single_chat_retained` 带 retainedInputId 和可空卡片描述（null 只指默认位置）。
三者都带 Thread、原 Conversation 和 attachmentRefId；不接受 clientId、scopeKey 或其他自报权限。
旧默认 owner 的 JSON 不加字段；不能在旧 owner 塞入卡片描述后由 Main 丢弃描述、降级成默认材料。

Core 按可信 client、Conversation、派生 key 和原材料行查找源引用，工作副本另核对 Pending/token；
retained ID 不能代替上述归属。错绑或材料不存在不回退到旧托管附件查询。读取不登记 scope 或修改数据；
原 pin 删除后仍按持久原归属读取孤立材料，不将它重绑到其他卡片。文件路径的底层访问策略沿用现行附件合同。
Main 原生附件与文件预览两入口保留完整描述；预览来源、会话与图片缓存 key 包含卡片、retained ID 或租约，避免同附件号跨位置复用。

本批只完成该定位边界和客户端键值接线，未启用卡片上传/新预览，不以 scopeVersion 1 宣称上传或资源链路已经验收。
源引用结构、公共/Agent live source 语义、模型输出和旧冻结证据不变；源内容替换检测继续待实现。
生产 Core 的隔离 SQLite/既有源引用测试与模拟 Main/客户端证据见
[私有文件资源执行记录](../../integration/execution/i03-private-resource-result.json)，实际 HTTP/Native、最终 Blob 与完整 PC01–PC24 仍待。

本轮因主键及迁移安全影响后续接线，按阶段策略例外做本地定向编译/迁移 owner，完整跨平台、实际 Runtime 与 PC01–PC24 仍待验。
具体命令、源码和失败记录见[迁移执行证据](../../integration/execution/i03-private-scope-storage-result.json)，不宣称完整功能或整套一期通过。

材料服务与按 scope 发送的17项本地定向检查、自审修正和未验边界见
[业务服务执行证据](../../integration/execution/i03-private-composer-service-result.json)。完整 PC01–PC24 仍待全链路验证。

Application/可信编辑端接线、默认形状/编辑令牌隔离、回执只读核对及客户端能力检查见
[应用入口执行证据](../../integration/execution/i03-private-composer-api-result.json)。实际 Host HTTP/Native IPC 与完整平台随阶段候选验证。

排队租约/完整移回、尾部回执失败回滚、原请求回放和旧默认形状的本地证据见
[排队编辑执行记录](../../integration/execution/i03-private-pending-edit-result.json)。本地分项不替代完整 PC01–PC24 或实际客户端验收。

Renderer、原请求恢复和隔离浏览器挂载的分项证据见
[输入界面执行记录](../../integration/execution/i03-private-input-ui-result.json)；完整 PC01–PC24 仍未执行完毕。

## 上传位置接线与待验边界（2026-10-16）

Web 上传的既有 `single_chat` / `single_chat_pending` target 增加可选 composerScope，默认空值序列化省略，
旧规范请求和原 UUID 回放不变。新卡片上传在原 Gateway 事务内核对 Thread、Conversation、可信 client 和 scope；
活动输入按 draft revision 附加，排队工作副本还核对原 Pending 版本、编辑令牌和租约位置。失败不留下首次登记。
上传及原结果查询的快照精确返回原卡片，不返回其他位置的工作正文或令牌。Web 在摘要计算前冻结 target，
身份变化则拒绝派发，不把后续切卡改动带入在途上传。

Native 旧字节入口不再因 Core 异常删除可能已经绑定的源文件；明确失败后的回收、Native 上传原编号持久化及
私有源内容变化校验继续实施。卡片文件添加入口保持禁用。此批只完成部分接线，Core 新断言留待阶段候选编译执行；
27项 Web 客户端/摘要检查及定向类型通过不代表实际 Host HTTP、Native IPC 或完整 PC01–PC24 通过。

## Native 私聊正文与在途命令的整进程恢复（2026-10-17）

Native 的私聊本机正文、恢复索引与原命令使用 Desktop Main 私有文件存储；同步保存完成后才允许发送继续。
每份原归属记录独立命名，使用临时文件、内容 flush 与原子替换，写入失败保留当前正文并阻止发送；
损坏记录不能解释为空记录。该存储只拥有客户端编辑状态，不拥有 Core 回执、材料权威或模型输入。
旧 localStorage 记录在首次读取时迁入；已迁入的明确清除记录不再恢复旧副本。Web 仍使用原编辑端存储。
桥接只允许主业务窗口的主 frame、闭合私聊 key 和受限大小，不提供文件路径操作。

原请求恢复继续只读查询相同 UUID 与完整参数，不自动重发。Single Chat 沿当前 v8 继承的重启约定
取消未完成旧回复并保留 Conversation；公共会话的 accepted-input failure 状态不用于替换该私聊语义。
标准 ACP 的确定接受在其 prompt terminal 核定；已派发而未收到确定接受的输入仍为结果未知，不能称为 not_accepted。
本批单测与实际整 App/Core 资格分别记录，实际中断测试通过前不据本节宣告 PC21/PC22 完成。

## Native 原上传请求恢复（2026-10-16）

新增可选 Native `prepareInput/reconcileInput/retryInput/pendingPreparations` 桥。请求固定原 commandId、Thread、
Conversation、scope、revision 和可选 Pending/编辑令牌；闭合解析拒绝自报 client、未知字段及非规范标识。
Main 在当前 Core 数据目录保存版本化请求记录；本机路径和原文件信息只留在 Main，不返回 Renderer。
字节来源先写入并落盘，再保存准备记录；完整同编号残留仅在与显式重选的原字节逐字一致时复用，不覆盖不同内容。
记录为 prepared、unknown 或 recorded，读恢复/重复 prepare 只查询原结果，显式 retry 才派发原请求。

Host 私有 `host.upload.observe` 只允许 Desktop 私聊目标，观察文件和摘要，不创建业务对象或 scope；
`host.upload.receipt` 独立只读原回执，不依赖当前草稿快照或源文件仍存在。公开上传仍不接受 Desktop 身份。
所有私聊上传在原 Gateway Handler 内复核实际字节摘要，已存 UUID 回放先命中原结果，不重新读取源文件。
读取使用现有不跟随末端符号链接、非阻塞的文件打开边界，类型变化拒绝。原 SourceRef 形状、模型投影和冻结输入保持。

Main 查询到 Core 原回执后持久记录，并可独立结清原连接仍在等待的调用；查询未知、连接失败或请求冲突时保留输入和文件。
明确重试再次观察原路径并核对原摘要、名称和类型，同长度内容变化也拒绝，不改请求编号或改绑位置。
准备记录按准确位置列出，不把其他卡片的 Pending 令牌交给当前卡片。旧 Native 默认入口仍兼容，新增桥尚未接入文件界面。

本批 Native 桥暂只观察普通文件，目录的内容观察仍在一期清单内。明确失败后的安全回收、已附加后至发送前的源变化检查、
Core 数据目录内字节暂存的实际资源授权/预览、原字节重选界面以及迁入/孤立恢复继续实施；不能据上传附加前摘要校验判 PC15 通过。
新增 Main 最低层 owner 以真实隔离文件系统和模拟 Core 运输验证持久化、恢复、内容变化和迟到回执；
Core 新代码及原第三个扩展 owner 留待阶段候选编译运行。卡片文件添加仍禁用，实际 Native IPC/Host/多窗口验证未完成。

## 私聊源观察与接受前检查（2026-10-16）

Migration206 从精确 schema155 原子升级到156，仅增加 `single_chat_source_observation`、私聊归属和不可更新约束。
表按原 Conversation 与 source ref ID 定位，保存原路径、类型和版本化观察；删除 Conversation 级联清理元数据，
不删除外部文件。旧材料、正文、引用、SourceRef JSON、回执和已接受 Run 的冻结输入不回填、不重写；迁移不遍历用户文件。
表/触发器不完整、伪造同名约束或旧 marker 混入新结构均不作为当前库准入，失败回滚同一原库事务。

新私聊材料附加、旧默认材料显式迁入、完整取回和排队编辑保存时，先观察并核对所有源，再提交观察与原业务变更。
已存在的观察不能被后来文件内容覆盖；同一 source ID 随完整输入移动，卡片 scope 不改变源身份，也不授予资源权限。
旧版默认/历史 Pending 缺少内容观察时保留原路径/类型检查的兼容方式；迁入新卡片时记录当前可验证来源，
不能声称已证明旧版从未记录过的历史文件内容。新的卡片发送缺少观察时明确拒绝，不能退回默认材料。

文件观察包含内容摘要和对象身份摘要；目录观察包含相对路径、空目录、子文件内容与身份，使用现有非跟随句柄与
目录边界：32层、2000文件、4000条目。失效、类型变化、链接/卷逃逸、超限或观察中变化均拒绝，不跳过材料。
这些观察只读原文件，不建立内容副本。发送与排队执行准入前重新核对；失效时保留原输入并报告错误。
排队源变化在原 Gateway 事务内将队首记为 needs_repair 并保存拒绝结果，保留正文和全部材料，阻止后续 FIFO 越过或自动重试循环。
同 UUID 沿 Gateway 首次结果规则回放，不重新附加或更改材料归属；Native 日志继续约束重试原参数。

Core先在数据库锁外准备本次内容观察，再进入原Gateway事务；准备结果只适用于同一份完整、有序SourceRef，
不提供权限或业务版本权威。提交仍重新读取归属、材料和原CAS，准备期间材料变化时回滚并保留输入，不能自动补拼。
同UUID已记录的操作先回放，不重复扫描。每Core限4个实际观察任务，取消等待不提前释放仍运行的IO名额；
容量不足或并发准备失配不把队首标成材料损坏。模型字段、SourceRef、内容/对象摘要算法及旧缺观察兼容规则不变。

本批最小 Core 检查覆盖206回滚/准入与原材料 owner，合并验证此前两轮待编译上传代码；
这不代替真实 Host/Native IPC、平台、完整 PC01–PC24 或324场景。文件接受后仍遵循既有 live source 语义，
观察不等于模型可永远读取不可变文件快照。Native 新桥的目录请求、实际资源预览、共享恢复界面与大材料性能继续验证后才可收口。

## Native 目录准备与暂存附件预览（2026-10-16）

Native 私聊准备桥已支持原路径目录：intent 仅在目录时携带 `sourceKind: directory`，文件继续省略该字段，
兼容旧请求与日志。目录的 byteSize 是只读观察的子文件总字节数，sha256 是原目录树摘要；SourceRef 保持原目录形状，
observedByteSize 和 mediaType 均为空，不把目录伪装为普通文件。Web 与公开上传不能声明目录。
Main 持久化原类型、摘要和位置；重启只查原回执，明确重试重新观察并比较完整原意图，变化时不派发。
Core 在同一 Gateway 事务尾核对类型、摘要和总字节数，再保存观察；失败回滚材料、首次 scope、观察和回执。

Core 数据目录内的字节来源复用既有附件定位与授权，不增加私有根目录豁免。Main 预览和 HTML 资源服务保留完整卡片定位、
窗口归属、隐藏路径、附件子目录和每次 HTML 请求的授权核对；工作区不能借此读取私有根。
目录沿用现有系统展示行为，本批不增加目录浏览或压缩下载。

当前证据只包含 Main 真实临时文件/本地 HTTP 与模拟 Core 授权、运输接口；不能称为真实 Host 或 Native IPC 通过。
Core 新目录断言已补入原 owner，留待阶段候选编译执行；共享文件界面、迁入/孤立恢复及规模验证仍待，卡片文件添加仍禁用。

## 共享文件准备界面与 Native 恢复（2026-10-16）

共享界面只在平台同时提供 prepareInput、reconcileInput、retryInput 和 pendingPreparations 时启用新文件入口。
控制器按平台实例、Thread、Conversation、卡片和可选 Pending/编辑令牌复用，冻结每次原编号、原位置和 revision；
界面不保存第二份文件字节或模型材料。读取恢复仅列原日志并查询原回执，明确重试才调用平台重试，不生成新编号。
未知/准备中不能关闭成已失败或再次添加；回执拒绝可关闭提示。原连接等待时可独立查询，迟到未知结果或连接错误不覆盖已查回结果。

平台结果增加 not_prepared，仅用于平台确认本次尚未派发绑定的准备失败，不能用于 IPC/HTTP 运输结果未知。
Native 在锁内读取旧日志后，只有无旧日志、写源/只读观察/准备记录失败且尚未进入 bind 时返回此状态；
原字节残留仍不覆盖。已记录回执经编号、命令类型、状态和材料编号校验后可直接离线回放，损坏记录拒绝。
旧日志/原请求冲突仍报恢复错误，不伪装为未准备。所有结果继续不返回本机路径。

Native 卡片及排队工作副本文件入口已接线；文件未知期间，当前输入发送/材料变更和队列编辑交接保持阻止，
核对结果按钮仍可用。批量选择按原位置逐个准备，前一项未完成则停止，其余文件明确提示尚未添加。
Web 尚未提供新平台接口，卡片新入口继续禁用；原文件重选、旧编辑租约记录的统一恢复、迁入/孤立恢复及真实 Host/IPC 验证继续实施。
本批 Renderer 控制器、静态组件和模拟运输检查不代替实际软件运行或完整 PC01–PC24。

## Web 原请求准备与原文件重选（2026-10-16）

Web 已接入同一四接口能力，只有 Host 明确声明恢复版本1时启用；Native/Web 复用闭合请求解析，不接受自报 client 或路径。
浏览器按原 Host/Owner/editor 的现有标签页恢复存储保存原请求、文件名、大小、摘要与状态，不保存文件字节、路径或凭据。
摘要前冻结原位置；准备记录写入成功、再保存 unknown，随后才派发上传。存储/观察前失败不上传。

刷新后不自动重传；原结果通过独立只读回执查询，不依赖当前草稿或旧编辑令牌仍有效。
明确重试先核对回执，尚未知时必须取得原 File；名称、大小和摘要不符拒绝，完整原意图不改。
内存最多保留16个文件且不超过40MiB，淘汰只要求重选，不删除原准备元数据。文件选择器打开时冻结恢复对象，不能在切卡后改投其他位置。

首次派发获得明确 HTTP 拒绝时返回本次 rejected/code，并保留拒绝记录，不冒充 Core StoredCommandResult；
已有 unknown 的重试发生拒绝、断线或未知时仍不据此判原请求失败。not_prepared 仅用于派发前明确失败。
原连接挂起时可独立查回并结清；迟到运输响应沿已保存回执结束，旧编辑端退出后不能继续使用旧平台接口。

实际 HTTP owner 已补无登录/错编辑端拒绝、回执字段投影、材料移除与编辑取消后查询；当前只做语法检查，待阶段候选实际执行。
浏览器平台/适配器/共享控制器定向检查不代替该真实 Host 验证。旧租约记录统一入口、迁入/孤立/冲突恢复及规模仍待。

## 明确业务拒绝与原上传结果收口（2026-10-16）

私聊上传在原 Gateway 写事务内、任何材料/首次scope/源观察写入之前，复用原归属与scope解析读取业务前提。
Conversation不再活动、scope不可用、草稿版本已变、Pending编辑租约/版本失效、附件容量或引用冲突，
显式返回业务 rejected，由同一 Gateway 保存原 commandId 的首次结果。当前正文、附件、引用、工作副本和源观察不变。
旧默认 Native/Web 输入与卡片/排队位置均受此准入约束；同编号不能在条件变化后偷偷成为另一项上传。

这不是把 Handler 错误吞掉：SQL/损坏存储、文件读取、摘要/大小观察及后续写入错误继续上抛，整笔业务与回执一起回滚。
回执本身写入失败时，已写材料/首次scope/观察也必须回滚；不能伪造一个 rejected 来掩盖存储失败。
原 SourceRef、模型投影、已冻结输入和旧回执不回写，schema156/Migration206不变。

Web 上传及旧 reconcile 只有读到 Core 已提交的拒绝回执才返回 `409/upload_rejected`，新回执接口仍返回安全 recorded 视图。
确认未绑定的拒绝spool或重复spool可清理；结果未知不能删除。旧 Web transport 在派发、查回和明确重试中识别该强结果，
普通拒绝/运输失败仍不能替代旧未知请求的事实。Native 与新 Web 准备接口沿原回执结束，不要求换编号重传。

最小Core库实跑3个既有owner验证业务拒绝材料不变、原编号回放、存储故障回滚和此前目录断言；
61项客户端检查通过，Web服务编译检查通过。真实HTTP owner已补陈旧版本/失效租约拒绝与spool清理，尚未实际执行。
没有原字节且尚无拒绝回执时的明确结束路径、旧租约准备记录统一入口、迁入/孤立/冲突及规模仍待，完整PC01–PC24不据此收口。

## 无原字节的准备恢复与旧编辑租约（2026-10-16）

Native 与支持新生命周期能力的 Web，在明确重试时先查询原回执，再只用冻结原意图检查业务准入。
准入失效可由 Core 记录真实拒绝；仍可提交才要求原源，查询本身始终只读。
用户可明确结束这次准备：原 UUID 的首次结果仍优先，没有结果时才由 Gateway 记录正式终结拒绝。
这不撤销已添加文件，不清除正文或材料，不删除源文件；结果未知、日志存储失败时保留原准备继续核对。

同一卡片的“之前的文件准备”列出当前工作副本之外的原 Pending ID/token；
原 Thread、Conversation、scope 与租约均保持，不改绑到当前输入。
显示列表、重建与刷新不会自动 retry 或结束；切换编辑端/卡片后迟到列表不显示在新归属下。
已终结记录不重新加入历史列表，当前尚未关闭的拒绝提示可明确关闭。
新 Rust 断言扩展原第三 owner，不新增测试 owner；真实 Host/Native IPC/挂载和完整 PC01–PC24 仍待阶段验证。

## 默认材料迁入与原位置恢复界面（2026-10-16）

迁入入口先显式读取同一可信编辑端/Conversation 的默认材料，展示附件和捕获引用，再由用户确认。
控制器在取得目标正文锁后冻结目标正文、源 revision 与目标 revision，沿原 adopt_legacy_materials 命令提交；
默认正文不移动，目标已有内容时由原 Core 服务生成完整 retained 输入。未知结果保留原请求，恢复只读查询原回执。
默认草稿只有引用撤销记录时仍允许显式核对迁入，Core 无材料拒绝不能伪装迁入成功。

恢复列表合并当前原 Conversation 的 Core scope 元数据与本机正文索引，校验 Host/Core、Thread/Conversation、
scope/contextKey、确定的字符串字典位置及正文 key。未登记正文、旧 working 正文和已登记 orphan 原输入分别保留；
不完整分页与读取失败不删除此前发现项。相同位置的多个正文 key 每次合并只读一次字典，避免按副本数重复解析。
已登记原位置复用 SingleChatPanel，保持原 Conversation 和 scope，可编辑原完整输入，不能自动重绑定到当前卡片。
只有本机正文时明确标注不含附件和引用，显式新增当前输入的正文副本，原正文与当前正文均不覆盖；需要时再手动切换。
恢复编辑器不嵌套表单，也不递归开启恢复弹窗；其离开准备参加父页面的原子离开，未知/未保存时阻止关闭。
Thread 卡片中的本机正文可沿用 conversationId 为 null 的原呈现上下文，只用于找回其索引明确归属的私聊正文；
这不授权私有 pin 登记或跨单聊材料读取。呈现上下文明确指向其他私聊时拒绝，不把它降级为默认位置。

客户端定向及隔离生产组件挂载有分项证据；模拟 Core 不证明实际 Host、Native IPC、文件授权或完整 PC01–PC24 通过。

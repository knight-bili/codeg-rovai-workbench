---
document_type: architecture
authority: integration-canvas-boundaries
last_updated: 2026-10-16
---

# Codeg canvas integration

I03 ports multi-board navigation and all eight Codeg node kinds: folder, group, agent,
conversation, custom, note, file and terminal. The [full plan](../../integration/planning/plan-v4.md)
and C12/C13/C14 acceptance cases remain the completion boundary. A board API is foundation work,
not a substitute for interactive nodes, task execution or cross-platform qualification.

## Authority and migration

Use Rovai Core's SQLite, typed Domain Command Gateway and authenticated Host transport.
Board identity and metadata are owned by [Canvas Boards v1](../contracts/canvas-boards-v1.md).
Node types, graph writes and snapshots are owned by [Canvas Nodes v1](../contracts/canvas-nodes-v1.md).
The board list also reads the optional bounded silhouette/count projection from Canvas Boards v1,
in the same Core transaction as board metadata and the sequence. It never opens a Thread, reads
file/note contents or starts a terminal to generate a thumbnail; older Hosts expose unavailable
statistics explicitly. The Renderer adapts Codeg's original footprint SVG and board-card structure.
The paged metadata directory is owned by [Canvas References v1](../contracts/canvas-references-v1.md).
Schema152/Migration202 appends one table to schema151 without changing previous model, skill,
member, Mission or Thread facts. Retain the closed source-contract and existing command-result
replay; do not copy Codeg's database or SeaORM/Tauri lifecycle into the Core.

Each mutation validates the User scope and exact board revision in the existing write transaction.
Commit a small invalidation event and the first command result together. Each read captures its
through-sequence and rows in one transaction. Reconnect, gap and stale responses cause a refetch;
they do not authorize clients to rebuild a state store from event payloads.

The client graph controller subscribes before its initial read and keeps one Host/board scope.
Revision/sequence hints reject older reads; conflict and unknown command results do not silently
rebase a gesture or generate a replacement command ID. Read failures after a committed result
retain that result. Renderer effect instances isolate Host changes and StrictMode remounts.
Controlled client tests cover this cache boundary; mounted UI and actual Core recovery remain separate qualification.

## Remaining node and interaction work

`canvas.references.page` reads bounded Thread/Mission metadata, actual active members and exact active private
conversations in one transaction per page. A fixed identity upper bound keeps a scan finite while activity changes;
the directory controller treats mid-scan invalidation as incomplete and schedules a trailing read. It does not freeze
one transaction across pages or infer live Runtime qualification. The renderer uses this directory for choices and
member regions rather than treating sidebar prefixes as complete. Folder/group worktree relations come from the
read-only [Workspace Worktrees v1](../contracts/workspace-worktrees-v1.md) Git topology operation. Main regions absorb
explicit linked checkouts; a child or project subdirectory stays exact. Missing topology remains visibly incomplete,
never guessed from path prefixes. [Navigation Project Groups v1](../contracts/navigation-project-groups-v1.md) now supplies
client-local schema7 group identity, membership and color to the sidebar and canvas. One BusinessApp-owned folder provider
merges sidebar, surface and manager demands behind the same bounded controller; failed reads keep known relations incomplete.
Management/dragging and real mounted qualification remain separate from these persistence and projection checks. Current SQL fixture and controlled
client results do not qualify the new Rust route or mounted UI before stage verification.

The next I03 slices port board-unit geometry, grid regions, collapse/expand, dragging,
box selection, alignment, resize, grouping/detach, previews and minimap. Keep the board's own
zoom independent of the application's text zoom. Persist shared node geometry separately from
client-local viewport, selection, expanded cards and unsent conversation drafts. Scope local
view keys by Core identity and board ID to avoid cross-backend state reuse.

Native uses the live `app.info.dataDir` as an identity hint. Web deliberately redacts that server
path and uses a live authenticated, Core-issued editor identity scoped by origin and owner instead;
it remains stable when that editor resumes and distinct across independently verified editors/Cores.
Neither identity grants file access. Canvas opening, composer lookup and private-input recovery
use the same resolver; stale authentication replies and missing identity never fall back to Host-only keys.

`canvas-layout.ts` adapts the fixed donor's board-unit grids, drop hints, alignment guides and
shelf packing. Overlap follows actual paint order rather than treating Core UUIDs as numeric source IDs;
Thread and exact private-conversation references remain distinct. The client view-state module keeps
viewport/expansion keys under explicit Host/Core/board identity, with a minimap preference shared only
within that Host/Core. It does not adopt the donor's unscoped numeric-ID keys or persist Runtime sessions.
Unsent input now uses the existing Composer with independent Host/Core/board/pin/reference draft contexts;
the same card's inline/drawer presentations reuse its editor. Different cards do not merge unsent input.

Notes retain Codeg's whole-paper drag and double-click inline editing, while idle Markdown uses
the existing safe renderer. Blur or Escape submits only the content patch at the board revision
captured when editing began. A rejected or uncertain write keeps the text; an uncertain command
uses the existing graph reconciliation instead of minting another command. Revision changes
require explicit review and a new save against the current snapshot. There is no silent rebase.
Unsent note copies use a separate `rovai.canvas.note-draft.v1` local-storage key scoped by
Host, Core, board and node, containing only text, baseline and captured revision. They never
enter advisory view-state records or model input. Input handlers save the last text synchronously;
normal navigation/quit guards block while a note remains dirty. Forced unmount leaves the local
copy for explicit recovery on the same surviving note; it does not dispatch against a disposed
Core owner or recreate a deleted node. Confirmed saves clear only that note's local copy.

References to AI members, Mission, Task, Thread and project files identify existing Core objects;
the canvas does not own copied business status or a second execution engine. Resolve visibility
and actions through the object's existing permissions and current snapshot. Missing or removed
objects must be visibly unavailable; never recreate one because its card survived. A board/node
operation may change layout without changing or deleting the referenced business object.

客户已确认[私聊材料隔离 r1](../versions/v1.72/model-context-change-canvas-private-materials.md)。
[Scope 合同](../contracts/single-chat-composer-scope-v1.md)区分可信编辑端身份和卡片材料归属，
保留默认草稿、单一 FIFO、旧命令摘要与已冻结输入。Scope codec、真实 pin 校验和 Schema155/Migration205 存储已实现，
默认 SQL/quote/资源读取限定空 scope。Core 已实现材料七动作、精确读取、有界恢复及按 scope 消费后进入原单一 FIFO；
完整保留项与回执同事务，引用复用原捕获和模型投影。get/mutate/recovery 已接同一 Application、两端准入与共享客户端能力核对，
显式请求才回显 scopeVersion；快照草稿和编辑会话按同一归属过滤，原回执只读恢复不派发命令。
Core 已扩单 Conversation 编辑租约的 client+scope 接管和完整移回：空目标返回活动输入，占用目标另建完整 retained，
原 FIFO、材料与回执保持原子性。上传准备、资源授权、Renderer targetBody/placement/完整材料选择和本机意图仍待接线；
当前旧移回入口缺新版参数会明确拒绝，UI 尚未启用，真实 Host/Runtime 与完整隔离功能仍待验。

会话读取由 client 所有的 `ThreadProjectionStore` 按 Thread 隔离，现有页面的只读打开、刷新、缓存和历史分页已接入。
同 Thread 的同时打开合并运输；刷新发生在读取过程中时追加一次最新读取，不把较早的在途请求当刷新完成。
各 Thread 水位与历史窗口独立，未知/失败保留最后有效快照；分页被新水位越过后丢弃，防止旧内容覆盖已更新读取。
五个空闲快照沿用原缓存预算，已挂载/订阅或正在读取的 Thread 不受该空闲上限限制。
显式 `threads.enter` 继续由原导航入口发出，只把其有效结果交回同一读取 owner；画布恢复没有 enter、Runtime 启动或通知确认副作用。
服务重启清快照、推进代次并保留挂载/订阅关系；旧 client、删除资源和旧代次结果不能覆盖新读取。
实际多卡 UI、全部卡片事件分发、各 Thread 文件预览与离开保护聚合仍需接线及阶段资格验证，不能以当前单聚焦入口代替。

File nodes use the existing file-preview handle/root grant and actual path validation. A stored
path is not file authorization. Terminal nodes keep launch intent and geometry, never a durable
PTY ID or credential. Rovai currently has no interactive canvas PTY operation; its
`RuntimeTerminalAdmission` admits AgentRun terminal-state settlement, not PTY startup. Port
Codeg's actual PTY lifecycle and add explicit Core ownership, launch authorization and planned
shutdown integration before claiming terminal support. Reopening after restart requires a new
ephemeral session. Board removal must settle its owned terminals and remove node bindings,
while keeping independent Mission/Thread histories and user files. Those ownership and lifecycle
joins need implementation and actual process tests before terminal nodes are qualified.

## Current evidence boundary

The multi-board Core lifecycle and schema154/204 eight-kind node command/snapshot boundary
are implemented. Local isolated Host/HTTP verifies the actual 153 upgrade, graph gestures and restart;
the [node evidence](../../integration/execution/i03-canvas-nodes-result.json) records checks and remaining work. UI board list/switching,
all node rendering, business navigation, actual PTY, execution round-trip and
platform acceptance remain pending. No canvas content is sent to a model by these slices; any
later model-visible context change must follow the existing revision confirmation governance.

## Node mapping and retained behavior

| Codeg source | Destination authority / integration requirement |
|---|---|
| folder region | Actual directory plus the current navigation group/query; client directory preferences stay JSON and do not become a second project registry in SQLite |
| group region | Preserve folder-group membership and worktree inclusion; source numeric folder/group IDs cannot be copied into Core object IDs |
| agent region | Preserve source Runtime-type filtering and additionally bind the intended Core member identity; Runtime kind and member ID are different facts |
| conversation | Reference the real Thread and optional private conversation with its actual permissions; open through the current conversation surface |
| custom region | Ordered, deduplicated curated Thread references; grouping/detach changes board placement, not Thread business membership |
| note | Core-owned plain/structured note content and geometry; rendering must use the existing safe Markdown rules, with no implicit model input |
| file | Absolute source path plus current owner/root-grant resolution; path text cannot bypass file-preview authorization |
| terminal | Port `portable-pty` manager behavior: process generation, output sequence, bounded whole-chunk scrollback, resize and real shutdown; PTY process identity remains ephemeral |

Source graph operations include create/update, batch move, collect/group, detach, single/batch
delete and deleted-conversation pruning. Preserve their atomic gesture boundaries, exact board
identity and stale-response protection. The donor's LWW event replay is adapted to Core's
revision/CAS and invalidation snapshot rules; do not run both protocols as parallel authorities.

## Mounted conversation instances

The Renderer now keeps exact card-context instances in `CanvasConversationsController` and maps
stable keyed children through the existing `ViewportPortal`. Each `CanvasThreadWorkspace` uses
the original `ThreadWorkspace` and an independent composer context. A presentation change does
not recreate the editor; the donor's single drawer sits alongside multiple inline instances.
The shared `threadWorkspaceActions` factory contains the original eight handler declarations,
and the original command and send-format helpers remain unchanged. It is not another execution layer.

One `CanvasThreadReader` per unique Thread bridges Core events, Host invalidation and the existing
bounded fallback poll into `ThreadProjectionStore`. Its subscription precedes the reconciliation
read. It never enters a Thread, creates a Conversation or starts a Runtime.
Closing prepares every selected editor before removing any instance; a failed preparation unlocks
all prepared instances. Graph mutations only prepare/unlock affected editors and retain orphaned
instances so that a removed pin does not discard input.

All card providers share one window file resource pool and retention union through the same API
object. Contained decks use local coordinates and scoped DOM IDs; focus selects the native binding
and the file-find surface. Shared Thread preview tabs do not imply shared composer drafts.
Browser checks mount three production card/editor components with in-memory Core and files;
they do not mount the full ReactFlow/BusinessApp or establish real Core/model/platform acceptance.
Notification visibility/ack unions are now wired through the same Attention Controller, with clipping,
occlusion checks and independent per-Thread requests. Mock Core browser checks cover offscreen,
covered and closed cards, source reappearance and a frozen uncertain retry. Real Core notification
acceptance, private attachment/quote isolation and recovery of closed orphan inputs remain required I03 work.

通知派发前只建立一次当前卡片DOM索引，保留原同key首个挂载匹配规则，避免每个owner重新扫描整页。
真实可见范围同时裁剪布局窗口和`visualViewport`的CSS坐标区域，覆盖软键盘遮挡、滚动偏移与缩放；
视口resize/scroll、窗口resize/scroll/blur均重新计算，卸载撤销原观察和监听。被遮挡消息不进入本次可见来源，
原报告和Core已读事实不改写。64卡片局部夹具验证单次DOM枚举与32可见/32遮挡分离，不代表真实页面帧率或移动真机通过。

Expanded card contexts now persist in Host/Owner + Core + Board scoped local presentation records.
Only exact validated live graph references restore. Restoring reads existing Threads (fresh per Thread),
checks the original private Conversation and never enters a Thread or restores execution liveness.
Transient leave/suspend retains expansion intent; explicit collapse removes only that context.
Drawer placement remains session-only and reconstruction uses inline cards. Corrupt/future records
and unmatched references are retained; quota failures retain in-memory intent and expose retry.
The restore batch reports progress and can stop without accepting its late reads.

CanvasSurface waits for a valid graph and a completed leave transaction before one restore pass
per mount/retry. Navigation prepares input while keeping the original instances mounted and locked;
only the observed committed destination releases them. Failure, refusal and superseded no-ops
unlock the same editors and preserve undo history. Concurrent navigation attempts share preparation
and release it only after all attempts settle. Metadata dialogs keep their editors; create/delete
commands release affected instances only after an applied receipt, including reconciliation of an
unknown result. An empty selection chooses the next board directly without starting an editor leave.
Renderer quit preparation rolls back if another renderer guard fails; failures after successful native
quit preflight, real Core shutdown and platform qualification remain pending. Node geometry depends on stable context/mode keys,
not changing content elements or visibility reports; project group projections are memoized to avoid
the ReactFlow update loop found by the real mounted canvas fixture.
The fixture mounts CanvasWorkspace/CanvasSurface/ReactFlow/editors with mock Core, observes actual
page reload/localStorage recovery and confirms readonly calls. Native process/crash/Host recovery,
concurrent graph changes, private attachments and scale/platform qualification remain pending.

Mission-backed public cards now reuse MissionIntro and the existing window Mission action owner.
The current Thread projection and Mission list record must agree on both IDs before exposing the
Mission entry. Delivery/activity and cumulative Diff use the existing MissionActivityDocument and
Core missions.delivery/changes/fileDiff paths inside each card's contained preview. Missing or
rebound Missions show unavailable content in retained activity tabs, never a substituted Mission.
Activity source links focus the original card's public message; Task/Mission focus lookup is scoped
to its workspace shell. A private card sends public-source navigation through the existing guarded
full public workspace and focuses only after successful navigation; that private route still needs
full integration qualification. Diff disclosure/tree/modal IDs are per instance, and the viewport portal sits
above selected graph nodes so selection cannot intercept real conversation controls.
These are current Thread-to-Mission links; durable independent Mission/Task/Diff pins, file-node
authorization joins and actual Core/Runtime/end-to-end qualification remain required I03 work.


## Private input handoff in the Renderer

SingleChatPanel binds PrivateInputController to the admitted client, Thread, original Conversation and
exact canvas context. Reads validate scope metadata without registering. Meaningful local edits and
explicit commands persist the body-location index before registration or dispatch. The Core remains
the authority for revisions, retained materials, one FIFO and the edit lease; no parallel execution queue exists.

Full returns and swaps lock the same context's body store while preserving other contexts. A durable
intent freezes the original UUID and complete parameters, then records the outcome before atomically
applying body/receipt markers. Reload performs receipt lookup; only an explicit unknown retry resends.
Late unapplied bodies cannot be paired with newer Core materials. Accepted sends only clear their matching
original body. Native default bodies use the same admitted local recovery storage as canvas bodies.

The mounted three-panel fixture uses a simulated Core and isolated browser storage. Complete retained
selection, mirrored bodies, other-card isolation, reply loss, reload, same-request retry, save/cancel and
takeover are checked there. Actual Host/IPC, multiwindow/crash recovery, scale and final model input
remain unqualified. Scoped upload/source-digest proof, scoped/retained file authorization, explicit legacy
material adoption and orphan recovery UI remain required; card files render names only until authorization lands.

Private attachment locators now distinguish scoped composers, scoped pending edits and retained inputs.
Core resolves the source from its exact Conversation/client/scope row; pending edits also require the current
Pending ID and lease token. A retained ID grants no independent access. These owners cannot fall back to
legacy managed-attachment lookup. Persistent scope ownership survives pin deletion for orphan recovery.
Main's two file entry points preserve the complete descriptor and reject scope data smuggled into an old
default owner. Renderer and Main file identities include the exact scope/retained/lease before caching.
Scoped upload, content-change proof and actual Host resource qualification remain pending; file UI stays gated.

## 私聊源观察（2026-10-16）

Migration206/schema156 按 Conversation/source ref 独立保存内容及对象身份观察，不把摘要加入 SourceRef 或模型输入。
选择材料和显式迁入时记录，发送/排队准入前重检；变化阻断并保留整份输入，队首失效记为 needs_repair。
目录的安全递归观察复用既有句柄和层级/条目边界，公共/Agent live source 及旧冻结 Run 不改。
实现边界见 [私聊输入合同](../contracts/single-chat-composer-scope-v1.md#私聊源观察与接受前检查2026-10-16)。
Native新桥的目录请求和共享Native文件恢复界面已接线；Web恢复接口、原文件重选、真实资源/IPC与迁入/孤立恢复仍待。
共享控制器只呈现平台原日志/回执，不成为字节或模型材料权威；迟到运输错误不能覆盖已查回结果。
边界见[共享文件准备与Native恢复](../contracts/single-chat-composer-scope-v1.md#共享文件准备界面与-native-恢复2026-10-16)。
内容摘要和递归目录观察先在Core数据库锁外准备，每个Core最多4个观察任务；实际IO结束才释放名额，取消等待不提前归还。
准备只持有本次完整SourceRef和结果，不长期缓存、不复制正文、不授予文件权限。原事务重验当前归属、版本和有序材料集合，
缺项、路径或顺序变化均回滚，不用旧准备拼接新输入。原UUID先查回执，已经完成的操作不再读文件。
发送、排队编辑/发布、旧材料迁入及上传均沿同一边界；队首遇容量或并发准备变化稍后再读，不记为永久needs_repair。
旧缺内容观察的历史发送仍只做原兼容检查，不补造历史摘要。原廉价路径/类型准入保持，移走的是完整内容扫描与目录递归。
真实大材料响应、取消/退出、事务锁和多卡负载仍须C06实际测量，源码与语法检查不能证明高可用已完成。


## 独立 Mission、Task 与 Diff 身份

I03-C02 在原 conversation 卡片容器上增加显式 `objectReference`，用只含身份/选择提示的独立子表持久化，
并非另一份 Mission、Task 或 Git 状态。Core 初次写入核对原对象与公开 Thread；对象消失后仍保留卡片，
后续原对象读取再次核对身份与 Thread，不从 Thread 当前 Mission 重新绑定。
Mission Diff 只保存 Mission ID 与可选原文件名，基线、实际 Git、临时 viewId 与权限均属于既有 Mission 服务。
Schema157/Migration207 保留原八类节点表，新增引用表及不可变/归属守卫，与旧节点几何写入共用原命令事务和回执。
新快照能力控制首次对象写入；旧省略、新字段闭合、原编号未知恢复和失败回滚仍须阶段 Core/Host 实测。
后续客户端接线复用同一引用：新增选择器按原 Thread/对象读取，卡片点击后才挂载只读详情；
Mission/Task 的编辑在既有工作区，使用原对象定位与精确 Task 锚定，不另建业务写入或执行层。
Diff 在画布详情中复用原累计变更组件，先读原 Mission 工作区基准，再以当前列表/viewId 打开精确原路径；
多个挂载查看器最后关闭才释放同客户端/Mission 的快照。业务引用从普通对话展开/镜像/分组手势和旧恢复入口中排除。
选择器与详情的隔离模拟证据只证明客户端交互；源157/207、真实Host及实际工作区跳转仍须阶段候选集中运行，C02未收口。

## 文件节点与原文件预览权威

I03-C03 新增独立 `fileReference:{threadId}`：画布保存原公开工程会话与精确路径，具体文件能力继续属于既有Core/Main/Host文件预览链。
`bind_file` 只为旧文件节点明确追加一次来源，不按当前会话、相同路径或上次焦点推断。来源失效保留，不授予目录权限。
Schema158/Migration208 仅追加引用子表与来源/不可变守卫，读投影在原23列加4个业务引用列后追加1列，仍以单查询读取。
创建、旧节点绑定、布局版本、事件和首次结果继续在原Gateway事务中；旧canonical请求新增字段None时省略。
具体合同见[文件节点来源绑定](../contracts/canvas-nodes-v1.md#文件节点来源绑定2026-10-16)。
客户端新建须明确选择原工程 Thread，旧节点通过同一编辑器显式绑定；未知回执保留表单与原选择，核对成功后清除旧运输错误。
`CanvasFilePreview` 将精确绝对路径编码后交给原 `FilePreviewApi.restore`，不直接读取路径、不借用当前工程，也不自动启动系统应用。
固定文件展示与原工作区共用窗口 `FilePreviewResources` 和原 Thread session，但保存各卡自己的 tab ID、DOM scope、查找焦点和源码显示状态。
首次可见才读取；收起/删除撤销展示 owner，不关闭另一处仍使用的共享预览。重新展开再次核对来源，内容变化先保留旧正文并提示，显式刷新才换内容。
文件中的关联链接沿原句柄打开原 Thread 工作区并传递定位目标；根文件固定不变，迟到导航不能抢走新的页面意图。
HTML 展示含同句柄镜像计入原窗口上限；后台冷恢复只走预览，不触发系统打开。文件头删除固定本行目标，工具栏删除读取即时选中项，确认框列出路径。
隔离界面已挂载生产画布与原读者，模拟 Core/文件验证选择、未知恢复、变化、失效、收起/重开和删除；
当前158/208实际 Rust、Host/Native IPC、真实 HTML、完整应用导航和规模仍须阶段候选验证，代码就绪不等同工程通过。

## 临时终端移植基础（2026-10-16）

`canvas_terminal` 拥有临时会话来源与代次，来源只从存活画板的 terminal 节点读取；外部请求只包含原 board/node，
不接收 cwd、shell、进程 ID 或文件 RootGrant。目录是启动位置，不能宣称 OS 沙箱；可信 Owner、实际目录和删除竞争仍需启动入口校验。
状态将 Starting、Running、Stopping、Exited、Failed 分开：请求停止立即拒绝迟到启动提交和输入，只有实际回收结果才记录退出。
重启使用新代次，旧代次的输入、resize 与游标不能作用于新会话。原请求 ID 保留用于后续启动恢复，不能在丢回执后默发新启动。

输出按最多8192字节的原始块累积，保留最近128KiB且最多2048块；整块淘汰，回放同时返回起始/截止序号和缺口。
读取重叠按同一锁内游标消除，中文或转义序列跨块不先进行有损解码。缩放只在实际PTY操作成功后更新记录。

Codeg供体与portable-pty0.8.1的直接child kill不能单独证明进程树回收。PTY字节辅助进程因此必须通过现有
ManagedProcess启动，复用Windows原Job归属和Unix既有身份回收；遵循现有[受管进程决策V1.72-D26](../versions/v1.72/decisions.md)边界。
辅助进程只处理一次启动和有界stdin/stdout帧，不打开数据库、不管理画布引用、不启动AgentRun或模型；实际业务会话仍由Core管理。
父端未读时输出管道反压，输入队列最多8帧，单次输入16KiB；EOF、root退出和输出排空分别观察，不把它们冒充整树回收。

Core父端registry、三个二进制的早期helper入口、原ManagedProcess父端、节点/画板删除与计划退出已编码。
公共方法/能力、Native/Web准入、终端读者与卡片已接线；实际最低层进程检查已接入原Host生命周期owner，尚未编译完整Core或启动实际PTY。
纯状态源单独编译通过不代表辅助进程或完整Core编译通过；C04代码集齐后转C05/C06，完整PTY/Host/平台资格由阶段候选实际验证。

启动绑定原Core generation和原请求，旧Core的未结请求不能在重启后重开Shell。一个节点同代次只接受原参数，
新启动必须匹配已退出的原代次；活动和回收中进程合计最多16个。最近64个已退出会话保留正文，其他会话只保留
与仍存活节点对应的代次/回执元数据；淘汰正文不让旧启动变成首次启动。删除节点后回收完成才移除元数据。
输入以原generation、expectedInputSequence、inputId和字节摘要共同核对，最多64条回执；过期序号拒绝，不能重新送入stdin。
单份输入未查明前不接后续输入，原回执等待有期限，超时只返回pending；unknown不自动重放。回执等待不持有画布生命周期锁。

父端逐帧读取使用有界独立读者，避免select取消丢失半帧；控制、输出和维护使用公平选择，日志洪流不能按固定优先级饿死输入或回收维护。
真实尺寸确认后才更新，原字节序号与stdin回执都由同一个Core会话owner保存；辅助进程无独立业务状态。
目录查询只在DB锁内取原路径；canonicalize、Shell解析和冻结启动规格移至限量4个只读线程，超时3秒，超时任务仍持名额至结束。
Shell优先SHELL，再用平台默认；裸命令经原RuntimeSearchEnvironment解析，PATH沿同一环境冻结，保留cmd、PowerShell与POSIX已知启动形式。

停止先关闭准入，再以原ManagedProcess捕获/终止自有树、等待root并检查实际树为空，最后结清会话；失败继续持有owner并后台重试。
节点删除只在原命令事务后核对真实删除事实，CAS拒绝不杀仍存活节点；回收异常不推翻已经持久的画布命令回执。
计划退出立即停止新终端启动，终端回收结果计入原退出报告deadlineExpired；它不改变AgentRun的终态fence前提。
Linux重复强停继续通知已捕获的后代；原进程owner补恢复标记回归。真实Linux/macOS硬退出、网络目录、ConPTY/Job和跨平台仍待验证，不能据源码宣称高可用已完成。

## 终端公共接口与客户端（2026-10-16）

画布快照声明可选`terminalVersion:1`，缺少或未知版本时客户端在运输前拒绝终端操作。Core暴露5个
`canvas.terminals.*`方法，Native沿原IPC准入、Web沿原已认证Host逐项开放，均复用原Core身份与会话权威。
启动/输入/缩放/停止离开主请求队列，快照走独立读取队列；后台方法仍在各自生命周期入口核对来源。
既有Main准入漏列的7个技能包与8个画布方法，以及Web共享客户端漏列的7个技能包方法本批同步补齐，避免拦截已经实现的业务入口。
逐项对照还补齐Web原待创建会话的`threads.pendingDraft.setPresence`，恢复原草稿存在状态通知；不改变草稿内容或命令恢复行为。

共享`CanvasTerminalClient`固定构造时的board/node，逐项组装闭合请求，冻结原字节与请求字段，核对响应目标、
Core/启动身份、会话代次、连续游标、有界原始块和输入回执。不承担进程管理或UI轮询；不自动重试，不保存命令字节。
Web终端操作明确不进入`RECONCILABLE_COMMANDS`或持久恢复队列；丢回执后由终端控制器读取原会话/输入回执，
不能借通用恢复再次投递stdin。停止响应仅表示已请求，实际回收必须看快照`cleanupComplete`。
Host投影与Native客户端都按公开字段组装返回值，排除未来新增的内部进程/摘要字段；输出仍为base64原始字节。

当前协议清单追加5个动作至185项，并修正清单中过时的schema156为既有158/208；Host协议4和固定来源161项快照不改。
合同见[临时终端接口](../contracts/canvas-nodes-v1.md#临时终端公共接口2026-10-16)。客户端与模拟运输检查不代表实际Core/Host/IPC或PTY通过。

## 临时终端卡片与字节控制器（2026-10-16）

`CanvasTerminal`挂在原ReactFlow terminal卡片，复用原布局/CAS、标题栏、删除确认和收起状态。首次可见只读取，
用户显式启动；收起、换页、页面隐藏与视口外释放仿真器和轮询，不关闭Core的shell。重新展开读取同一Core/代次的有界原输出。
删除确认列出实际节点及停止命令的影响；真正停止和树回收仍由原Core父端负责，界面不能将停止请求当回收完成。

`CanvasTerminalController`拥有一份在途输入、最多64KiB未发送字节、原启动/输入身份、尺寸合并和读取游标。
每份输入最多16KiB，先确认上份写入才继续；unknown清空尚未投递部分且不重发。只在已推进的原序号围住迟到输入后
允许明确知悉继续，否则需核对回执或停止旧会话；已确认整树回收的旧代次不阻止显式新启动。
启动未知时保留原requestId/Core/expectedGeneration/尺寸，明确重试仍用原请求。Core替换清旧身份和待发输入，不能自动启动。

窗口内按ThreadClient、Core目录scope、画板和节点缓存最多64个控制器，跨路由保留未决身份，不落持久存储。
仅无展示、无在途或未决操作的条目可淘汰；没有安全可淘汰项时显示资源上限。输入队列在视图释放时丢弃，进程仍留在Core。
`CanvasTerminalReader`连续交付Uint8Array，不逐块解码UTF8；等待xterm写回调后推进游标，重叠跳过，缺口明确提示并重置读者。
释放解决等待中的绘制，防止新视图被旧回调卡住；Core/代次变化同时清除仿真器和无障碍live region中的旧输出。

xterm6.0.0、fit0.11.0及web-links0.12.0沿固定供体版本接入，无新增传递依赖；原锁条目字节保留，MIT通知见
`integration/licenses/xterm/`。颜色只读取现行主题token，字体沿原代码阅读字号；原字节颜色、滚动、IME、快捷键/应用光标模式、
虚拟Ctrl/Alt及复制选区/显式粘贴按同一组件实现。HTTP/HTTPS链接沿既有外部打开入口，完整共享浏览器/菜单仍归既定I08，
完整工程终端与Shell配置归I05，移动原生交互归I10，完整字体/连字等个性化归I11，未从一期范围删除。
可见且前台才轮询，运行中500ms、静止3s、读错5s，前一读取和绘制完成后再定时；窗口聚焦触发合并读取。

低层定向测试及生产画布/xterm的浏览器夹具已检查未知恢复、双卡、换页、停止/新代次、缩放、日夜主题与删除目标。
夹具Core/PTY为模拟，不证明实际Host、Native IPC、Shell、进程树或平台通过；证据见
`integration/execution/i03-terminal-ui-result.json`。实际进程owner源码见下节，集中工程验证仍是C06必需项。

## 终端进程退出保护与实际测试（2026-10-16）

Linux专用PTY helper通过Core冻结环境取得父进程身份，并用pidfd核对实际父子关系及存活；该字段不进入公开RPC。
仅helper设置child subreaper，普通Core/Runtime的收养行为保持既有规则。保护线程观察Core父pidfd和本helper退出意图，
平时不扫描`/proc`；父进程硬退出或本次会话收尾时，捕获helper自有后代，用pidfd终止，收养并回收已退出孤儿。
启动锁与保护线程共用，防止清空后又产生新Shell；portable-pty直接child由原owner等待，保留实际退出码。
除已捕获进程均退出外，还需内核`waitid(WNOWAIT)`确认没有子进程，才算helper清理完成；扫描失败不伪报清空。
这不改变Core的原ManagedProcess关闭、实际树为空与会话`cleanupComplete`条件；Windows沿原Job，macOS沿原持久身份账本恢复。

`scripts/lib/canvas-terminal-process.mjs`扩展原`host-web.test.mjs`的唯一Core生命周期夹具，使用隔离HOME/PATH、
绝对Node交互解释器和真实PTY；同一Host管道与已认证HTTP交替调用。子进程使用带随机nonce的本机证明服务，
清理请求须匹配本夹具身份；另起独立控制进程，所有终端回收后均要求其仍活跃。macOS在硬退出前核实后代身份已实际落盘，
不靠固定睡眠推定已捕获。测试脚本源码与独立worker冒烟不能证明这些真实Core/PTY场景已通过，结果随C06候选记录。

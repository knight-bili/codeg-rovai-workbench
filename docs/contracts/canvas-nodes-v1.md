---
document_type: protocol-contract
contract: canvas-nodes-v1
authority: core-canvas-node-graph-and-atomic-gestures
status: accepted
version: 1
last_updated: 2026-10-16
---

# Canvas Nodes v1

继承 [Canvas Boards v1](canvas-boards-v1.md)，在同一个 Core 数据库保存节点图。
范围来自固定 Codeg `aff1e6c278453ed8d0b96a5f664edcdca621aa3f` 的 canvas entity/service、
commands、store 与 viewport storage，来源摘要见[源码清单](../../integration/execution/i03-node-source-audit-result.json)。
合同定义工程边界，不代表交互画布、PTY 或整个 I03 已验收。

## 读取与命令

| Operation | 参数 | 结果 |
|---|---|---|
| `canvas.nodes.snapshot` | `{boardId}` | `{board, nodes, throughGlobalSequence}` |
| `canvas.nodes.apply` | `{commandId, command:{boardId, expectedRevision, mutation}}` | 首次持久化命令结果 |

Snapshot 在同一读事务捕获 Board、节点和序列；不存在或已删除的画板返回 null Board 和空节点。
节点包含 Core 创建的 UUID `id`、不可变 `boardId`、`data`、`createdAt` 与 `updatedAt`。
读取不创建、修复或清理节点。所有参数与嵌套对象拒绝未知字段。

写入只接受 User，不接受 Camp scope、execution epoch 或额外 expected-entity 列表。
所有手势使用当前画板同一个 revision；元数据和节点写入共用该版本，不能分别维护冲突真源。
冲突返回 `canvas.nodes.conflict` 和当前 revision；缺失画板返回 `canvas.nodes.board_not_found`。
按 [Domain Command Result v2](domain-command-result-v2.md) 保存首次结果，回放不再修改图或发布失效事件。
Web共用适配器准入全部画板/节点操作；四种写命令接入既有原命令恢复。
`commands.reconcile`只读回查原User作用域的首次收据，缺少收据仍是unknown，不能因此自动重发或换命令ID。
浏览器断线/重载保留既有待核对命令，显式重试使用同一编号和原始参数；读取快照不替代收据确认。

`mutation.type` 为以下闭集，字段均用 camelCase：

| type | 字段 | 原子行为 |
|---|---|---|
| create | node | 创建一个新节点，ID 由 Core 分配 |
| update | nodeId, patch | 更新展示、几何或 custom 成员；kind、画板和绑定身份不变 |
| move | moves:[{nodeId,x,y}] | 整批移动；不操作其他画板或已删除 ID |
| group | targetNodeId / newRegion 二选一，conversations，consumeNodeIds，可选sourceMembers | 合并到 custom 区域，原子移除明确选中的custom源成员及已被接纳的会话pin；其他种类不被吸收删除 |
| detach | regionId, conversation, x, y | custom 中移除该精确成员并生成 pin；其他 region 保持其动态绑定 |
| delete | nodeIds | 仅删除本画板节点，不删除引用的业务对象或用户文件 |
| prune | 无 | 清除本画板失效会话 pin、custom 中的失效引用 |

改变图时，节点差异、Board revision/updatedAt、一个 `canvas.board.invalidated` 以及首次命令结果同事务提交。
事件仍仅为 `{boardId,revision}`；客户端重新读取权威快照，不移植 Codeg 的 LWW 全状态事件为第二套真源。
结果仅返回 `{boardId,revision,nodeIds,deletedNodeIds}`，不在每次拖动收据重复保存整份便签正文。
无变化时返回 `canvas.nodes.unchanged`、原 revision 与空 ID 列表，不产生画布失效；普通 command.result 事实保持既有规则。
校验失败不保存部分手势；SQL、事件或结果保存失败则一起回滚。

## 八种 data

共同字段为 title、color、collapsed、gridColumns、gridRows、x、y、width、height。
绑定字段为 folderPath、folderGroupId、runtimeKind、agentId、conversation、conversations、content、path。
`conversation` 是 `{threadId,conversationId:null|string}`；custom 保存此引用的有序去重数组，
因此公开 Thread 与它内部的指定 Conversation 不会因同一个 threadId 被错误合并。

| kind | 内容与引用 |
|---|---|
| folder | folderPath；引用实际工程目录，不复制 Codeg 数字 folder ID 或建第二个项目注册表 |
| group | folderGroupId；引用既有导航偏好身份，实时分组解析仍由导航能力提供 |
| agent | runtimeKind 筛选和/或 agentId；Runtime 种类与队员身份分开，创建时检查指定队员仍存在 |
| conversation | 一个实际存在且未进入删除的 Core Thread/Conversation 引用 |
| custom | 最多 200 个精确会话引用，保持首次出现顺序；新增引用检查实际存在 |
| note | content 原文，包括换行和 Markdown；展示仍须使用现有安全 Markdown 规则 |
| file | path，保存源绝对路径，存在性与可读性由实际预览授权链路判定 |
| terminal | path，保存工作目录意图；不保存 PTY ID、凭据或原生进程身份 |

Note 以外不接受正文，file/terminal 以外不接受 path。其他不相干绑定也拒绝。
标题和颜色修剪，空标题清除；正文不修剪。颜色沿用 Board 的固定主题词汇。
尺寸夹在 48..20000，坐标夹在 -1000000..1000000，非有限值拒绝。
region 的网格轴夹在 0..12，0 为自动，非 region 轴为0；detach pin 为源尺寸224×132。

## 区域成员手势

`group.sourceMembers`为最多200个唯一`{regionId,conversation:{threadId,conversationId}}`，均须属于本次incoming引用。
源必须是同画板真实region；custom源必须仍包含该精确成员。全部校验成功后，同一原子命令完成目标接纳、
移除明确选中的custom源成员及消费独立pin。未选择的镜像实例保留；folder/group/agent源只复制引用，不改变动态绑定或业务归属。
目标与源相同的已存在实例保留；单卡落回原区域由客户端作为无变化处理。公开与私有Conversation始终是不同引用。
源区域也进入原有命令前内容指纹范围。默认空sourceMembers在序列化时省略，旧Group请求及收据指纹保持，
不以新增可选字段改变旧未知操作的回查/原编号重试。此扩展不新增数据库字段、操作名或模型输入。
新快照返回`memberTransferVersion:1`；旧Host省略该字段时，Renderer不发送包含sourceMembers的新写入，
先提示升级服务，避免旧服务拒绝字段后留下无法结算的新手势。原detach、pin移动/分组及其他旧操作仍按原合同使用。

Renderer采用真实画布库派生成员节点，ID仅用于展示选择，不写成Core节点或业务ID。坐标由真实父区域与固定网格计算，
区域移动/折叠、显示全部、选中镜像、落点提示与已展开区域保持一致；拖动时冻结源成员名单，释放时使用起始画板版本。
成员拖到空白调用detach，拖到custom或独立pin调用单次group；投放到folder/agent区域只形成独立pin，不给Thread改工程/队员。
选中的跨区域成员与独立pin可以一次分组，只消费pin与明确选中custom成员。多选位置移动只持久化独立节点/区域，派生网格位置不写回。
删除、方向键布局、打包与对齐过滤派生ID；键盘用户可通过卡片按钮移出或固定，再沿独立节点布局。
失焦/Esc只取消未发送手势，待核对命令继续走原回执；手势归属与代次保护避免旧结束回调清掉新操作。
实际鼠标/触控/键盘、镜像/重排、断连恢复、Rust与Host新增路径仍按I03阶段候选验，不用派生模型测试替代。
路径限制4096个Unicode标量，拒绝NUL/相对路径；保留其他主机的绝对路径作为不可用引用，不能因此获得本机访问权。
文件和目录暂时不存在时，节点身份与几何仍保留。已有业务对象后来消失时允许显示不可用；新会话引用不接受不存在的对象。

## 存储与删除

Schema154/Migration204 从准确 schema153 原子增加 `canvas_node`、画板索引和迁移回执，再更新 marker。
几何、展示与绑定各自保存为独立字段，每项事实只有一个真源；只有 custom 的有序成员列表使用受限 JSON。
批量移动只读写布局，不读取或绑定便签正文；其他手势只加载涉及的节点，不加载整板。
命令收据不复制业务状态或完整节点正文。
旧 Board、安装、队员、Run、Manifest、Blob 和命令结果不改写；历史格式与模型输入合同不变。
当前准入只检查必要结构，不放宽历史来源匹配，不比较历史 SQL 全文来认定新库。

Board 删除在同一事务删除它的节点并保留 Board tombstone，不恢复旧 ID。
本切片没有交互 PTY，不能据此声称已结算终端；引入真实终端前必须接入所属进程的关闭/删除生命周期。
后续 `canvas_terminal` 移植基础使用原 board/node 查活跃终端来源，原请求/进程代次只存Core内存，不写画布表。
拟接启动/读取/写入/resize/停止的闭合请求不接受cwd、shell、Owner或RootGrant注入，原代次和原输入编号不能由重连替换。
父端registry、CLI helper、受管进程与删除/退出已有源码接线；后续公开方法/终端能力、Native/Web与读者合同见本文件末节。
真实最低层进程检查已接入原Host生命周期owner。完整Core/Host与真实PTY尚未编译或运行，不据纯状态检查宣称终端交付。
内部启动类型增加必需coreGeneration，必须来自本次Core；输入增加必需expectedInputSequence，以原代次/序号/inputId/摘要核对，
待定、未知及过期回执均不能换新编号重新写入。会话ID不进入数据库，完整内部状态与限额见[终端架构](../architecture/canvas.md#临时终端移植基础2026-10-16)。
跨画板业务删除 funnel 的自动清理、导航组实时解析、Mission/Task 入口、Renderer 布局和客户端视口继续属于 I03 后续工作，
本合同的 prune 不替代这些生命周期接线，也不缩减[完整一期计划](../../integration/planning/plan-v4.md)。
画布正文不会自动进入模型输入；以后若改变该边界，继续遵循既有模型输入变更治理。

## 验证

### Renderer 内嵌会话接线

画布原地展开与侧边呈现复用同一个既有 `ThreadWorkspace`、读取/刷新 owner、发送/撤回/审批/停止回调，
不新增 Conversation、Run、草稿数据库或模型请求入口。模式、平移、缩放、节点位置与卡片远端消失只改变同一 portal 子树的几何；
卡片消失/换绑时保留原会话于侧边，用户收起前不静默卸载输入。手动切画板、删除/吸收当前 pin、切换对话及退出沿用既有 leave preparation，
保存失败保留旧编辑器；读取/保存中阻止旧内容继续操作。同一卡片的呈现切换完成后解锁现有编辑器，不按离开实例处理；
切到同一 Thread 的另一张卡片仍是离开原输入实例。

区域成员先由 Core `detach` 获得真实 pin 收据后再展开，未知结果沿原命令恢复，不从临时成员 ID 推断成功。
私有引用先核对 `singleChat.get` 的精确 Thread/Conversation/active，再读取 Thread；迟到/换 Host 的结果不得提交。
绑定私有引用时仅挂载既有私有面板，禁用换队员与替代新建；原单聊丢失/结束后不能向另一段对话发送，公开 Composer 不挂在下面。
画布正文不会进入模型输入；schema154、Host4、当前178操作及冻结输入合同不变。

多卡共享层的会话请求固定绑定指定的 Core client 与 Thread ID，发送、撤回、审批、取消及名册操作不从稍后选中的侧栏行取地址。
只读打开仍为 `threads.open`，不以恢复展开状态为理由调用 `threads.enter`、创建 Conversation 或启动 Runtime。
发送格式和投影转换从既有页面提取、函数体保持不变；原导出保留兼容，发送参数在运输前复制，编辑器后续修改不改变已提交内容。
命令工厂不产生重试/回执权威或替代生命周期；Core 仍核对授权、CAS、输入准入和持久结果，呈现 owner 负责拒绝迟到结果。

现有只读入口、刷新和分页已接同一 client 所有的 `ThreadProjectionStore`；每 Thread 独立水位、历史、错误和在途队列。
同 Thread 的普通打开复用在途读取；刷新信号使该读取结束后补读，多个信号合并，只有新信号才补读，运输失败不自动无限重试。
显式 enter 的投影可交回该 owner，但 owner 本身只调用 `threads.open`、`thread.messages.page`，不 enter、建会话、启动 Runtime 或确认通知。
有效历史沿用原排序/coverage 合并；分页的请求水位被新投影越过时不采纳，旧 schema/Thread/游标或更晚序号仍拒绝。
服务重启推进本机读取代次、清快照并保留已挂载租约与订阅；删除精确资源使原在途结果失效。
仅五个空闲缓存受 LRU 预算限制，挂载/订阅及读取中的实例不被该预算驱逐。换 client 新建 store，不跨 Host/Owner 采纳缓存。
实际多卡入口已按精确卡片上下文挂载，每个 Thread 一个读取订阅 owner，分发既有 Core 事件、Host invalidation 与有界事件轮询。
每张卡片拥有自己的 leave guard，批量离开先准备全部输入；任一准备失败即解除已准备项并保留全部实例。
可见通知已接实际卡片 public/private 报告的按 Thread 并集、精确确认与独立重试；
只有窗口与裁剪范围内且未被遮住的来源参与，收起只移除所属实例的报告。
多卡 quiet 只影响临时浮层，不清未读；完整展开恢复和真实 Core 通知确认仍需继续实施与实测。

固定 Codeg `canvas-conversation-surface.tsx` 的 `draftStorageKey=canvas-draft:<contextKey>` 与 `attachmentTabId=contextKey`
明确每张卡片的输入独立，不能由同一 Thread 的消息共享推导出所有卡片共享一份草稿。该核查纠正先前检查点中的共享草稿计划，
不缩减多卡完整编辑能力。卡片上下文使用 Host/Owner、Core dataDir、Board、真实 pin ID、Thread 和精确私有 Conversation 的规范元组；
模式及几何不进 key，同卡原地/抽屉复用，另一卡、换绑定或换 Core 不采纳原输入。成员先取得真实 pin，不能用派生成员 ID 保存输入。

公开正文、结构化内容、引用、回复/续发及附件身份仍用既有本地 Draft 格式，按 Thread 聚合成单个版本化 bundle，
每个上下文一项，读改写同一值同时保存索引与内容；主会话原 key 不变，画布不自动导入主会话或创建队员的初始草稿。
破损、未知版本或非字符串 bundle 阻止覆盖；保存失败保留编辑器并阻止离开。恢复副本只提取当前上下文，恢复仍重验原附件与来源。
Web 公开 bundle 复用既有同编辑端本机归档，标签页存储丢失后仍可恢复；新编辑端仅列同 Host/Owner 的精确上下文副本供显式选择，
不自动导入另一编辑端。主会话与画布公开快照均过滤至既有公开字段，私聊正文、会话证明和待提交命令不进入该归档；
旧主会话及旧标签页内的有效公开记录仍能读取与迁入，未知/破损归档拒绝覆盖。
Pending presence 在同一 client/Thread 串行核对主会话及所有同 Host/Core 卡片的输入并集，包括已收起卡片；
清空单卡不清掉其他输入。已接受的激活停止旧 Pending 写入；卸载后执行空草稿清理时，还挂载的卡片也阻止 discard，
挂载本身不伪造非空 presence。此本地提示不是资源授权或第二个 Core 草稿权威。

现有私有面板的主会话正文恢复字典继续使用 `single-chat:<Thread>` 与字符串表；画布在 key 后附同一规范上下文，
同卡共享、不同卡分开，不新增 Core 字段或跨客户端合并。不同 Conversation 保留独立正文，同上下文编辑基于最新整表更新。
Native 的画布正文使用带上述完整归属的 localStorage，Web 继续使用既有 editingRecovery；此处的重建单测不是实际进程重启资格。
同一正文 key 的请求发送使用一次性本地互斥，原文在发送前读取并沿既有 `singleChat.send` 参数运输；
成功只清仍等于冻结原文的正文，新输入保留，未知/拒绝不由此层自动重发。迁移 pending key 等待相应发送结束。
pending 与 Conversation 均有不同的非空正文时保留两份，由用户显式切换；目标为空时采用保留输入，不能通过删除旧 key 丢弃正文。
待发送消息移回后也基于共享整表接纳：已有其他输入时将返回正文保留为 `<正文key>:returned:<Core commandId>` 字符串条目，
否则接纳为当前正文并保留空条目作为已应用标记。重复收据不覆盖较新输入，用户切换时保留双方正文；Core 返回前不生成应用标记。
首次恢复读取失败时禁用输入/发送和移回操作；保存失败保留内存正文、阻止发送和离开，只重试本地保存。
Core 事件回读不能覆盖本地未保存正文或正在提交的快照；本地锁不替代 Core 幂等、私有 Draft revision 或真实未知结果验收。

当前接线支持多张可交互实例，包括同一 Thread 的多个镜像；原地与侧边切换只改变位置，保留同一卡片的编辑器。
正常侧边模式沿固定 Codeg 的单 drawer 行为，其他展开卡片仍留在画布。节点被删除、打包或换绑前准备相关输入，
图操作结束后解除输入锁，不因节点移除而丢弃原实例；失去原 pin 的实例保留到侧边并提供切换入口。
各卡片共享按 Thread 的消息与预览资源会话，公开/私有正文仍按上述卡片上下文独立，不另建执行或业务权威。
窗口共用一份文件保留资源并集和原预算；卡片预览坐标、DOM 标识和查找焦点隔离，原系统动作等待所属绑定。
模拟 Core 的浏览器挂载已检查三张真实 Frame/ThreadWorkspace/Composer 的独立正文、模式切换、撤销、局部查找、
关闭重开、文件归属及 60%/100% 预览边界；它没有挂载完整 ReactFlow/BusinessApp，也不证明真实文件能力或进程重启。
展开记录按 Host/Owner、Core dataDir、Board 保存精确规范上下文；只含卡片引用，不存正文、私有证明、会话令牌或 Runtime 连接。
恢复等待完整且有效的画板图，先匹配原节点及精确公开/私有引用，再核对 Core 与读取原会话；每 Thread 首次恢复刷新，镜像共享该读取 owner。
跨画板、跨 Owner/Core、旧服务加载占位及错误图不触发恢复。旧的本项目 scoped expandedCards 仅通过当前有效图迁为精确上下文，
原 Codeg 未分后端的 localStorage key 不自动迁入。失配/不可用引用、破损/未来记录均保留，禁止换成新的私有 Conversation。
切页/切画板暂时关闭只卸载实例，显式收起才删除对应展开记录；drawer 位置只属于当前会话，重建按原地卡片恢复，
不恢复 ACP/Runtime 连接或发送消息。恢复有完成数量、停止与显式重试，迟到结果受代次限制；本机 quota 失败保留当前内存意图和输入。
离开前先准备并锁定输入、保留原实例，只有实际导航/画板切换成功后才移除；失败、拒绝或已失效的导航解除原锁，保留同一编辑器和撤销栈。
并发离开共享同一批准备，全部尝试结束前不提前解锁。画板/项目分组弹窗不移除原编辑器；创建与删除画板只在成功回执后交接相关实例，
拒绝和未知结果保留原实例，核对成功才提交。没有编辑器的空选择直接选择有效画板，避免自动选择反复触发离开事务。
退出准备在其他 Renderer 检查失败时回滚；Native 已完成预检后的退出失败与真实 Core 停止/接管仍待资格验证。
真实 CanvasWorkspace/CanvasSurface/ReactFlow/编辑器已在模拟 Core 下验证切板、离开返回、页面刷新、显式收起/重开及独立草稿恢复。
这不是完整 BusinessApp、Native 进程重启、异常退出或真实 Host 接管资格。
私有附件与 quotes 的 Core Draft 仍按 Conversation，需要继续完成卡片间隔离。完整进程/异常退出恢复、
真实 Core 的通知确认、关闭后的孤立输入恢复、复杂导航失败恢复及规模性能仍在 I03 队列，未移出一期。
真实 Core/Runtime 流式、审批、停止、IME/触控、HTML/iframe 资源规模与各平台资格仍待验收。

公开卡片可从当前 Thread 关联进入原 Mission 说明/启动、交付、活动和累计文件 Diff；只在当前 Thread 与 Mission 列表的双向标识一致时显示。
现有 Mission action owner 和 Core 命令仍为唯一执行入口，卡片不复制使命状态或另造启动命令。活动来源回到所属卡片原消息，
Task/Mission 详情查找限本 workspace；累计变更的折叠、目录树和弹窗控件使用独立 DOM 标识。选中节点不得遮住会话操作平面。
原活动标签在 Mission 缺失/换绑时显示不可用，不改开另一使命。独立持久 Mission/Task/Diff 引用、文件节点授权与实际运行仍待补齐。

纯输入 owner 拥有八种类型、几何/网格、路径与成员上限；扩展 SQLite owner 拥有204回执回滚、
CAS/跨画板、原子手势与结果回滚、精确引用、重开、删除与旧结果回放。
上述既有纯输入owner补旧Group序列化不增字段，既有扩展SQLite owner补跨源私有/公开成员原子转移、未选镜像保留、
无效源回滚、派生绑定不变与原收据回放；没有新增Rust owner，本切片尚未编译/执行。
真实 Host/HTTP 另证明153升级、封闭入口与实际持久化 seam；这些都不能替代交互画布、真实模型或全平台资格。


## 独立业务对象卡片引用（2026-10-16）

既有八种节点保持。conversation 节点可附加闭合、不可变的 `objectReference`，此时是独立业务对象卡片，
不能只按 Thread 当前关联的 Mission 推断对象。缺少该字段的旧节点序列化仍省略它，保留旧请求及回执指纹。

```ts
type CanvasObjectReference =
  | {kind:'mission'; missionId:string}
  | {kind:'task'; taskId:string}
  | {kind:'mission_diff'; missionId:string; path?:string|null};
```

对象卡片必须同时有公开 `conversation:{threadId,conversationId:null}`。创建在原 User/画板版本事务内校验
该对象实际属于这个 Thread，Thread 未删除；不创建业务对象或触发执行。对象 ID 和绑定不可通过 patch 改写，
几何/标题等展示仍可调整。引用删除只删除节点元数据，Mission、Task、工作区与用户文件不受影响。
分组不消费或转换对象卡片；prune 不自动清除它们。原对象缺失时保留引用与布局，读取/定位应显示不可用，不能换成新对象。

`mission_diff` 指原 Mission 的当前累计变更，path 是可选的精确列表文件名，保留空格/Unicode；
它不授权文件访问、不保存 viewId/PTY/工作区路径或复制固定基线。文件打开仍应先读当前 `missions.changes`，
按原路径匹配当前列表，再沿原 `missions.fileDiff` 授权与短期视图，不能猜测第一项或采用旧 viewId。
完整 Git 工程工作区与历史变更能力仍按既定一期后续工作包推进。

Snapshot 增加可选兼容能力 `objectReferenceVersion:1`。旧 Host 未声明时，客户端在派发前拒绝新对象写入，
不创建一个无法核对的新待处理命令；已有节点和旧操作保持。结果未知时仍冻结原 UUID、对象 ID、path 和起始画板版本，
显式重试不能跟随 Thread 新绑定重新选择对象。

Schema157/Migration207 仅新增 `canvas_node_object_reference` 及归属/不可变触发器；保留 canvas_node 原表与旧行。
引用以 node_id 为唯一主键和删除级联外键；业务对象 ID 不设删除级联，以便显示失效引用。迁移只接受准确 schema156，
表、两触发器、207回执与157 marker 同事务，失败完整回滚；不扫描用户文件，不改既有模型输入或冻结结果。
当前代码与原文 SQLite 夹具已有分项证据，新增 Rust/实际 Host 尚未编译运行，不能据此声称完成工程验证。

客户端选择器提供使命、任务与累计变更三项，只有快照声明 `objectReferenceVersion:1` 才能新建。
先选原公开 Thread，再以 `missions.get` 核对 Mission，或按50项显式分页选择 Task；历史已结束任务可以继续定位。
Diff 可显式读取当前变更清单并选择精确路径，只保存 Mission ID 和 path，不把临时文件 ID 或 viewId 写入画布。
清单刷新后原选择失效时保留原路径并要求重新选择，不能自动换成整个 Mission 或另一文件。

对象卡片显示保存的类型和对象 ID，点击才读取；不为全部卡片预读正文，不渲染私聊输入，不启动 Runtime。
独立对象不参与普通对话展开、镜像高亮、旧展开状态迁入、成员分组或拖入分组，仍可普通移动、改标题和删除引用。
详情按保存的对象 ID 和 Thread 复核，失败保留卡片；Mission/Task 的操作入口重新核对后复用既有工作区与定位请求，
Task 使用精确锚定任务补入原投影，不因任务未在首屏列表而打开另一任务。工作区原有编辑/离开/恢复机制保持。

Diff 详情先核对原 Mission 和 `missions.delivery` 的 Thread、工作区 Mission/Thread，使用原工作区基准及现行可见性条件，
再复用 `MissionChanges` 读取当前列表，按 path 选择当前文件 ID 与 viewId。原路径不存在时显示提示，不能自动打开第一项。
相同客户端、相同 Mission 的已挂载 Diff 查看器共享释放计数，最后一个关闭才发 Mission 级释放，防止关闭一个界面使另一个失效。
Core 的12视图容量及现行过期规则仍生效；选择清单不持久化快照。当前界面模拟检查不能替代真实 Core/Host、工作区跳转和阶段集成。

## 文件节点来源绑定（2026-10-16）

文件节点的 `path` 本身不授予读取能力。新增可选 `fileReference:{threadId}` 保存原公开工程会话身份，
不保存 Root Grant、文件句柄、reopen token 或文件内容；不存在该字段的旧请求继续省略它，保留原回执指纹。
新绑定只用于 `file`，创建时须匹配未删除、active、directory 的原 Thread，具体路径和权限仍由现行
[文件预览架构](../architecture/file-preview.md)与 File Preview v21 负责。

旧文件节点不会自动借用当前会话。显式 `bind_file:{nodeId,threadId}` 在原画板 CAS/Gateway 事务内追加一次来源，
不能改绑或清空；原 UUID 重放沿首次持久结果。仅来源相同的新请求可得到未改变结果，跨画板或失效来源拒绝。
创建或绑定都不 stat 文件、不创建文件能力，不启动执行；之后实际打开必须重新经过原文件预览来源/真实身份校验。
原 Thread 失效后保留文件路径和来源，仍可移动、改标题和删除引用，不能默选其他 Thread。

Snapshot 声明可选 `fileReferenceVersion:1`。旧服务没有声明时，客户端在分配待处理命令前拒绝带来源的新建与显式绑定。
未知恢复冻结原 UUID、画板版本、nodeId、threadId 和原路径，不跟随当前页面或目录重新选择。
新绑定文件保存精确原路径，不修剪尾部空格去打开另一个 Unix 文件；未绑定旧请求的规范化保持。

Schema158/Migration208 只增加 `canvas_node_file_reference` 与来源/不可变触发器，不重建节点主表、不回写旧路径或
157/207 的 Mission/Task/Diff 引用。node_id 外键仅级联引用元数据，Thread 采用保留失效身份的软引用。
准确157来源、DDL、208回执和158 marker 同事务；失败完整回滚，目标准入比较三项自身DDL。
客户端新建文件必须显式选择 directory Thread，旧文件必须先绑定才读取；选择器没有“采用当前会话”的默认值。
绝对原路径按字面编码后经原文件服务解析，保留空格、Unicode、百分号、井号、问号与字面冒号；不将文件名尾部误当行号。
Windows盘符/UNC只规范分隔符，UNC的实际支持继续受各平台原文件合同限制，不能把客户端编码测试当Web支持证明。
预览根文件始终固定，关联文件沿原句柄/原Thread转入原工作区，保留行号等定位参数。收起/删除只移除卡片展示，原工作区共享session仍由原资源层管理。
重新展开必须重新核对原来源，失败不直接回显缓存正文；已经打开的旧快照沿原文件合同保留。变化提示不静默替换旧内容。
本组代码已接线，分项与隔离界面证据见 `integration/execution/i03-file-preview-ui-result.json`；
真实158/208 Core/Host、Native IPC、完整应用跳转与多卡规模仍随阶段候选工程验证，不能据模拟证据宣称本组工程完成。

## 临时终端公共接口（2026-10-16）

`CanvasGraphSnapshot.terminalVersion`可选，只有数值1允许使用。临时终端不新增DB迁移、不创建AgentRun或模型输入，
现行schema158/208保持。Native与Web共用下表的方法和驼峰字段，Web继续使用Host协议4及原Owner登录。
`target`固定为`{boardId,nodeId}`，必须指向存活画板上的terminal节点；请求不接收目录、Shell、用户身份或进程参数。

| 方法 | 除target以外的请求字段 | 返回 |
| --- | --- | --- |
| `canvas.terminals.start` | `coreGeneration,requestId,expectedGeneration,cols,rows` | 原会话快照 |
| `canvas.terminals.snapshot` | `generation?:string|null,afterSeq?:number` | 有界原字节快照与输入回执 |
| `canvas.terminals.write` | `generation,inputId,expectedInputSequence,bytesBase64` | `sequence,inputId,status` |
| `canvas.terminals.resize` | `generation,cols,rows` | `{resized:true}`仅在原PTY确认后 |
| `canvas.terminals.stop` | `generation` | `{stopping:true}`表示停止已请求 |

身份使用规范小写UUID。初次读取可不带generation且afterSeq必须0，以取得当前Core/会话身份；增量读取必须固定原generation。
启动固定原Core代次和requestId，只有同一请求得到原会话；重启已结束会话需显式新requestId及原expectedGeneration。
客户端不因运输超时自动重新启动。Core重启后旧终端不恢复执行，读取原节点再由用户显式启动新会话。

尺寸为1至1000的整数。单次输入1至16384原字节，使用规范标准base64。输入序号CAS与inputId共同定位原回执，
状态为queued/pending/written/unknown/not_written；written仅表示原输入写入PTY，不表示命令执行成功。
unknown不能自动重发，过期回执不能用原序号再次写入。终端控制器只按原代次/编号读取核对，不使用通用commands.reconcile。
输入字节不进入Web持久恢复、本地草稿或业务命令存储。

快照包含`coreGeneration,target,exists,generation,launchRequestId,phase,cols,rows,exitCode,throughSeq,firstAvailableSeq,gap,
chunks,inputSequence,inputs,issue,cleanupComplete`。不存在时phase为missing，身份/尺寸/exitCode为空、序号0、firstAvailableSeq1。
存在时phase为starting/running/stopping/exited/failed；停止请求或根进程退出都不能代替cleanupComplete。
chunks每块`{seq,bytesBase64}`，每块最多8192字节，总128KiB及2048块，整块淘汰；缺段由gap明确标出，不能假装连续。
inputs最多64条`{sequence,inputId,status}`，正文淘汰后可为空但原截止序号仍保留。跨块字节交由终端读者连续解码。
Host和客户端投影排除内部进程身份、环境与输入摘要。完整Core/Host/Native IPC、实际PTY和最终界面行为随阶段候选验证。

终端卡片首次可见只读，显式启动/重试原启动；重进页面不自动执行Shell。收起、切页、隐藏和视口外释放读者与未发送输入，
保留Core进程及窗口内未决请求身份；不把原始输入写进localStorage、sessionStorage、草稿或通用命令恢复。
输入单份在途，未发队列64KiB，单份16KiB；队列超限整次拒绝本次输入。失去回执后丢弃后续未发字节，按原ID读取，
written清除原运输错误并开放后续；unknown/未入队不能用新编号补发原字节。确认继续仅在Core截止序号已围住原输入时开放。
停止未回收时禁止重新启动；旧会话已实际回收后，其未知输入不能阻止用户显式新开代次，迟到旧输入仍被Core代次挡住。
客户端缓存最多64个窗口控制器，只安全淘汰无展示/未决/在途者；身份不能跨ThreadClient或Core目录scope复用。
读者按同一代次逐块写Uint8Array并等待绘制确认；缺口重置并提示，Core/代次改变清空旧显示及无障碍live region。
浏览器模拟覆盖这些交互，实际PTY、Native/Web平台资格和真实进程回收仍须阶段候选执行。

Linux专用helper在Core父pidfd失活时回收其收养的自有后代；父进程身份来自Core冻结环境，客户端不能提交或更改。
启动许可与回收互斥，清空还需内核确认无剩余子进程。Windows原Job、macOS原身份账本及Core统一清理完成条件继续适用。
真实退出/强退/重启和无关进程保护由原Host生命周期测试拥有，源码就绪不代表实际平台已通过。

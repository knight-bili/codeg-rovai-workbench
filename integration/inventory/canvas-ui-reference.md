# 画布界面的源码参考与移植边界

客户于 2026-10-16 提供五张真实 Codeg 截图，并明确要求持续参考两份应用的本地源码与 CodeGraph。此次纠正此前仅整理文字按钮的实现方式，按照原组件的布局和交互组织画布。此调整属于 I03 已有画布能力的界面整改，不新增阶段、不减少完整一期范围。

## 固定参考版本

| 源码 | 本地位置（相对融合仓库） | 固定提交 | 使用方式 |
|---|---|---|---|
| Codeg | `../source-reference/codeg` | `aff1e6c278453ed8d0b96a5f664edcdca621aa3f` | 独立 detached 工作树，源码参考，Apache-2.0 |
| Rovai AI | `../source-reference/rovai-ai` | `cc465dda562536b94f23787759e3206324baa29e` | 独立 detached 工作树，源码参考，MIT |
| 融合工程 | 当前仓库 | 以当前任务分支为准 | 实际开发与测试 |

三处均已按客户本次直接授权建立 CodeGraph 索引，并通过实际组件查询验证。没有修改源仓库较新的 HEAD，没有更改 `sources.lock.json`，也没有更改全局 MCP 配置。索引只存本地，不提交数据库。后续一批源码修改结束后同步融合索引；参考源只有在明确升级锁定版本时才更换。

## 原组件到融合组件

| 原 Codeg 文件或组件 | 原设计承担的职责 | 融合实现 |
|---|---|---|
| `canvas-page.tsx` 的 `CanvasPageTitle` / `BoardTitleMenu` | 细标题栏、画板标题菜单、返回列表 | `CanvasWorkspace.tsx` 的面包屑、画板菜单与画布列表；沿用原有离开事务，切换前保留输入保护 |
| `canvas-board-list.tsx` 的 `CanvasBoardList` / `BoardCard`、`canvas-board-preview.tsx` | 空列表引导、画布选择/搜索、真实轮廓/数量、编辑时间及独立菜单 | `CanvasWorkspace.tsx`、`CanvasBoardPreview.tsx` 已接同事务 Core `summaries`，保留最大200轮廓但节点计数完整；旧服务缺字段明确不可用。16:10预览、12px卡片、紧凑文案、独立打开/编辑/删除菜单，列表单独承担必要滚动。当前源码/局部逻辑检查不代证Rust编译、真实Core与日夜列表视觉 |
| `canvas-board-dialogs.tsx` / `canvas-swatches.tsx` | 单标题创建表单、名称/描述/颜色、再次选色清空 | `CanvasBoardDialog.tsx`，继续使用 Core 并发版本、未知结果回查与忙碌锁；保留所有十二种合法颜色及无色值 |
| `canvas-dock.tsx` 的 `CanvasDock` | 底部悬浮图标操作，选择后出现相应动作 | `CanvasSurface.tsx`，添加入口接原有八类节点；排列、分组、删除、刷新均保留原处理函数和确认保护 |
| `canvas-dock.tsx` 的 `CanvasViewportPanel` | 右下角小地图与水平缩放胶囊，实时比例、100%恢复、尺寸同步 | `CanvasDock.tsx`，复用原有按 Host/Core 隔离的视口和地图偏好；缩放不启动任何模型 |
| `nodes/card-frame.tsx` | 16px 卡片圆角、36px 单标题栏、紧凑图标操作 | `canvas.css`、`CanvasSurface.tsx`、`CanvasConversationFrame.tsx`；保留实时文件、终端和对话组件 |
| `theme-presets.ts` 的 `THEME_COLOR_PREVIEW` | 稳定身份色，与成功/错误等状态色分开 | `packages/ui/src/theme.css` 中画布专用色板，十二个颜色值按原源码保留 |
| 原应用使用的 `lucide-react` | 工具与窗口操作图标 | 同版本 `0.564.0`，精确锁定依赖并保留许可证；没有顺带升级其他依赖 |

以上 Codeg 文件均位于固定参考源码的 `src/components/canvas/` 下，色板位于 `src/lib/theme-presets.ts`。相关 Apache-2.0 许可证已保留在 `integration/licenses/codeg/`。

## Rovai 继续承担的真实业务

Rovai 原 `ThreadWorkspace`、`SingleChatPanel`、`FilePreviewProvider` 的职责仍在原组件中。画布里的队员来自真实队员列表，不伪造 Codeg 的品牌代理列表；公开/私有输入、每卡材料隔离、恢复副本、文件权限、停止和排队等能力继续经过原业务链路。Core 仍是唯一数据和执行权威，不能接入供体自己的 Tauri 数据库或 ACP 连接管理来形成第二套执行系统。

展开会话继续遵循 Codeg `nodes/card-frame.tsx:98–110` 的单标题拖动栏和贴合正文：行内模式复用真实节点的36px标题栏及操作，侧边模式保留独立标题；工作区组件不因模式切换改换挂载位置。按原框架 `:13–18,64`，卡片正文必须恢复文字选择及普通光标，标题栏保留整栏拖动和禁止选中文字；便笺静态整纸拖动与编辑态另按原组件处理。Rovai 原文件预览在紧凑布局中以 `.timeline-pane` 控制正文替换，绑定私聊也须使用该原布局职责，避免私聊浮层盖住文件。原 `SingleChatPanel` 的目标对象用于打开会话的 effect 依赖，画布传入的目标须按会话/队员身份稳定，不能因本地展示渲染反复重开。

Mission、Task、Diff、文件工作区仍进入原对象。此前真实 C02 检查发现的 `missions.delivery` 输出字段修复属于独立兼容缺陷，不通过放宽客户端归属校验来掩盖。

## 各类卡片的源码对照（2026-10-16）

| 融合卡片 | 固定 Codeg 对应位置 | 本批采用的外观与保留行为 |
|---|---|---|
| 公开/私有会话摘要、区域内派生会话 | `nodes/conversation-card-node.tsx:82–205` | 同一224×132紧凑结构，12px圆角、14px信息行、13px四行标题、11px底部工程信息；有色卡片8%淡底。公开/私有标识使用真实引用，工程名称只来自Core已授权目录关系。展开、编辑、固定或移出仍用现有处理函数，按钮保留可访问名称及键盘入口 |
| 展开的实时会话 | `nodes/conversation-detail-node.tsx:81–133`、`nodes/card-frame.tsx:24–113` | 16px圆角、36px单标题、24px图标按钮及与正文贴合的框架；保留原Rovai真实输入、运行、附件与恢复，不引入第二套会话连接 |
| 文件卡片 | `nodes/file-node.tsx:153–236`、`nodes/card-frame.tsx` | 单标题、文件类型图标、按需预览/源码/刷新/工作区操作；正文占满余下空间。沿用原已授权读取与HTML CSP，本批不更改文件权限 |
| 终端卡片 | `nodes/terminal-node.tsx:56–129`、`nodes/card-frame.tsx` | 同一单标题框架和终端图标；路径与原版一样通过标题悬停展示。控制栏改为24px图标，启动/停止/回读、复制粘贴、快捷键和输入确认均保留；rc14真实260px宽度六操作可见，可信输入计算、绘制结果和停止回收已通过，其他窗口/平台继续按既定清单核对 |
| 文件夹、项目分组、队员、自定义区域 | `nodes/region-node.tsx:115–248` | 四种绑定共用16px半透明区域；40px标题带、实际已载入成员数量、折叠后胶囊、未完成关系虚线及真实空状态；保持所有分组、展开、拖动、绑定和归属规则 |
| 便笺 | `nodes/note-node.tsx:30–155` | 12px纸张边框、13px正文、8%淡底，最小140×96；整纸拖动、双击及键盘行内编辑，失焦/Escape保存。可选标题和安全Markdown保留，标题/颜色编辑移至选中工具条。Core冲突保留原文与独立本机副本；rc14真实拖动/编辑/冲突/离开保护及renderer硬中断后副本恢复已通过。SafeMarkdown文档15px覆盖已用便笺局部13px/1.625规则修正，未改普通文档，待下一冻结候选实际核对；物理IME与完整主题视觉仍待 |
| Mission、Task、累计Diff对象 | Codeg `nodes/card-frame.tsx`；Rovai `MissionBoard.tsx`、`MissionControls.tsx` | 外框只沿用Codeg框架，使命/任务/变更图标区分原对象；真实详情和状态继续来自Rovai原组件，不能将对象伪装成普通对话摘要或生成假进度 |

原Codeg摘要的元信息按 `conversation-card-node.tsx:114–200` 与 `conversation-status-dot.tsx` 继续适配。R09新增代码从实际 active 成员和原 AgentProfile 读取明确选择的模型，标注“配置”以区别原生会话的实际观测；私聊只读精确队员，不把 Default Lead 配置套给所有卡片。默认模型没有实际ID时保持空，不生成推测名。分支来自原 `workspaces.worktrees` 的精确 checkout，复用四并发目录读取；旧字段、失败、缺失、游离HEAD不猜分支。新增Core只读活动投影区分公开Run与精确私聊Run，沿现有目录失效合并刷新；旧Host缺字段保持未知，目录未完整不显示活动点。沿用14px元信息行、6px状态点、四行标题和左右紧凑页脚；运行颜色沿Rovai `conversation-run-presence.css:16` 的 `--info`，尊重减少动画偏好。

随后已补最近运行模型的源码：复用Rovai `read_model/message_model.rs` 的原投影，直接来自精确公开/私聊Run的冻结选择或默认模型实际观测，优先于当前配置，分别标注“最近”和“配置”；最新默认Run缺观测不回退更早模型。模型与分支沿原Codeg使用等宽元信息。源码、原文SQL和局部检查已有结果，新增Core与实际UI尚未集中编译/运行；八类完整状态和视觉对照仍由 [I03-R09](../execution/i03-closeout-remaining.md) 跟踪。原 `child_count` 对应Codeg原生父子Conversation，来源功能簇C08“跨智能体异步委派”按既定I04实施；当前独立私聊不是其子会话，不能用 privateConversations.length 填徽章。I04必须完成真实委派身份/数量接线与画布回归，完整一期范围保留；不能把当前缺少子会话来源写成已移植。摘要操作继续保留紧凑图标；实际布局、四行长标题、悬停/键盘、色板、选中/镜像/拖入、不同缩放与日/夜主题须在下一批真实运行中核对，源码和局部测试不覆盖视觉结论。

当前真实证据沿 `integration/execution/i03-c06-source-card-group-verification.json`、`i03-c05-notes-mirrors-native-verification.json`、`i03-c05-renderer-crash-native-verification.json` 分别记录，不用旧截图覆盖后续源码。renderer故障只验证显式重载后选择画布的恢复，不等于整个App/Core硬中断、自动恢复入口或在途未知请求已通过。

## 本批完成标准

2026-10-17：节点编辑色板复用 Codeg `src/components/canvas/canvas-swatches.tsx:92–115` 的十二色、六列、24px 命中区和再次选择清空行为，与已移植的画板色板共用样式。原生选择框改为原版色点，仍保留字段禁用、可访问名称和选中状态；未改 Core 命令。实际日夜、键盘、清空及小窗口观察归下一集中候选，不以源码检查代替。

列表右键菜单沿用 Codeg `canvas-board-list.tsx:393–408` 的打开/编辑/删除；定位与 Escape 回焦复用 Rovai
`ImageContextMenu.tsx:36–50` 的视口锚点。右键、菜单键/Shift+F10 与省略号入口共用原处理函数，未增加执行通道。
删除提示对照 Codeg `canvas-board-dialogs.tsx:235–258`，显示同画板/版本的节点数和终端卡数，明确只关闭仍在运行的终端；
统计缺失或失配不显示伪造零值，原冻结版本、冲突阻断和忙碌保护继续保留。rc15 已实际通过真实 Core 数量/轮廓、原生右键/Shift+F10、Escape 回焦、同版本删除提示及取消、独立省略号编辑，共7个场景；菜单键与旧服务提示保留后续检查，不用已过场景替代。

列表对照 `canvas-board-list.tsx:336–357` 与 `canvas-board-preview.tsx:108–139`，文字采用自然流紧凑排布。
纵向轮廓的 SVG 固有高度不能决定卡片行高：当前轮廓绝对贴合既有16:10框，空画板图标仍在框内居中，
网格保持原等高行、描述最多两行和可到达末尾的单一列表滚动。rc15截图发现此问题，后续当前CSS已在日夜实际组件复现/修复验证，
完整App集成待下一累计候选。精确证据分别见 `integration/execution/i03-c06-rc15-list-native-verification.json` 与
`integration/execution/i03-c06-board-compact-renderer-verification.json`，不将旧候选结果归给后改CSS。

1. 先完成组件与调用链核对、界面代码、自审、类型及相关低成本检查。
2. 与已完成的私聊附件 UI 和 Mission 输出修复一起冻结候选，集中编译并运行已有真实 Native 检查，不为每个按钮分别构建或触发 Actions。
3. 使用真实应用截图，按同一画布场景核对主页、创建弹窗、空画布、会话与文件卡片；记录参考图尺寸、实际视口和缩放，不能把不同 DPI 的截图直接当作差异。
4. 实际验证八类创建入口、菜单键盘操作、排列/分组/删除、小地图与缩放、原工作区跳转及每卡附件预览。此前已通过的结果不自动覆盖新界面。
5. 类型检查和源码移植均不等于视觉验证通过。未取得新的运行截图前，本批界面保持工程验证待补，不交给客户做阶段技术测试。

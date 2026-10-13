# 无 Mac、移动真机时的推进顺序

客户已明确先做其他部分。设备实测保持待补，后续收到指定ADB再接入；不因此删减一期范围。原v4是终点和工期基准，本文只安排当前可实施的顺序，不宣布设备到位日期或改变验收结果。

## 当前 I01

- 两款固定源的Windows Web与原生Server基线已构建并运行健康检查。
- Rovai真实Host协议12项和迁移基础9项通过。迁移基础使用归一化测试记录，通过现有Core命令创建对话、复查回执、停机恢复；还不是读取实际Codeg旧库并导入全部历史消息的产品功能。
- Windows关闭策略61项单元检查及3项真实Electron夹具通过。三个夹具验证生产Main/preload/UI的关闭、托盘和桥接，均未启动Core；不能作为完整融合界面验收。
- Mac/移动编译已转GitHub，六项固定源码编译/产物均通过；Rovai双Mac各2个真实Electron夹具，iOS与Android模拟器首屏通过，Android176单测/lint通过。Codeg Intel任务超过90分钟后cancelled，不能把所有CI写成绿；后续时间余量已调整，完整事实见cross-platform-result.json。移动真机与真实硬件交互仍待补。Linux按单独构建环境推进，不能用编译替代设备测试。

## 下一批可实施的源码切片

| 顺序 | 所属阶段 | 具体入口与改动边界 | 验证检查点 |
|---|---|---|---|
| 1 | I02-T01 工作台导航 | Rovai `BusinessApp.tsx`、`desktop-navigation.ts`、`NavigationShell.tsx`和共享`RestorableLocation`拥有页面切换与离开保护；参考Codeg `src/components/layout/sidebar.tsx`和`workbench/workbench-content.tsx`的工程/会话入口行为 | 前进后退、重新打开、未发送草稿、迟到读取均不能切到错误工程或丢内容；工程路径用Core规范值 |
| 2 | I02-T02、I02-T03 队员与能力配置 | Rovai `MemberSidebar.tsx`、`CapabilityWorkspace.tsx`及现有成员/技能/MCP Host操作；Codeg `src/lib/resolve-default-agent.ts`、`src/hooks/use-agent-skills.ts`提供行为参考 | Runtime默认偏好不冒充队员身份；配置重新打开一致；真实Runtime执行另行记录，I02最终验收仍要求一次真实运行 |
| 3 | I03 画板数据与事件 | Codeg `src-tauri/src/db/entities/canvas_board.rs`、`canvas_node.rs`及现有服务语义进入Core既有迁移体系；`canvas-boards-store.ts`、`canvas-store.ts`改接Host失效通知和授权读取 | 重复写入、并发冲突、删除后迟到响应、换Host残留、重连重取；不保留第二业务数据库 |
| 4 | I03 画布交互与节点 | Codeg `src/components/canvas/canvas-view.tsx`、`canvas-model.ts`、`nodes/*`保留React Flow、缩放、框选、便签、文件、终端及会话行为；替换Next路由、Tauri/API、旧整数引用和主题连接 | 八种源节点全部保留；拖拽/缩放/重开几何一致；公共Thread只使用Core身份；关闭节点不取消任务 |
| 5 | I05 工程面板 | 文件树、编辑、PTY、Diff与Git按原工作包移植，保留Mission固定base与真实工程路径 | 暂存区与HEAD校验、外部文件变化、冲突恢复、终端回收、Worktree隔离 |

表中路径除标明Codeg者外均位于当前Rovai骨架；详细固定来源和版本见sources.lock.json。切片2至5仍服从原工作包依赖，不能因为设备暂挂就跳过I04协作执行、记忆和自动化，也不能把未接线按钮作为完成。

## 开始产品源码改动前

以Rovai既有视觉系统和Core权威为基线。Codeg Next/Tauri入口转换为共享React页面及受控Host调用，保留源行为，避免复制整个Codeg运行引擎。
画布新增DTO、持久化与Host准入操作需要先完成所属阶段的当前合同/迁移设计；不能在Renderer临时存一套业务事实。I01的夹具只存在于隔离验收目录。
I01草稿保留供客户验收；阶段范围、设备待验收和当前证据分别登记。后续阶段按已确定的分支及PR流程推进。

跨平台CI执行规则与结果分层见[云端验证计划](cross-platform-ci.md)。

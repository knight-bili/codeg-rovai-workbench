# I02-T01 工程首页切片

本切片将Codeg工程工作台入口行为接入Rovai既有导航。使用Project菜单“进入工程”，保留原项目行展开/折叠和目录偏好行为；首页显示该工程名、规范路径和最近对话，继续使用既有创建/打开Thread操作。

页面历史的quick_chat增加可选客户端projectPath，公共Core RestorableLocation保持原合同。进入工程先调用现有workspaces.inspect，在共享离开保护成功且导航意图仍最新时提交规范路径。取消或迟到结果不改变当前工程；已移除的历史目录回退，损坏相对路径偏好被拒绝。未增加数据库、业务身份或Runtime。

新增两项回归先失败，再与既有导航用例一起通过。最终导航、工程偏好及语言覆盖41项通过，类型检查通过。原生Electron组件夹具验证菜单键盘进入、工程内对话过滤、Back/Forward及两主题，并保留既有导航回归；它不启动Core或Runtime，不代表完整业务验收。

Windows隐藏窗口首次在旧的菜单淡入断言处失败；未改断言或产品CSS。原始基线夹具在本机另一次执行中推进到折叠场景后100秒超时，不能写成同一断言稳定复现。为测试窗口采用Electron支持的[离屏渲染](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering)，完整组件夹具通过，失败、跳过均0；不涉及生产窗口设置。

双主题截图已人工核查，使用夹具目录与投影数据；无实际AI执行。41单元、组件截图与构建不能直接把324个融合验收场景标记通过。

生产Web与真实Windows Rovai Host的14项检查已通过，见[i02-navigation-live-result.json](i02-navigation-live-result.json)。使用I01已核实的原生Core二进制、当前编译Web和全新私有数据根；没有Desktop桥接mock或Runtime。通过真实Core API创建两个工程各一条活跃Thread，验证工程内对话、前后退、刷新、目录缺失保留原页面/历史、恢复重试及浏览器进程重新打开。仅延迟真实Core返回的A响应，在较新的B请求完成、旧A响应交付完成后断言B仍有效；不替换Core结果。

真实回归发现“目录恢复后进入成功但旧错误残留”，在工程进入动作开始清除旧错误，原失败断言随后通过。浏览器验收工具改为正常退出后重开，避免强制终止导致刚保存的偏好尚未落盘；重开后还等待真实对话投影加载，截图不取启动中间态。数据库完整性为ok，agent_run为0；当前类型检查、Web构建及37项定向回归通过。截图已人工核查，完整原始证据保留工作区，提交记录只含哈希、检查结果和限制，不提交凭据、数据库或浏览器配置。

继续验证时通过当前thread.messages.send提交八条受控用户消息，execution为null；相同commandId再次提交回放原记录，没有重复消息。生产Thread页读取八条消息，这些execution:null阅读记录没有Principal投递；此前截图的待处理提示是Renderer错误推导，已纠正，不能作为等待投递或真实AI证据。

同一浏览器两标签的实际测试复现了未发送文字串读：标签B读取到标签A的I02_TAB_A_UNSENT。Web公共Thread正文原来仍读写origin共享localStorage，现在接入既有Host/Owner/editor作用域的editingRecovery；正文加载、Active及Pending保存、发送回执替换、删除/丢弃均使用同一个存储适配。Desktop仍使用原本机存储，没有新增Core表或公共API。双标签分别输入并刷新后保留私有文字，原失败断言通过；该批5个测试文件33项回归、类型检查、Web/ExecutionWeb/Electron代码构建通过。

2026-10-14补齐旧无身份Web记录的显式恢复，见[i02-legacy-draft-result.json](i02-legacy-draft-result.json)。复用实际修复前的隔离Core/浏览器数据及原origin，在当前生产Web验证：不自动复制、新输入不覆盖、用户选择后复制到当前编辑存储、原始字节保持、刷新后正文恢复。旧附件移除sourcePath并标unknown，需要重新选择；回复和成员继续走既有加载校验。单测验证异Thread、非空当前草稿及配额失败均不改原记录。最新5文件29项回归、类型检查、Web/ExecutionWeb/Electron代码构建通过。

截图自审发现原刷新等待可能在新页面提交前命中旧DOM，第一轮中间态截图不作为证据。浏览器驱动现在等待主框架的不同loader提交和页面加载，业务检查还等待登录恢复完成；原真实Host与旧草稿恢复检查重新通过，最终截图已核查。

随后真实复现了完整浏览器退出后私有文字缺恢复入口。公共Thread正文现在使用按Host origin/验证Owner/编辑身份分开的本机JSON快照；同身份标签内旧正文迁移一次，清空后的空快照阻止旧标签记录复活。只保存公共正文DTO，不持久化Session凭据、编辑证明、Single Chat编辑或待发命令。当前身份仅自动读取自己的快照；新身份由用户打开恢复选择器，按保存时间和内容预览选择一份，原副本保持、不合并，旧draftId与附件原路径不借用。

真实关闭全部浏览器进程、以原隔离profile重开后，两份不同未发送文字分别存在；明确选择A只恢复A。实际浏览器容量边界满额后输入保留、全部已保存快照字节保持；释放测试占用、继续输入后保存成功，再刷新恢复。相同快照不重复更新保存时间。最终17项真实Host检查、旧版本实际数据5项检查、6文件33项回归、类型检查与Web/ExecutionWeb/Electron代码构建通过。不同Host/Owner、嵌套Owner前缀、旧标签迁移、清空不复活、非公共恢复材料不进入快照、损坏及quota由单元覆盖。断电/进程崩溃、真实旧附件和全平台尚未验证；未声称完整恢复资格或324融合验收完成。

复跑使用tools/integration/smoke-workbench-live.mjs，设置绝对路径ROVAI_HOST_BIN、ROVAI_WEB_UI、WORKBENCH_EVIDENCE_ROOT、WORKBENCH_BROWSER_BIN；只支持本次新建隔离数据根。Windows由Host原生prepare命令建立私有根，明确独立skill library和MCP路径。浏览器应使用支持当前CDP的Chrome/Chromium，无真实AI运行。

I02-T01仍进行中，桌面进程/Host进程重开及实际AI执行未验证，324融合场景仍not_run。后续补齐项目启动器、会话地图、通知及首次使用差异，再推进成员/Provider、Skills/MCP；原生Mac脚本已移除旧SQL草稿及未公开Pending夹具，按当前客户端快照和阅读记录无撤回改写；完整双Mac夹具由专用GitHub工作流运行，结果尚待核实。研发问题记入development-todos.json，不转为客户资源阻塞。缺少的客户资源见customer-todos.json，不阻塞独立开发。

2026-10-14继续整改：真实生产Web与锁定Windows Host完整19项检查通过。新增检查核实execution:null记录没有投递/Turn/Run，不显示待处理或撤回；Core返回message.withdraw_too_late后消息、当前输入与全部草稿快照保持原值。源码构建、类型与文档治理通过；等待投递撤回成功和真实Runtime尚未运行。见[i02-native-fixture-repair-result.json](i02-native-fixture-repair-result.json)、[21种Runtime盘点](i02-runtime-inventory-result.json)与[移植顺序](i02-runtime-port.md)。Core当前18种AdapterKind，Gemini/Hermes/OpenClaw三种源码差异进入I02-T02，完整范围不删减。

# Codeg 与 Rovai 一期完整融合

I00已自审修正并合入，I01基础构建与契约证据保留草稿；I02继续补齐，按已确认r1补齐实际输入并推进独立I03画布基础，完整一期终点不变。Rovai Core唯一业务与执行权威，Codeg与双原生移动按模块移植；第二阶段才开发自主新增能力。

- [完整计划](planning/plan-v4.md)、[日历基准](planning/schedule.json)、[源码锁定](sources.lock.json)。
- [功能账本](planning/features.json)、[研发工作包](planning/work-packages.json)、[验收场景](acceptance/cases.json)。
- [候选入口库存](inventory/source-entrypoints.json)、[开发规则](development.md)、[I00验收单](acceptance/i00.md)。
- [资源与风险](resources.md)、[许可证保留](licenses/README.md)。
- [免费优先 CI 安排](ci-cost-policy.md)：公开前审查、标准运行机、按里程碑启动全平台验证及产物保留边界。

源Rovai当前版本指针只代表源骨架状态，不证明融合完成。根文档和品牌保留，后续设计阶段再处理。

- [I01执行入口](foundation/README.md)。
- [持续执行状态](execution/goal-state.json)、[需要客户补齐的待办](execution/customer-todos.json)。客户已授权沿I00至I12自动推进，阶段分支持续开发，main仍由客户验收控制。
- [I03收口排期](execution/i03-closeout-plan-r1.md)、[有限剩余清单](execution/i03-closeout-remaining.md)：由Codex完成研发与工程验证，明确每组完成条件，客户软件使用验收仍在I12之后。
- [I03实际完整输入页面核定](execution/i03-r01-native-complete-input-verification.json)：保留当批卡片往返、排队、删除后恢复及迟到上传证据。此为历史批次，后续资格与当前剩余项统一以[有限剩余清单](execution/i03-closeout-remaining.md)及[实时账本](execution/i03-closeout-ledger.json)为准，不能把历史待补数量当成当前状态。
- [I03真实Windows终端输入核定](execution/i03-r07-native-input-verification.json)：系统拼音、剪贴板、原生复制、折叠重开及受控读取错误恢复整批通过；原Core容量/重连按未变源码复用，完整I03与其他平台仍以实时账本为准。
- [I02技能包配置证据](execution/i02-skill-members-result.json)：目录、安装/更新卸载与队员配置已验；[实际模型投递r1](../docs/versions/v1.72/model-context-change-skill-pack-member-delivery.md)已获客户明确确认，[本地实际输入及恢复](execution/i02-skill-delivery-context-result.json)已接通并验证，逐SP矩阵和真实Gate仍继续。Office及其他一期功能继续实施。
- [I03画布架构](../docs/architecture/canvas.md)：多画板Core元数据及八类节点图已实现；[固定版本节点源码清单](execution/i03-node-source-audit-result.json)与[节点持久化/真实升级验证](execution/i03-canvas-nodes-result.json)可查。交互UI、实时业务绑定、布局、客户端视口和真实临时PTY继续实施，均保留在一期，不能把Core基础当整个I03完成。
- [I02恢复兼容矩阵增补](execution/i02-skill-delivery-matrix-result.json)：数据库边界的执行轮次、旧公开29/33与旧A2A冻结输入补测已通过；[数据库修复](execution/i02-db153-regression-repair-result.json)的 Windows109项与Linux110项全部通过，原失败保留。[进程恢复](execution/i02-skill-process-recovery-result.json)已验真实Core重启保留冻结输入并终结未知结果、禁止重发；明确确认分支、其余逐SP与真实模型Gate继续补齐。

- [I03项目分组排列检查点](execution/i03-project-layout-result.json)：侧栏/画布统一入口、组与工程混合拖放、键盘排列及冲突/未知结果保护已编码；37项相关检查与4项静态导航检查通过，实际交互和当前Host资格仍待阶段候选。

- [I03工作树层级与分组菜单检查点](execution/i03-project-tree-result.json)：真实Git父子/分支展示、置顶去重、显式打开登记和统一分组菜单已编码；42项相关测试与5项静态导航检查通过，新Rust及实际Host/UI仍待阶段候选，活动统计继续实施。

- [I03完整导航活动统计检查点](execution/i03-navigation-activity-result.json)：Core按普通导航Thread完整聚合、窗口外组定位及工程/分组三态徽章已编码；78项相关检查、6项静态导航与7项SQL原文夹具通过，新Rust/真实Host/挂载UI继续按阶段候选补验，不据此标I03完成。

- [I03区域成员拖放检查点](execution/i03-canvas-member-drag-result.json)：派生成员节点、跨源原子分组、精确引用和旧服务保护已编码；52项相关检查及定向类型/文档/格式通过，新增Rust与真实Host/UI仍待阶段候选，原地展开和Composer继续实施。

- [I03画布原地与侧边会话检查点](execution/i03-canvas-conversation-result.json)：复用既有会话/输入/执行控制，补精确私有绑定和离开保护；40项组件及4项离开退出检查通过，定向类型/文案/文档通过，真实UI/Runtime及多卡、重开恢复、通知继续，不作为I03完成依据。

- [I03会话读写归属检查点](execution/i03-thread-scope-result.json)：既有页面改用固定Core client/Thread的共享读写层；13声明保持原文、10旧导出兼容，216项定向检查与类型/文案/文档通过。多卡实例、共享草稿和展开恢复仍继续，实际UI/Runtime待阶段候选。

- [I03私有共享草稿检查点](execution/i03-single-chat-shared-result.json)：既有面板接共享正文、发送互斥、保存失败恢复与保留输入切换，原send和pending edit请求表达式保持；41项相关检查及类型/文案/文档通过。公开草稿镜像和多卡挂载仍继续，真实UI/Runtime未验。

- [I03每卡独立草稿与恢复检查点](execution/i03-canvas-composer-context-result.json)：固定Codeg源码确认每卡输入独立，纠正此前共享草稿计划；已接主会话隔离、Pending输入并集、Web公开归档与精确副本、Native私有正文存储。251项相关检查及类型/文案/文档通过；当前仍单聚焦，多卡同时挂载及私有附件/引用隔离继续，真实UI/Runtime未验。

- [I03按Thread读取与刷新检查点](execution/i03-thread-projection-result.json)：现有页面的只读打开、刷新、缓存和历史分页已用client/Thread owner；刷新尾读、过期页、删除/重启代次、挂载租约和旧错误保护已接。215项相关检查及类型/文案/文档通过，enter参数与原发送/编辑器源码保持；实际多卡UI、事件分发和各卡文件预览继续。

- [I03实际多卡会话检查点](execution/i03-canvas-multi-result.json)：多卡及镜像、独立输入、稳定原地/侧边实例、每Thread事件读取与窗口预览并集已接。296项相关检查与类型/文案/文档通过；浏览器实际挂载三张生产卡片、模拟Core/文件，验证独立草稿、撤销、局部查找、关闭重开及预览归属/缩放。通知、持久展开恢复、私有附件隔离和真实Core/Runtime/完整应用验证继续，不作为I03完成依据。


- [I03多卡通知可见确认检查点](execution/i03-canvas-notification-result.json)：实际卡片来源并集、裁剪/遮挡观察、每Thread确认/独立重试和client围栏已接；245项检查、类型/文案/文档及浏览器9项检查通过。现有隔离Electron通知检查1通过1失败，设置焦点问题在旧Controller对照同样复现并登记研发整改；真实Core通知、公私来源/Host与规模待验。

- [I03展开保存与只读恢复检查点](execution/i03-canvas-recovery-result.json)：精确Host/Owner/Core/Board记录、切页切板保留、显式收起、恢复/停止/重试与saved-input恢复已接；230相关检查及类型/文案/文档通过。真实CanvasWorkspace/Surface/ReactFlow模拟Core完成12步检查，另发现并修复展开白屏；只读运输没有enter/启动Runtime。原编辑器/undo的原子离开、Native完整/异常进程恢复、私有附件隔离及真实平台仍待补齐。

- [I03原编辑器离开事务检查点](execution/i03-canvas-atomic-leave-result.json)：导航失败/拒绝/失效、等待取消与Renderer后续退出检查失败保留同一编辑器和撤销；画板拒绝/未知结果保留实例、核对成功才交接。247相关检查、类型/文案/文档及生产画布mock浏览器验证通过，并修复删除后自动选板循环；Native退出/异常进程/Host与私有附件隔离继续。

- [I03卡片使命交付与累计Diff检查点](execution/i03-canvas-mission-result.json)：复用原Mission说明/启动/交付/活动/累计Diff，核对Thread/Mission标识、来源回原卡片及镜像控件隔离；修复选中节点遮挡真实会话控件。228相关检查与类型/文案/文档、mock前端交互通过；独立持久对象引用、完整私有导航和真实使命运行/平台验收继续。

- [I03私聊卡片材料隔离r1](proposals/canvas-private-materials-r1.md)：16页客户确认版已逐页自审且获明确确认，[证据](execution/i03-private-materials-proposal-result.json)绑定批准文件摘要。继续Core归属、完整输入保留和未知结果恢复；24项验证要求仍待执行，不计作功能通过。

- [I03私聊草稿归属基础](execution/i03-private-scope-foundation-result.json)：r1已确认；闭合codec、旧省略/显式null区分与精确活跃私聊pin校验已编写，原文SQL25项见证/格式/文档通过；Rust两owner未编译执行，生产新接口及新存储尚未接通，不计作完整隔离功能通过。

- [I03私聊草稿与保留输入存储](execution/i03-private-scope-storage-result.json)：已确认r1追加Schema155/Migration205，保留旧默认原值，补材料/引用/资源及编辑范围限制、orphan保留和删除清理。22项本地Rust定向及相关回归通过，旧回执/准入负例保留；新卡片材料接口/完整恢复和平台Runtime资格继续，不判I03完成。

- [I03私聊材料业务服务与按卡片发送](execution/i03-private-composer-service-result.json)：已确认r1的Core七动作、精确读取、分页恢复及按scope消费接原FIFO，17项本地定向检查通过；整份交换/回执回滚和100001字正文保留已验证。运输/客户端、上传准备、编辑接管/完整移回及最终Blob/真实Runtime继续，不计完整24PC或324产品场景通过。

- [I03私聊材料应用入口与客户端能力核对](execution/i03-private-composer-api-result.json)：统一get/mutate/recovery、可信编辑端注入和原UUID只读回查已接两端准入；快照隔离其他位置的令牌和未保存材料。17项Core、29项模拟客户端及定向类型/文档通过；current准入180，历史161保持。UI未启用，上传/编辑/本机意图及实际Host/Native/模型继续待验。

- [I03私聊排队接管与完整移回](execution/i03-private-pending-edit-result.json)：Core 单租约按 client/scope 接管并拒绝旧令牌；空目标迁入、占用目标完整 retained，与 Pending 取消和回执同事务。17项Core及56项既存/模拟客户端检查通过。该检查点之后继续 Renderer 接线；最新进展见下一条，上传/授权和正式24PC/324继续。

- [I03私聊完整输入界面与原请求恢复](execution/i03-private-input-ui-result.json)：生产面板已接完整移回、整份保留交换、排队保存/放弃/接管和本机原请求恢复。76项定向检查及模拟Core三位置挂载通过，包括原连接永久等待后查回结果解除按钮等待；卡片上传/资源授权、迁入/孤立恢复与真实Host/平台/模型仍待，完整24PC/324未验。

- [I03私有文件资源定位](execution/i03-private-resource-result.json)：卡片、排队工作副本与retained按可信编辑端/原对话/位置/材料定位，旧默认JSON保持；Main双入口与缓存保留位置，接管后旧token拒绝、孤立输入保留可读。17项Core、65项客户端及定向types/文档通过；上传/源摘要、实际Host文件链路与新预览UI、完整PC15/324仍待。

2026-10-16分工澄清：[目标描述](execution/goal-description.txt)与[阶段验证规则](ci-cost-policy.md#工程验证与最终用户验收)规定I00–I12由Codex研发和工程验证，客户只审方案/协助环境，I12工程完成后才进行真实软件使用验收；[I03固定收口清单](execution/i03-closeout.json)不设客户阶段门槛。

- [I03上传准备生命周期与旧租约入口](execution/i03-private-upload-lifecycle-result.json)：原意图重试/明确结束/同卡片旧Pending-token恢复已编码，71项客户端检查、定向类型与2项文案检查通过；新Rust和实际HTTP/Native/挂载待阶段集中验证。用户不承担阶段技术验收。

- [I03默认迁入与原位置恢复界面](execution/i03-private-recovery-ui-result.json)：61项定向检查与类型/文案通过，模拟Core的生产组件完成9步交互，包含孤立原位置编辑与未知提交关闭保护。C01登记阶段工程待验，继续独立Mission/Task/Diff引用；实际Host/资源/24PC尚未通过。

- [I03独立对象引用存储](execution/i03-object-reference-storage-result.json)：源码Schema157/Migration207仅追加引用元数据，原对象归属/身份/失效保留已编码；46项原文SQL与19项客户端检查、types通过，新Rust/实际Host未验。独立卡片选择和工作区定位继续，C02未完成。

- [I03独立对象选择与详情](execution/i03-object-reference-ui-result.json)：Mission/历史Task/Diff原路径选择、按需原对象读取及既有工作区接线已编码；66项定向检查和类型通过，模拟Core界面检查通过。C02代码就绪待阶段工程验证，实际Core/Host/跳转未验；继续C03授权文件节点。

- [I03文件节点原来源基础](execution/i03-file-binding-result.json)：源码158/208追加原Thread身份与旧节点一次显式绑定；42项原文SQL、76项客户端/原Main检查及类型通过，1项Windows条件跳过。具体预览权限保持，选择/预览UI和生命周期继续，新增Rust/真实Host未运行，C03未完成。

- [I03文件节点选择与固定预览](execution/i03-file-preview-ui-result.json)：来源选择、旧节点绑定、原文件读者、变化/失效与收起/删除/重开已编码；108项定向检查及类型通过，1项原Windows条件跳过。隔离界面包含删除目标缺陷修复复测；C03代码就绪待阶段工程验证，继续C04临时PTY，实际Core/Host/完整App仍待。

- [I03临时终端移植基础](execution/i03-terminal-foundation-result.json)：闭合请求、原节点来源查询、进程代次和有界原始字节回放、PTY辅助进程源码已加入。纯状态源单独编译执行2项通过，11项原文SQL只读见证通过；helper/完整Core尚未编译，父端受管进程、API/Native/Web/UI和关闭接线继续，C04开发中。

- [I03终端父端与关闭接线](execution/i03-terminal-parent-result.json)：Core会话registry、受管helper、原输入顺序/回执、删除和计划退出已编码；状态源2项复验通过，Core语法与模块格式通过。新增manager/codec、实际PTY/进程树尚未运行，Native/Web/API与终端读者继续，C04开发中，用户无需阶段技术验收。

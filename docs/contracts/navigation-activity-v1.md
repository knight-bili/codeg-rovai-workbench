---
document_type: protocol-contract
contract: navigation-activity-v1
authority: core-navigation-activity-metadata
status: accepted
version: 1
last_updated: 2026-10-15
---

# Navigation Activity v1

为Codeg工程/分组活动徽章补完整Core元数据，继续以Rovai Thread为计数单位。
不以[Navigation Read v1](navigation-read-v1.md)前N行的loading标记计算整组，不改变原有行读取、分页或排序。

## 接口与计数

Native及已认证Host的`navigation.activity`为独立有界读队列操作，参数为
`{groupKeys:string[],threadIds?:string[]}`，拒绝未知字段。groupKeys为1–200个唯一的`quick-chat`或
`directory:<绝对标识路径>`，路径语法与现有导航偏好一致：Unix、Windows盘符或UNC、最多8192个UTF-16单元、无NUL及`.`/`..`段。
历史路径不要求属于当前主机平台或仍存在，不赋予文件、Git、终端或执行权限。
可选threadIds为1–200个唯一非空标识，兼容既有Thread ID格式，不接受NUL。

无threadIds时返回每个请求组，空组也返回权威0。指定threadIds时在同一SQLite事务内按这些ID定位当前所属组，
仅统计与groupKeys相交的组；全部属于其他组时返回空groups。任何ID已物理删除而不能定位时，核对本次最多200个
请求组的统计，避免留下旧计数。删除受理但仍存在的Thread保留原组定位，实际统计不包括它。

响应为`{schemaVersion:1,throughGlobalSequence,groups:[{groupKey,activeThreadCount}]}`。
每组计数来自完整数据，不受导航窗口/置顶/折叠/最近活跃排序影响。一个Thread存在任意queued、running或waiting
Run即计1，不按Run或队员个数重复累计；同时支持Run显式camp_id及仅由camp_turn_id归属的既有私有执行形态，
显式camp_id优先，不借另一个camp_turn给其他Thread计数。

可见性直接复用现有导航VISIBLE条件：排除删除受理项、Mission承载Thread；active项可见，pending项仅在可信
DraftClient有presence、非空Composer/附件或prepared attachment时可见。其他客户端的pending材料不能使它可见。
仅传组键、计数与读取水位，不传Thread、队员、Conversation、消息、输入、凭据或Run标识。
活动SQL从活跃Run候选去重，不扫描事件历史；事务水位沿用现有current_global_sequence。读取不写业务或推进水位。

## 客户端与未知状态

侧栏每个实际挂载的Host/Owner拥有一个控制器，启动先订阅再读；组键/ID分批上限均为200，不逐Thread请求详情。
普通标记已读、改名及仅消息通知不额外读统计；运行与组变化按通知范围发起读取，窗口外Thread由Core在统计请求内定位。
全量恢复、20秒可见完整性刷新及重新聚焦可以核对当前登记范围。隐藏暂停自动读；通知ID积压或在途恢复超过200时，
合并为当前范围的元数据核对，不积累无界ID或扩大成全Thread内容读取。

通知只声明读取范围，不拥有计数。读取中再失效的旧结果不发布；Host/Owner切换销毁旧控制器，迟到响应不能回填。
请求/响应身份、重复组、计数/水位及完整组覆盖均校验，倒退水位拒绝；失败保留旧计数并标未核实，不能改为0。
尚无结果显示“…”；旧值待更新显示`~n`并说明是上次统计；只有核实为0才隐藏徽章。

主工程与分组按[真实工作树关系](workspace-worktrees-v1.md)合并当前可见登记工程，精确组键去重；置顶只改变显示位置，
不改变归属计数。关系不完整时不给出数字总数，未登记工作树只显示元数据且不进入导航统计。
空组没有成员时计0。`complete`说明覆盖与状态已核实，不表示所有组跨多个读取批次冻结在同一全局时刻；每组值拥有
自己的响应水位，跨批合计不提供全局原子快照承诺。旧Host缺此操作时保持未知，不回退为前缀loading合计。

## 验证边界

Core新增单个最小SQLite owner `read_model::navigation::tests::activity_counts_complete_visible_threads_once_and_resolves_external_window_owners`，
拥有去重、归属优先、pending编辑端隔离、Mission/删除排除、空组、ID定位/物理删除与只读边界；旧导航窗口/计量owner保持原职责。
阶段最小Rust命令为`cargo test -p rovai-core --lib --features extended-tests read_model::navigation`，当前切片尚未编译执行。
临时Node SQLite只运行Rust原文SQL和fixture，不能替代Rust或真实Host结果。

`navigation-activity-controller.test.ts`拥有批量/迟到/重试/作用域/积压及未知值，Web既有adapter owner补正反传递；
App静态owner补徽章三态。真实Host认证与参数检查已加到既有smoke，实际Native/Web挂载、跨Owner/重连、
多批水位变化、后台通知压力和平台资格集中在I03候选验证，不用这些局部证据宣称整个I03完成。

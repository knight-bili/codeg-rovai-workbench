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
- [I02技能包配置证据](execution/i02-skill-members-result.json)：目录、安装/更新卸载与队员配置已验；[实际模型投递r1](../docs/versions/v1.72/model-context-change-skill-pack-member-delivery.md)已获客户明确确认，[本地实际输入及恢复](execution/i02-skill-delivery-context-result.json)已接通并验证，逐SP矩阵和真实Gate仍继续。Office及其他一期功能继续实施。
- [I03画布架构](../docs/architecture/canvas.md)：多画板Core元数据已实现；[固定版本节点源码清单](execution/i03-node-source-audit-result.json)已核对，八类节点、业务绑定、布局、客户端视口和临时PTY继续实施，均保留在一期。
- [I02恢复兼容矩阵增补](execution/i02-skill-delivery-matrix-result.json)：数据库边界的执行轮次、旧公开29/33与旧A2A冻结输入补测已通过；[数据库修复](execution/i02-db153-regression-repair-result.json)的 Windows109项与Linux110项全部通过，原失败保留。[进程恢复](execution/i02-skill-process-recovery-result.json)已验真实Core重启保留冻结输入并终结未知结果、禁止重发；明确确认分支、其余逐SP与真实模型Gate继续补齐。

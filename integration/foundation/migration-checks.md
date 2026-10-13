# I01 可执行迁移基础夹具

运行tools/integration/smoke-migration-fixtures.mjs前提供绝对ROVAI_HOST_BIN、ROVAI_WEB_UI与专用FOUNDATION_EVIDENCE_ROOT。使用与固定Core版本匹配、已校验的Windows包。脚本创建全新私有数据根、技能库和MCP配置，通过真实Host的HTTP Session调用现有命令，结果不写Token。Windows复验需要已有PowerShell 7，用于复制原ACL，不安装全局工具。

9项实际结果见[migration-runtime-result.json](migration-runtime-result.json)：

1. 归一化来源记录经现有Core命令创建一个公共Thread，Core分配正式身份。
2. 相同来源Host、Runtime及会话整数ID使用同一commandId重放，仍只有一个Thread。
3. 另一来源Host中的相同整数ID产生独立Thread。
4. 未知来源版本在调用Core写命令前被拒绝。
5. 夹具范围以外的工程路径被拒绝，目标对象计数不变。
6. 丢弃已返回的HTTP结果正文并重启Host后，从commands.reconcile恢复已提交结果，重放不重复创建。
7. 停机恢复Core数据目录和夹具工程目录，恢复前数据库字节匹配，重开后的对象、合同及完整性与导入前一致，导入命令回执回到unknown。
8. 来源夹具文件hash不变。
9. 未配置Runtime，没有AgentRun，也没有恢复供应商Session。

## 自审与修正

Windows不能只把Node规范路径直接传给受控Web命令；本脚本使用workspaces.validate返回的精确Core规范路径。首次路径检查拒绝已通过这一改动解决，没有绕过权限门。
普通文件复制不保留Windows的显式私有DACL，首次回滚因此被Core lease准入拒绝。现采用停机快照，逐项复制源ACL，保留原生准备的目标根；未放宽未知目录权限。另测ACL工具向夹具外目标复制权限必须失败，外部目标原ACL保持不变。

当前Core回执查询内层operation使用原camps.create身份；外层HTTP创建使用规范threads.create。生产兼容层必须逐项映射，不能递归改写既有命令身份或回执。

## 范围边界

输入是按Codeg固定源字段归一化的测试JSON，不是实际Codeg旧库。这里验证Thread空壳、命令回执和本次目录的停机恢复；未导入历史消息、附件、供应商原生Session、画板或标签。生产导入器尚未实现，原6项设计场景的生产验收仍not_run。
中断用例模拟结果正文未消费后的客户端检查点缺口，不是SQLite事务内断电测试。快照恢复只操作脚本新建目录，不提供日常数据库恢复入口。

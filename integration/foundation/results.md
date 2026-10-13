# I01 当前实测记录

截至2026-10-13，I01进行中，不声明完整融合或整阶段验收通过。

| 项目 | 结果 | 范围限制 |
|---|---|---|
| 两应用本地前端类型检查 | 通过 | 不等于运行和产品验收 |
| Codeg静态Web构建 | 通过 | 固定供体版本，未接Rovai Core |
| Rovai Web、Execution Web、Electron构建 | 通过 | 完整融合应用UI尚未验收，桌面组件CI另列 |
| Rovai Windows原生Server CI | 全部成功 | 构建main提交9d1ad55；development-preview，不是正式发布 |
| 原生包ZIP与manifest | 通过 | SHA256一致，213个文件逐项校验 |
| 本机真实Host HTTP/SSE/SQLite | 12项通过 | 新隔离数据根，无真实AI执行；明细见windows-host-result.json |
| Codeg Windows原生Server | CI构建和隔离认证健康检查通过 | 不改固定供体源码；未启动真实AI，本机未运行Codeg桌面 |
| 本地Rust原生编译 | 未通过 | MSVC link.exe缺失，用户全局环境未修改 |
| 迁移基础 | 9项真实Core夹具通过 | 归一化记录、Thread空壳、回执、停机快照；实际Codeg旧库及历史消息导入未实现 |
| Windows桌面组件 | 61项单元检查与3项真实Electron夹具通过 | 关闭/托盘/桥接；未启动Core，不等于完整产品UI验收 |
| 两款Mac双架构 | 四项编译与预览包通过 | Rovai两架构各2真实Electron夹具；Codeg Intel任务90分钟超限cancelled，源码构建及上传已过，不能称CI全绿 |
| iOS模拟器 | 编译、安装、启动和首屏通过 | 固定iOS源无单测target；iPhone模拟器，不含iPad、真实服务器协作、真机或签名分发 |
| Android模拟器 | APK、176源单测、lint、安装启动及首屏通过 | 标准API36 AOSP镜像，无androidTest用例；最终无系统ANR，不替代真机/Google服务/完整业务验收 |
| Mac/移动真机 | 实测暂挂 | 用户稍后提供指定ADB；没有使用旧设备 |
| 融合产品验收 | 尚未开始 | 81来源簇对应324场景仍not_run |

## 复验

在同版本的校验Windows包上，设置绝对ROVAI_HOST_BIN、ROVAI_WEB_UI以及专用FOUNDATION_EVIDENCE_ROOT，再运行tools/integration/smoke-foundation.mjs。脚本自行创建私有Windows数据根、技能库与MCP路径，测试后关闭本次Host，不需要模型凭据。

结果证据不保存管理员Token、业务Session或用户秘密；不上传SQLite及运行目录。源版本、Host协议4、Core合同v1.72和schema146分别核对。

## 自审结论

I00复核发现的固定ID校验和提交差异校验缺口已修，私有仓凭据获取方式已整改，完整CI通过后合并PR50。I01的源基线构建与协议检查有实际证据；Mac和移动编译、模拟器转由GitHub运行机验证，真实硬件、完整桌面功能、各Runtime执行及生产旧数据迁移仍待验收，不得因此降低一期终点。

资源逐项状态、负责人和最迟使用阶段见resource-status.json；基准日期是排期约束，客户未承诺设备到位日期，等待将顺延有关测试。

迁移身份自审发现设计示例误用普通UUID，已改为源合同合法Thread示例，并直接复用源isThreadId校验。合法示例通过，普通UUID、错误UUID版本和大写拼写均拒绝。生产对象仍须从Core创建命令取得身份。storage-map.json核对8项Codeg实体与7张实际Core表的字段，只读schema，不含业务数据。

Codeg源Server结果见codeg-server-result.json，工作流38382011684完整成功。GitHub artifact摘要是平台提供值，下载后的EXE另记SHA256；没有把两者混成相同文件的校验。

客户已明确先做不依赖Mac和移动真机的工作。当前可推进顺序见available-software-queue.md；迁移执行边界及Windows规范路径、私有ACL整改见migration-checks.md。9项实际结果见migration-runtime-result.json，Windows组件CI见windows-desktop-result.json。

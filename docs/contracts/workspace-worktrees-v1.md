---
document_type: protocol-contract
contract: workspace-worktrees-v1
authority: core-workspace-git-topology
status: accepted
version: 1
last_updated: 2026-10-15
---

# Workspace Worktrees v1

为[画布业务目录](canvas-references-v1.md)提供真实 Git 工作树关系。
`workspaces.worktrees` 是 Native Core 与已认证 Host 共用的只读操作，参数为 `{path:string}`，
拒绝未知字段。它不创建、登记、修复、移动、清理或删除项目、Git 工作树与业务对象。

## 目录边界与响应

先复用 `validate_workspace_directory` 核对绝对目录、可读取性、真实路径、应用托管数据和 Git 元数据排除。
不放宽 managed quick-chat 例外。普通非 Git 目录正常返回空工作树列表；损坏 Git、进程失败、
超时、异常输出和读取中身份变化返回错误，不能冒充普通目录或完整的空关系。

响应为 `{schemaVersion:1,requestedPath,projectPath,repositoryRoot,mainWorktreePath,worktrees}`：

- requestedPath 保留请求路径，projectPath 是核实后的 canonical 目录。
- repositoryRoot 为当前 checkout 根目录，普通目录为 null；工程内子目录与根目录保持不同身份。
- mainWorktreePath 为主工作树路径；普通目录和 bare 主仓库为 null。
- worktrees 每项为 `{projectPath,isMain,bare,locked,prunable,available,branch,detached}`。
  branch为`branch refs/heads/`后的真实Git分支名或null，detached只来自独立`detached`字段，不从目录名推测。
  重复branch、branch与detached并存或空分支拒绝，未知未来属性仍沿原边界忽略。旧Host可能不返回这两个新增展示字段，
  客户端将其视为未知而非猜测分支；schema1、身份与权限含义不变，不新增Git命令或访问范围。
  主记录保持第一项，bare 主记录仍保留 isMain=true，但不能作为工程工作区。

Git 复用现有可执行文件解析、进程环境和Core托管有界命令执行器，10秒单命令deadline、2秒清理窗口；
清除覆盖仓库身份的GIT环境变量，禁用交互和可选锁。Windows仅在进程参数边界简化verbatim路径，
Core身份仍保持canonical表示。使用 `git worktree list --porcelain -z`，捕获stdout上限2MiB、
stderr上限64KiB；根目录探测stdout上限64KiB。拒绝截断、超过4096项、无终止符、
相对/重复路径及非Unicode路径，不能截断后声称完整。
HEAD、branch、detached、原因文本和未来非身份属性不进入投影。
主记录顺序和NUL格式依照[Git官方合同](https://git-scm.com/docs/git-worktree#_list_output_format)。

可访问记录复用目录校验并 canonicalize。已丢失、prunable、bare或被目录策略排除的记录仍保留元数据，
available=false；它只说明此次目录检查可用性，不证明该路径的模型、文件授权或执行资格。
Windows失效记录仅转换到持久路径使用的分隔符和verbatim/UNC表示，不把字符串转换当文件系统验证。
读取不扫描dirty状态、文件内容或业务数据库；Git列表与目录检查不是一个原子文件系统快照。

## 画布使用

父工程区域只在 projectPath、repositoryRoot、mainWorktreePath 三者相等时吸收各个非bare工作树。
绑定 linked worktree 或工程子目录时只显示其精确目录，不吸收兄弟工作树，也不按路径前缀猜测关系。
缺失工作树的已知路径仍可关联既有Thread历史；访问文件、执行或启动终端时必须另走现有授权和实时校验。

同一BusinessApp内，侧栏、画布和分组弹窗通过CanvasFolderProvider合并实际需要的路径，
共用一个controller与可见性刷新时钟，最多4个并发读取；不因同时显示多个入口重复查询相同工程。
路径集合切换或Host销毁后不发布旧结果、不再发出旧集合下一项。读取失败保留已知路径，标记未完整。
页面可见时20秒刷新、回到前台刷新，并提供显式“刷新关联”；不订阅布局事件反复查询Git。
controller从linked checkout的repositoryRoot/mainWorktreePath派生展示用parentPath，失败刷新保留已知父关系并标记未完整。
同一缓存保存原始只读工作树元数据的副本，侧栏/画布/管理弹窗仍共用有界读取。主工程仅按精确Git关系容纳工作树，
普通子目录与同名前缀不成为父工程；主工程未登记时，已登记linked checkout仍可作为独立入口，不吸收兄弟工作树。
关系冲突、循环或旧缓存缺少必要元数据时不得隐藏已登记工程；保留入口并显示待核对，不能任意选择一个父工程。

侧栏在主工程展开内容中显示已登记子工作树的原会话、菜单和分页，置顶主工程携带未置顶子项，置顶子项不重复显示。
未登记的非bare工作树仅显示元数据和显式打开入口；缺失/待清理或关系未完整时禁开，锁定状态只作为事实展示。
打开先走当前Core `workspaces.inspect`校验实际目录，再沿原导航偏好登记/恢复与选择，不在读取时自动登记、授权或执行。
同一时刻仅一个打开操作，保护页面离开/退出；Host/Owner切换拒绝旧结果回填。实际Desktop/Web操作仍待阶段集中验收。
分组身份与管理入口由[Navigation Project Groups v1](navigation-project-groups-v1.md)拥有，不能用这个读取接口代替。

## 验证所有权

`git::worktrees::tests::nul_records_preserve_path_characters_and_reject_incomplete_or_ambiguous_topology`
拥有纯NUL解析、空格/换行、bare/locked/prunable、损坏与重复输出及Windows表示。
旧Git parser不存在NUL工作树记录，故增加最低成本纯函数owner，不建数据库或Runtime。
真实Git调用复用 `git::tests` 原有普通目录、空仓库、Git观察和损坏元数据owner，扩展主/子工作树、
子目录、托管目录拒绝与丢失checkout；不另建仓库fixture。最小命令是 `cargo test -p rovai-core --lib git::`，
依阶段批量规则在I03候选执行；源码格式通过不代表这些Rust测试已运行。

TypeScript owner覆盖精确关系、失效记录保留、畸形响应、并发上限、去重、失败、切换与销毁。
Host seam扩展原隔离画布smoke，只证明鉴权/参数/序列及真实路径传递；实际运行和挂载UI另记证据。

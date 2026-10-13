# I01 资源与兼容记录

客户回复目前没有Mac或移动验收设备，设备实测暂时搁置，稍后提供ADB。此项保持未验证；ADB接入后再核对设备、SDK和实际系统版本，不提前访问旧ADB中的设备。

Windows当前有Node24.9、Rust/Cargo1.94，JDK17位于现有安装目录，但PATH默认Java8。构建使用命令级环境，不修改全局PATH。
本地Cargo读取上级用户目录的TUNA Git镜像后长时间排队。通过隔离CARGO_HOME并在非用户目录执行带绝对manifest-path的Cargo绕开，官方稀疏索引下载成功；用户Cargo配置未改。
原生编译随后确认缺link.exe，MSVC链接器未安装。已启动仅Windows的源Server CI构建，无自动发布或签名；本机从其校验产物执行隔离Host测试。完整本地编译仍待工具链，不把CI编译冒充本机编译。

待一期解决的兼容项：Codeg Tauri到Electron宿主、Rovai Linux桌面准入、独立Server渠道、Codeg与Host认证/事件协议、21类Runtime准入、移动SDK及签名。对应原阶段仍包含这些任务。

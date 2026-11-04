J.A.R.V.I.S Mac 纯净开源版（macOS 13+）

Apple / M 系列芯片下载 arm64 包，Intel 芯片下载 x64 包。

完整解压后双击“首次安装.command”，脚本将应用安装到你的 ~/Applications/贾维斯.app 并使用 Mac 自带工具完成本地签名和校验。以后直接打开应用即可。

如果安装位置已有同名应用，脚本会停止，请先退出并手动移走旧应用。现有用户数据不会删除。

应用自带 Python 和依赖。首次打开没有预设 API、个人文档、照片、记忆或提醒。
请在“模型 API 设置”填写自己的接口；实时语音另在“实时语音设置”配置自己的火山语音 API。

使用手势时允许摄像头，使用语音时允许麦克风。
双手张掌拉开放大、合拢缩小；OK 锁定后，可双手张掌保持约 0.3 秒重新接管缩放。
资料导入后在网络里显示为光点；锁定并指向光点，右拖展开，左拖收回。

用户数据位置：~/Library/Application Support/JarvisClean
本机服务：127.0.0.1:47671

本版本是技术预览。没有 Apple Developer ID 签名和苹果公证。如 macOS 阻止首次打开，请按照“隐私与安全性”中对已知来源应用的提示处理，不要关闭系统安全防护。

源码、版本说明和构建检查：
https://github.com/zhuge661/jarvis-neural-desktop
https://github.com/zhuge661/jarvis-neural-desktop/releases/tag/v1.0.0

项目代码 MIT；第三方依赖保留原许可，见应用包内 licenses 和仓库 LICENSES。

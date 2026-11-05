# 上游来源与第三方许可

本项目的 MIT 许可适用于项目自身代码。下列作品保留其原作者署名并适用各自许可；模型、字体、编译运行环境与服务商 API 条款不由本项目重新许可。

| 作品 | 本项目的使用方式 | 许可与原始来源 |
|---|---|---|
| JARVIS | 全息界面、本机服务、搜索与提醒结构；有中文化和适配修改 | MIT，Copyright (c) 2026 Newmintea；[源仓库](https://github.com/rayeedaabir/JARVIS)，[许可原文](LICENSES/JARVIS-MIT.txt) |
| Quantum Neural AR | 神经视觉、手势与部分合成音效的改编来源 | 上游 README 声明 `MIT © 2026`；[源仓库](https://github.com/AaricaMatrix/quantum-neural-ar)；上游未提供单独 LICENSE 文件 |
| Three.js r128 | WebGL 场景和几何 | MIT；[许可](LICENSES/threejs-MIT.txt) |
| Tone.js 14.8.49 | 合成环境音、交互音效 | MIT；[许可](LICENSES/Tone-MIT.txt)，[构建内署名](LICENSES/Tone.js.LICENSE.txt) |
| MediaPipe Tasks Vision 0.10.35 | 本机摄像头手部关键点识别；原始运行文件未修改 | Apache-2.0；[许可](LICENSES/MediaPipe-Apache-2.0.txt)，[项目](https://github.com/google-ai-edge/mediapipe) |
| SheetJS CE 0.18.5 | 本机表格读取 | Apache-2.0；[许可](LICENSES/SheetJS-Apache-2.0.txt) |
| Vosk API / small-cn-0.22 | 可选中文离线识别；模型从官方地址下载 | Apache-2.0；[许可](LICENSES/Vosk-Apache-2.0.txt)，[模型表](https://alphacephei.com/vosk/models) |
| Electron | Mac 桌面运行环境 | MIT 及其 Chromium/其他组件许可；构建时保留官方 LICENSE 和 LICENSES.chromium.html |
| CPython / python-build-standalone | 可携带 Python 运行环境 | Python 及所含组件原许可；保留分发包中的许可文件，详见 [上游](https://github.com/astral-sh/python-build-standalone) |
| Python 依赖 | WebSocket、在线 TTS、音频输入等 | 各自 wheel 的 `.dist-info` 中保留元数据和许可；确切版本与 SHA256 见 `requirements-macos-*.lock` |

项目修改包括聚类神经核心、中文 HUD、资料导入及点节点阅读、卡片拖动与高度调整、逐字回复、模型协议转换、实时语音中继以及 Mac 桌面封装。

背景音乐为用户指定的《Supercluster》音轨前 48 秒，恢复自 Windows 原版，保留 48kHz 双声道 PCM16；来源为 https://www.bilibili.com/video/BV1Aj421Z7az/ 。音源与处理记录见 `app/backend/JARVIS-main/ui/audio/bgm/来源说明.md`。该音乐不适用本项目的 MIT 许可，来源记录不表示已取得公开分发或商业使用授权。

固定唤醒提示为通用在线语音合成短句，不是演员声音复刻。在线语音服务与各模型接口仍受其服务条款约束。

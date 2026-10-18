# v0.1.0 — 首个可运行版本

Windows 便携版视频下载器：粘贴 / 拖入媒体直链即可下载；可选装浏览器扩展后，能跟随 Chrome / Edge 当前标签页里正在播放的视频。

## 下载哪个

| 文件 | 用途 |
| --- | --- |
| `video-downloader-0.1.0-portable.exe` | 程序本体（105 MB，免安装，双击即用） |
| `video-downloader-extension-0.1.0.zip` | 浏览器扩展（可选，装了才有「跟随页面 / 抓当前页」） |

## 快速开始

1. 双击 `video-downloader-0.1.0-portable.exe`（第一次启动要解压，慢几秒）。
2. 把媒体直链粘进输入框回车，或拖进窗口 → 开始下载。
3. 关窗口只是缩到右下角托盘，真正退出用托盘菜单「退出」。

## 可选：装扩展（只有想「跟随页面」才需要）

1. 解压 `video-downloader-extension-0.1.0.zip`，得到 `video-downloader-extension` 文件夹；
2. Edge 打开 `edge://extensions`（Chrome 用 `chrome://extensions`）→ 开启「开发者模式」；
3. 点「加载已解压的扩展程序」→ 选第 1 步那个文件夹；
4. 回到程序，面板显示「浏览器扩展已连接」即成功；之后在浏览器里刷新一下目标页面。

## 说明与限制

- 只支持 **Windows**（打包与托盘行为按 Windows 做）。
- 「跟随页面」依赖浏览器扩展，而 Chrome / Edge 不允许程序静默安装扩展，所以需要手动装一次；不装扩展时，程序依然可以下载直链。
- 只抓「文件」：`blob:` / MSE（HLS、DASH 播放器常见形态）抓不到；站点适配器目前只有 B 站。
- 分离的视频轨 + 音频轨合并成 mp4 需要本机有 ffmpeg（放到 `%APPDATA%\video-downloader\tools\bin\ffmpeg.exe` 或加进 PATH）；没有时会隐藏这些清晰度并说明原因。
- 本项目仅供学习、测试与技术研究使用，请遵守来源网站的服务条款与当地法律。

## 校验（发布者自测结论）

- `pnpm test`：293 个用例全过
- `pnpm test:e2e`：真 Chrome 155 加载扩展 → 夹具页开采 → 扩展取字节 → 上传 → 落盘文件 sha256 与夹具一致（15/15）
- `pnpm verify:mux`：真 ffmpeg 合并出同时含 h264 + aac 的 mp4
- 托盘：关窗不退出、二次启动可唤回窗口
- 打包版：API 应答、关窗进托盘、便携 exe 双击启动均通过

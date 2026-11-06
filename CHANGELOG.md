# Changelog

格式按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号按 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.1] - 2026-11-06

### Added
- 出站按来源分流：QQ 发起的轮次才回推 QQ，桌面发起的轮次不再镜像到手机。
- 收图：自动下载到本地并把路径交给 AI（AI 用 `read_image` 看）。
- 收 QQ 表情 / 商城表情包：记成 `[QQ表情 id=…]` / `[表情包「名字」…]`。
- 发图 `[[img:路径]]`、发表情 `[[face:id]]`、发表情包 `[[mface:id/pkg/名]]`。
- 群消息开关 `groupMessages`（默认关，只记日志）。

### Changed
- 插件改为零配置可安装：本机路径、端口、token、账号、会话 id 全部进配置项。
- 语音转写改为可选（`earScript`），不配就只留占位。

### Fixed
- 会话 `setup` 不能 `return agent`：引擎会把返回值当提交句柄调 `.commit()`，导致建会话直接抛错。
- 模型走到未启动的本地服务时回 503 —— 现在可在配置里固定 provider/model。

## [0.1.0] - 2026-11-05

### Added
- 第一版：QQ 私聊收发文字，接 NapCat 的 OneBot11 WebSocket，私聊白名单。

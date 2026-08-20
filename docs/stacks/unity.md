# Unity / GameCI

## 状态与执行器

检测 `ProjectSettings/ProjectVersion.txt`，状态为 credential-gated。GitHub workflow 使用固定 SHA 的 `game-ci/unity-builder`，目标平台选择 Ubuntu、Windows 或 macOS runner。

## License 凭据

| License | 必需 Secrets |
| --- | --- |
| Personal | `UNITY_LICENSE`（目标项目所有者导出的 `.ulf` 内容）、`UNITY_EMAIL`、`UNITY_PASSWORD` |
| Pro | `UNITY_SERIAL`、`UNITY_EMAIL`、`UNITY_PASSWORD` |

Release Ops 不附带通用 Personal license，也不在不同项目间复用 license。凭据只进入 GameCI build step。

## 版本、构建与产物

canonical version 与平台 build number 分开。GameCI 负责 Unity 构建，配置声明 `projectPath`、目标和产物路径；发布 player package。Sentry 可上传 source maps、R8 mapping 和平台 DIF。

## 验收与限制

验证 Unity editor version、license 类型、target platform、签名和 player 启动。Console SDK、受限模块或不能进入 GitHub runner 的许可证需要合法 self-hosted 环境；build unit 必须填写 `runner: self-hosted` 和 `selfHostedReason`。

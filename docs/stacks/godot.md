# Godot

## 为什么可以使用 hosted runner

Godot 无引擎激活或席位许可证，官方 export templates 支持无头导出，因此标准工具链可以安装到 GitHub-hosted runner。配置必须声明 `godotVersion`，workflow 使用固定 SHA 的 setup action。

## 目标与 runner

| 目标 | Runner | 额外条件 |
| --- | --- | --- |
| Linux / Web | `ubuntu-latest` | 对应 export template |
| Android | `ubuntu-latest` | JDK、Android SDK、签名配置 |
| Windows | `windows-latest` | Windows export template |
| macOS / iOS | `macos-latest` | Xcode；iOS 还需证书与 profile |

## 版本、构建与产物

canonical version 从项目约定的单一 key 读取，平台 build number 分开声明。构建命令使用 `godot --headless --export-release ...` 的结构化参数。发布各目标 export package；Sentry 可上传 source maps/DIF。

## Secrets、验收与限制

Godot 本身不需要 license Secret，但 Android/iOS/macOS 签名仍需要目标 Secret。验证 export preset、目标架构、签名和无头导出结果。

Proprietary console SDK、自定义引擎构建、host SDK/签名条件缺失以及不能合法部署到 hosted runner 的工具链不在普通支持范围；此时 build unit 必须显式使用 `runner: self-hosted` 并填写 `selfHostedReason`，不能把 hosted 标成成功。

# Flutter

## 检测与目标

检测 Flutter `pubspec.yaml`。Android/Web/Linux 使用 Ubuntu，Windows 使用 Windows，iOS/macOS 使用 macOS；Action 使用固定 Flutter setup action 的 stable channel。

## 版本、构建与签名

`version` 中的语义版本和 `+build` 分开映射 canonical/build number。使用 `flutter` executable 与明确 build 参数；Android、iOS/macOS 签名 Secret 只进入对应 unit。

## 产物与 Sentry

发布各平台 package；Sentry 上传 Dart symbols/source maps，并组合底层 Android/Apple DIF。

## 验收与限制

运行 `flutter test`、`flutter analyze` 和目标 release build。平台商店上传和证书审批不是默认发布步骤。

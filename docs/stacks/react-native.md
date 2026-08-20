# React Native

## 检测与目标

从 package metadata 与 Android/iOS 工程检测 React Native。Android 使用 Ubuntu/JDK 17，iOS 使用 macOS。

## 版本、构建与签名

canonical version 与 Android versionCode、iOS CFBundleVersion 分开。JS bundle 与原生 package 在各平台 unit 中构建；签名 Secret 不进入其他平台或 provider step。

## 产物与 Sentry

发布 APK/AAB/IPA；Sentry 同时处理 JS source maps、R8 mapping 和 dSYM/DIF，release/dist 必须一致。

## 验收与限制

运行 JS 测试/类型检查和平台 release build，验证 Hermes/source map 对应关系。其他 React Native 平台需要新增已测试 adapter target，不能借 generic 名义宣称支持。

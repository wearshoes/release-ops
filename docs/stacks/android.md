# Android Gradle

## 检测与目标

检测 `gradlew` 和 Android Gradle 文件。正式目标为 `android`，runner 是 `ubuntu-latest`，Action 配置 Temurin JDK 17。

## 版本、构建与签名

canonical version 通常读取 `gradle.properties` 的版本名，Android build number 单独读取整数 versionCode。命令使用 Gradle wrapper 的 `executable + args`，例如 `./gradlew` 与 `app:assembleRelease`；签名 Secret 只进入该 build step。

## 产物与 Sentry

发布 APK/AAB；Sentry 调试产物为 R8 mapping 和可选 native DIF。产物路径必须在构建后存在并留在仓库内。

## 验收与限制

核对 APK/AAB 包名、版本、v2/v3 签名和 mapping；按项目风险运行 Gradle 测试、Lint 和 release build。Play Console 上传不属于 GitHub Release 核心能力。

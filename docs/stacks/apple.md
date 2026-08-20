# Apple / Xcode

## 检测与目标

检测 `.xcodeproj` 或 `.xcworkspace`。macOS 与 iOS 都使用 `macos-latest`；Xcode/toolchain 版本由项目和 runner 共同约束。

## 版本、构建与签名

canonical version 与 CFBundleVersion 分开读取。build unit 使用 `xcodebuild` 的结构化参数；证书、私钥和 provisioning profile 只进入签名 build step。

## 产物与 Sentry

发布 archive、IPA 或 pkg；Sentry 上传 dSYM/DIF，并绑定相同 release、dist 和完整 source SHA。

## 验收与限制

验证签名 identity、bundle identifier、版本和产物可安装性。App Store notarization、账号审批和硬件能力必须由项目显式配置；缺少 Apple 凭据时不能宣称可发布。

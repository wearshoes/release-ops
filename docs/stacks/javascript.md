# JavaScript / TypeScript

## 检测与目标

检测 `package.json`。Web/Linux 默认 Ubuntu，Windows 使用 Windows，macOS 使用 macOS；每个目标单独声明 build unit。

## 版本与构建

canonical version 通常读取 `package.json.version`，桌面打包器的 build number 另行声明。命令直接调用 `npm`、`pnpm`、`yarn` 或项目二进制及参数，不允许 shell 拼接。

## 产物与 Sentry

发布 bundle、归档或安装包；Sentry 上传 source maps/artifact bundle。Source map 必须对应本次构建，不能从旧 Release 下载复用。

## 验收与限制

运行项目测试、类型检查和生产构建，验证 sourcemap release/dist。包注册表发布、Electron 签名或 notarization 需要各自 build unit Secret。

# Native / C / C++ / Rust

## 检测与目标

检测 CMake、Meson 或 Cargo 文件；Linux、Windows、macOS 分别使用对应 runner。自定义编译器或 SDK 不在 hosted image 时必须使用合法的 self-hosted runner。

## 版本与构建

canonical version 从项目单一来源读取，平台 build number 单独声明。命令使用 `cmake`、`meson`、`cargo` 等 executable/args，不通过 shell 注入环境脚本。

## 产物与 Sentry

发布二进制或归档；Sentry 调试产物包括 ELF/DWARF、PDB、dSYM/DIF。Strip 前后的 debug identity 必须匹配。

## 验收与限制

运行单元测试和目标架构 smoke check，验证动态依赖、符号和签名。交叉编译 SDK 的许可证与缓存由项目负责。

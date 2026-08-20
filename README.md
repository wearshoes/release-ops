# Release Ops

[![Verify Release Ops](https://github.com/wearshoes/release-ops/actions/workflows/ci.yml/badge.svg)](https://github.com/wearshoes/release-ops/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Release Ops 是面向 Codex 的可复用发布 Plugin。它负责项目探测、构建、签名、版本核对、GitHub 托管、private-to-public 分发和 GitHub Release；Sentry 等质量系统以可选 provider 接入，不拥有版本或发布目标。

配置写入项目的 `.release-ops/config.json`，凭据只存在于本地环境或目标仓库的 Actions Secrets。旧的 `release-ops/config/v1` 不兼容，必须按[迁移 SOP](docs/migrations/config-v1.md)重新初始化。

## 五分钟开始

```bash
codex plugin marketplace add wearshoes/release-ops --ref main
codex plugin add release-ops@release-ops
```

Windows PowerShell 拦截 `codex.ps1` 时使用 `codex.cmd`。安装或升级后重启 Codex，并在目标仓库根目录新建任务：

```text
使用 $release-ops-setup 初始化或审计当前项目。先 inspect，只询问无法从仓库或 GitHub 验证的决策；必须明确询问是否使用 GitHub，以及选择 None 还是已安装的 provider。生成 plan 和 SHA-256 摘要后等待我确认，不要发版。
```

Agent 将执行 `inspect -> plan -> apply -> audit`。`apply` 必须携带与 plan 完全相同的 SHA-256；初始化授权不等于发版授权。

完整步骤见[新旧项目初始化](docs/getting-started.md)。

## 文档导航

| 目标 | SOP |
| --- | --- |
| 本地构建、签名和校验和 | [本地发布](docs/workflows/local-release.md) |
| public 源码仓库发版 | [GitHub Release](docs/workflows/github-release.md) |
| private 源码向 public 仓库分发 | [Private-to-public](docs/workflows/private-to-public.md) |
| 审计、升级和冲突处理 | [审计与升级](docs/workflows/audit-and-upgrade.md) |
| 从旧配置迁移 | [config/v1 迁移](docs/migrations/config-v1.md) |
| 选择或开发质量平台 | [Provider 索引](docs/providers/README.md) |
| 按技术栈配置构建 | [技术栈索引](docs/stacks/README.md) |

## 技术栈

| Adapter | 状态 | 文档 |
| --- | --- | --- |
| Android Gradle | 支持 | [Android](docs/stacks/android.md) |
| Xcode | 支持 | [Apple](docs/stacks/apple.md) |
| JavaScript/TypeScript | 支持 | [JavaScript](docs/stacks/javascript.md) |
| .NET | 支持 | [.NET](docs/stacks/dotnet.md) |
| C/C++/Rust native | 支持 | [Native](docs/stacks/native.md) |
| Flutter | 支持 | [Flutter](docs/stacks/flutter.md) |
| React Native | 支持 | [React Native](docs/stacks/react-native.md) |
| Godot | 支持 hosted runner | [Godot](docs/stacks/godot.md) |
| Unity | GameCI，凭据门禁 | [Unity](docs/stacks/unity.md) |
| Generic | 显式配置 | [Generic](docs/stacks/generic.md) |
| Unreal | 仅检测，不支持 | [Unreal](docs/stacks/unreal.md) |

## Provider

当前仅安装 [Sentry](docs/providers/sentry.md)。`performance` 与 `vulnerability` 只是开发 contract fixture，不会作为可选项展示。Provider 必须由用户整体选择；检测到 SDK、旧 workflow 或环境变量都不会自动启用。

## 发布保证

- build 使用 `executable + args` 且 `shell:false`；所有配置路径必须留在仓库内并通过 symlink 检查。
- 每个平台使用自己的 runner 和构建单元，产物通过一天内失效的 Actions Artifact 聚合。
- public 源码在当前仓库发布；private 源码保留 private Release，并把同一本地字节发布到独立 public 仓库。
- 双仓先建立 draft，先发布 private、最后发布 public；部分成功不回滚，使用同一 version、SHA 和 correlation 续跑。
- public manifest 不包含 private 仓库名、private commit、workflow ID 或内部链接。
- 发布成功与 incident resolved 是两个独立状态，任何一方都不能冒充另一方。

## 安全边界

Token 不进入配置、命令参数、日志、Issue、Artifact 或发布说明。签名、provider 上传、源码 Release 和 public Release 凭据只注入使用它们的步骤。自动事故只能写入 private 源码仓库。

安全问题请使用 [Private vulnerability reporting](https://github.com/wearshoes/release-ops/security/advisories/new)。

## 开发

新增 adapter/provider 必须同时提供 manifest、实现、文档、fixture 和端到端测试。验证入口：

```bash
node --test scripts/tests/*.test.mjs
python -m unittest discover -s scripts/tests -p "test_*.py"
python scripts/validate_self.py
```

[MIT](LICENSE)

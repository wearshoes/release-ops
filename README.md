# Release Ops

[![Verify Release Ops](https://github.com/wearshoes/release-ops/actions/workflows/ci.yml/badge.svg)](https://github.com/wearshoes/release-ops/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Release Ops 是面向 Codex 的可复现发布 Plugin。Kernel 只负责 extension 注册、processor graph、权限、事务、结构化 workflow、审计和执行；技术栈、签名、发布目标及 Sentry 行为由内置 extension 提供。

项目配置位于 `.release-ops/config.json`，唯一格式为 `release-ops/config/v1`。配置只保存项目名和 extension 实例，不保存路径推导状态、processor graph、生成状态或凭据值。

## 快速开始

```powershell
codex.cmd plugin marketplace add wearshoes/release-ops --ref v1.1.0
codex.cmd plugin add release-ops@release-ops
node scripts/release-ops.mjs inspect --root <repository>
```

初始化流程是 `inspect -> plan --mode initialize -> apply --confirm <digest> -> audit`。合法 `/v1` 默认只进入 audit；显式 `reconfigure` 会把当前值作为默认值，`reinitialize` 不继承 GitHub 或 provider 决策。初始化授权不等于发版授权。

详见[初始化、重新配置与审计](docs/getting-started.md)。

## Processor 数据流

每个 processor 节点使用 `<instanceId>:<processorId>` 标识。Kernel 依固定 stage、显式 `before/after` 和完整节点 ID 排序；跨实例依赖只由 capability 建边。

```text
inspect/configure/plan
        |
preflight -> prepare -> build -> sign -> debug-artifacts -> collect -> publish-stage -> publish-finalize

scheduled-ingest     resolve     audit
      (独立入口，不进入 release 主链)
```

Capability 支持 `one/many` 消费和 `exclusive/append/keyed` 合并。缺失、歧义、重复 key、重复 build-unit owner 或循环会在 plan 阶段失败。

## 内置 Extensions

以下矩阵由 `extensions/**/extension.json` 确定性生成：

<!-- EXTENSION_MATRIX_START -->
| Type | Extension | Status | Targets |
| --- | --- | --- | --- |
| provider | [sentry](docs/providers/sentry.md) | supported | - |
| release | [github](docs/workflows/github-release.md) | supported | - |
| release | [local](docs/workflows/local-release.md) | supported | - |
| signing | [android-keystore](docs/signing/android-keystore.md) | supported | - |
| signing | [apple-codesign](docs/signing/apple-codesign.md) | supported | - |
| signing | [generic-command](docs/signing/generic-command.md) | supported | - |
| stack | [android](docs/stacks/android.md) | supported | android: ubuntu-latest |
| stack | [apple](docs/stacks/apple.md) | supported | macos: macos-latest<br>ios: macos-latest |
| stack | [dotnet](docs/stacks/dotnet.md) | supported | linux: ubuntu-latest<br>windows: windows-latest<br>macos: macos-latest |
| stack | [flutter](docs/stacks/flutter.md) | supported | android: ubuntu-latest<br>windows: windows-latest<br>ios: macos-latest |
| stack | [generic](docs/stacks/generic.md) | supported | - |
| stack | [godot](docs/stacks/godot.md) | supported | linux: ubuntu-latest<br>web: ubuntu-latest<br>android: ubuntu-latest<br>windows: windows-latest<br>macos: macos-latest<br>ios: macos-latest |
| stack | [javascript](docs/stacks/javascript.md) | supported | web: ubuntu-latest<br>windows: windows-latest<br>macos: macos-latest |
| stack | [native](docs/stacks/native.md) | supported | linux: ubuntu-latest<br>windows: windows-latest<br>macos: macos-latest |
| stack | [react-native](docs/stacks/react-native.md) | supported | android: ubuntu-latest<br>ios: macos-latest |
| stack | [unity](docs/stacks/unity.md) | credential-gated | linux: ubuntu-latest<br>windows: windows-latest<br>macos: macos-latest |
| stack | [unreal](docs/stacks/unreal.md) | diagnostic only | - |
<!-- EXTENSION_MATRIX_END -->

`performance` 与 `vulnerability` 仅是未注册 contract fixture，不会出现在 setup 选项、runtime、workflow、Secret 或网络权限中。

## 发布保证

- Extension module 只能使用冻结的 Kernel API；命令固定 `shell:false`，HTTPS 限制为 manifest 声明的精确 origin。
- Workflow extension 只能贡献 pinned action 或 processor invocation；只有 Kernel renderer 能生成 YAML 和固定 trampoline。
- Plan 固化 config、graph、extension code SHA-256、workflow model、当前文件字节、仓库身份和 Secret role。
- Apply 先复核 digest、extension code 与文件快照，再执行幂等远端操作和 journal/backup 本地事务；本地失败逆序回滚。
- GitHub dual repository 只构建一次，并向 private/public Release 上传相同本地字节；标准 manifest 与项目 `latest.json` projection 分离。
- 发布成功与 incident resolved 是独立状态，任何一方都不能冒充另一方。

## 文档

- [初始化、reconfigure、reinitialize 与 audit](docs/getting-started.md)
- [本地发布](docs/workflows/local-release.md)
- [GitHub Release](docs/workflows/github-release.md)
- [Private-to-public](docs/workflows/private-to-public.md)
- [Audit 与升级](docs/workflows/audit-and-upgrade.md)
- [Stack extensions](docs/stacks/README.md)
- [Signing extensions](docs/signing/README.md)
- [Provider extensions](docs/providers/README.md)
- [Extension 开发契约](docs/extensions/developing.md)

## 开发验证

```bash
node --test scripts/tests/*.test.mjs
python -m unittest discover -s scripts/tests -p "test_*.py"
python scripts/validate_self.py
node scripts/validate-boundaries.mjs
node scripts/validate-credentials.mjs
node scripts/generate-readme.mjs --check
git diff --check
```

[MIT](LICENSE)

# Release Ops

[![Verify Release Ops](https://github.com/wearshoes/release-ops/actions/workflows/ci.yml/badge.svg)](https://github.com/wearshoes/release-ops/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**中文** | [English](README.en.md)

Release Ops 是面向 Codex 的可复现发布插件。内核只负责扩展注册、处理器图、权限、事务、结构化工作流、审计和执行；技术栈、签名、发布目标及 Sentry 行为由内置扩展提供。

项目配置位于 `.release-ops/config.json`，唯一格式为 `release-ops/config/v1`。配置只保存项目名和扩展实例，不保存路径推导状态、处理器图、生成状态或凭据值。

## 快速开始

```powershell
codex.cmd plugin marketplace add wearshoes/release-ops --ref v1.1.0
codex.cmd plugin add release-ops@release-ops
node scripts/release-ops.mjs inspect --root <repository>
```

初始化流程是 `inspect -> plan --mode initialize -> apply --confirm <digest> -> audit`。合法配置默认只进入 `audit`；显式 `reconfigure` 会把当前值作为默认值，`reinitialize` 不继承 GitHub 或服务提供方决策。初始化授权不等于发版授权。

详见[初始化、重新配置与审计](docs/getting-started.md)。

## 处理器数据流

每个处理器节点使用 `<instanceId>:<processorId>` 标识。内核依固定阶段、显式 `before/after` 和完整节点 ID 排序；跨实例依赖只由能力建边。

```text
inspect/configure/plan
        |
preflight -> prepare -> build -> sign -> debug-artifacts -> collect -> publish-stage -> publish-finalize

scheduled-ingest     resolve     audit
      (独立入口，不进入 release 主链)
```

能力支持 `one/many` 消费和 `exclusive/append/keyed` 合并。缺失、歧义、重复键、重复构建单元所有者或循环会在 plan 阶段失败。

## 内置扩展

以下矩阵由 `extensions/**/extension.json` 确定性生成：

<!-- EXTENSION_MATRIX_START -->
| 类型 | 扩展 | 状态 | 目标 |
| --- | --- | --- | --- |
| 服务提供方 | [sentry](docs/providers/sentry.md) | 支持 | - |
| 发布 | [github](docs/workflows/github-release.md) | 支持 | - |
| 发布 | [local](docs/workflows/local-release.md) | 支持 | - |
| 签名 | [android-keystore](docs/signing/android-keystore.md) | 支持 | - |
| 签名 | [apple-codesign](docs/signing/apple-codesign.md) | 支持 | - |
| 签名 | [generic-command](docs/signing/generic-command.md) | 支持 | - |
| 技术栈 | [android](docs/stacks/android.md) | 支持 | android: ubuntu-latest |
| 技术栈 | [apple](docs/stacks/apple.md) | 支持 | macos: macos-latest<br>ios: macos-latest |
| 技术栈 | [dotnet](docs/stacks/dotnet.md) | 支持 | linux: ubuntu-latest<br>windows: windows-latest<br>macos: macos-latest |
| 技术栈 | [flutter](docs/stacks/flutter.md) | 支持 | android: ubuntu-latest<br>windows: windows-latest<br>ios: macos-latest |
| 技术栈 | [generic](docs/stacks/generic.md) | 支持 | - |
| 技术栈 | [godot](docs/stacks/godot.md) | 支持 | linux: ubuntu-latest<br>web: ubuntu-latest<br>android: ubuntu-latest<br>windows: windows-latest<br>macos: macos-latest<br>ios: macos-latest |
| 技术栈 | [javascript](docs/stacks/javascript.md) | 支持 | web: ubuntu-latest<br>windows: windows-latest<br>macos: macos-latest |
| 技术栈 | [native](docs/stacks/native.md) | 支持 | linux: ubuntu-latest<br>windows: windows-latest<br>macos: macos-latest |
| 技术栈 | [react-native](docs/stacks/react-native.md) | 支持 | android: ubuntu-latest<br>ios: macos-latest |
| 技术栈 | [unity](docs/stacks/unity.md) | 需要凭据 | linux: ubuntu-latest<br>windows: windows-latest<br>macos: macos-latest |
| 技术栈 | [unreal](docs/stacks/unreal.md) | 仅诊断 | - |
<!-- EXTENSION_MATRIX_END -->

`performance` 与 `vulnerability` 仅是未注册的契约夹具，不会出现在 setup 选项、运行时、工作流、Secret 或网络权限中。

## 发布保证

- 扩展模块只能使用冻结的内核 API；命令固定 `shell:false`，HTTPS 限制为清单声明的精确来源。
- 工作流扩展只能贡献固定 SHA 的 Action 或处理器调用；只有内核渲染器能生成 YAML 和固定跳板命令。
- Plan 固化配置、处理器图、扩展代码 SHA-256、工作流模型、当前文件字节、仓库身份和 Secret 角色。
- Apply 先复核摘要、扩展代码与文件快照，再执行幂等远端操作和 journal/backup 本地事务；本地失败逆序回滚。
- GitHub 双仓库模式只构建一次，并向私有和公开 Release 上传相同本地字节；标准发布清单与项目 `latest.json` 投影分离。
- 发布成功与事故已解决是独立状态，任何一方都不能冒充另一方。

## 文档

- [初始化、重新配置、重新初始化与审计](docs/getting-started.md)
- [本地发布](docs/workflows/local-release.md)
- [GitHub Release](docs/workflows/github-release.md)
- [私有源码到公开分发](docs/workflows/private-to-public.md)
- [审计与升级](docs/workflows/audit-and-upgrade.md)
- [技术栈扩展](docs/stacks/README.md)
- [签名扩展](docs/signing/README.md)
- [服务提供方扩展](docs/providers/README.md)
- [扩展开发契约](docs/extensions/developing.md)

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

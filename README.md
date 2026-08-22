# Release Ops

[![Verify Release Ops](https://github.com/wearshoes/release-ops/actions/workflows/ci.yml/badge.svg)](https://github.com/wearshoes/release-ops/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**中文** | [English](README.en.md)

Release Ops 是面向 Codex 的发布流程插件。它会询问项目技术栈、构建产物、签名方式、发布目标和可选服务，然后生成可审计、可重复执行的发布配置与工作流。

## 快速开始

### 1. 安装插件

在终端中执行：

```powershell
codex.cmd plugin marketplace add wearshoes/release-ops --ref v1.1.0
codex.cmd plugin add release-ops@release-ops
```

已经添加过插件源时，先更新再重新安装：

```powershell
codex.cmd plugin marketplace upgrade release-ops --json
codex.cmd plugin add release-ops@release-ops --json
```

### 2. 在目标项目中打开 Codex

```powershell
cd <repository>
codex
```

### 3. 在 Codex 对话中触发初始化

下面两种说法都可以。它们是发给 Codex 的请求，不是终端命令：

```text
使用 Release Ops 插件初始化当前项目
```

或：

```text
release-ops init
```

插件会检查项目，按顺序询问技术栈与构建单元、签名方式、发布方式、GitHub 仓库结构和可选服务。随后它会展示完整计划，包括将要写入和删除的文件、处理器图、机密变量名称、仓库操作及 SHA-256 摘要。

当前初始化请求已经授权执行这份计划。展示完成后，Codex 会把计划中的摘要作为内部确认值立即应用并审计配置、工作流、运行时和远端仓库身份，不要求你复制或回复摘要。若文件漂移或处理器修复导致计划变化，但用户选择和远端目标不变，Codex 会展示新计划后自动继续；只有选择或目标发生变化时才重新询问。初始化只建立发布能力，不会修改应用版本，也不会创建 Release。

常用的后续请求：

```text
release-ops audit
release-ops reconfigure
release-ops reinitialize
```

完整说明见[安装、初始化与审计](docs/getting-started.md)。

## Sentry 接入

初始化时选择 Sentry 后，Release Ops 会先根据处理器图，找到最终发布产物所属的技术栈实例并检查应用 SDK。只有依赖、官方初始化和非占位公开 DSN 三类证据完整时才允许生成计划；检测到多个最终产物归属时不会擅自选择。

SDK 缺失时，Codex 先核验 Sentry 项目，并通过 Chrome 控制插件从用户已登录的 Sentry 项目页读取公开 DSN；用户不需要手工查找或粘贴 DSN。随后 Codex 依次使用支持当前平台的官方 Wizard、受限的 Sentry Agent 或对应的官方平台手册。版本与分发标识、源码映射、混淆映射和其他调试产物上传仍由 Release Ops 管理，避免安装器重复配置。完整步骤见 [Sentry 接入](docs/providers/sentry.md)。

## 生成内容

- `.release-ops/config.json`：项目名和已选择的扩展实例；
- `.release-ops/processor-graph.json`：构建、签名、发布及可选服务的数据流；
- `.release-ops/managed-files.json`：受管文件、摘要和所有权；
- `.release-ops/runtime/`：内核及当前项目实际选择的扩展运行时；
- 结构化生成或明确接管的 CI 工作流。

配置不会保存凭据值。机密变量只以角色和名称出现，实际值仍由本地环境或 CI 的机密变量存储管理。

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

- [安装、初始化与审计](docs/getting-started.md)
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

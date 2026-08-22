# 安装、初始化与审计

**中文** | [English](getting-started.en.md)

Release Ops 通过 Codex 插件使用。普通用户不需要寻找或执行插件内部的 Node.js 脚本，也不需要手写 `.release-ops` 配置。

## 安装插件

首次安装时，在终端执行：

```powershell
codex.cmd plugin marketplace add wearshoes/release-ops --ref v1.2.0
codex.cmd plugin add release-ops@release-ops
```

已经添加过插件源时，更新并重新安装：

```powershell
codex.cmd plugin marketplace upgrade release-ops --json
codex.cmd plugin add release-ops@release-ops --json
```

安装完成后，在目标项目目录中打开 Codex：

```powershell
cd <repository>
codex
```

## 触发初始化

在 Codex 对话中输入：

```text
使用 Release Ops 插件初始化当前项目
```

也可以使用简写：

```text
release-ops init
```

这两行都是发给 Codex 的请求，不是终端命令。插件会先检查当前项目；没有 Release Ops 配置时，它会自动进入初始化流程。

## 回答配置问题

插件会按固定顺序询问：

1. 项目使用的技术栈、构建单元、构建命令和产物；
2. 每个构建单元是否需要签名，以及使用哪种签名方式；
3. 发布到本地目录还是 GitHub Release；
4. GitHub 源码仓库与公开分发仓库的结构；
5. 是否启用 Sentry 等可选服务。

只回答当前项目真实需要的选项。凭据值不要写进对话或配置；Release Ops 只记录 CI 机密变量的名称和用途。

## 选择 Sentry 时

选择 Sentry 后，Codex 会先根据处理器图确定最终发布产物所属的技术栈，再检查项目是否已有 SDK 依赖、官方初始化和非占位公开 DSN。检查不会用检测候选列表替代已配置的产物归属，也不会输出 DSN 内容。

状态不是 `configured` 时暂不生成计划。Codex 会先创建或核验准确的 Sentry 项目，再使用 Chrome 控制插件从用户已登录的项目页读取公开 DSN，不要求用户手工查找或粘贴。随后按官方 Wizard、受限 Sentry Agent、官方平台手册的顺序完成最小 SDK 接入；安装器生成的认证残留和重复发布、调试产物上传配置必须清理。详细步骤见 [Sentry 接入](providers/sentry.md)。

## 审阅计划

问答完成后，插件会展示完整计划：

- 将生成的项目配置；
- 构建、签名、发布和可选服务的处理器图；
- 可选扩展的脱敏静态检查及证据文件 SHA-256；
- 将新增、更新、接管或删除的文件；
- 需要配置的机密变量名称；
- 将验证或创建的仓库；
- 风险与冲突；
- 本次计划唯一的 SHA-256 摘要。

Codex 会先完整展示计划，然后把 `plan.planDigest` 作为内部 `--confirm` 值立即应用。你不需要复制或回复摘要；插件仍会拒绝缺失、错误或过期的摘要，避免把另一份计划写入项目。

## 自动应用与审计

应用前，插件会重新核对计划、扩展代码和当前文件。若文件漂移或处理器修复使计划失效，但技术栈、签名、发布方式、仓库、Sentry 项目和 Secret 目标都没有变化，Codex 会重新生成并展示计划，再使用新摘要自动继续。只有这些用户选择或目标发生变化时才重新询问。应用完成后会立即审计：

- 配置、处理器图和工作流摘要是否一致；
- 只安装了当前项目选择的扩展运行时；
- 受管文件是否被人工修改；
- GitHub 仓库身份是否正确；
- 机密变量名称是否齐全。

审计结果必须同时满足 `success:true` 和 `remoteVerified:true`。任一摘要漂移或远端验证失败都不能视为成功。

## 已初始化项目

在 Codex 对话中使用以下请求：

```text
release-ops audit
```

只读检查当前配置、工作流、运行时和远端仓库。

```text
release-ops reconfigure
```

以当前有效配置为默认值，重新选择需要调整的内容；它会先展示计划，再自动应用和审计。

```text
release-ops reinitialize
```

配置损坏、格式无法识别或需要完全重做时，重新询问全部选择。它不会沿用以前的 GitHub 仓库结构或可选服务决定。

## 操作边界

明确请求初始化、重新初始化或重新配置，即授权对应的计划、应用和审计。已经选定的仓库可见性、Sentry 项目标识、各个 Secret 目标、测试和审计不再重复确认；仓库创建、Sentry 项目标识和 Secret 仓库的精确匹配仍由插件在内部校验。

这些 setup 请求不等于发版授权。除非用户另行明确要求发布，Release Ops 不会递增应用版本、编写发布说明、推送代码或创建 Release，也不会制造真实 Sentry 事件或关闭远端 Issue。

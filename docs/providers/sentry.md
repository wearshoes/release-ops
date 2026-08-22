# Sentry 接入

**中文** | [English](sentry.en.md)

Release Ops 的 Sentry 扩展负责版本与分发标识、调试符号上传、定时事故接入和显式状态回写。应用 SDK 与公开 DSN 必须先在项目源码中完成接入；Release Ops 不会把 DSN、令牌或扫描状态写进自己的配置。

## 1. 选择 Sentry 并确认目标技术栈

在初始化或重新配置时明确选择 Sentry。Release Ops 从处理器图中查找最终发布产物所属的技术栈实例，不使用项目检测阶段的候选列表代替配置决定。

如果所有发布产物属于同一个技术栈实例，就检查该实例对应的平台。若存在多个不同的最终产物归属且无法唯一确定，计划会停止，要求先拆分或明确 SDK 目标。

## 2. 运行只读 SDK 检查

Codex 会在 plan 前运行内部检查器。下面是 agent 使用的内部命令，普通用户不需要手工执行：

```powershell
node <release-ops-plugin>/scripts/sentry-sdk-check.mjs --root <repository> --answers <setup-answers.json>
```

已经应用 Release Ops 后，可以省略 answers：

```powershell
node <release-ops-plugin>/scripts/sentry-sdk-check.mjs --root <repository>
```

检查器只返回平台、[Sentry 官方平台文档](https://docs.sentry.io/platforms/)、建议安装方式、缺失项，以及依赖、初始化和 DSN 证据文件的路径与 SHA-256。它不会返回 DSN、令牌或匹配文本。

- `configured`：三类证据完整，跳过安装器；
- `missing` 或 `partial`：先完成下面的 SDK 接入；
- `ambiguous`：最终产物归属不唯一，不能继续生成计划；
- `unsupported`：当前技术栈没有可安全自动核验的 SDK 路径，按诊断处理。

## 3. 创建或核验 Sentry 项目

使用 `$sentry-project-provisioner` 核验准确的组织、团队和项目标识。用户在 setup 问答中选定的组织、团队、项目标识和 Sentry 服务地址就是创建授权；Codex 会把该项目标识作为内部 `--confirm-slug` 值，不再重复提问。已经存在的项目只做身份核验。尚未选定这些值时必须先询问，不得擅自创建项目。

## 4. 由 Codex 通过 Chrome 获取公开 DSN

公开 DSN 由 Codex 主动获取，不把控制台操作步骤交给用户：

1. Codex 调用 `chrome:control-chrome`，连接用户现有的 Chrome 登录态。不得改用另一个浏览器，也不得读取 Cookie、local storage、密码或浏览器会话文件。
2. 从已核验的 Sentry 服务入口进入组织设置，依次打开准确的组织、项目和 `Client Keys (DSN)` 页面。不得通过搜索结果或相似名称猜测项目。
3. 读取页面中明确标为 `DSN` 或 `Public DSN` 的公开客户端 DSN，并在读取前再次核对页面显示的组织与 project slug。DSN 必须使用 HTTPS、不是占位值，且不得包含密码、查询参数或片段。
4. 不在对话、进度消息、截图、日志或计划中显示 DSN；直接把它用于应用 SDK 配置。不得读取或复用页面上的认证令牌，也不得把 DSN 写入 Release Ops `config/v1`。

Chrome 控制插件未连接时，Codex 暂停并要求用户连接插件；Sentry 未登录时，Codex 暂停并要求用户在同一个 Chrome 中登录，然后从当前步骤继续。Codex 不得要求用户代为查找、复制或粘贴 DSN。

## 5. 安装并初始化应用 SDK

优先使用检查结果给出的方式。

### 官方 Wizard

[Sentry Wizard](https://github.com/getsentry/sentry-wizard) 支持当前平台时，先解析当前版本并固定到精确版本：

```powershell
npm.cmd view @sentry/wizard version --json
npx.cmd @sentry/wizard@<exact-version> -i <integration> --org <organization> --project <project> --url <service-url> --disable-telemetry
```

执行前先展示精确版本和 `git status --short`。不要使用运行时 `@latest`，也不要传 `--ignore-git-changes`。Wizard 失败或被中断后，先检查它已经产生的差异，再决定如何继续，不能直接重复执行。

### Sentry Agent

Wizard 不支持、但 [Sentry Agent Plugin](https://docs.sentry.io/ai/agent-plugin/) 有对应 SDK 参考资料时，使用官方 `sentry-instrument` skill。权限只覆盖当前目标技术栈的 SDK 依赖、推荐初始化和公开 DSN：禁止 Agent 创建项目、制造或验证真实事件、配置版本、源码映射、混淆映射、dSYM 或 DIF 上传、推送代码或发布版本。

### 官方平台手册

Sentry Agent 没有对应 reference 时，Codex 只读取检查结果中的 `docs.sentry.io` 官方平台页，完成最小 SDK 依赖、官方初始化和 public DSN 配置。Unreal 仍只返回不支持诊断，不猜测接入方式。

## 6. 清理安装器副作用

安装后审阅完整工作区差异：

- 保留应用运行时 SDK、初始化和公开 DSN；
- 删除本次安装生成的本地认证文件或令牌行，不输出其中的值；
- 禁用安装器添加的自动版本、源码映射、Proguard 混淆映射、dSYM 或 DIF 上传；
- 保留项目原有与 Sentry 无关的改动。

版本、分发标识与调试产物上传继续只由 Release Ops 的 Sentry 处理器和机密变量角色管理，避免同一次构建重复创建版本或重复上传。

## 7. 重新检查到 `configured`

再次运行只读检查器。依赖、官方初始化或非占位公开 DSN 任一缺失，计划都会失败。计划会保存脱敏证据和文件 SHA-256；应用前若证据文件变化，当前计划会被拒绝。同一 Sentry 项目和其他选择不变时，Codex 会展示重新生成的计划并自动继续。应用后删除任何一类证据，审计也会失败并返回缺失项和官方文档链接。

## 8. 配置四类凭据

| Secret | 职责 | 使用位置 |
| --- | --- | --- |
| `SENTRY_PROJECT_ADMIN_TOKEN` | 创建或核验项目 | 仅本地 provision |
| `SENTRY_ORG_CI_TOKEN` | 上传 mapping、source map、dSYM、PDB、DIF | build/provider step |
| `SENTRY_AUTH_TOKEN` | 读取事故分组和白名单事件字段 | private source 定时 Action |
| `SENTRY_WRITE_TOKEN` | 显式 trailer 触发 resolved 回写 | private source resolver Action |

四个角色不得复用。令牌不得进入对话、源码、应用包、日志、Issue、发布说明或产物；应用只允许包含公开 DSN。写入 GitHub Secret 时，Codex 使用已选仓库作为内部 `--confirm-repository` 值，不逐个要求用户再次确认 Secret 或仓库。

## 9. 计划、自动应用和审计

SDK 检查通过后，Release Ops 才生成完整计划。Codex 先展示配置、处理器图、`extensionChecks`、受管文件、机密变量名称、仓库操作和 SHA-256 摘要，再立即把 `plan.planDigest` 作为内部确认值应用，不要求用户复制或回复摘要。同一用户选择和远端目标下重新计划时，也会展示新计划后自动继续。

应用完成后立即运行审计。成功要求配置、处理器图、工作流和 SDK 证据一致，所需机密变量元数据与远端仓库身份也通过核验。

## 10. 可选真实事件验证

初始化不自动运行应用、注入崩溃、制造测试事件、调用 Sentry MCP、推送代码或发布版本。需要真实事件验证时，用户必须另行明确授权，并单独约定运行环境与数据边界。

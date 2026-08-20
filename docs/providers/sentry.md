# Sentry Provider SOP

## 选择与能力

用户选择一次 Sentry 即授权 setup 配置其已实现能力。GitHub 同时启用时生成完整 Issue 闭环；GitHub 未启用时只配置 SDK、release/dist 和调试符号上传。检测到现有 SDK、DSN、Token 或 workflow 都不会自动选择 Sentry。

能力包括 `configure`、`audit`、`requiredSecrets`、`buildHooks`、`scheduledIngest`、`incidentIntake` 和 `resolve`。

## 四类凭据

| Secret | 职责 | 位置 |
| --- | --- | --- |
| `SENTRY_PROJECT_ADMIN_TOKEN` | 创建/核验项目与读取 public DSN | 本地 provision 步骤 |
| `SENTRY_ORG_CI_TOKEN` | 上传 mapping、dSYM、source map、PDB/DIF | build/provider step |
| `SENTRY_AUTH_TOKEN` | 只读分组与白名单事件字段 | private source 定时 Action |
| `SENTRY_WRITE_TOKEN` | 显式 trailer 触发的 resolved 写入 | private source resolver Action |

Token 不得复用、打印、写入源码、APK、Issue 或 Artifact。应用只允许内置 public DSN。

## Provision

`$sentry-project-provisioner` 先 inspect/dry-run，再经用户确认创建组织下的具体 project slug。缺少 token 时可由用户手工交接，或在已登录浏览器中创建后加密写入目标 Secret；任何出现在聊天或日志中的 token 都视为泄露。

## Build hook

Provider 接收可信的 project、完整 source SHA、release、dist、build unit 和本地调试符号路径。R8 mapping 使用 `upload-proguard`，source map 使用 inject/upload，dSYM/PDB/ELF/WASM 等 DIF 使用 `debug-files upload` 的受限类型或自动识别，Dart symbols 映射为 Breakpad；它不执行配置中的任意命令。`apiBase` 支持 Sentry SaaS 和兼容的自托管 HTTPS `/api/0`。

## Scheduled ingest

同步至少使用 75 分钟重叠窗口，并只跟随同源 `rel=next; results=true` 分页。Issue 内容由固定白名单 schema 构造，禁止原始异常消息、请求、用户、breadcrumb、locals、设备标识和 event JSON。一个 Sentry 分组对应一个 private GitHub Issue；回归重开原 Issue。

## Resolve

默认分支 push 的全部 commit 会先完整预检 `Issues: #...` 与 `Commit-ID: HEAD|<full-sha>`。Resolver 写入可信 start marker，再执行一次 Sentry PUT；响应不确定时不自动重放。只有确认 applied marker 后才评论并关闭 GitHub Issue。

发布与 resolved 独立；Release 成功不能关闭事故。

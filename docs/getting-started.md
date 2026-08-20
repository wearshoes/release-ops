# 新旧项目初始化

本 SOP 同时适用于新项目、已开发项目和旧 Release Ops 项目。推荐由 `$release-ops-setup` 驱动；人工运行 CLI 时必须保持相同授权边界。

## 1. Inspect

在目标仓库读取根级 Agent 指令，再执行：

```bash
node <release-ops>/scripts/release-ops.mjs inspect --root <project>
```

检查 adapter 候选、版本来源候选、签名文件迹象、产物类型、Git remote、默认分支和已有 workflow。Inspect 不读取签名文件内容，也不会根据 SDK、workflow 或 Secret 自动选择 provider。`config/v1` 会返回 `incompatible/reinitialize`；Unreal 会返回 `ADAPTER_UNSUPPORTED`。

## 2. 回答不可发现的决策

每次初始化或重新初始化都必须明确回答：

1. 是否使用 GitHub。
2. 使用已有仓库还是创建仓库；只有创建时询问 private/public。
3. private 源码使用哪个 public 分发仓库。
4. `providerSelection` 是 `["none"]`（也接受显式空数组）还是包含已安装 provider；`none` 不能与 provider 混选。不得省略，也不得根据 SDK 自动填写。选择 None 时配置和 managed files 均不保留该 provider 的项目 runtime。

回答文件使用 `release-ops/setup-answers/v2`。build unit 的命令必须拆成 `executable` 和 `args`，canonical version 与各平台 build number 分开声明。文件中只写 Secret 名称，不写值。

迁移成熟项目时，现有等价 workflow 只能通过 `managedFileAdoptions` 接管：提供目标路径、
与该 workflow 匹配的 `release` 或 `provider:<id>` owner，以及当前 SHA-256。该机制不接受
runtime、配置或任意额外目标，也不会放宽后续 managed-file 冲突检查。

## 3. Plan

```bash
node <release-ops>/scripts/release-ops.mjs plan --root <project> --answers <answers.json> --out <plan.json>
```

Plan 会验证 GitHub visibility/default branch、provider manifest、路径边界及 managed file 的 add/update/delete。审核 `config`、仓库身份、所需 Secret 元数据、文件操作和 `planDigest`。

## 4. Apply

只有用户确认当前 plan 后执行：

```bash
node <release-ops>/scripts/release-ops.mjs apply --plan <plan.json> --confirm <planDigest>
```

Apply 会再次核对文件哈希，然后事务写入。任一 managed file 被人工修改时不写入任何本地文件。GitHub 仓库创建属于独立远端副作用；失败时保留已完成结果供同一 plan 幂等续跑。

## 5. Audit

```bash
node <release-ops>/scripts/release-ops.mjs audit --root <project>
```

`remoteVerified:false` 时 `success` 必须为 false。配置、managed files、GitHub、发布、provider 和事故闭环分别报告，不能把“未运行”伪装为成功。

初始化完成不触发 Release。发版必须另行明确授权并使用项目生成的固定入口。

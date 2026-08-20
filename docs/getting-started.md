# 初始化与审计

所有命令都由已安装 Plugin 的 `scripts/release-ops.mjs` 提供。配置和 answer 文件只能保存 Secret 名称，不能保存凭据值。

## Inspect 路由

```bash
node scripts/release-ops.mjs inspect --root <repository>
```

- 配置缺失：只能 `initialize`。
- 合法 `release-ops/config/v1`：默认 `audit`；显式 `reconfigure` 或 `reinitialize` 可进入只读问答路由。
- 损坏、非法或 `release-ops/config/v2`：只能 `reinitialize`。

`reconfigure` 以当前 `/v1` 值为默认。`reinitialize` 重新询问所有选择，不继承旧 GitHub topology 或 provider 决策。

## 问答顺序

1. stack 与 build unit
2. signing
3. release
4. GitHub topology
5. provider

只有选中的 extension 才会 hydrate config schema、动态问题和文档。Unreal 只返回 unsupported diagnostic，不生成 graph。

## Plan

Answer 使用 `release-ops/setup-answers/v1`。每个 build command 必须拆成 `executable` 和 `args`；每个 extension instance 必须提供 `instanceId`、`extensionId`、`configSchemaVersion` 和严格 `config`。

```bash
node scripts/release-ops.mjs plan \
  --root <repository> \
  --mode initialize \
  --answers <answers.json> \
  --out <plan.json>
```

Plan 展示 config preview、processor graph、managed add/update/delete、Secret roles、仓库操作和稳定 SHA-256 digest。循环、缺失 capability、重复 build-unit owner、输出 merge 冲突、adoption SHA 漂移或 unmanaged target 冲突都会在此阶段失败。

## Apply

```bash
node scripts/release-ops.mjs apply \
  --plan <plan.json> \
  --confirm <exact-plan-digest>
```

Apply 重新核验 plan digest、extension code hash 和全部当前文件 hash。远端仓库操作先按 plan 幂等执行；本地文件使用 staging、持久 journal、backup、原子替换和逆序回滚。远端成功不会被伪装成本地事务回滚。

## Audit

```bash
node scripts/release-ops.mjs audit --root <repository>
```

Audit 检查 config、processor graph、workflow model 和 managed state digest，逐个核对 extension runtime、远端仓库身份和 Secret metadata。`remoteVerified:false` 或任一 digest 漂移都不是成功，必须重新 plan/apply。

旧 `/v2` 项目参见[破坏性 reinitialize](migrations/config-v2.md)。发布操作是独立授权，setup/apply 不会自动发版。

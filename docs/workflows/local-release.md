# 本地发布 SOP

适用于 `hosting.github.enabled=false`。初始化只生成本地 build、可选签名、SHA-256、manifest 和 changelog 打包能力，不生成 GitHub Actions、GitHub Issue 或远端 Release。

## 发版前

- 用户必须在当前请求中明确授权发版。
- 工作区版本、build numbers 和 UTF-8 changelog 必须一致。
- 每个 build unit 的 runner/toolchain 在本机可用，所需签名 Secret 已进入当前进程环境。
- 启用 Sentry 时仅运行 release/dist 与调试符号上传，不声称存在 GitHub 闭环。

## 固定入口

```bash
node .release-ops/runtime/local-release.mjs --root . --version 1.2.3
```

入口依次构建每个 unit、运行 provider build hook、从本地产物计算 SHA-256，并写入 `release.localOutputDirectory/v<version>`。不从远端下载或回读产物。

以后采用 GitHub 时重新执行 setup，明确选择 GitHub 仓库并生成新的 plan。

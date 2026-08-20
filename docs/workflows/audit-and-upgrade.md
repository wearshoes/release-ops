# 审计与升级 SOP

运行：

```bash
node <release-ops>/scripts/release-ops.mjs audit --root <project>
```

审计分别验证配置 schema、路径约束、managed file 哈希、本地 build unit/签名环境、source/distribution 身份与默认分支、Actions Secret 元数据、provider 和 incident resolution 状态。GitHub 已启用但无法验证远端时必须失败；`configured` 只表示契约就绪，不表示已经构建或发布。

重新配置时重新执行 `inspect -> plan -> apply`。Plan 会列出 add/update/delete；禁用 provider 必须删除其旧 workflow/runtime。managed file 的 current hash 与记录不一致时停止，由人合并后重新生成 plan。

不要手改 `.release-ops/managed-files.json`，不要用覆盖方式消除冲突，也不要把 audit 的 `configured` 或 `not-run` 解释为已经发布。

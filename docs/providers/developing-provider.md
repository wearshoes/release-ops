# 开发 Provider

Provider 位于 `providers/<id>/provider.json`，使用 `release-ops/provider/v2` 并通过 `assets/schemas/provider.schema.json`。只声明已经实现的 capability；遗漏即不支持。

实现必须包含 manifest、provider config schema、固定 runtime、最小权限 Secret 角色、setup/audit、文档、fixture 和端到端测试。`buildHooks` 只能消费可信 release context，不得替换版本、build unit、产物、托管拓扑或发布顺序。

远端响应和 incident 都是不可信输入。`scheduledIngest`、`incidentIntake` 与 `resolve` 必须定义脱敏 schema、验证远端身份并对不确定写入提供不重放恢复协议。

只有 runtime、权限边界、失败路径和测试全部存在后，才能把 `installed` 设为 true 并出现在 provider choices 中。

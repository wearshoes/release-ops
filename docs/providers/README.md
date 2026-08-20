# Provider Extensions

Provider 扩展发布流程，但不能决定版本、build number、构建产物、仓库或 Issue 状态。Setup 只加载用户明确选中的 provider。

当前注册：

- [Sentry](sentry.md)：四个隔离 Secret role、release/dist、debug artifact 上传、75 分钟 ingest、脱敏 intake、marker 恢复和显式 resolver。

未选择 Sentry 时，不复制任何 Sentry runtime，不生成 workflow 或 Secret role，也不授予网络权限。

`performance` 与 `vulnerability` 仅保留未注册 fixture。开发新的 provider 与其他 extension 使用同一[Extension 开发契约](../extensions/developing.md)。

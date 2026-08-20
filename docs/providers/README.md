# Provider 索引

Provider 扩展发布，但不能决定版本、build number、产物、仓库或 Issue 状态。Setup 每次都必须让用户整体选择 provider；不存在“检测到 SDK 就启用”的默认行为。

## 已安装

- [Sentry](sentry.md)：release/dist、调试符号、脱敏事故同步和显式 resolved 闭环。

## 未安装

`performance` 与 `vulnerability` 目前只有 contract fixture，不出现在 setup 选项中，也不接受任意 shell、URL 或不透明请求体作为伪 provider。

实现新 provider 请阅读[开发 Provider](developing-provider.md)。

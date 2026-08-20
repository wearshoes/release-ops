# 从 config/v2 迁移

`release-ops/config/v2` 与 `release-ops/config/v1` 是两套不兼容架构。v1.1.0 不包含 adapter、provider 或 config 转换器，也不会从旧配置继承 GitHub topology 或 provider 选择。

## 路由

1. 运行 `inspect`。旧 `/v2` 必须返回 `incompatible` 和 `reinitialize`。
2. 显式运行只读 `reinitialize`，重新选择 stack/build-unit、signing、release、GitHub topology 和 provider。
3. 写入 `release-ops/setup-answers/v1`，运行 `plan --mode reinitialize`。
4. 检查 config preview、processor graph、managed add/update/delete、Secret role、仓库操作和 SHA-256 digest。
5. 只有用户逐字确认实际 digest 后，才运行 `apply --confirm <digest>`。
6. 运行 `audit`，确认 config、graph、workflow digest 和远端身份一致。

旧 workflow 只能通过 `managedFileAdoptions` 迁移。每项 adoption 必须给出当前文件的精确 SHA-256 和新的 extension instance owner；任一字节变化都会停止 plan/apply。

旧 adapter/provider runtime、未选择的 stack runtime 和已禁用 provider runtime 会作为 managed delete 操作移除。项目版本、发布说明和应用 Release 不属于 reinitialize 的隐式操作。

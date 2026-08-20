# 从 config/v1 迁移

`release-ops/config/v1` 不兼容当前契约，不能原地补字段。迁移必须重新初始化：

1. `inspect` 读取旧配置和项目事实，返回 `incompatible/reinitialize`。
2. 重新明确 GitHub、仓库 action/visibility、distribution 和 provider selection。
3. 把 shell 字符串命令改为 `executable + args`，把单一 build 改为平台 build units。
4. 把 canonical version 与平台 build numbers 分开，并把 source/distribution 默认分支分别写入。
5. 生成 plan，核对旧 managed 文件的 update/delete 和 SHA-256，再确认 apply。
6. 运行完整 audit 与该技术栈的聚焦测试。

成熟项目已经存在等价但项目定制的发布或 provider workflow 时，可以在 answers 中加入
`managedFileAdoptions`。每项必须给出目标路径、`release` 或 `provider:<id>` owner，以及当前
文件的完整 SHA-256。只能接管本次配置本来就会生成且 owner 匹配的 workflow，不能接管
runtime 或配置；摘要会纳入 plan digest。接管后 Plugin 保留当前字节，后续人工修改仍作为
整体事务冲突，禁用对应 provider 时仍事务删除。

Apply 只允许在 plan 捕获的旧配置哈希未变化时替换 `config/v1`。项目自有 workflow 或已人工修改的 managed file 不会被静默覆盖。

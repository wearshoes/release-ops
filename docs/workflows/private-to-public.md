# Private-to-public SOP

private 源码仓库必须使用 `dual-repository`。source 与 distribution 各自保存 owner、name、canonical repository identity、visibility 和 default branch；distribution 必须是独立 public 仓库。

新建 distribution 时先初始化默认分支，再写入带 Release Ops marker 的根 README。重试只接管相同 managed README 或 GitHub 自动生成的空白 README；发现人工内容时停止，不覆盖。

## 权限

- source Release 使用仓库自带 `GITHUB_TOKEN`。
- public distribution 只使用绑定该仓库的 `RELEASE_REPO_TOKEN`。
- 自动事故、Debug 包和诊断数据只能进入 private source。

## 顺序与恢复

1. 对 source/public 创建或接管相同 tag、标题和完整 changelog 的 draft。
2. 从本次 Action 聚合结果向两端上传完全相同的字节、manifest 和本地 SHA-256。
3. 更新 public 仓库的根 README 与 `latest.json`；public 源码模式只更新 `docs/releases/README.md`。
4. 先发布 private Release，最后发布 public Release。
5. 部分成功不删除、不回滚；使用原 version、source SHA 和 correlation 幂等续跑。

公开 manifest 不得包含 source 仓库名称、private commit、workflow/run ID 或内部 URL。

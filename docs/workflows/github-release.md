# GitHub Release SOP

适用于已完成 setup/audit 的 GitHub 项目。public 源码使用 `same-repository`；private 源码继续阅读 [Private-to-public](private-to-public.md)。

## 门禁

- 当前请求明确授权发版，工作区清洁且位于 source default branch。
- 本地 HEAD 与远端 default branch 是同一完整 SHA。
- canonical version、各平台 build number、UTF-8 changelog 和 Secret 元数据通过检查。
- 不把初始化、合并、版本变更或 provider resolved 当作发版授权。

## 固定入口

```bash
node .release-ops/runtime/kernel/github-release-entry.mjs --root . --version 1.2.3
```

入口只 dispatch 一次并固定返回的 workflow run ID。POST 结果不确定时，只按唯一 correlation 分页接管已接受 run，不重发请求。

只有一个 build unit 时，Action 在同一个 job 内完成构建和发布，不经过 Actions Artifact 存储。多个 build unit 跨 runner 时才使用一天内失效的 Actions Artifact 聚合本地字节和 SHA-256，然后创建 Release、`release-manifest.json` 与 `latest.json`。禁止从远端 Release 下载再分发，也禁止发布后回读冒充验收。

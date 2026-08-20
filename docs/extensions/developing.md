# Extension 开发契约

Extension 位于 `extensions/<type>/<id>/`，使用语义短 ID 和 `release-ops/extension/v1` manifest。Manifest 声明严格 config schema、文档、依赖、processors、runtime files、Secret roles、命令和 HTTPS origins。

## Registry 与加载

Inspect 只读取轻量 manifest 和 detection。用户选中 extension 后，Kernel 才 hydrate 它的 config schema、动态问题、文档、processor module 和 runtime，并计算代码 SHA-256。Kernel 不允许按具体 extension ID 分支。

## Processor

Processor 使用 `release-ops/processor/v1`，节点 ID 为 `<instanceId>:<processorId>`。`before/after` 只能引用同一 manifest 内的 processor ID；跨实例依赖必须声明 capability。

- `exclusive` 只能有一个 producer。
- `append` 按 graph order 聚合。
- `keyed` 生成无重复 key 的映射。
- `one` 必须得到唯一 producer，`many` 得到有序集合，非 optional 缺失会阻止 plan。

`scheduled-ingest` 与 `resolve` 是独立入口，不得混入 release lane。

## 权限边界

Extension module 只接收冻结 context 和 Kernel API。禁止直接使用文件写入、`child_process`、完整 `process.env`、原生 `fetch/http/https`、shell 字符串或 YAML 片段。

Kernel API 只提供：

- 仓库内、symlink-safe 的只读文本/JSON/字节访问；
- manifest 允许命令的 `execFile(..., shell:false)`；
- 按 role 注入的 Secret，extension 永远拿不到 Secret 值清单；
- manifest 允许的精确同源 HTTPS；
- managed-file contribution；
- 结构化 workflow contribution。

Workflow step 只能使用 pinned 40 位 action SHA 或 processor invocation。YAML 与固定 `node .release-ops/runtime/kernel/execute.mjs` trampoline 由 Kernel renderer 生成。

## 验证

新增 extension 必须提供 manifest、严格 schema、文档、fixture 和聚焦测试，并通过：

```bash
node scripts/validate-boundaries.mjs
node scripts/generate-readme.mjs --check
python scripts/validate_self.py
```

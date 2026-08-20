# .NET

## 检测与目标

检测 `.sln`、`.csproj`，按 Linux/Windows/macOS 目标选择对应 runner。Action 配置 .NET 8 SDK；项目可在命令参数中固定其他 target framework/runtime。

## 版本、构建与签名

canonical version 与平台/包 build number 分开。使用 `dotnet` 加 `restore/test/publish/pack` 等参数；代码签名 Secret 只进入需要它的 unit。

## 产物与 Sentry

发布 binary、NuGet 包或平台归档；Sentry 上传 portable/native PDB 与适用 DIF。

## 验收与限制

验证 RID、架构、版本、签名与 trimming/AOT 产物。NuGet feed 推送不是默认 GitHub Release 行为。

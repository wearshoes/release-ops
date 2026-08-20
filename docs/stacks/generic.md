# Generic Adapter

## 适用范围

仅在没有正式 stack extension 且项目能够明确描述 runner、结构化命令、版本来源和文件产物时使用。Generic 不是绕过 unsupported 诊断的开关。

## 必填契约

每个 build unit 明确 target、runner、`executable + args`、所需 Secret 名称、产物路径、下载名称、content type、平台和架构。自定义工具链可显式使用 `runner: self-hosted`，并必须填写 `selfHostedReason`。canonical version 与 build numbers 必须使用受支持 reader。

## Provider 与验收

默认没有调试符号映射。只有 provider 实现了该产物类型的固定 hook 后才能配置。验收必须运行项目自有测试/build，并确认产物存在、路径留在仓库内且 SHA-256 稳定。

不得配置任意 shell、任意 API URL 或 opaque body 来伪装 stack/provider extension。

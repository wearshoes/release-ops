# Unreal Engine

Release Ops 会检测 `.uproject`，但当前返回 `UNREAL_UNSUPPORTED` diagnostic，不会生成可执行 workflow，也不会把 Unreal 列为已支持 stack。

原因不是 Unreal 不能自动化，而是普通可复用 hosted 契约尚未覆盖引擎安装来源、许可、平台 SDK、BuildGraph/UAT、缓存、签名和调试符号的端到端验证。

不要选择 Generic 绕过此诊断并宣称受支持。要增加支持，必须先实现 Unreal extension manifest、合法 runner/toolchain 契约、产物和符号处理、凭据边界、fixture、文档与端到端测试。

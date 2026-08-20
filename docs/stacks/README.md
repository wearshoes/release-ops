# 技术栈索引

Setup 只读取检测到或用户选定 adapter 的页面；不要一次加载全部技术栈文档。检测有歧义时必须由用户确认 build root。

| Adapter | 状态 | SOP |
| --- | --- | --- |
| `android-gradle` | 支持 | [Android](android.md) |
| `apple-xcode` | 支持 | [Apple](apple.md) |
| `javascript` | 支持 | [JavaScript](javascript.md) |
| `dotnet` | 支持 | [.NET](dotnet.md) |
| `native` | 支持 | [Native](native.md) |
| `flutter` | 支持 | [Flutter](flutter.md) |
| `react-native` | 支持 | [React Native](react-native.md) |
| `godot` | 支持 hosted runner | [Godot](godot.md) |
| `unity` | GameCI，凭据门禁 | [Unity](unity.md) |
| `generic` | 显式配置 | [Generic](generic.md) |
| `unreal` | 不支持 | [Unreal](unreal.md) |

所有 adapter 都使用独立 build unit、结构化命令、仓库内路径和本地 SHA-256。平台产物和 provider 调试符号是两个不同清单。

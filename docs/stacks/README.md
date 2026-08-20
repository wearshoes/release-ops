# Stack Extensions

Stack extension 自己负责 detection、版本来源、runner、build units、正式产物和 debug artifacts。Setup 只读取检测到或用户选中的 stack 文档。

| Extension | 状态 | 文档 |
| --- | --- | --- |
| `android` | supported | [Android](android.md) |
| `apple` | supported | [Apple](apple.md) |
| `javascript` | supported | [JavaScript](javascript.md) |
| `dotnet` | supported | [.NET](dotnet.md) |
| `native` | supported | [Native](native.md) |
| `flutter` | supported | [Flutter](flutter.md) |
| `react-native` | supported | [React Native](react-native.md) |
| `godot` | hosted runner matrix | [Godot](godot.md) |
| `unity` | credential-gated | [Unity](unity.md) |
| `generic` | explicit executable/args only | [Generic](generic.md) |
| `unreal` | diagnostic only | [Unreal](unreal.md) |

每个 build unit 由一个 stack instance 独占。Generic 不接受 shell 字符串；self-hosted runner 必须给出原因。跨 stack 的 canonical version 和 changelog 契约必须一致后才能发布。

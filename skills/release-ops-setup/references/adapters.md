# Build Adapters

Release Ops classifies artifacts into four handlers and composes them for framework adapters.

| Adapter | Detection | Release artifacts | Sentry debug artifacts |
| --- | --- | --- | --- |
| `android-gradle` | `gradlew` and Android Gradle files | APK/AAB | R8 mapping, optional native DIF |
| `apple-xcode` | `.xcodeproj` or `.xcworkspace` | IPA/pkg/archive | dSYM/DIF |
| `javascript` | `package.json` | configured bundles/packages | source maps/artifact bundles |
| `dotnet` | `.sln` or `.csproj` | configured binaries/packages | portable/native PDB |
| `native` | CMake/Meson/Cargo/native build files | configured binaries | ELF/DWARF/PDB/dSYM |
| `flutter` | `pubspec.yaml` with Flutter | platform packages | Dart symbols/source maps plus platform DIF |
| `react-native` | React Native package metadata | platform packages | JS source maps plus platform DIF |
| `unity` | `ProjectSettings/ProjectVersion.txt` | exported player packages | target-platform source maps/DIF/R8 |
| `godot` | `project.godot` | exported packages | target-platform source maps/DIF |
| `unreal` | `.uproject` | packaged builds | target-platform DIF |
| `generic` | explicit selection | configured paths | none unless a provider adapter is configured |

Detection can return several candidates. Never select among ambiguous build roots without user confirmation. A configured artifact path must exist after the build; otherwise publication fails before any Release mutation.

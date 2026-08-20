export const PROVIDER_SCHEMA = "release-ops/provider/v1";

export const BUILD_ADAPTERS = Object.freeze([
    { id: "android-gradle", detects: ["gradlew", "build.gradle.kts", "build.gradle"], artifacts: ["apk", "aab"], debugArtifacts: ["proguard", "dif"] },
    { id: "apple-xcode", detects: ["*.xcodeproj", "*.xcworkspace"], artifacts: ["ipa", "pkg", "archive"], debugArtifacts: ["dif"] },
    { id: "javascript", detects: ["package.json"], artifacts: ["bundle", "package"], debugArtifacts: ["source-map"] },
    { id: "dotnet", detects: ["*.sln", "*.csproj"], artifacts: ["binary", "package"], debugArtifacts: ["dif"] },
    { id: "native", detects: ["CMakeLists.txt", "meson.build", "Cargo.toml"], artifacts: ["binary"], debugArtifacts: ["dif"] },
    { id: "flutter", detects: ["pubspec.yaml"], artifacts: ["platform-package"], debugArtifacts: ["source-map", "dif"] },
    { id: "react-native", detects: ["package.json"], artifacts: ["platform-package"], debugArtifacts: ["source-map", "dif"] },
    { id: "unity", detects: ["ProjectSettings/ProjectVersion.txt"], artifacts: ["player-package"], debugArtifacts: ["source-map", "proguard", "dif"] },
    { id: "godot", detects: ["project.godot"], artifacts: ["export-package"], debugArtifacts: ["source-map", "dif"] },
    { id: "unreal", detects: ["*.uproject"], artifacts: ["packaged-build"], debugArtifacts: ["dif"] },
    { id: "generic", detects: [], artifacts: ["configured"], debugArtifacts: [] },
]);

export const PROVIDERS = Object.freeze({
    sentry: Object.freeze({
        schemaVersion: PROVIDER_SCHEMA,
        id: "sentry",
        category: "observability",
        capabilities: [
            "configure",
            "audit",
            "requiredSecrets",
            "buildHooks",
            "scheduledIngest",
            "incidentIntake",
            "resolve",
        ],
        requiredSecrets: Object.freeze({
            projectProvision: "SENTRY_PROJECT_ADMIN_TOKEN",
            buildUpload: "SENTRY_ORG_CI_TOKEN",
            incidentRead: "SENTRY_AUTH_TOKEN",
            incidentWrite: "SENTRY_WRITE_TOKEN",
        }),
    }),
});

export function providerChoices() {
    return ["none", ...Object.keys(PROVIDERS).sort()];
}

export function adapterById(id) {
    return BUILD_ADAPTERS.find((adapter) => adapter.id === id) ?? null;
}

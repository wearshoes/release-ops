import assert from "node:assert/strict";
import test from "node:test";

import { CONFIG_SCHEMA, RELEASE_SCHEMA, validateConfig } from "../config.mjs";
import { BUILD_ADAPTERS, PROVIDERS, providerChoices } from "../provider-registry.mjs";

function fixture(overrides = {}) {
    return {
        schemaVersion: CONFIG_SCHEMA,
        project: { name: "Example", adapter: "android-gradle" },
        build: {
            command: "./gradlew assembleRelease",
            artifacts: [{
                id: "app",
                path: "app/build/outputs/apk/release/app-release.apk",
                nameTemplate: "example-v{version}.apk",
                contentType: "application/vnd.android.package-archive",
                platform: "android",
                architecture: "universal",
            }],
        },
        versioning: {
            file: "gradle.properties",
            versionKey: "VERSION_NAME",
            codeKey: "VERSION_CODE",
            changelogPattern: "docs/releases/v{version}.md",
            requiresChinese: false,
        },
        hosting: {
            github: {
                enabled: true,
                sourceRepository: "owner/example",
                sourceVisibility: "private",
                defaultBranch: "main",
                releaseMode: "dual-repository",
                publicRepository: "owner/example-releases",
            },
        },
        release: {
            workflowFile: ".github/workflows/publish-release.yml",
            tagTemplate: "v{version}",
            titleTemplate: "Example {version}",
            manifestSchema: RELEASE_SCHEMA,
            publicReadme: "docs/public-release-readme.md",
            latestManifest: "latest.json",
        },
        providers: {
            sentry: {
                enabled: true,
                schemaVersion: PROVIDERS.sentry.schemaVersion,
                organization: "owner",
                project: "example",
                host: "owner.sentry.io",
                issueSync: true,
            },
        },
        ...overrides,
    };
}

test("validates a private dual-repository Sentry project", () => {
    assert.equal(validateConfig(fixture()).schemaVersion, CONFIG_SCHEMA);
});

test("enforces hosting topology", () => {
    const value = fixture();
    value.hosting.github.releaseMode = "same-repository";
    assert.throws(() => validateConfig(value), /private sources must use dual-repository/u);
});

test("disabling GitHub prevents Sentry issue sync", () => {
    const value = fixture();
    value.hosting.github = {
        enabled: false,
        sourceRepository: null,
        sourceVisibility: "none",
        defaultBranch: "main",
        releaseMode: "local",
        publicRepository: null,
    };
    assert.throws(() => validateConfig(value), /issueSync requires GitHub/u);
    value.providers.sentry.issueSync = false;
    assert.equal(validateConfig(value).hosting.github.releaseMode, "local");
});

test("rejects credential-shaped config fields", () => {
    const value = fixture();
    value.providers.sentry.authToken = "must-not-exist";
    assert.throws(() => validateConfig(value), /credential material/u);
});

test("registers all planned adapters and only implemented providers", () => {
    assert.deepEqual(providerChoices(), ["none", "sentry"]);
    assert.deepEqual(
        BUILD_ADAPTERS.map(({ id }) => id),
        ["android-gradle", "apple-xcode", "javascript", "dotnet", "native", "flutter", "react-native", "unity", "godot", "unreal", "generic"],
    );
});

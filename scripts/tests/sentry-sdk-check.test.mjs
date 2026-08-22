import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import { createKernelApi } from "../kernel-api.mjs";
import { inspectSentrySdk } from "../sentry-sdk-check.mjs";
import {
    checkSentrySdk,
    SENTRY_PLATFORM_ROUTES,
    SENTRY_SDK_CHECK_SCHEMA,
} from "../processors/sentry-sdk-check.mjs";
import { addAndroidSentrySdk, answersFor, baseConfig, fixtureRoot } from "./fixtures.mjs";

function configFor(stack) {
    return baseConfig({ sentry: true, stack });
}

function sentryInstance(config) {
    return config.extensions.find(({ extensionId }) => extensionId === "sentry");
}

function graphFor(...owners) {
    return {
        buildUnitOwners: Object.fromEntries(owners.map((owner, index) => [`unit-${index}`, owner])),
    };
}

function apiFor(root) {
    return createKernelApi({
        root,
        node: {
            id: "sentry:plan",
            instanceId: "sentry",
            permissions: { commands: [], networkOrigins: [], outputRoots: [] },
            secretRoles: [],
        },
    });
}

async function write(root, path, content) {
    const target = join(root, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
}

async function check(root, stack, graph = graphFor("application")) {
    const config = configFor(stack);
    return checkSentrySdk({ api: apiFor(root), config, graph, instance: sentryInstance(config) });
}

test("all built-in stacks have deterministic official Sentry documentation and installer routing", () => {
    assert.deepEqual(Object.keys(SENTRY_PLATFORM_ROUTES).sort(), [
        "android", "apple", "dotnet", "flutter", "generic", "godot", "javascript", "native", "react-native", "unity", "unreal",
    ]);
    for (const [stack, route] of Object.entries(SENTRY_PLATFORM_ROUTES)) {
        assert.match(route.docsUrl, /^https:\/\/docs\.sentry\.io\/platforms\//u, stack);
        assert.equal(["wizard", "agent", "manual", "none"].includes(route.installer.method), true, stack);
    }
    assert.equal(SENTRY_PLATFORM_ROUTES.android.installer.integration, "android");
    assert.equal(SENTRY_PLATFORM_ROUTES.apple.installer.integration, "ios");
    assert.equal(SENTRY_PLATFORM_ROUTES.native.installer.method, "manual");
    assert.equal(SENTRY_PLATFORM_ROUTES.unreal.unsupported, true);
});

test("configured SDK evidence is recognized for every supported concrete stack", async () => {
    const fixtures = [
        {
            stack: "apple",
            files: {
                "Package.swift": ".package(url: \"https://github.com/getsentry/sentry-cocoa\", from: \"8.0.0\")\n",
                "Sources/App.swift": "SentrySDK.start { options in options.dsn = \"https://abcdef12@o1.ingest.sentry.io/1\" }\n",
            },
        },
        {
            stack: "dotnet",
            files: {
                "App.csproj": "<Project><ItemGroup><PackageReference Include=\"Sentry\" Version=\"5.0.0\" /></ItemGroup></Project>\n",
                "Program.cs": "SentrySdk.Init(o => o.Dsn = \"https://abcdef12@o1.ingest.sentry.io/2\");\n",
            },
        },
        {
            stack: "native",
            files: {
                "CMakeLists.txt": "find_package(sentry REQUIRED)\n",
                "src/main.cpp": "sentry_options_set_dsn(options, \"https://abcdef12@o1.ingest.sentry.io/3\"); sentry_init(options);\n",
            },
        },
        {
            stack: "flutter",
            files: {
                "pubspec.yaml": "dependencies:\n  sentry_flutter: ^9.0.0\n",
                "lib/main.dart": "SentryFlutter.init((options) => options.dsn = 'https://abcdef12@o1.ingest.sentry.io/4');\n",
            },
        },
        {
            stack: "react-native",
            files: {
                "package.json": "{\"dependencies\":{\"@sentry/react-native\":\"7.0.0\"}}\n",
                "index.js": "Sentry.init({ dsn: 'https://abcdef12@o1.ingest.sentry.io/5' });\n",
            },
        },
        {
            stack: "godot",
            files: {
                "addons/sentry/plugin.cfg": "name=\"Sentry\"\n",
                "project.godot": "[editor_plugins]\nenabled=PackedStringArray(\"res://addons/sentry/plugin.cfg\")\n[sentry/options]\ndsn=\"https://abcdef12@o1.ingest.sentry.io/6\"\n",
            },
        },
        {
            stack: "unity",
            files: {
                "Packages/manifest.json": "{\"dependencies\":{\"io.sentry.unity\":\"5.0.0\"}}\n",
                "Assets/Resources/SentryOptions.asset": "SentryOptions:\n  Dsn: https://abcdef12@o1.ingest.sentry.io/7\n",
            },
        },
    ];
    for (const fixture of fixtures) {
        const root = await fixtureRoot(`release-ops-sentry-${fixture.stack}-`);
        for (const [path, content] of Object.entries(fixture.files)) await write(root, path, content);
        const result = await check(root, fixture.stack);
        assert.equal(result.status, "configured", `${fixture.stack}: ${JSON.stringify(result)}`);
        assert.deepEqual([...new Set(result.evidence.map(({ type }) => type))].sort(), ["dsn", "initialization", "sdk"]);
    }
});

test("Android official auto-initialization produces only redacted, hashed evidence", async () => {
    const root = await fixtureRoot("release-ops-sentry-android-");
    await addAndroidSentrySdk(root);
    const result = await check(root, "android");
    assert.equal(result.schemaVersion, SENTRY_SDK_CHECK_SCHEMA);
    assert.equal(result.status, "configured");
    assert.equal(result.platform, "android");
    assert.deepEqual(result.missing, []);
    assert.equal(result.evidence.every(({ sha256 }) => /^[0-9a-f]{64}$/u.test(sha256)), true);
    assert.doesNotMatch(JSON.stringify(result), /abcdef12|ingest\.sentry/u);
});

test("the agent-facing checker reads setup answers without writing project state", async () => {
    const root = await fixtureRoot("release-ops-sentry-command-");
    await addAndroidSentrySdk(root);
    const config = configFor("android");
    config.extensions.at(-1).config.issueSync = false;
    const answersPath = join(root, "setup-answers.json");
    await writeFile(answersPath, JSON.stringify(answersFor(config)), "utf8");
    const result = await inspectSentrySdk({ root, answersPath });
    assert.equal(result.status, "configured");
    assert.equal(result.platform, "android");
});

test("missing and partial states reject placeholder DSNs", async () => {
    const missingRoot = await fixtureRoot("release-ops-sentry-missing-");
    const missing = await check(missingRoot, "android");
    assert.equal(missing.status, "missing");
    assert.deepEqual(missing.missing, ["sdk", "initialization", "dsn"]);

    const partialRoot = await fixtureRoot("release-ops-sentry-partial-");
    await write(partialRoot, "app/build.gradle.kts", "plugins { id(\"io.sentry.android.gradle\") }\n");
    await write(partialRoot, "gradle.properties", "SENTRY_DSN=https://public@example.ingest.sentry.io/123\n");
    const partial = await check(partialRoot, "android");
    assert.equal(partial.status, "partial");
    assert.deepEqual(partial.missing, ["initialization", "dsn"]);
    assert.doesNotMatch(JSON.stringify(partial), /public@example/u);
});

test("JavaScript framework routing follows official priority before the installed Sentry package", async () => {
    const root = await fixtureRoot("release-ops-sentry-javascript-");
    await write(root, "package.json", JSON.stringify({ dependencies: {
        "@sentry/browser": "9.0.0", react: "19.0.0", next: "15.0.0",
    } }));
    await write(root, "sentry.client.config.ts", "Sentry.init({ dsn: 'https://abcdef12@o1.ingest.sentry.io/8' });\n");
    const result = await check(root, "javascript");
    assert.equal(result.status, "configured");
    assert.equal(result.platform, "javascript-nextjs");
    assert.deepEqual(result.installer, { method: "wizard", integration: "nextjs" });
});

test("final artifact ownership selects Android even when JavaScript tooling is present", async () => {
    const root = await fixtureRoot("release-ops-sentry-syosetu-shape-");
    await addAndroidSentrySdk(root);
    await write(root, "package.json", "{\"dependencies\":{\"@sentry/browser\":\"9.0.0\"}}\n");
    await write(root, "scripts/tool.mjs", "Sentry.init({ dsn: 'https://abcdef12@o1.ingest.sentry.io/99' });\n");
    const result = await check(root, "android");
    assert.equal(result.status, "configured");
    assert.equal(result.platform, "android");
    assert.deepEqual(result.candidates, [{ instanceId: "application", extensionId: "android" }]);
});

test("multiple final artifact owners are ambiguous and generic or Unreal targets are unsupported", async () => {
    const root = await fixtureRoot("release-ops-sentry-targets-");
    const config = configFor("android");
    config.extensions.splice(1, 0, {
        ...structuredClone(config.extensions[0]), instanceId: "web", extensionId: "javascript",
        configSchemaVersion: "release-ops/extension-config/javascript/v1",
    });
    const ambiguous = await checkSentrySdk({
        api: apiFor(root), config, graph: graphFor("application", "web"), instance: sentryInstance(config),
    });
    assert.equal(ambiguous.status, "ambiguous");
    assert.deepEqual(ambiguous.missing, ["target-owner"]);
    assert.equal((await check(root, "generic")).status, "unsupported");
    assert.equal((await check(root, "unreal")).status, "unsupported");
});

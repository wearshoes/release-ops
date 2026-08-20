import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { BUILD_ADAPTERS, PROVIDERS } from "../provider-registry.mjs";
import { planSentryBuildHook, runSentryBuildHook } from "../sentry-build-hook.mjs";
import { baseConfig, BUILD_NUMBERS, fixtureRoot, SOURCE_SHA } from "./fixtures.mjs";

test("disabled provider has no build commands", async () => {
    const plan = await planSentryBuildHook(baseConfig(), { version: "1.2.3", buildNumbers: BUILD_NUMBERS, sourceSha: SOURCE_SHA });
    assert.equal(plan.enabled, false);
    assert.deepEqual(plan.commands, []);
});

test("Sentry upload and release plans use fixed sentry-cli operations", async () => {
    const root = await fixtureRoot("release-ops-sentry-hook-");
    const config = structuredClone(baseConfig({ sentry: true }));
    config.providers.sentry.debugArtifacts = [
        { type: "proguard", path: "build/example.bin", unit: "desktop" },
        { type: "source-map", path: "build/example.bin", unit: "desktop" },
        { type: "dif", path: "build/example.bin", unit: "desktop" },
        { type: "dart-symbol", path: "build/example.bin", unit: "desktop" },
    ];
    const upload = await planSentryBuildHook(config, {
        root, version: "1.2.3", buildNumbers: BUILD_NUMBERS, sourceSha: SOURCE_SHA, unitId: "desktop", mode: "upload",
    });
    assert.equal(upload.release, "application@example-1.2.3");
    assert.equal(upload.dist, "9");
    assert.equal(upload.commands.every(({ executable }) => executable === "sentry-cli"), true);
    assert.equal(upload.commands.some(({ args }) => args[0] === "upload-proguard" && !args.includes("--type")), true);
    assert.equal(upload.commands.some(({ args }) => args[0] === "sourcemaps" && args[1] === "upload"), true);
    assert.equal(upload.commands.some(({ args }) => args[0] === "debug-files" && !args.includes("--type")), true);
    assert.equal(upload.commands.some(({ args }) => args.includes("--type") && args.includes("breakpad")), true);
    const release = await planSentryBuildHook(config, {
        root, version: "1.2.3", buildNumbers: BUILD_NUMBERS, sourceSha: SOURCE_SHA, mode: "release",
    });
    assert.deepEqual(release.commands.map(({ args }) => args.slice(0, 2).join(" ")), [
        "releases new", "releases set-commits", "releases finalize",
    ]);
    assert.doesNotMatch(JSON.stringify({ upload, release }), /SENTRY_ORG_CI_TOKEN|token-value/u);
});

test("Sentry release templates can use validated adapter identifiers", async () => {
    const config = structuredClone(baseConfig({ sentry: true }));
    config.project.adapterOptions = { applicationId: "com.example.app" };
    config.providers.sentry.releaseTemplate = "{applicationId}@{version}+{windows}";
    const plan = await planSentryBuildHook(config, {
        version: "1.2.3", buildNumbers: BUILD_NUMBERS, sourceSha: SOURCE_SHA, mode: "release",
    });
    assert.equal(plan.release, "com.example.app@1.2.3+9");
});

test("build hook passes only its CI credential to child commands", async () => {
    const root = await fixtureRoot("release-ops-sentry-env-");
    const plan = await planSentryBuildHook(baseConfig({ sentry: true }), {
        root, version: "1.2.3", buildNumbers: BUILD_NUMBERS, sourceSha: SOURCE_SHA, mode: "release",
    });
    const calls = [];
    const result = await runSentryBuildHook(plan, {
        env: { PATH: "bin", SENTRY_ORG_CI_TOKEN: "token-value", RELEASE_REPO_TOKEN: "hidden" },
        exec: async (executable, args, options) => calls.push({ executable, args, env: options.env }),
    });
    assert.equal(result.commandCount, calls.length);
    assert.equal(calls.every(({ args }) => !args.includes("token-value")), true);
    assert.equal(calls.every(({ env }) => env.SENTRY_AUTH_TOKEN === "token-value" && env.RELEASE_REPO_TOKEN === undefined), true);
    assert.equal(calls.every(({ env }) => env.SENTRY_URL === "https://owner.sentry.io"), true);
});

test("fixtures cover manifests while placeholder provider categories stay uninstalled", async () => {
    const fixtures = JSON.parse(await readFile(new URL("../../assets/fixtures/adapters.json", import.meta.url), "utf8"));
    assert.deepEqual(fixtures.fixtures.map(({ adapter }) => adapter).sort(), BUILD_ADAPTERS.map(({ id }) => id).sort());
    assert.deepEqual(Object.keys(PROVIDERS), ["sentry"]);
    for (const name of ["performance", "vulnerability"]) {
        const fixture = JSON.parse(await readFile(new URL(`../../assets/fixtures/providers/${name}.example.json`, import.meta.url), "utf8"));
        assert.equal(fixture.installed, false);
        assert.equal(fixture.schemaVersion, "release-ops/provider/v2");
    }
});

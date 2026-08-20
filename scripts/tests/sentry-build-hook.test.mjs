import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadExtensionCatalog } from "../extension-registry.mjs";
import { planSentryBuildHook, runSentryBuildHook } from "../sentry-build-hook.mjs";
import { baseConfig, BUILD_NUMBERS, fixtureRoot, SOURCE_SHA } from "./fixtures.mjs";

function sentry(config) {
    return config.extensions.find(({ instanceId }) => instanceId === "sentry").config;
}

test("unselected Sentry has no build commands", async () => {
    const plan = await planSentryBuildHook(baseConfig(), {
        version: "1.2.3", buildNumbers: BUILD_NUMBERS, sourceSha: SOURCE_SHA,
    });
    assert.equal(plan.enabled, false);
    assert.deepEqual(plan.commands, []);
});

test("Sentry upload and release plans use fixed sentry-cli operations", async () => {
    const root = await fixtureRoot("release-ops-sentry-hook-");
    const config = structuredClone(baseConfig({ mode: "dual-repository", sentry: true }));
    sentry(config).debugArtifacts = [
        { type: "proguard", path: "build/example.bin", buildUnitId: "desktop" },
        { type: "source-map", path: "build/example.bin", buildUnitId: "desktop" },
        { type: "dif", path: "build/example.bin", buildUnitId: "desktop" },
        { type: "dart-symbol", path: "build/example.bin", buildUnitId: "desktop" },
    ];
    const upload = await planSentryBuildHook(config, {
        root, version: "1.2.3", buildNumbers: BUILD_NUMBERS, sourceSha: SOURCE_SHA, unitId: "desktop", mode: "upload",
    });
    assert.equal(upload.release, "application@1.2.3");
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

test("Sentry release templates read application data from the selected stack instance", async () => {
    const config = structuredClone(baseConfig({ mode: "dual-repository", sentry: true }));
    config.extensions[0].config.application = { applicationId: "com.example.app" };
    sentry(config).releaseTemplate = "{applicationId}@{version}+{windows}";
    const plan = await planSentryBuildHook(config, {
        version: "1.2.3", buildNumbers: BUILD_NUMBERS, sourceSha: SOURCE_SHA, mode: "release",
    });
    assert.equal(plan.release, "com.example.app@1.2.3+9");
});

test("build hook passes only its CI credential to child commands", async () => {
    const root = await fixtureRoot("release-ops-sentry-env-");
    const plan = await planSentryBuildHook(baseConfig({ mode: "dual-repository", sentry: true }), {
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
    assert.equal(calls.every(({ env }) => env.SENTRY_URL === "https://sentry.io"), true);
});

test("fixtures cover stack manifests while performance and vulnerability remain unregistered", async () => {
    const fixtures = JSON.parse(await readFile(new URL("../../assets/fixtures/stacks.json", import.meta.url), "utf8"));
    const catalog = await loadExtensionCatalog();
    const stacks = Object.values(catalog).filter(({ type }) => type === "stack").map(({ id }) => id).sort();
    assert.deepEqual(fixtures.fixtures.map(({ stack }) => stack).sort(), stacks);
    for (const name of ["performance", "vulnerability"]) {
        const fixture = JSON.parse(await readFile(new URL(`../../assets/fixtures/providers/${name}.example.json`, import.meta.url), "utf8"));
        assert.equal(fixture.installed, false);
        assert.equal(Object.hasOwn(catalog, name), false);
    }
});

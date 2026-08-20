import assert from "node:assert/strict";
import test from "node:test";

import { CONFIG_SCHEMA, RELEASE_SCHEMA, validateConfig } from "../config.mjs";
import { BUILD_ADAPTERS, PROVIDERS } from "../provider-registry.mjs";
import { baseConfig } from "./fixtures.mjs";

test("validates the v2 private dual-repository Sentry contract", () => {
    const config = baseConfig({ sentry: true });
    assert.equal(config.schemaVersion, CONFIG_SCHEMA);
    assert.equal(config.release.manifestSchema, RELEASE_SCHEMA);
    assert.equal(config.build.units[0].command.executable, "node");
    assert.equal(config.hosting.github.source.defaultBranch, "main");
    assert.equal(config.hosting.github.source.owner, "private-owner");
    assert.equal(config.hosting.github.source.name, "private-source");
    assert.equal(config.hosting.github.distribution.visibility, "public");
    assert.equal(config.providers.sentry.lookbackMinutes, 75);
});

test("rejects shell commands, repository escapes, and unsupported Unreal", () => {
    const shell = structuredClone(baseConfig());
    shell.build.units[0].command.shell = true;
    assert.throws(() => validateConfig(shell), /shell is forbidden/u);
    const escape = structuredClone(baseConfig());
    escape.build.units[0].artifacts[0].path = "../private.bin";
    assert.throws(() => validateConfig(escape), /unsafe path/u);
    const unreal = structuredClone(baseConfig());
    unreal.project.adapter = "unreal";
    assert.throws(() => validateConfig(unreal), /detected but unsupported/u);
});

test("enforces GitHub topology and provider isolation", () => {
    const publicConfig = structuredClone(baseConfig({ mode: "same-repository" }));
    publicConfig.hosting.github.distribution = {
        repository: "owner/releases", owner: "owner", name: "releases", visibility: "public", defaultBranch: "main",
    };
    assert.throws(() => validateConfig(publicConfig), /no separate distribution/u);
    const local = structuredClone(baseConfig({ github: false }));
    local.providers.sentry = {
        ...baseConfig({ github: false, sentry: true }).providers.sentry,
        issueSync: true,
    };
    assert.throws(() => validateConfig(local), /issueSync requires GitHub/u);
});

test("rejects inconsistent split repository identities", () => {
    const config = structuredClone(baseConfig());
    config.hosting.github.source.owner = "someone-else";
    assert.throws(() => validateConfig(config), /remote identity is inconsistent/u);
});

test("self-hosted fallback requires adapter support and an explicit reason", () => {
    const android = structuredClone(baseConfig());
    android.project.adapter = "android-gradle";
    android.build.units[0].target = "android";
    android.build.units[0].runner = "self-hosted";
    android.build.units[0].selfHostedReason = "custom toolchain";
    assert.throws(() => validateConfig(android), /cannot use a self-hosted runner/u);

    const godot = structuredClone(baseConfig());
    godot.project = { name: "Game", adapter: "godot", adapterOptions: { godotVersion: "4.4.1" } };
    godot.build.units[0].runner = "self-hosted";
    assert.throws(() => validateConfig(godot), /selfHostedReason is invalid/u);
});

test("registry is manifest-driven and exposes no placeholder providers", () => {
    assert.deepEqual(Object.keys(PROVIDERS), ["sentry"]);
    assert.equal(PROVIDERS.sentry.schemaVersion, "release-ops/provider/v2");
    assert.equal(PROVIDERS.sentry.configSchemaVersion, "release-ops/provider-config/sentry/v1");
    assert.equal(BUILD_ADAPTERS.find(({ id }) => id === "godot").targets.find(({ id }) => id === "windows").runner, "windows-latest");
    assert.equal(BUILD_ADAPTERS.find(({ id }) => id === "unity").status, "credential-gated");
    assert.equal(BUILD_ADAPTERS.find(({ id }) => id === "unreal").status, "unsupported");
});

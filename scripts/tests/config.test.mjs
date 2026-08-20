import assert from "node:assert/strict";
import test from "node:test";

import { CONFIG_SCHEMA, validateConfig } from "../config.mjs";
import { loadExtensionCatalog, loadExtensions } from "../extension-registry.mjs";
import { baseConfig } from "./fixtures.mjs";

test("validates strict config/v1 extension instances", async () => {
    const config = baseConfig({ mode: "dual-repository", sentry: true, signing: true });
    const validated = await validateConfig(config);
    assert.equal(validated.schemaVersion, CONFIG_SCHEMA);
    assert.deepEqual(Object.keys(validated), ["schemaVersion", "project", "extensions"]);
    assert.deepEqual(validated.extensions.map(({ instanceId }) => instanceId), [
        "application", "application-signing", "release", "sentry",
    ]);
});

test("rejects unknown fields and credential material", async () => {
    const unknown = structuredClone(baseConfig());
    unknown.options = {};
    await assert.rejects(validateConfig(unknown), /options is not supported/u);

    const extensionUnknown = structuredClone(baseConfig());
    extensionUnknown.extensions[0].options = {};
    await assert.rejects(validateConfig(extensionUnknown), /options is not supported/u);

    const credentialKey = structuredClone(baseConfig());
    credentialKey.extensions[0].config.token = "not-even-a-real-token";
    await assert.rejects(validateConfig(credentialKey), /not supported|credential material/u);

    const credentialValue = structuredClone(baseConfig());
    credentialValue.project.name = `github_${"pat"}_abcdefghijklmnopqrstuvwxyz123456`;
    await assert.rejects(validateConfig(credentialValue), /credential material/u);
});

test("enforces build-unit ownership, signing references, and release topology", async () => {
    const duplicateUnit = structuredClone(baseConfig());
    const second = structuredClone(duplicateUnit.extensions[0]);
    second.instanceId = "second-stack";
    duplicateUnit.extensions.splice(1, 0, second);
    await assert.rejects(validateConfig(duplicateUnit), /multiple owners/u);

    const unknownUnit = structuredClone(baseConfig({ signing: true }));
    unknownUnit.extensions[1].config.buildUnitIds = ["missing"];
    await assert.rejects(validateConfig(unknownUnit), /unknown build unit/u);

    const topology = structuredClone(baseConfig({ mode: "dual-repository" }));
    topology.extensions[1].config.source.visibility = "public";
    await assert.rejects(validateConfig(topology), /private source/u);
});

test("catalog contains only the v1 built-in extension set and hydrates selected code", async () => {
    const catalog = await loadExtensionCatalog();
    assert.deepEqual(Object.keys(catalog).sort(), [
        "android", "android-keystore", "apple", "apple-codesign", "dotnet", "flutter", "generic",
        "generic-command", "github", "godot", "javascript", "local", "native", "react-native",
        "sentry", "unity", "unreal",
    ]);
    assert.equal(catalog.unreal.status, "diagnostic");
    assert.equal(catalog.unity.status, "credential-gated");
    assert.equal(Object.hasOwn(catalog.android, "configSchemaObject"), false);
    const hydrated = await loadExtensions({ ids: ["android", "github"] });
    assert.deepEqual(Object.keys(hydrated), ["android", "github"]);
    assert.match(hydrated.android.codeSha256, /^[0-9a-f]{64}$/u);
    assert.equal(Object.hasOwn(hydrated, "sentry"), false);
});

test("diagnostic Unreal cannot become an active stack instance", async () => {
    const config = structuredClone(baseConfig());
    config.extensions[0].extensionId = "unreal";
    config.extensions[0].configSchemaVersion = "release-ops/extension-config/unreal/v1";
    await assert.rejects(validateConfig(config), /diagnostic-only/u);
});

test("credential-gated stacks require explicit toolchain Secret role mappings", async () => {
    const invalid = baseConfig({ stack: "unity" });
    await assert.rejects(validateConfig(invalid), /requires Secret role unity-license/u);

    const valid = structuredClone(invalid);
    valid.extensions[0].config.secretNames = {
        "unity-license": "UNITY_LICENSE",
        "unity-email": "UNITY_EMAIL",
        "unity-password": "UNITY_PASSWORD",
    };
    valid.extensions[0].config.buildUnits[0].requiredSecretRoles = Object.keys(valid.extensions[0].config.secretNames);
    await validateConfig(valid);
});

test("stack manifests own hosted target runner contracts", async () => {
    const wrongRunner = baseConfig({ stack: "android" });
    wrongRunner.extensions[0].config.buildUnits[0].target = "android";
    wrongRunner.extensions[0].config.buildUnits[0].runner = "windows-latest";
    await assert.rejects(validateConfig(wrongRunner), /requires runner ubuntu-latest/u);

    const unknownHosted = structuredClone(wrongRunner);
    unknownHosted.extensions[0].config.buildUnits[0].target = "wearos-custom";
    unknownHosted.extensions[0].config.buildUnits[0].runner = "ubuntu-latest";
    await assert.rejects(validateConfig(unknownHosted), /does not support hosted target/u);

    unknownHosted.extensions[0].config.buildUnits[0].runner = "self-hosted";
    unknownHosted.extensions[0].config.buildUnits[0].selfHostedReason = "Project-owned SDK image";
    await validateConfig(unknownHosted);
});

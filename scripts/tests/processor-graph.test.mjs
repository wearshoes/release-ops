import assert from "node:assert/strict";
import test from "node:test";

import { loadExtensions } from "../extension-registry.mjs";
import { createProcessorGraph, nodesForEntrypoint } from "../processor-graph.mjs";
import { baseConfig } from "./fixtures.mjs";

async function registryFor(config) {
    return loadExtensions({ ids: config.extensions.map(({ extensionId }) => extensionId) });
}

function addSecondStack(config) {
    const second = structuredClone(config.extensions[0]);
    second.instanceId = "second-stack";
    second.config.buildUnits[0].id = "linux";
    second.config.buildUnits[0].target = "linux";
    second.config.buildUnits[0].runner = "ubuntu-latest";
    second.config.buildUnits[0].artifacts[0].id = "linux-primary";
    second.config.buildUnits[0].artifacts[0].path = "build/linux.bin";
    config.extensions.splice(1, 0, second);
}

test("graph order is deterministic and append capabilities follow graph order", async () => {
    const config = baseConfig();
    addSecondStack(config);
    const registry = structuredClone(await registryFor(config));
    registry.local.processors.find(({ id }) => id === "preflight").before = ["collect"];
    const first = await createProcessorGraph(config, registry);
    const second = await createProcessorGraph(structuredClone(config), registry);
    assert.equal(first.graphDigest, second.graphDigest);
    assert.deepEqual(first.capabilities["built-artifacts"], {
        merge: "append",
        producers: ["application:build", "second-stack:build"],
    });
    assert.deepEqual(first.buildUnitOwners, { desktop: "application", linux: "second-stack" });
    assert.deepEqual(first.nodes.find(({ id }) => id === "release:preflight").before, ["release:collect"]);
});

test("graph detects cycles, missing capabilities, and ambiguous one consumers", async () => {
    const cycleConfig = baseConfig();
    const cycleRegistry = structuredClone(await registryFor(cycleConfig));
    cycleRegistry.local.processors.find(({ id }) => id === "preflight").after = ["collect"];
    await assert.rejects(createProcessorGraph(cycleConfig, cycleRegistry), /cycle/u);

    const missingConfig = baseConfig();
    const missingRegistry = structuredClone(await registryFor(missingConfig));
    missingRegistry.local.processors.find(({ id }) => id === "publish").requires.push({
        capability: "not-installed", cardinality: "one", optional: false,
    });
    await assert.rejects(createProcessorGraph(missingConfig, missingRegistry), /Missing capability/u);

    const ambiguousConfig = baseConfig();
    addSecondStack(ambiguousConfig);
    const ambiguousRegistry = structuredClone(await registryFor(ambiguousConfig));
    ambiguousRegistry.local.processors.find(({ id }) => id === "collect").requires[0].cardinality = "one";
    await assert.rejects(createProcessorGraph(ambiguousConfig, ambiguousRegistry), /ambiguous/u);
});

test("exclusive and keyed producers reject incompatible output ownership", async () => {
    const exclusiveConfig = baseConfig();
    const exclusiveRegistry = structuredClone(await registryFor(exclusiveConfig));
    exclusiveRegistry.generic.processors[0].provides.push({ capability: "release-context", merge: "exclusive" });
    await assert.rejects(createProcessorGraph(exclusiveConfig, exclusiveRegistry), /must have one provider/u);

    const keyedConfig = baseConfig();
    const keyedRegistry = structuredClone(await registryFor(keyedConfig));
    keyedRegistry.generic.processors[0].provides.push({ capability: "fixture-keyed", merge: "keyed", key: "same" });
    keyedRegistry.local.processors.find(({ id }) => id === "preflight").provides.push({
        capability: "fixture-keyed", merge: "keyed", key: "same",
    });
    await assert.rejects(createProcessorGraph(keyedConfig, keyedRegistry), /duplicate keyed output/u);
});

test("scheduled-ingest and resolve are independent from the release lane", async () => {
    const config = baseConfig({ sentry: true });
    config.extensions.at(-1).config.issueSync = false;
    const graph = await createProcessorGraph(config, await registryFor(config));
    const release = nodesForEntrypoint(graph, "release").map(({ stage }) => stage);
    assert.equal(release.includes("scheduled-ingest"), false);
    assert.equal(release.includes("resolve"), false);
    assert.deepEqual(nodesForEntrypoint(graph, "scheduled-ingest").map(({ id }) => id), ["sentry:ingest"]);
    assert.deepEqual(nodesForEntrypoint(graph, "resolve").map(({ id }) => id), ["sentry:resolve"]);
});

test("build nodes receive only build-unit roles resolved from the owning signing instance", async () => {
    const config = baseConfig({ signing: true });
    const graph = await createProcessorGraph(config, await registryFor(config));
    const role = graph.nodes.find(({ id }) => id === "application:build").secretRoles.find(({ role: name }) => name === "credential");
    assert.deepEqual(role, {
        role: "credential",
        required: true,
        defaultName: "SIGNING_CREDENTIAL",
        configuredName: "SIGNING_CREDENTIAL",
        sourceInstanceId: "application-signing",
    });
});

test("credential-gated stack roles are owned by the stack processor", async () => {
    const config = baseConfig({ stack: "unity" });
    const stack = config.extensions[0];
    stack.config.secretNames = {
        "unity-license": "UNITY_LICENSE",
        "unity-email": "UNITY_EMAIL",
        "unity-password": "UNITY_PASSWORD",
    };
    stack.config.buildUnits[0].requiredSecretRoles = Object.keys(stack.config.secretNames);
    const graph = await createProcessorGraph(config, await registryFor(config));
    const roles = graph.nodes.find(({ id }) => id === "application:build").secretRoles;
    assert.deepEqual(roles.map(({ sourceInstanceId, configuredName }) => [sourceInstanceId, configuredName]), [
        ["application", "UNITY_EMAIL"],
        ["application", "UNITY_LICENSE"],
        ["application", "UNITY_PASSWORD"],
    ]);
});

test("release output permissions cannot cover the repository root", async () => {
    const config = baseConfig();
    config.extensions.find(({ instanceId }) => instanceId === "release").config.localOutputDirectory = ".";
    await assert.rejects(createProcessorGraph(config, await registryFor(config)), /cannot be the repository root/u);
});

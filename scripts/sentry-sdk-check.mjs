#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { isMainModule } from "./cli-entry.mjs";
import { CONFIG_SCHEMA, validateConfig } from "./config.mjs";
import { hydrateExtensions } from "./extension-registry.mjs";
import { createKernelApi } from "./kernel-api.mjs";
import { createProcessorGraph } from "./processor-graph.mjs";
import { checkSentrySdk } from "./processors/sentry-sdk-check.mjs";

function argumentsMap(argv) {
    const result = new Map();
    for (let index = 0; index < argv.length; index += 1) {
        const key = argv[index];
        if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
        result.set(key, value);
        index += 1;
    }
    return result;
}

async function stateFromAnswers(path) {
    const answers = JSON.parse(await readFile(resolve(path), "utf8"));
    if (answers.schemaVersion !== "release-ops/setup-answers/v1") throw new Error("Setup answers schema is unsupported");
    return {
        config: {
            schemaVersion: CONFIG_SCHEMA,
            project: answers.project,
            extensions: answers.extensions,
        },
        graph: null,
    };
}

async function stateFromInstalled(root) {
    const releaseOpsRoot = resolve(root, ".release-ops");
    return {
        config: JSON.parse(await readFile(resolve(releaseOpsRoot, "config.json"), "utf8")),
        graph: JSON.parse(await readFile(resolve(releaseOpsRoot, "processor-graph.json"), "utf8")),
    };
}

export async function inspectSentrySdk({ root = process.cwd(), answersPath = null } = {}) {
    const absoluteRoot = resolve(root);
    const state = answersPath ? await stateFromAnswers(answersPath) : await stateFromInstalled(absoluteRoot);
    const registry = await hydrateExtensions(state.config.extensions.map(({ extensionId }) => extensionId));
    const config = await validateConfig(state.config, { extensions: registry });
    const graph = state.graph ?? await createProcessorGraph(config, registry);
    const instance = config.extensions.find(({ extensionId }) => extensionId === "sentry");
    if (!instance) throw new Error("The Sentry extension is not selected");
    const node = graph.nodes.find((candidate) => candidate.instanceId === instance.instanceId && candidate.stage === "plan");
    if (!node) throw new Error("The Sentry SDK check processor is unavailable");
    const api = createKernelApi({ root: absoluteRoot, node });
    return checkSentrySdk({ api, config, graph, instance });
}

async function main() {
    if (process.argv.includes("--help")) {
        process.stdout.write("Usage: node scripts/sentry-sdk-check.mjs --root <repository> [--answers <setup-answers.json>]\n");
        return;
    }
    const args = argumentsMap(process.argv.slice(2));
    const result = await inspectSentrySdk({ root: args.get("--root") ?? process.cwd(), answersPath: args.get("--answers") ?? null });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`Sentry SDK check failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

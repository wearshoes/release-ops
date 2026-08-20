#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { loadExtensionCatalog, PLUGIN_ROOT } from "./extension-registry.mjs";

const MODULE_BANS = [
    [/node:(?:fs|fs\/promises)/u, "direct filesystem access"],
    [/node:child_process/u, "child_process access"],
    [/\bprocess\.env\b/u, "complete process.env access"],
    [/node:(?:http|https)/u, "native HTTP access"],
    [/\b(?:globalThis\.)?fetch\s*\(/u, "native fetch access"],
    [/\bshell\s*:/u, "shell execution"],
    [/\bexec(?:Sync)?\s*\(/u, "shell-string execution"],
    [/["'`]\s*(?:name|jobs|steps|runs-on|uses):\s*\r?\n/u, "raw YAML fragment"],
];

const KERNEL_FILES = [
    "scripts/config.mjs",
    "scripts/execute.mjs",
    "scripts/extension-registry.mjs",
    "scripts/kernel-api.mjs",
    "scripts/processor-graph.mjs",
    "scripts/project-installer.mjs",
    "scripts/release-ops.mjs",
    "scripts/setup-core.mjs",
    "scripts/workflow-renderer.mjs",
];

function escaped(value) {
    return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function main() {
    const catalog = await loadExtensionCatalog();
    const modules = new Set(Object.values(catalog).flatMap((manifest) => [
        ...manifest.processors.map(({ module }) => module),
        ...manifest.runtimeFiles,
    ]));
    for (const path of [...modules].sort()) {
        const source = await readFile(`${PLUGIN_ROOT}/${path}`, "utf8");
        for (const [pattern, reason] of MODULE_BANS) {
            if (pattern.test(source)) throw new Error(`${path} violates the extension boundary: ${reason}`);
        }
    }
    const ids = Object.keys(catalog).map(escaped).join("|");
    const concreteBranch = new RegExp(`(?:\\.extensionId|\\[\"extensionId\"\\])\\s*(?:===|!==)\\s*[\"'](?:${ids})[\"']|[\"'](?:${ids})[\"']\\s*(?:===|!==)\\s*(?:[^;\\n]*\\.extensionId)`, "u");
    for (const path of KERNEL_FILES) {
        const source = await readFile(`${PLUGIN_ROOT}/${path}`, "utf8");
        if (concreteBranch.test(source)) throw new Error(`${path} branches on a concrete extension id`);
    }
    process.stdout.write("Release Ops extension boundaries are valid\n");
}

main().catch((error) => {
    process.stderr.write(`Release Ops boundary validation failed: ${error.message}\n`);
    process.exitCode = 1;
});

#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadExtensionCatalog, PLUGIN_ROOT } from "./extension-registry.mjs";

const START = "<!-- EXTENSION_MATRIX_START -->";
const END = "<!-- EXTENSION_MATRIX_END -->";

function label(status) {
    return status === "supported" ? "supported" : status === "credential-gated" ? "credential-gated" : "diagnostic only";
}

function link(manifest) {
    return `[${manifest.id}](${manifest.docs})`;
}

function targets(manifest) {
    const entries = Object.entries(manifest.targets ?? {});
    return entries.length ? entries.map(([target, runner]) => `${target}: ${runner}`).join("<br>") : "-";
}

export async function extensionMatrix() {
    const catalog = await loadExtensionCatalog();
    const rows = Object.values(catalog).sort((left, right) => left.type.localeCompare(right.type) || left.id.localeCompare(right.id));
    return [
        START,
        "| Type | Extension | Status | Targets |",
        "| --- | --- | --- | --- |",
        ...rows.map((manifest) => `| ${manifest.type} | ${link(manifest)} | ${label(manifest.status)} | ${targets(manifest)} |`),
        END,
    ].join("\n");
}

async function main() {
    const path = resolve(PLUGIN_ROOT, "README.md");
    const current = await readFile(path, "utf8");
    const start = current.indexOf(START);
    const end = current.indexOf(END);
    if (start < 0 || end < start) throw new Error("README extension matrix markers are missing");
    const desired = `${current.slice(0, start)}${await extensionMatrix()}${current.slice(end + END.length)}`;
    if (process.argv.includes("--check")) {
        if (desired !== current) throw new Error("README extension matrix is stale");
        process.stdout.write("README extension matrix is current\n");
        return;
    }
    await writeFile(path, desired, "utf8");
}

main().catch((error) => {
    process.stderr.write(`README generation failed: ${error.message}\n`);
    process.exitCode = 1;
});

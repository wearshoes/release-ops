#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { isMainModule } from "./cli-entry.mjs";
import { loadExtensionCatalog, PLUGIN_ROOT } from "./extension-registry.mjs";

const START = "<!-- EXTENSION_MATRIX_START -->";
const END = "<!-- EXTENSION_MATRIX_END -->";

const LOCALES = Object.freeze({
    en: {
        headers: ["Type", "Extension", "Status", "Targets"],
        types: { provider: "provider", release: "release", signing: "signing", stack: "stack" },
        statuses: { supported: "supported", "credential-gated": "credential-gated", diagnostic: "diagnostic only" },
    },
    zh: {
        headers: ["类型", "扩展", "状态", "目标"],
        types: { provider: "服务提供方", release: "发布", signing: "签名", stack: "技术栈" },
        statuses: { supported: "支持", "credential-gated": "需要凭据", diagnostic: "仅诊断" },
    },
});

function language(locale) {
    const value = LOCALES[locale];
    if (!value) throw new Error(`Unsupported README locale: ${locale}`);
    return value;
}

function label(status, locale) {
    const labels = language(locale).statuses;
    return labels[status] ?? labels.diagnostic;
}

function link(manifest) {
    return `[${manifest.id}](${manifest.docs})`;
}

function targets(manifest) {
    const entries = Object.entries(manifest.targets ?? {});
    return entries.length ? entries.map(([target, runner]) => `${target}: ${runner}`).join("<br>") : "-";
}

export async function extensionMatrix(locale = "en", eol = "\n") {
    const catalog = await loadExtensionCatalog();
    const labels = language(locale);
    const rows = Object.values(catalog).sort((left, right) => left.type.localeCompare(right.type) || left.id.localeCompare(right.id));
    return [
        START,
        `| ${labels.headers.join(" | ")} |`,
        "| --- | --- | --- | --- |",
        ...rows.map((manifest) => `| ${labels.types[manifest.type]} | ${link(manifest)} | ${label(manifest.status, locale)} | ${targets(manifest)} |`),
        END,
    ].join(eol);
}

export async function renderReadme(current, locale = "en") {
    const start = current.indexOf(START);
    const end = current.indexOf(END);
    if (start < 0 || end < start) throw new Error("README extension matrix markers are missing");
    const eol = current.includes("\r\n") ? "\r\n" : "\n";
    return `${current.slice(0, start)}${await extensionMatrix(locale, eol)}${current.slice(end + END.length)}`;
}

async function main() {
    const readmes = [
        { name: "README.md", locale: "zh" },
        { name: "README.en.md", locale: "en" },
    ];
    for (const readme of readmes) {
        const path = resolve(PLUGIN_ROOT, readme.name);
        const current = await readFile(path, "utf8");
        const desired = await renderReadme(current, readme.locale);
        if (process.argv.includes("--check")) {
            if (desired !== current) throw new Error(`${readme.name} extension matrix is stale`);
        } else {
            await writeFile(path, desired, "utf8");
        }
    }
    if (process.argv.includes("--check")) process.stdout.write("README extension matrices are current\n");
}

if (isMainModule(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`README generation failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

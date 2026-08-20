#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config.mjs";
import { readCanonicalVersion } from "./release-publisher.mjs";

function applyTemplate(template, version) {
    return template.replaceAll("{version}", version);
}

export async function preflightRelease(config, { root = process.cwd(), version, versionCode = null, sourceSha }) {
    if (!/^[0-9a-f]{40}$/u.test(sourceSha)) throw new Error("Source SHA must be a full lowercase commit SHA");
    const canonical = await readCanonicalVersion(config, root);
    if (canonical.version !== version) throw new Error("Canonical version does not match the requested release");
    if (config.versioning.codeKey && canonical.versionCode !== versionCode) throw new Error("Canonical version code does not match the requested release");
    const changelog = resolve(root, applyTemplate(config.versioning.changelogPattern, version));
    await access(changelog);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(changelog));
    if (!text.trim()) throw new Error("Release changelog is empty");
    if (config.versioning.requiresChinese && !/[\u3400-\u9fff]/u.test(text)) throw new Error("Release changelog must contain Chinese");
    return { schemaVersion: "release-ops-preflight/v1", success: true, version, versionCode, sourceSha, changelog };
}

async function main() {
    const args = new Map();
    for (let index = 2; index < process.argv.length; index += 2) {
        const key = process.argv[index];
        const value = process.argv[index + 1];
        if (!key?.startsWith("--") || value === undefined || args.has(key)) throw new Error("Arguments must use unique --name value pairs");
        args.set(key, value);
    }
    const root = resolve(args.get("--root") ?? process.cwd());
    const result = await preflightRelease(await loadConfig(root), {
        root,
        version: args.get("--version") ?? "",
        versionCode: args.has("--code") && args.get("--code") !== "" ? Number(args.get("--code")) : null,
        sourceSha: args.get("--sha") ?? "",
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        process.stderr.write(`Release preflight failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

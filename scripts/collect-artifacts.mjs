#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { isMainModule } from "./cli-entry.mjs";
import { allBuildUnits } from "./config-query.mjs";
import { loadConfig } from "./config.mjs";
import { resolveRepositoryPath } from "./path-safety.mjs";
import { readCanonicalVersion } from "./release-publisher.mjs";

function applyTemplate(template, values) {
    return template.replaceAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (match, key) => {
        if (values[key] === undefined || values[key] === null) throw new Error(`Template value ${key} is unavailable`);
        return String(values[key]);
    });
}

export async function collectBuildArtifacts(config, {
    root = process.cwd(),
    unitId,
    output = ".release-ops/upload",
} = {}) {
    const unit = allBuildUnits(config).find(({ id }) => id === unitId);
    if (!unit) throw new Error("A valid build unit is required for artifact collection");
    const canonical = await readCanonicalVersion(config, root);
    const values = { version: canonical.version, ...canonical.buildNumbers };
    const outputRoot = await resolveRepositoryPath(root, output, { name: "artifact collection output" });
    const unitRoot = join(outputRoot, unit.id);
    await mkdir(unitRoot, { recursive: true });
    const artifacts = [];
    for (const declared of unit.artifacts) {
        const source = await resolveRepositoryPath(root, applyTemplate(declared.path, values), {
            name: `artifact ${declared.id}`,
            mustExist: true,
        });
        if (!(await stat(source)).isFile()) throw new Error(`Artifact ${declared.id} is not a file`);
        const bytes = await readFile(source);
        const name = applyTemplate(declared.nameTemplate, values);
        if (basename(name) !== name) throw new Error(`Artifact ${declared.id} name must not contain a path`);
        await copyFile(source, join(unitRoot, name));
        artifacts.push({
            id: declared.id,
            unit: unit.id,
            name,
            contentType: declared.contentType,
            platform: declared.platform,
            architecture: declared.architecture,
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
        });
    }
    const manifest = {
        schemaVersion: "release-ops-build-artifacts/v2",
        unit: unit.id,
        version: canonical.version,
        buildNumbers: canonical.buildNumbers,
        artifacts,
    };
    await writeFile(join(unitRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
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
    const result = await collectBuildArtifacts(await loadConfig(root), {
        root,
        unitId: args.get("--unit"),
        output: args.get("--output") ?? ".release-ops/upload",
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`Artifact collection failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

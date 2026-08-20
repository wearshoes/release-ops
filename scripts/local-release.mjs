#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config.mjs";
import { publishRelease } from "./release-publisher.mjs";
import { readCanonicalVersion } from "./release-publisher.mjs";
import { runBuild } from "./run-build.mjs";
import { planSentryBuildHook, runSentryBuildHook } from "./sentry-build-hook.mjs";

async function main() {
    const args = new Map();
    for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
    const root = resolve(args.get("--root") ?? process.cwd());
    const config = await loadConfig(root);
    if (config.hosting.github.enabled) throw new Error("Use the repository release entry for GitHub-hosted projects");
    const version = args.get("--version") ?? "";
    const sourceSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const canonical = await readCanonicalVersion(config, root);
    for (const unit of config.build.units) {
        await runBuild(config, { root, unitId: unit.id });
        await runSentryBuildHook(await planSentryBuildHook(config, {
            root,
            version,
            buildNumbers: canonical.buildNumbers,
            sourceSha,
            unitId: unit.id,
        }));
    }
    await runSentryBuildHook(await planSentryBuildHook(config, {
        root,
        version,
        buildNumbers: canonical.buildNumbers,
        sourceSha,
        mode: "release",
    }));
    const result = await publishRelease({ config, root, version, buildNumbers: canonical.buildNumbers, sourceSha });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        process.stderr.write(`Local release failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config.mjs";

export async function runBuild(config, { root = process.cwd(), env = process.env, spawnImpl = spawn } = {}) {
    for (const name of config.build.requiredSecretNames ?? []) {
        if (!env[name]) throw new Error(`Required build Secret is unavailable: ${name}`);
    }
    await new Promise((resolvePromise, reject) => {
        const child = spawnImpl(config.build.command, {
            cwd: resolve(root),
            env,
            shell: true,
            stdio: "inherit",
            windowsHide: true,
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (code === 0) resolvePromise();
            else reject(new Error(`Build failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
        });
    });
    return { schemaVersion: "release-ops-build/v1", completed: true };
}

async function main() {
    const rootIndex = process.argv.indexOf("--root");
    const root = resolve(rootIndex >= 0 ? process.argv[rootIndex + 1] : process.cwd());
    const result = await runBuild(await loadConfig(root), { root });
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        process.stderr.write(`Release build failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

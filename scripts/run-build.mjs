#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config.mjs";

const SENSITIVE_ENVIRONMENT = /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|KEYSTORE|LICENSE|SERIAL)$/iu;

function buildEnvironment(env, requiredNames) {
    const allowedSecrets = new Set(requiredNames);
    return Object.fromEntries(Object.entries(env).filter(([name]) =>
        !SENSITIVE_ENVIRONMENT.test(name) || allowedSecrets.has(name)));
}

export async function runBuild(config, {
    root = process.cwd(),
    unitId = null,
    env = process.env,
    spawnImpl = spawn,
    chmodImpl = chmod,
    platform = process.platform,
} = {}) {
    const unit = unitId
        ? config.build.units.find(({ id }) => id === unitId)
        : config.build.units.length === 1 ? config.build.units[0] : null;
    if (!unit) throw new Error("A valid --unit is required when the configuration has multiple build units");
    for (const name of unit.requiredSecretNames ?? []) {
        if (!env[name]) throw new Error(`Required build Secret is unavailable: ${name}`);
    }
    if (config.project.adapter === "android-gradle" && platform !== "win32"
        && /(?:^|[\\/])gradlew$/u.test(unit.command.executable)) {
        await chmodImpl(resolve(root, "gradlew"), 0o755);
    }
    await new Promise((resolvePromise, reject) => {
        const child = spawnImpl(unit.command.executable, unit.command.args, {
            cwd: resolve(root),
            env: buildEnvironment(env, unit.requiredSecretNames ?? []),
            shell: false,
            stdio: "inherit",
            windowsHide: true,
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (code === 0) resolvePromise();
            else reject(new Error(`Build failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
        });
    });
    return { schemaVersion: "release-ops-build/v2", completed: true, unit: unit.id };
}

async function main() {
    const rootIndex = process.argv.indexOf("--root");
    const unitIndex = process.argv.indexOf("--unit");
    const root = resolve(rootIndex >= 0 ? process.argv[rootIndex + 1] : process.cwd());
    const result = await runBuild(await loadConfig(root), {
        root,
        unitId: unitIndex >= 0 ? process.argv[unitIndex + 1] : null,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        process.stderr.write(`Release build failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

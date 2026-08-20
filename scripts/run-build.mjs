#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod } from "node:fs/promises";
import { resolve } from "node:path";

import { isMainModule } from "./cli-entry.mjs";
import { allBuildUnits, secretNamesForBuildUnit } from "./config-query.mjs";
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
    const units = allBuildUnits(config);
    const unit = unitId ? units.find(({ id }) => id === unitId) : units.length === 1 ? units[0] : null;
    if (!unit) throw new Error("A valid --unit is required when the configuration has multiple build units");
    const roleNames = secretNamesForBuildUnit(config, unit.id);
    const requiredSecretNames = (unit.requiredSecretRoles ?? []).map((role) => {
        const name = roleNames[role];
        if (!name) throw new Error(`Build unit ${unit.id} has no Secret name for role ${role}`);
        return name;
    });
    for (const name of requiredSecretNames) {
        if (!env[name]) throw new Error(`Required build Secret is unavailable: ${name}`);
    }
    if (unit.target === "android" && platform !== "win32"
        && /(?:^|[\\/])gradlew$/u.test(unit.command.executable)) {
        await chmodImpl(resolve(root, "gradlew"), 0o755);
    }
    await new Promise((resolvePromise, reject) => {
        const child = spawnImpl(unit.command.executable, unit.command.args, {
            cwd: resolve(root),
            env: buildEnvironment(env, requiredSecretNames),
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
    return { schemaVersion: "release-ops/build/v1", completed: true, unit: unit.id };
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

if (isMainModule(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`Release build failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

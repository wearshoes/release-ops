#!/usr/bin/env node

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { loadConfig } from "./config.mjs";

const execFileAsync = promisify(execFile);

function applyTemplate(template, values) {
    return template.replaceAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (match, key) => {
        if (values[key] === undefined || values[key] === null) throw new Error(`Sentry template value ${key} is unavailable`);
        return String(values[key]);
    });
}

export function planSentryBuildHook(config, { root = process.cwd(), version, versionCode = null, sourceSha }) {
    const sentry = config.providers.sentry;
    if (!sentry?.enabled) return { schemaVersion: "release-ops-sentry-build-hook/v1", enabled: false, commands: [] };
    if (!/^[0-9a-f]{40}$/u.test(sourceSha)) throw new Error("Sentry build hook requires a full lowercase source SHA");
    const values = { version, versionCode, sourceSha, project: config.project.name };
    const release = applyTemplate(sentry.releaseTemplate ?? "{project}@{version}", values);
    const dist = applyTemplate(sentry.distTemplate ?? "{versionCode}", values);
    const shared = ["--org", sentry.organization, "--project", sentry.project];
    const commands = [
        { executable: "sentry-cli", args: ["releases", "new", release, ...shared] },
    ];
    if (config.hosting.github.enabled) {
        commands.push({
            executable: "sentry-cli",
            args: ["releases", "set-commits", release, "--commit", `${config.hosting.github.sourceRepository}@${sourceSha}`, ...shared],
        });
    }
    for (const artifact of sentry.debugArtifacts ?? []) {
        const path = resolve(root, applyTemplate(artifact.path, values));
        if (artifact.type === "source-map") {
            commands.push({ executable: "sentry-cli", args: ["sourcemaps", "inject", path] });
            commands.push({ executable: "sentry-cli", args: ["sourcemaps", "upload", "--release", release, "--dist", dist, ...shared, path] });
        } else {
            const type = artifact.type === "dart-symbol" ? "debug-id" : artifact.type;
            commands.push({ executable: "sentry-cli", args: ["debug-files", "upload", "--type", type, ...shared, path] });
        }
    }
    commands.push({ executable: "sentry-cli", args: ["releases", "finalize", release, ...shared] });
    return { schemaVersion: "release-ops-sentry-build-hook/v1", enabled: true, release, dist, commands };
}

export async function runSentryBuildHook(plan, { env = process.env, exec = execFileAsync } = {}) {
    if (!plan.enabled) return { ...plan, completed: true };
    const token = env.SENTRY_ORG_CI_TOKEN;
    if (!token) throw new Error("SENTRY_ORG_CI_TOKEN is required for the Sentry build hook");
    for (const command of plan.commands) {
        await exec(command.executable, command.args, {
            windowsHide: true,
            env: { ...env, SENTRY_AUTH_TOKEN: token },
        });
    }
    return { schemaVersion: plan.schemaVersion, enabled: true, release: plan.release, dist: plan.dist, commandCount: plan.commands.length, completed: true };
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
    const config = await loadConfig(root);
    const plan = planSentryBuildHook(config, {
        root,
        version: args.get("--version") ?? "",
        versionCode: args.has("--code") && args.get("--code") !== "" ? Number(args.get("--code")) : null,
        sourceSha: args.get("--sha") ?? "",
    });
    const result = await runSentryBuildHook(plan);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        process.stderr.write(`Sentry build hook failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

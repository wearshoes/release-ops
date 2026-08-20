#!/usr/bin/env node

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { isMainModule } from "./cli-entry.mjs";
import { loadConfig } from "./config.mjs";
import { resolveRepositoryPath } from "./path-safety.mjs";

const execFileAsync = promisify(execFile);

function applyTemplate(template, values) {
    return template.replaceAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (match, key) => {
        if (values[key] === undefined || values[key] === null) throw new Error(`Sentry template value ${key} is unavailable`);
        return String(values[key]);
    });
}

export async function planBuildHook(config, {
    root = process.cwd(),
    version,
    buildNumbers = {},
    sourceSha,
    unitId = null,
    mode = "upload",
}) {
    const sentry = config.providers.sentry;
    if (!sentry?.enabled) return { schemaVersion: "release-ops-sentry-build-hook/v2", enabled: false, commands: [] };
    if (!["upload", "release"].includes(mode)) throw new Error("Sentry build hook mode must be upload or release");
    if (!/^[0-9a-f]{40}$/u.test(sourceSha)) throw new Error("Sentry build hook requires a full lowercase source SHA");
    const values = {
        ...(config.project.adapterOptions ?? {}),
        version,
        versionCode: Object.values(buildNumbers)[0] ?? "",
        ...buildNumbers,
        sourceSha,
        project: config.project.name,
    };
    const release = applyTemplate(sentry.releaseTemplate ?? "{project}@{version}", values);
    const dist = applyTemplate(sentry.distTemplate ?? "{version}", values);
    const shared = ["--org", sentry.organization, "--project", sentry.project];
    const commands = [];
    if (mode === "release") {
        commands.push({ executable: "sentry-cli", args: ["releases", "new", release, ...shared] });
        if (config.hosting.github.enabled) {
            commands.push({
                executable: "sentry-cli",
                args: ["releases", "set-commits", release, "--commit", `${config.hosting.github.source.repository}@${sourceSha}`, ...shared],
            });
        }
        commands.push({ executable: "sentry-cli", args: ["releases", "finalize", release, ...shared] });
    }
    for (const artifact of (sentry.debugArtifacts ?? []).filter((entry) => mode === "upload" && (!entry.unit || entry.unit === unitId))) {
        const relative = applyTemplate(artifact.path, values);
        const path = await resolveRepositoryPath(root, relative, { name: `Sentry debug artifact ${relative}`, mustExist: true });
        if (artifact.type === "source-map") {
            commands.push({ executable: "sentry-cli", args: ["sourcemaps", "inject", path] });
            commands.push({ executable: "sentry-cli", args: ["sourcemaps", "upload", "--release", release, "--dist", dist, ...shared, path] });
        } else if (artifact.type === "proguard") {
            commands.push({ executable: "sentry-cli", args: ["upload-proguard", ...shared, "--require-one", path] });
        } else {
            const type = artifact.type === "dart-symbol" ? "breakpad" : artifact.type === "dif" ? null : artifact.type;
            commands.push({
                executable: "sentry-cli",
                args: ["debug-files", "upload", ...shared, ...(type ? ["--type", type] : []), path],
            });
        }
    }
    return { schemaVersion: "release-ops-sentry-build-hook/v2", enabled: true, mode, unitId, release, dist, apiBase: sentry.apiBase, commands };
}

export async function runBuildHook(plan, { env = process.env, exec = execFileAsync } = {}) {
    if (!plan.enabled) return { ...plan, completed: true };
    const token = env.SENTRY_ORG_CI_TOKEN;
    if (!token) throw new Error("SENTRY_ORG_CI_TOKEN is required for the Sentry build hook");
    for (const command of plan.commands) {
        await exec(command.executable, command.args, {
            windowsHide: true,
            env: {
                ...Object.fromEntries(Object.entries(env).filter(([name]) => !/(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY)$/iu.test(name))),
                SENTRY_AUTH_TOKEN: token,
                ...(plan.apiBase ? { SENTRY_URL: plan.apiBase.replace(/\/api\/0\/?$/u, "") } : {}),
            },
        });
    }
    return { schemaVersion: plan.schemaVersion, enabled: true, release: plan.release, dist: plan.dist, commandCount: plan.commands.length, completed: true };
}

export const planSentryBuildHook = planBuildHook;
export const runSentryBuildHook = runBuildHook;

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
    const plan = await planBuildHook(config, {
        root,
        version: args.get("--version") ?? "",
        buildNumbers: JSON.parse(args.get("--build-numbers") ?? "{}"),
        sourceSha: args.get("--sha") ?? "",
        unitId: args.get("--unit") ?? null,
        mode: args.get("--mode") ?? "upload",
    });
    const result = await runBuildHook(plan);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`Sentry build hook failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

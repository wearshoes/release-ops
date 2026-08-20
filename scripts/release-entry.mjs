#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config.mjs";
import { dispatchRelease } from "./dispatch-release.mjs";
import { createGitHubClient } from "./github-client.mjs";
import { listSecretMetadata } from "./github-admin.mjs";
import { preflightRelease } from "./preflight-release.mjs";

function git(root, args) {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function requiredSecretNames(config) {
    const names = new Set(config.build.requiredSecretNames ?? []);
    if (config.hosting.github.releaseMode === "dual-repository") names.add("RELEASE_REPO_TOKEN");
    if (config.providers.sentry?.enabled) names.add("SENTRY_ORG_CI_TOKEN");
    return [...names].sort();
}

export async function auditReleaseEntry({ config, root, version, versionCode, github, gitImpl = git }) {
    if (gitImpl(root, ["status", "--porcelain"])) throw new Error("Release requires a clean working tree");
    const branch = gitImpl(root, ["branch", "--show-current"]);
    if (branch !== config.hosting.github.defaultBranch) throw new Error("Release must run from the configured default branch");
    const sourceSha = gitImpl(root, ["rev-parse", "HEAD"]);
    const remoteLine = gitImpl(root, ["ls-remote", "origin", `refs/heads/${branch}`]);
    const remoteSha = remoteLine.split(/\s+/u)[0];
    if (remoteSha !== sourceSha) throw new Error("Local HEAD does not match the remote default branch");
    await preflightRelease(config, { root, version, versionCode, sourceSha });
    const secretMetadata = await listSecretMetadata({ github, repository: config.hosting.github.sourceRepository });
    const available = new Set(secretMetadata.secrets.map(({ name }) => name));
    const missing = requiredSecretNames(config).filter((name) => !available.has(name));
    if (missing.length) throw new Error(`Required Actions Secret metadata is missing: ${missing.join(", ")}`);
    return { schemaVersion: "release-ops-entry-audit/v1", success: true, sourceSha, branch, requiredSecretNames: requiredSecretNames(config) };
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
    if (!config.hosting.github.enabled) throw new Error("GitHub is disabled; use local-release.mjs");
    const token = process.env.github_token ?? process.env.GITHUB_TOKEN;
    const github = createGitHubClient({ sourceRepository: config.hosting.github.sourceRepository, sourceToken: token });
    const version = args.get("--version") ?? "";
    const versionCode = args.has("--code") && args.get("--code") !== "" ? Number(args.get("--code")) : null;
    const audit = await auditReleaseEntry({ config, root, version, versionCode, github });
    const result = await dispatchRelease({
        github,
        config,
        version,
        versionCode,
        sourceSha: audit.sourceSha,
        correlation: args.get("--correlation") ?? randomUUID(),
    });
    process.stdout.write(`${JSON.stringify({ audit, dispatch: result }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        process.stderr.write(`Release entry failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

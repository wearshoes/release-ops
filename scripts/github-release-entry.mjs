#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { isMainModule } from "./cli-entry.mjs";
import { executeNode } from "./execute.mjs";
import { readCanonicalRelease, verifyReleaseState } from "./local-release-entry.mjs";

const execFile = promisify(execFileCallback);

function parseArguments(values) {
    const args = new Map();
    for (let index = 0; index < values.length; index += 2) {
        const key = values[index];
        const value = values[index + 1];
        if (!key?.startsWith("--") || value === undefined || args.has(key)) {
            throw new Error("Arguments must use unique --name value pairs");
        }
        args.set(key, value);
    }
    return args;
}

function applyTemplate(template, values) {
    return template.replaceAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (match, key) => {
        if (values[key] === undefined || values[key] === null) throw new Error(`Changelog template value ${key} is unavailable`);
        return String(values[key]);
    });
}

async function verifyChangelog(root, config, version, buildNumbers) {
    const stacks = config.extensions.filter((candidate) => candidate.config.versioning);
    const patterns = new Set(stacks.map((candidate) => candidate.config.versioning.changelogPattern));
    if (patterns.size !== 1) throw new Error("Stack changelog contracts do not match");
    const path = applyTemplate([...patterns][0], { version, ...buildNumbers });
    const text = await readFile(resolve(root, path), "utf8");
    if (!text.trim() || (stacks.some((candidate) => candidate.config.versioning.requiresChinese) && !/[\u3400-\u9fff]/u.test(text))) {
        throw new Error("Release changelog is invalid");
    }
}

export async function runGithubRelease({ root, version, token, correlation = randomUUID() }) {
    if (!token) throw new Error("github_token or GITHUB_TOKEN is required");
    const stateRoot = resolve(root, ".release-ops");
    const [config, graph, managed] = await Promise.all([
        readFile(resolve(stateRoot, "config.json"), "utf8").then(JSON.parse),
        readFile(resolve(stateRoot, "processor-graph.json"), "utf8").then(JSON.parse),
        readFile(resolve(stateRoot, "managed-files.json"), "utf8").then(JSON.parse),
    ]);
    verifyReleaseState(config, graph, managed);
    const release = config.extensions.find((candidate) => candidate.config.mode && candidate.config.source);
    if (!release || !["same-repository", "dual-repository"].includes(release.config.mode)) {
        throw new Error("Configured release extension is not GitHub-hosted");
    }
    const status = await execFile("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
    if (status.stdout.trim()) throw new Error("GitHub release requires a clean working tree");
    const branch = (await execFile("git", ["-C", root, "branch", "--show-current"], { encoding: "utf8" })).stdout.trim();
    if (branch !== release.config.source.defaultBranch) throw new Error("Release must run from the configured source default branch");
    const sourceSha = (await execFile("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
    const remote = (await execFile(
        "git",
        ["-C", root, "ls-remote", "origin", `refs/heads/${branch}`],
        { encoding: "utf8" },
    )).stdout.trim().split(/\s+/u)[0];
    if (!/^[0-9a-f]{40}$/u.test(sourceSha) || remote !== sourceSha) {
        throw new Error("Local HEAD does not match the remote source default branch");
    }
    const canonical = await readCanonicalRelease(root, config);
    if (canonical.version !== version) throw new Error("Requested version does not match the canonical version");
    await verifyChangelog(root, config, version, canonical.buildNumbers);
    const preflight = graph.nodes.find((node) => node.instanceId === release.instanceId && node.stage === "preflight");
    if (!preflight) throw new Error("GitHub release preflight processor is unavailable");
    return executeNode({
        root,
        nodeId: preflight.id,
        operation: "dispatch",
        arguments: [version, JSON.stringify(canonical.buildNumbers), sourceSha, correlation],
        secretValues: { "source-release": token },
    });
}

async function main() {
    const args = parseArguments(process.argv.slice(2));
    const root = resolve(args.get("--root") ?? process.cwd());
    const version = args.get("--version");
    if (!version) throw new Error("--version is required");
    const result = await runGithubRelease({
        root,
        version,
        token: process.env.github_token ?? process.env.GITHUB_TOKEN,
        correlation: args.get("--correlation") ?? randomUUID(),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`GitHub release failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

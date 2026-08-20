#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { isMainModule } from "./cli-entry.mjs";
import { executeNode } from "./execute.mjs";
import { sha256, stableJson } from "./stable.mjs";

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

function scalar(value) {
    const text = String(value ?? "").trim().replace(/^['"]|['"]$/gu, "");
    return /^(?:0|[1-9]\d*)$/u.test(text) ? Number(text) : text;
}

async function readVersionSource(root, source) {
    const text = await readFile(resolve(root, source.file), "utf8");
    if (["properties", "gradle-properties"].includes(source.reader)) {
        const values = new Map(text.split(/\r?\n/u).map((line) => {
            const index = line.indexOf("=");
            return index < 0 ? [line.trim(), ""] : [line.slice(0, index).trim(), line.slice(index + 1).trim()];
        }));
        return scalar(values.get(source.key));
    }
    if (["json", "package-json"].includes(source.reader)) {
        return scalar(source.key.split(".").reduce((value, key) => value?.[key], JSON.parse(text)));
    }
    if (source.reader === "text") return scalar(text);
    const escaped = source.key.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const separator = source.reader === "unity" ? ":" : "=";
    const match = text.match(new RegExp(`^\\s*${escaped}\\s*${separator}\\s*(.+)$`, "mu"));
    return scalar(match?.[1]);
}

export async function readCanonicalRelease(root, config) {
    const stacks = config.extensions.filter((candidate) => candidate.config.versioning);
    const versions = [];
    const buildNumbers = {};
    for (const stack of stacks) {
        versions.push(String(await readVersionSource(root, stack.config.versioning.canonical)));
        for (const entry of stack.config.versioning.buildNumbers) {
            if (Object.hasOwn(buildNumbers, entry.id)) throw new Error(`Duplicate build number id: ${entry.id}`);
            buildNumbers[entry.id] = await readVersionSource(root, entry.source);
        }
    }
    if (new Set(versions).size !== 1 || !versions.length) throw new Error("Stack versions do not share one canonical value");
    return { version: versions[0], buildNumbers };
}

export function verifyReleaseState(config, graph, managed) {
    if (config.schemaVersion !== "release-ops/config/v1" || graph.schemaVersion !== "release-ops/processor-graph/v1"
        || managed.schemaVersion !== "release-ops/managed-files/v1") throw new Error("Release Ops state is incompatible");
    const configDigest = sha256(stableJson(config));
    const { graphDigest, ...graphPayload } = graph;
    if (graph.configDigest !== configDigest || sha256(stableJson(graphPayload)) !== graphDigest
        || managed.configDigest !== configDigest || managed.graphDigest !== graphDigest) {
        throw new Error("Release Ops config or graph digest has drifted; run audit and re-plan/apply");
    }
}

function byStage(graph, stage) {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    return graph.order.map((id) => byId.get(id)).filter((node) => node.stage === stage);
}

async function invoke(root, node, operation, args = []) {
    return executeNode({ root, nodeId: node.id, operation, arguments: args });
}

export async function runLocalRelease({ root, version, correlation = randomUUID() }) {
    const stateRoot = resolve(root, ".release-ops");
    const [config, graph, managed] = await Promise.all([
        readFile(resolve(stateRoot, "config.json"), "utf8").then(JSON.parse),
        readFile(resolve(stateRoot, "processor-graph.json"), "utf8").then(JSON.parse),
        readFile(resolve(stateRoot, "managed-files.json"), "utf8").then(JSON.parse),
    ]);
    verifyReleaseState(config, graph, managed);
    const release = config.extensions.find((candidate) => candidate.config.mode);
    if (release?.config.mode !== "local") throw new Error("Configured release extension is not local");
    const status = await execFile("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
    if (status.stdout.trim()) throw new Error("Local release requires a clean working tree");
    const shaResult = await execFile("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
    const sourceSha = shaResult.stdout.trim();
    if (!/^[0-9a-f]{40}$/u.test(sourceSha)) throw new Error("Git did not return a full source SHA");
    const canonical = await readCanonicalRelease(root, config);
    if (canonical.version !== version) throw new Error("Requested version does not match the canonical version");
    const serializedBuildNumbers = JSON.stringify(canonical.buildNumbers);
    for (const node of [...byStage(graph, "preflight"), ...byStage(graph, "prepare")]) {
        await invoke(root, node, node.stage, [version, serializedBuildNumbers, sourceSha]);
    }
    const units = config.extensions.flatMap((candidate) => candidate.config.buildUnits ?? []);
    for (const unit of units) {
        const owner = graph.buildUnitOwners[unit.id];
        const build = byStage(graph, "build").find((node) => node.instanceId === owner);
        if (!build) throw new Error(`Build processor is unavailable for ${unit.id}`);
        await invoke(root, build, "build", [unit.id]);
        for (const node of byStage(graph, "sign")) {
            const instance = config.extensions.find((candidate) => candidate.instanceId === node.instanceId);
            if (instance.config.buildUnitIds?.includes(unit.id)) await invoke(root, node, "sign", [unit.id]);
        }
        for (const node of byStage(graph, "debug-artifacts")) {
            const instance = config.extensions.find((candidate) => candidate.instanceId === node.instanceId);
            if (instance.config.debugArtifacts?.some(({ buildUnitId }) => buildUnitId === unit.id)) {
                await invoke(root, node, "debug-artifacts", [unit.id, version, serializedBuildNumbers, sourceSha]);
            }
        }
    }
    for (const node of byStage(graph, "collect")) await invoke(root, node, "collect", [version, serializedBuildNumbers, sourceSha]);
    for (const node of byStage(graph, "publish-stage")) await invoke(root, node, "publish-stage", [version, serializedBuildNumbers, sourceSha]);
    const results = [];
    for (const node of byStage(graph, "publish-finalize")) {
        results.push(await invoke(root, node, "publish", [version, serializedBuildNumbers, sourceSha, correlation]));
    }
    return {
        schemaVersion: "release-ops/local-release-result/v1",
        version,
        buildNumbers: canonical.buildNumbers,
        sourceSha,
        correlation,
        results,
    };
}

async function main() {
    const args = parseArguments(process.argv.slice(2));
    const root = resolve(args.get("--root") ?? process.cwd());
    const version = args.get("--version");
    if (!version) throw new Error("--version is required");
    const result = await runLocalRelease({ root, version, correlation: args.get("--correlation") ?? randomUUID() });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`Local release failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { PLUGIN_ROOT, relativePluginPath } from "./extension-registry.mjs";
import { resolveRepositoryPath } from "./path-safety.mjs";
import { sha256, stableJson } from "./stable.mjs";
import { renderWorkflow } from "./workflow-renderer.mjs";

export const MANAGED_SCHEMA = "release-ops/managed-files/v1";
export const MANAGED_PLAN_SCHEMA = "release-ops/managed-plan/v1";

const KERNEL_RUNTIME_FILES = [
    "scripts/cli-entry.mjs",
    "scripts/execute.mjs",
    "scripts/github-release-entry.mjs",
    "scripts/kernel-api.mjs",
    "scripts/local-release-entry.mjs",
    "scripts/stable.mjs",
];

function normalizeBytes(value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    const text = bytes.toString("utf8");
    if (text.includes("\uFFFD")) throw new Error("Managed UTF-8 text contains replacement characters");
    return Buffer.from(text.replaceAll("\r\n", "\n"), "utf8");
}

function jsonBytes(value) {
    return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function addDesired(desired, path, bytes, ownerInstanceId, mode = "generated") {
    const normalized = path.replaceAll("\\", "/");
    const value = normalizeBytes(bytes);
    const existing = desired.get(normalized);
    if (existing && (!existing.bytes.equals(value) || existing.ownerInstanceId !== ownerInstanceId)) {
        throw new Error(`Managed file has conflicting contributions: ${normalized}`);
    }
    desired.set(normalized, { path: normalized, bytes: value, ownerInstanceId, mode });
}

async function existingBytes(root, path) {
    const target = await resolveRepositoryPath(root, path, { name: `managed file ${path}` });
    try {
        return await readFile(target);
    } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
    }
}

function normalizeAdoptions(adoptions) {
    if (!Array.isArray(adoptions)) throw new Error("Managed file adoptions must be an array");
    const result = new Map();
    for (const adoption of adoptions) {
        if (!adoption || typeof adoption !== "object" || Array.isArray(adoption)
            || Object.keys(adoption).some((key) => !["path", "ownerInstanceId", "sha256"].includes(key))) {
            throw new Error("Managed file adoption is invalid");
        }
        if (typeof adoption.path !== "string" || adoption.path.includes("\\")
            || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(adoption.ownerInstanceId ?? "")
            || !/^[0-9a-f]{64}$/u.test(adoption.sha256 ?? "") || result.has(adoption.path)) {
            throw new Error(`Managed file adoption is invalid: ${adoption.path ?? "unknown"}`);
        }
        result.set(adoption.path, adoption);
    }
    return result;
}

function extensionTarget(instanceId, sourcePath) {
    return `.release-ops/runtime/extensions/${instanceId}/${sourcePath.replaceAll("\\", "/")}`;
}

export async function desiredProjectFiles(root, config, graph, registry, workflows, {
    adoptions = [],
    contributions = [],
} = {}) {
    const desired = new Map();
    addDesired(desired, ".release-ops/config.json", jsonBytes(config), "kernel");
    addDesired(desired, ".release-ops/processor-graph.json", jsonBytes(graph), "kernel");
    for (const source of KERNEL_RUNTIME_FILES) {
        addDesired(desired, `.release-ops/runtime/kernel/${source.split("/").at(-1)}`, await readFile(resolve(PLUGIN_ROOT, source)), "kernel");
    }
    for (const instance of config.extensions) {
        const manifest = registry[instance.extensionId];
        addDesired(desired, extensionTarget(instance.instanceId, "extension.json"), await readFile(manifest.manifestPath), instance.instanceId);
        addDesired(desired, extensionTarget(instance.instanceId, "config.schema.json"), await readFile(manifest.schemaPath), instance.instanceId);
        for (const sourcePath of [...new Set([...manifest.modulePaths, ...manifest.runtimePaths])]) {
            const relativeSource = relativePluginPath(sourcePath);
            addDesired(desired, extensionTarget(instance.instanceId, relativeSource), await readFile(sourcePath), instance.instanceId);
        }
    }
    const workflowTargets = new Map();
    for (const contribution of workflows) {
        if (workflowTargets.has(contribution.path)) throw new Error(`Workflow has multiple owners: ${contribution.path}`);
        const rendered = renderWorkflow(contribution.model);
        addDesired(desired, contribution.path, rendered, contribution.ownerInstanceId);
        workflowTargets.set(contribution.path, contribution.ownerInstanceId);
    }
    for (const contribution of contributions) {
        if (!contribution || typeof contribution.path !== "string" || typeof contribution.content !== "string"
            || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(contribution.ownerInstanceId ?? "")) {
            throw new Error("Managed file contribution is invalid");
        }
        if (/^\.github\/workflows\//u.test(contribution.path)) {
            throw new Error("Workflow paths require a structured workflow contribution");
        }
        addDesired(desired, contribution.path, contribution.content, contribution.ownerInstanceId);
    }
    const requested = normalizeAdoptions(adoptions);
    for (const [path, adoption] of requested) {
        if (workflowTargets.get(path) !== adoption.ownerInstanceId) {
            throw new Error(`Managed file adoption must target the owning active workflow: ${path}`);
        }
        const current = await existingBytes(root, path);
        if (!current || sha256(current) !== adoption.sha256) throw new Error(`Managed file adoption SHA-256 does not match: ${path}`);
        new TextDecoder("utf-8", { fatal: true }).decode(current);
        desired.set(path, {
            path,
            bytes: Buffer.from(current),
            ownerInstanceId: adoption.ownerInstanceId,
            mode: "adopted",
        });
    }
    return desired;
}

async function previousManagedState(root) {
    try {
        const value = JSON.parse(await readFile(resolve(root, ".release-ops", "managed-files.json"), "utf8"));
        if (value.schemaVersion === MANAGED_SCHEMA || value.schemaVersion === "release-ops-managed-files/v2") return value;
        throw new Error(`Managed files schema is incompatible: ${value.schemaVersion}`);
    } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
    }
}

function previousFiles(state) {
    const result = {};
    for (const [path, record] of Object.entries(state?.files ?? {})) {
        result[path] = typeof record === "string" ? { desiredHash: record } : record;
    }
    return result;
}

function isReinitializableConfig(path, bytes) {
    if (path !== ".release-ops/config.json" || !bytes) return false;
    try {
        return JSON.parse(bytes.toString("utf8")).schemaVersion === "release-ops/config/v2";
    } catch {
        return false;
    }
}

export async function planProjectFiles(root, config, graph, registry, workflows, {
    adoptions = [],
    contributions = [],
} = {}) {
    const previous = previousFiles(await previousManagedState(root));
    const desired = await desiredProjectFiles(root, config, graph, registry, workflows, { adoptions, contributions });
    const paths = [...new Set([...Object.keys(previous), ...desired.keys()])].sort();
    const operations = [];
    const conflicts = [];
    for (const path of paths) {
        const current = await existingBytes(root, path);
        const currentHash = current ? sha256(current) : null;
        const wanted = desired.get(path) ?? null;
        const desiredHash = wanted ? sha256(wanted.bytes) : null;
        const previousHash = previous[path]?.desiredHash ?? previous[path]?.currentHash ?? null;
        let operation = "unchanged";
        if (currentHash !== desiredHash) operation = !desiredHash ? "delete" : !currentHash ? "add" : "update";
        if (operation !== "unchanged") {
            if (previous[path] && currentHash !== previousHash) {
                conflicts.push({ path, reason: "managed-file-changed", expectedHash: previousHash, currentHash });
            } else if (!previous[path] && currentHash && wanted?.mode !== "adopted" && !isReinitializableConfig(path, current)) {
                conflicts.push({ path, reason: "unmanaged-file-exists", currentHash });
            }
        }
        operations.push({
            path,
            operation,
            ownerInstanceId: wanted?.ownerInstanceId ?? previous[path]?.ownerInstanceId ?? previous[path]?.owner ?? "kernel",
            baseHash: previousHash,
            currentHash,
            desiredHash,
            mode: wanted?.mode ?? previous[path]?.mode ?? "generated",
        });
    }
    const workflowRecords = operations.filter(({ path }) => /^\.github\/workflows\//u.test(path) && desired.has(path))
        .map(({ path, desiredHash, ownerInstanceId, mode }) => ({ path, desiredHash, ownerInstanceId, mode }));
    return {
        schemaVersion: MANAGED_PLAN_SCHEMA,
        operations,
        conflicts,
        workflowDigest: sha256(stableJson(workflowRecords)),
        adoptions: [...normalizeAdoptions(adoptions).values()].sort((left, right) => left.path.localeCompare(right.path)),
        desired,
    };
}

export function publicManagedPlan(plan) {
    return {
        schemaVersion: plan.schemaVersion,
        operations: plan.operations,
        conflicts: plan.conflicts,
        workflowDigest: plan.workflowDigest,
        adoptions: plan.adoptions,
    };
}

function managedManifest(configDigest, graphDigest, plan) {
    const files = {};
    for (const [path, wanted] of [...plan.desired.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const operation = plan.operations.find((candidate) => candidate.path === path);
        const desiredHash = sha256(wanted.bytes);
        files[path] = {
            ownerInstanceId: wanted.ownerInstanceId,
            baseHash: operation?.currentHash ?? null,
            currentHash: desiredHash,
            desiredHash,
            mode: wanted.mode,
        };
    }
    return {
        schemaVersion: MANAGED_SCHEMA,
        configDigest,
        graphDigest,
        workflowDigest: plan.workflowDigest,
        files,
    };
}

async function removeEmptyParents(root, path) {
    const stop = resolve(root, ".release-ops");
    let directory = dirname(resolve(root, path));
    while (directory.startsWith(stop) && directory !== stop) {
        try {
            await rmdir(directory);
        } catch (error) {
            if (["ENOTEMPTY", "ENOENT", "EEXIST"].includes(error?.code)) return;
            throw error;
        }
        directory = dirname(directory);
    }
}

export async function installProjectFiles(root, plan, {
    expectedPlan,
    configDigest,
    graphDigest,
    transactionId = randomUUID(),
    failAfter = null,
} = {}) {
    if (plan.conflicts.length) throw new Error(`Managed file conflicts: ${plan.conflicts.map(({ path }) => path).join(", ")}`);
    if (expectedPlan && stableJson(publicManagedPlan(plan)) !== stableJson(expectedPlan)) {
        throw new Error("Managed file state changed after the confirmed plan");
    }
    const releaseOpsRoot = await resolveRepositoryPath(root, ".release-ops", { name: "Release Ops state directory" });
    await mkdir(releaseOpsRoot, { recursive: true });
    const transactionRoot = join(releaseOpsRoot, ".transactions", transactionId);
    const staged = join(transactionRoot, "staging");
    const backup = join(transactionRoot, "backup");
    const journalPath = join(transactionRoot, "journal.json");
    await mkdir(staged, { recursive: true });
    const changed = plan.operations.filter(({ operation }) => operation !== "unchanged");
    for (const operation of changed.filter(({ desiredHash }) => desiredHash)) {
        const target = join(staged, operation.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, plan.desired.get(operation.path).bytes);
    }
    const manifest = managedManifest(configDigest, graphDigest, plan);
    const stagedManifest = join(staged, ".release-ops", "managed-files.json");
    await mkdir(dirname(stagedManifest), { recursive: true });
    await writeFile(stagedManifest, jsonBytes(manifest));
    const journal = { schemaVersion: "release-ops/apply-journal/v1", transactionId, phase: "prepared", applied: [] };
    await writeFile(journalPath, jsonBytes(journal));
    let manifestState = null;
    try {
        journal.phase = "applying";
        await writeFile(journalPath, jsonBytes(journal));
        for (const operation of changed) {
            const target = await resolveRepositoryPath(root, operation.path, { name: `managed file ${operation.path}` });
            const saved = join(backup, operation.path);
            if (operation.currentHash) {
                await mkdir(dirname(saved), { recursive: true });
                await rename(target, saved);
            }
            if (operation.desiredHash) {
                await mkdir(dirname(target), { recursive: true });
                await rename(join(staged, operation.path), target);
            }
            journal.applied.push({ path: operation.path, currentHash: operation.currentHash, desiredHash: operation.desiredHash });
            await writeFile(journalPath, jsonBytes(journal));
            if (failAfter !== null && journal.applied.length === failAfter) throw new Error("Injected transaction failure");
        }
        const manifestTarget = join(releaseOpsRoot, "managed-files.json");
        const manifestBackup = join(backup, ".release-ops", "managed-files.json");
        let hadManifest = false;
        try {
            await access(manifestTarget);
            hadManifest = true;
            await mkdir(dirname(manifestBackup), { recursive: true });
            await rename(manifestTarget, manifestBackup);
        } catch (error) {
            if (error?.code !== "ENOENT") throw error;
        }
        manifestState = { manifestTarget, manifestBackup, hadManifest };
        await rename(stagedManifest, manifestTarget);
        journal.phase = "committed";
        await writeFile(journalPath, jsonBytes(journal));
    } catch (error) {
        journal.phase = "rolling-back";
        await writeFile(journalPath, jsonBytes(journal));
        if (manifestState) {
            await rm(manifestState.manifestTarget, { force: true });
            if (manifestState.hadManifest) await rename(manifestState.manifestBackup, manifestState.manifestTarget);
        }
        for (const applied of [...journal.applied].reverse()) {
            const target = await resolveRepositoryPath(root, applied.path, { name: `managed file ${applied.path}` });
            if (applied.desiredHash) await rm(target, { force: true });
            if (applied.currentHash) {
                const saved = join(backup, applied.path);
                await mkdir(dirname(target), { recursive: true });
                await rename(saved, target);
            }
        }
        journal.phase = "rolled-back";
        await writeFile(journalPath, jsonBytes(journal));
        await rm(transactionRoot, { recursive: true, force: true });
        throw error;
    }
    for (const operation of changed.filter(({ desiredHash }) => !desiredHash)) await removeEmptyParents(root, operation.path);
    await rm(transactionRoot, { recursive: true, force: true });
    return manifest;
}

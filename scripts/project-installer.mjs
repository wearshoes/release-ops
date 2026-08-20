import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ADAPTERS, PROVIDERS } from "./provider-registry.mjs";
import { resolveRepositoryPath } from "./path-safety.mjs";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_RUNTIME_FILES = [
    "config.mjs",
    "provider-registry.mjs",
    "path-safety.mjs",
    "github-client.mjs",
    "release-publisher.mjs",
    "preflight-release.mjs",
    "run-build.mjs",
    "collect-artifacts.mjs",
    "local-release.mjs",
    "release-entry.mjs",
    "dispatch-release.mjs",
    "workflow-dispatch.mjs",
    "github-admin.mjs",
];

const ACTIONS = Object.freeze({
    checkout: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262", // v4
    node: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020", // v4
    java: "actions/setup-java@cf277c60eb25467037889841efdb72551f06f6c3", // v4
    dotnet: "actions/setup-dotnet@67a3573c9a986a3f9c594539f4ab511d57bb3ce9", // v4
    flutter: "subosito/flutter-action@1a449444c387b1966244ae4d4f8c696479add0b2", // v2
    godot: "chickensoft-games/setup-godot@f166999204a4f2722c6fe042fbaa3b3ea0d9c789", // v2
    unity: "game-ci/unity-builder@1d4ee0697f193f54668e98961d79907911f4b4f2", // v4
    upload: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02", // v4
    download: "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093", // v4
});

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function yamlString(value) {
    return JSON.stringify(String(value));
}

function yamlEnv(names, indent) {
    if (!names.length) return "";
    return `${" ".repeat(indent)}env:\n${names.map((name) => `${" ".repeat(indent + 2)}${name}: \${{ secrets.${name} }}`).join("\n")}\n`;
}

function adapterSetup(config, unit) {
    const adapter = config.project.adapter;
    if (unit.runner === "self-hosted" && adapter === "godot") return "";
    if (adapter === "android-gradle" || (adapter === "react-native" && unit.target === "android")) {
        return `      - uses: ${ACTIONS.java}\n        with:\n          distribution: temurin\n          java-version: "17"\n`;
    }
    if (adapter === "dotnet") {
        return `      - uses: ${ACTIONS.dotnet}\n        with:\n          dotnet-version: "8.0.x"\n`;
    }
    if (adapter === "flutter") {
        return `      - uses: ${ACTIONS.flutter}\n        with:\n          channel: stable\n          cache: true\n`;
    }
    if (adapter === "godot") {
        const android = unit.target === "android"
            ? `      - uses: ${ACTIONS.java}\n        with:\n          distribution: temurin\n          java-version: "17"\n`
            : "";
        return `${android}      - uses: ${ACTIONS.godot}\n        with:\n          version: ${yamlString(config.project.adapterOptions.godotVersion)}\n          use-dotnet: false\n`;
    }
    return "";
}

function commandBuildStep(config, unit) {
    if (config.project.adapter === "unity") {
        const license = config.project.adapterOptions.license;
        const secrets = license === "personal"
            ? ["UNITY_LICENSE", "UNITY_EMAIL", "UNITY_PASSWORD"]
            : ["UNITY_SERIAL", "UNITY_EMAIL", "UNITY_PASSWORD"];
        return `      - name: Build ${unit.id} with GameCI
${yamlEnv(secrets, 8)}        uses: ${ACTIONS.unity}
        with:
          projectPath: ${yamlString(config.project.adapterOptions.projectPath)}
          targetPlatform: ${yamlString(unit.target)}
`;
    }
    return `      - name: Build ${unit.id}
${yamlEnv(unit.requiredSecretNames ?? [], 8)}        run: node .release-ops/runtime/run-build.mjs --root . --unit ${yamlString(unit.id)}
`;
}

function providerUploadSteps(config, unit) {
    const steps = [];
    for (const [id, providerConfig] of Object.entries(config.providers)) {
        const provider = PROVIDERS[id];
        if (!providerConfig.enabled || !provider?.buildHook) continue;
        const secret = provider.requiredSecrets[provider.buildHook.secretRole];
        steps.push(`      - name: Upload ${id} debug artifacts for ${unit.id}
        env:
          ${secret}: \${{ secrets.${secret} }}
        run: >-
          node .release-ops/runtime/${provider.buildHook.script}
          --root . --mode upload --unit ${yamlString(unit.id)}
          --version "\${{ inputs.version }}" --build-numbers "\${{ inputs.buildNumbers }}"
          --sha "\${{ inputs.sourceSha }}"
`);
    }
    return steps.join("");
}

function buildJob(config, unit) {
    return `  build_${unit.id.replaceAll("-", "_")}:
    name: Build ${unit.id}
    runs-on: ${unit.runner}
    steps:
      - uses: ${ACTIONS.checkout}
        with:
          ref: \${{ inputs.sourceSha }}
          fetch-depth: 0
      - uses: ${ACTIONS.node}
        with:
          node-version: "22"
${adapterSetup(config, unit)}${commandBuildStep(config, unit)}${providerUploadSteps(config, unit)}      - name: Collect ${unit.id} artifacts
        run: >-
          node .release-ops/runtime/collect-artifacts.mjs --root .
          --unit ${yamlString(unit.id)} --output .release-ops/upload
      - uses: ${ACTIONS.upload}
        with:
          name: release-ops-${unit.id}
          path: .release-ops/upload/${unit.id}
          if-no-files-found: error
          retention-days: 1
`;
}

function providerReleaseJobs(config, buildNeeds) {
    const jobs = [];
    for (const [id, providerConfig] of Object.entries(config.providers)) {
        const provider = PROVIDERS[id];
        if (!providerConfig.enabled || !provider?.buildHook) continue;
        const secret = provider.requiredSecrets[provider.buildHook.secretRole];
        jobs.push(`  provider_${id.replaceAll("-", "_")}:
    name: Finalize ${id} release
    needs: [${buildNeeds.join(", ")}]
    runs-on: ubuntu-latest
    steps:
      - uses: ${ACTIONS.checkout}
        with:
          ref: \${{ inputs.sourceSha }}
          fetch-depth: 0
      - uses: ${ACTIONS.node}
        with:
          node-version: "22"
      - name: Finalize ${id} release
        env:
          ${secret}: \${{ secrets.${secret} }}
        run: >-
          node .release-ops/runtime/${provider.buildHook.script}
          --root . --mode release --version "\${{ inputs.version }}"
          --build-numbers "\${{ inputs.buildNumbers }}" --sha "\${{ inputs.sourceSha }}"
`);
    }
    return jobs;
}

export function renderPublishWorkflow(config) {
    const buildNames = config.build.units.map(({ id }) => `build_${id.replaceAll("-", "_")}`);
    const providerJobs = providerReleaseJobs(config, buildNames);
    const providerNames = Object.entries(config.providers)
        .filter(([id, providerConfig]) => providerConfig.enabled && PROVIDERS[id]?.buildHook)
        .map(([id]) => `provider_${id.replaceAll("-", "_")}`);
    const needs = [...buildNames, ...providerNames];
    const sourceRepository = config.hosting.github.source.repository;
    const releaseSecrets = config.hosting.github.releaseMode === "dual-repository" ? ["RELEASE_REPO_TOKEN"] : [];
    return `name: Publish Release
run-name: Release v\${{ inputs.version }} from \${{ inputs.sourceSha }} [\${{ inputs.correlation }}]

on:
  workflow_dispatch:
    inputs:
      version:
        required: true
        type: string
      buildNumbers:
        required: true
        type: string
      sourceSha:
        required: true
        type: string
      correlation:
        required: true
        type: string

permissions:
  contents: read

concurrency:
  group: release-ops-publish
  cancel-in-progress: false

jobs:
${config.build.units.map((unit) => buildJob(config, unit)).join("")}${providerJobs.join("")}  publish:
    name: Publish verified artifacts
    if: github.repository == '${sourceRepository}'
    needs: [${needs.join(", ")}]
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: ${ACTIONS.checkout}
        with:
          ref: \${{ inputs.sourceSha }}
          fetch-depth: 0
      - uses: ${ACTIONS.node}
        with:
          node-version: "22"
      - name: Verify release inputs
        run: >-
          node .release-ops/runtime/preflight-release.mjs --root .
          --version "\${{ inputs.version }}" --build-numbers "\${{ inputs.buildNumbers }}"
          --sha "\${{ inputs.sourceSha }}"
      - uses: ${ACTIONS.download}
        with:
          pattern: release-ops-*
          path: .release-ops/collected
          merge-multiple: false
      - name: Publish locally built artifacts
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
${releaseSecrets.map((name) => `          ${name}: \${{ secrets.${name} }}`).join("\n")}${releaseSecrets.length ? "\n" : ""}        run: >-
          node .release-ops/runtime/release-publisher.mjs --root .
          --version "\${{ inputs.version }}" --build-numbers "\${{ inputs.buildNumbers }}"
          --sha "\${{ inputs.sourceSha }}" --correlation "\${{ inputs.correlation }}"
          --artifact-root .release-ops/collected
`;
}

function templateValues(config) {
    return {
        "__SOURCE_REPOSITORY__": config.hosting.github.source?.repository ?? "disabled/disabled",
        "__DEFAULT_BRANCH__": config.hosting.github.source?.defaultBranch ?? "main",
        "__SCHEDULE__": config.providers.sentry?.schedule ?? "17 * * * *",
    };
}

async function desiredProjectFiles(config, { includeConfig = false } = {}) {
    const desired = new Map();
    const add = (path, bytes) => desired.set(path.replaceAll("\\", "/"), Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8"));
    if (includeConfig) add(".release-ops/config.json", `${JSON.stringify(config, null, 2)}\n`);
    for (const name of CORE_RUNTIME_FILES) add(`.release-ops/runtime/${name}`, await readFile(resolve(PLUGIN_ROOT, "scripts", name)));
    for (const [id, adapter] of Object.entries(ADAPTERS)) {
        add(`.release-ops/runtime/adapters/${id}/adapter.json`, await readFile(join(adapter.manifestDirectory, "adapter.json")));
    }
    for (const [id, providerConfig] of Object.entries(config.providers)) {
        const provider = PROVIDERS[id];
        if (!providerConfig.enabled) continue;
        add(`.release-ops/runtime/providers/${id}/provider.json`, await readFile(join(provider.manifestDirectory, "provider.json")));
        add(`.release-ops/runtime/providers/${id}/${provider.configSchema}`, await readFile(join(provider.manifestDirectory, provider.configSchema)));
        for (const name of provider.runtimeFiles) add(`.release-ops/runtime/${name}`, await readFile(resolve(PLUGIN_ROOT, "scripts", name)));
        for (const managed of provider.managedFiles ?? []) {
            if (managed.requiresIssueSync && !providerConfig.issueSync) continue;
            let text = await readFile(join(provider.manifestDirectory, managed.source), "utf8");
            for (const [token, value] of Object.entries(templateValues(config))) text = text.replaceAll(token, value);
            add(managed.target, text);
        }
    }
    if (config.hosting.github.enabled) add(config.release.workflowFile, renderPublishWorkflow(config));
    return desired;
}

async function existingBytes(root, relativePath) {
    const target = await resolveRepositoryPath(root, relativePath, { name: `managed file ${relativePath}` });
    try {
        return await readFile(target);
    } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
    }
}

function normalizePrevious(previous) {
    const result = {};
    for (const [path, record] of Object.entries(previous?.files ?? {})) {
        result[path] = typeof record === "string" ? { desiredHash: record } : record;
    }
    return result;
}

function normalizeAdoptions(adoptions) {
    if (!Array.isArray(adoptions)) throw new Error("Managed file adoptions must be an array");
    const result = new Map();
    for (const adoption of adoptions) {
        if (!adoption || typeof adoption !== "object" || Array.isArray(adoption)) throw new Error("Managed file adoption must be an object");
        if (Object.keys(adoption).some((key) => !["path", "owner", "sha256"].includes(key))) {
            throw new Error("Managed file adoption contains an unsupported field");
        }
        const { path, owner, sha256: expectedHash } = adoption;
        if (typeof path !== "string" || !path || path.includes("\\")) throw new Error("Managed file adoption path is invalid");
        if (owner !== "release" && !/^provider:[a-z0-9][a-z0-9-]{0,63}$/u.test(owner ?? "")) {
            throw new Error("Managed file adoption owner is invalid");
        }
        if (!/^[0-9a-f]{64}$/u.test(expectedHash ?? "")) throw new Error("Managed file adoption SHA-256 is invalid");
        if (result.has(path)) throw new Error(`Managed file adoption is duplicated: ${path}`);
        result.set(path, { path, owner, sha256: expectedHash });
    }
    return result;
}

function adoptableWorkflowOwners(config) {
    const result = new Map();
    const add = (path, owner) => {
        const normalized = path.replaceAll("\\", "/");
        if (result.has(normalized) && result.get(normalized) !== owner) {
            throw new Error(`Managed workflow has conflicting owners: ${normalized}`);
        }
        result.set(normalized, owner);
    };
    if (config.hosting.github.enabled) add(config.release.workflowFile, "release");
    for (const [id, providerConfig] of Object.entries(config.providers)) {
        const provider = PROVIDERS[id];
        if (!providerConfig.enabled || !provider) continue;
        for (const managed of provider.managedFiles ?? []) {
            if (managed.requiresIssueSync && !providerConfig.issueSync) continue;
            add(managed.target, `provider:${id}`);
        }
    }
    return result;
}

export async function planProjectFiles(root, config, { includeConfig = false, adoptions = [] } = {}) {
    const manifestPath = resolve(root, ".release-ops", "managed-files.json");
    let previous = null;
    try {
        previous = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
    }
    const previousFiles = normalizePrevious(previous);
    const desired = await desiredProjectFiles(config, { includeConfig });
    const workflowOwners = adoptableWorkflowOwners(config);
    const requestedAdoptions = normalizeAdoptions(adoptions);
    for (const [path, adoption] of requestedAdoptions) {
        if (!desired.has(path) || !workflowOwners.has(path)) {
            throw new Error(`Managed file adoption is not an active Release Ops workflow target: ${path}`);
        }
        if (workflowOwners.get(path) !== adoption.owner) {
            throw new Error(`Managed file adoption owner does not match its workflow: ${path}`);
        }
    }
    const paths = [...new Set([...Object.keys(previousFiles), ...desired.keys()])].sort();
    const operations = [];
    const conflicts = [];
    const activeAdoptions = new Map();
    for (const path of paths) {
        const current = await existingBytes(root, path);
        const currentHash = current ? sha256(current) : null;
        const requestedAdoption = requestedAdoptions.get(path);
        const previousAdoption = previousFiles[path]?.mode === "adopted" && workflowOwners.get(path) === previousFiles[path].owner
            ? { path, owner: previousFiles[path].owner, sha256: previousFiles[path].desiredHash }
            : null;
        const adoption = requestedAdoption ?? previousAdoption;
        if (requestedAdoption && currentHash !== requestedAdoption.sha256) {
            throw new Error(`Managed file adoption SHA-256 does not match: ${path}`);
        }
        if (adoption && desired.has(path)) {
            activeAdoptions.set(path, adoption);
            if (currentHash === adoption.sha256) desired.set(path, current);
        }
        const desiredBytes = desired.get(path) ?? null;
        const desiredHash = adoption && desired.has(path) && currentHash !== adoption.sha256
            ? adoption.sha256
            : desiredBytes ? sha256(desiredBytes) : null;
        const previousHash = previousFiles[path]?.desiredHash ?? null;
        let operation = "unchanged";
        if (desiredHash === currentHash) operation = "unchanged";
        else if (!desiredHash && currentHash) operation = "delete";
        else if (desiredHash && !currentHash) operation = "add";
        else operation = "update";
        const managedBefore = Boolean(previousFiles[path]);
        const reinitializingV1Config = path === ".release-ops/config.json" && current && (() => {
            try { return JSON.parse(current.toString("utf8")).schemaVersion === "release-ops/config/v1"; } catch { return false; }
        })();
        if (operation !== "unchanged") {
            if (managedBefore && currentHash !== previousHash) conflicts.push({ path, reason: "managed-file-changed", expectedHash: previousHash, currentHash });
            else if (!managedBefore && currentHash && !reinitializingV1Config) conflicts.push({ path, reason: "unmanaged-file-exists", currentHash });
        }
        operations.push({ path, operation, baseHash: previousHash, currentHash, desiredHash });
    }
    return {
        schemaVersion: "release-ops-managed-plan/v2",
        operations,
        conflicts,
        desired,
        adoptions: [...activeAdoptions.values()].sort((left, right) => left.path.localeCompare(right.path)),
    };
}

function publicPlan(plan) {
    return {
        schemaVersion: plan.schemaVersion,
        operations: plan.operations,
        conflicts: plan.conflicts,
        adoptions: plan.adoptions,
    };
}

export async function installProjectFiles(root, config, {
    includeConfig = false,
    expectedPlan = null,
    adoptions = [],
} = {}) {
    const plan = await planProjectFiles(root, config, { includeConfig, adoptions });
    if (plan.conflicts.length) throw new Error(`Managed file conflicts: ${plan.conflicts.map(({ path }) => path).join(", ")}`);
    if (expectedPlan && JSON.stringify(publicPlan(plan)) !== JSON.stringify(expectedPlan)) {
        throw new Error("Managed file state changed after the confirmed setup plan");
    }
    const releaseOpsRoot = await resolveRepositoryPath(root, ".release-ops", { name: "Release Ops state directory" });
    await mkdir(releaseOpsRoot, { recursive: true });
    const stage = join(releaseOpsRoot, `.apply-${randomUUID()}`);
    const staged = join(stage, "new");
    const backup = join(stage, "backup");
    await mkdir(staged, { recursive: true });
    const changed = plan.operations.filter(({ operation }) => operation !== "unchanged");
    const manifest = {
        schemaVersion: "release-ops-managed-files/v2",
        files: Object.fromEntries([...plan.desired.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, bytes]) => {
            const operation = plan.operations.find((entry) => entry.path === path);
            const hash = sha256(bytes);
            const adoption = plan.adoptions.find((entry) => entry.path === path);
            return [path, {
                baseHash: operation?.currentHash ?? null,
                currentHash: hash,
                desiredHash: hash,
                ...(adoption ? { mode: "adopted", owner: adoption.owner } : {}),
            }];
        })),
    };
    for (const operation of changed.filter(({ desiredHash }) => desiredHash)) {
        const path = join(staged, operation.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, plan.desired.get(operation.path));
    }
    const stagedManifest = join(staged, ".release-ops", "managed-files.json");
    await mkdir(dirname(stagedManifest), { recursive: true });
    await writeFile(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const applied = [];
    let manifestTarget = null;
    let manifestBackup = null;
    let manifestHadPrevious = false;
    try {
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
            applied.push({ ...operation, target, saved });
        }
        manifestTarget = join(releaseOpsRoot, "managed-files.json");
        manifestBackup = join(backup, ".release-ops", "managed-files.json");
        try {
            await access(manifestTarget);
            manifestHadPrevious = true;
            await mkdir(dirname(manifestBackup), { recursive: true });
            await rename(manifestTarget, manifestBackup);
        } catch (error) {
            if (error?.code !== "ENOENT") throw error;
        }
        await rename(stagedManifest, manifestTarget);
    } catch (error) {
        if (manifestTarget) {
            await rm(manifestTarget, { force: true });
            if (manifestHadPrevious) {
                await mkdir(dirname(manifestTarget), { recursive: true });
                await rename(manifestBackup, manifestTarget);
            }
        }
        for (const operation of applied.reverse()) {
            if (operation.desiredHash) await rm(operation.target, { force: true });
            if (operation.currentHash) {
                await mkdir(dirname(operation.target), { recursive: true });
                await rename(operation.saved, operation.target);
            }
        }
        throw error;
    } finally {
        await rm(stage, { recursive: true, force: true });
    }
    return manifest;
}

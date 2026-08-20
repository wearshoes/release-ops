import { execFileSync } from "node:child_process";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CONFIG_SCHEMA, configDigest, validateConfig } from "./config.mjs";
import { loadExtensionCatalog, hydrateExtensions, publicExtension, PLUGIN_ROOT } from "./extension-registry.mjs";
import { createRepository, ensureDistributionReadme, inspectRepository, listSecretMetadata } from "./github-admin.mjs";
import { createGitHubClient } from "./github-client.mjs";
import { createKernelApi } from "./kernel-api.mjs";
import { createProcessorGraph, nodesForEntrypoint } from "./processor-graph.mjs";
import { installProjectFiles, planProjectFiles, publicManagedPlan } from "./project-installer.mjs";
import { sha256, stableJson } from "./stable.mjs";

export const ANSWERS_SCHEMA = "release-ops/setup-answers/v1";
export const PLAN_SCHEMA = "release-ops/setup-plan/v1";
export const INSPECT_SCHEMA = "release-ops/inspect/v1";
export const AUDIT_SCHEMA = "release-ops/audit/v1";

const LEGACY_CONFIG_SCHEMA = "release-ops/config/v2";
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SETUP_MODES = new Set(["initialize", "reconfigure", "reinitialize"]);
const QUESTION_PHASES = ["stack", "build-unit", "signing", "release", "github-topology", "provider"];

function freeze(value) {
    if (Array.isArray(value)) value.forEach(freeze);
    else if (value && typeof value === "object") Object.values(value).forEach(freeze);
    return Object.freeze(value);
}

function exactKeys(value, name, allowed) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
    for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${name}.${key} is not supported`);
}

function git(root, args) {
    try {
        return execFileSync("git", ["-C", root, ...args], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true,
        }).trim();
    } catch {
        return null;
    }
}

async function exists(path) {
    try {
        await access(path);
        return true;
    } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
    }
}

async function walk(root, maxDepth = 5, depth = 0) {
    if (depth > maxDepth) return [];
    const paths = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
        if ([".git", ".codegraph", ".gradle", ".release-ops", "build", "dist", "node_modules"].includes(entry.name)) continue;
        const path = join(root, entry.name);
        paths.push(path);
        if (entry.isDirectory() && !entry.isSymbolicLink()) paths.push(...await walk(path, maxDepth, depth + 1));
    }
    return paths;
}

function relativePath(root, path) {
    return relative(resolve(root), path).replaceAll("\\", "/");
}

function lightweightConfigValidation(raw, catalog) {
    exactKeys(raw, "config", new Set(["schemaVersion", "project", "extensions"]));
    if (raw.schemaVersion !== CONFIG_SCHEMA) throw new Error(`schemaVersion must be ${CONFIG_SCHEMA}`);
    exactKeys(raw.project, "project", new Set(["name"]));
    if (typeof raw.project.name !== "string" || !raw.project.name.trim()) throw new Error("project.name is invalid");
    if (!Array.isArray(raw.extensions) || raw.extensions.length < 2) throw new Error("extensions must contain a stack and release instance");
    const instances = new Set();
    let stacks = 0;
    let releases = 0;
    for (const [index, instance] of raw.extensions.entries()) {
        exactKeys(instance, `extensions[${index}]`, new Set(["instanceId", "extensionId", "configSchemaVersion", "config"]));
        if (!ID.test(instance.instanceId ?? "") || !ID.test(instance.extensionId ?? "") || instances.has(instance.instanceId)) {
            throw new Error(`extensions[${index}] identity is invalid or duplicated`);
        }
        instances.add(instance.instanceId);
        const manifest = catalog[instance.extensionId];
        if (!manifest || manifest.status === "diagnostic" || manifest.configSchemaVersion !== instance.configSchemaVersion) {
            throw new Error(`extensions[${index}] references an unavailable extension contract`);
        }
        if (!instance.config || typeof instance.config !== "object" || Array.isArray(instance.config)) {
            throw new Error(`extensions[${index}].config must be an object`);
        }
        if (manifest.type === "stack") stacks += 1;
        if (manifest.type === "release") releases += 1;
    }
    if (!stacks || releases !== 1) throw new Error("config requires at least one stack and exactly one release extension");
    return raw;
}

async function configState(root, catalog) {
    const path = resolve(root, ".release-ops", "config.json");
    if (!(await exists(path))) return { status: "missing", action: "initialize" };
    let raw;
    try {
        raw = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
        return { status: "invalid", action: "reinitialize", message: `Config is not valid UTF-8 JSON: ${error.message}` };
    }
    if (raw?.schemaVersion === LEGACY_CONFIG_SCHEMA) {
        return { status: "incompatible", schemaVersion: LEGACY_CONFIG_SCHEMA, action: "reinitialize" };
    }
    try {
        lightweightConfigValidation(raw, catalog);
        return {
            status: "valid",
            schemaVersion: CONFIG_SCHEMA,
            instanceIds: raw.extensions.map(({ instanceId }) => instanceId),
            action: "audit",
        };
    } catch (error) {
        return {
            status: "invalid",
            schemaVersion: typeof raw?.schemaVersion === "string" ? raw.schemaVersion : null,
            action: "reinitialize",
            message: error.message,
        };
    }
}

function setupRouteForState(state) {
    if (state.status === "missing") return { defaultCommand: "plan", allowed: ["initialize"], requiredMode: "initialize" };
    if (state.status === "valid") {
        return { defaultCommand: "audit", allowed: ["audit", "reconfigure", "reinitialize"], requiredMode: null };
    }
    return { defaultCommand: "reinitialize", allowed: ["reinitialize"], requiredMode: "reinitialize" };
}

async function matchesDetection(root, detection, repositoryPaths) {
    const present = (pattern) => pattern.startsWith("*.")
        ? repositoryPaths.some((path) => basename(path).endsWith(pattern.slice(1)))
        : repositoryPaths.includes(pattern.replaceAll("\\", "/"));
    if ((detection?.all ?? []).some((pattern) => !present(pattern))) return false;
    if ((detection?.any ?? []).length && !detection.any.some(present)) return false;
    for (const rule of detection?.content ?? []) {
        try {
            const text = await readFile(resolve(root, rule.path), "utf8");
            if (!new RegExp(rule.pattern, "u").test(text)) return false;
        } catch (error) {
            if (error?.code === "ENOENT") return false;
            throw error;
        }
    }
    return Boolean((detection?.all ?? []).length || (detection?.any ?? []).length || (detection?.content ?? []).length);
}

async function inspectVersionSources(root) {
    const candidates = [];
    const add = (kind, file, reader, key, value) => candidates.push({ kind, file, reader, key, value });
    for (const [file, reader] of [["gradle.properties", "gradle-properties"], ["version.properties", "properties"]]) {
        try {
            const text = await readFile(resolve(root, file), "utf8");
            for (const line of text.split(/\r?\n/u)) {
                const match = /^\s*([A-Za-z][A-Za-z0-9_.-]*)\s*=\s*(.*?)\s*$/u.exec(line);
                if (!match) continue;
                if (/^(?:VERSION|VERSION_NAME|versionName)$/u.test(match[1])) add("canonical", file, reader, match[1], match[2]);
                if (/^(?:CODE|VERSION_CODE|versionCode)$/u.test(match[1])) add("build-number", file, reader, match[1], match[2]);
            }
        } catch (error) {
            if (error?.code !== "ENOENT") throw error;
        }
    }
    try {
        const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
        if (typeof packageJson.version === "string") add("canonical", "package.json", "package-json", "version", packageJson.version);
    } catch (error) {
        if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    try {
        const text = await readFile(resolve(root, "pubspec.yaml"), "utf8");
        const match = /^version:\s*([^+\s]+)(?:\+([^\s]+))?/mu.exec(text);
        if (match) {
            add("canonical", "pubspec.yaml", "pubspec", "version", match[1]);
            if (match[2]) add("build-number", "pubspec.yaml", "pubspec", "build", match[2]);
        }
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
    }
    return candidates;
}

export async function inspectProject(root) {
    const absoluteRoot = resolve(root);
    const catalog = await loadExtensionCatalog();
    const paths = await walk(absoluteRoot);
    const repositoryPaths = paths.map((path) => relativePath(absoluteRoot, path));
    const stackCandidates = [];
    for (const manifest of Object.values(catalog).filter(({ type }) => type === "stack")) {
        if (await matchesDetection(absoluteRoot, manifest.detection, repositoryPaths)) {
            stackCandidates.push({ extensionId: manifest.id, status: manifest.status, docs: manifest.docs });
        }
    }
    stackCandidates.sort((left, right) => left.extensionId.localeCompare(right.extensionId));
    const config = await configState(absoluteRoot, catalog);
    const signingPattern = /(?:^|\/)(?:keystore\.properties|exportoptions\.plist|[^/]+\.(?:jks|keystore|p12|mobileprovision))$/iu;
    return {
        schemaVersion: INSPECT_SCHEMA,
        root: absoluteRoot,
        projectName: basename(absoluteRoot),
        config,
        route: setupRouteForState(config),
        stackCandidates,
        signingIndicators: repositoryPaths.filter((path) => signingPattern.test(path)).sort(),
        versionSources: await inspectVersionSources(absoluteRoot),
        git: {
            remote: git(absoluteRoot, ["config", "--get", "remote.origin.url"]),
            branch: git(absoluteRoot, ["branch", "--show-current"]),
            head: git(absoluteRoot, ["rev-parse", "HEAD"]),
        },
        workflows: repositoryPaths.filter((path) => /^\.github\/workflows\/[^/]+\.(?:yml|yaml)$/iu.test(path)).sort(),
        installedExtensions: Object.values(catalog).map((manifest) => ({
            id: manifest.id,
            type: manifest.type,
            version: manifest.version,
            status: manifest.status,
            configSchemaVersion: manifest.configSchemaVersion,
        })).sort((left, right) => left.type.localeCompare(right.type) || left.id.localeCompare(right.id)),
    };
}

function modeAllowed(inspection, mode) {
    if (mode === "initialize" && inspection.config.status !== "missing") throw new Error("initialize requires a missing config");
    if (mode === "reconfigure" && inspection.config.status !== "valid") throw new Error("reconfigure requires a valid config/v1 project");
    if (mode === "reinitialize" && inspection.config.status === "missing") throw new Error("reinitialize requires an existing config");
}

export async function routeSetup(root, mode, { extensionIds = [] } = {}) {
    if (!SETUP_MODES.has(mode) || mode === "initialize") throw new Error("Use reconfigure or reinitialize for a read-only setup route");
    const inspection = await inspectProject(root);
    modeAllowed(inspection, mode);
    let defaults = null;
    let ids = [...new Set(extensionIds)];
    if (mode === "reconfigure") {
        const raw = JSON.parse(await readFile(resolve(root, ".release-ops", "config.json"), "utf8"));
        ids = raw.extensions.map(({ extensionId }) => extensionId);
        const registry = await hydrateExtensions(ids);
        defaults = await validateConfig(raw, { extensions: registry });
    }
    const selected = ids.length ? await hydrateExtensions(ids) : {};
    const typeOrder = new Map([["stack", 0], ["signing", 1], ["release", 2], ["provider", 3]]);
    const questions = Object.values(selected).sort((left, right) => typeOrder.get(left.type) - typeOrder.get(right.type)
        || left.id.localeCompare(right.id)).map((manifest) => ({ extension: publicExtension(manifest), phase: manifest.type }));
    return {
        schemaVersion: "release-ops/setup-route/v1",
        mode,
        readOnly: true,
        inspection,
        defaults,
        questionOrder: QUESTION_PHASES,
        selectedExtensions: questions,
        inheritance: mode === "reconfigure" ? "current-config-defaults" : "none",
    };
}

function validateAnswers(answers, requestedMode = answers?.mode) {
    exactKeys(answers, "answers", new Set([
        "schemaVersion", "mode", "project", "extensions", "repositories", "managedFileAdoptions",
    ]));
    if (answers.schemaVersion !== ANSWERS_SCHEMA) throw new Error(`Answers must use ${ANSWERS_SCHEMA}`);
    if (!SETUP_MODES.has(answers.mode) || answers.mode !== requestedMode) throw new Error("Answers mode does not match --mode");
    exactKeys(answers.project, "answers.project", new Set(["name"]));
    if (!Array.isArray(answers.extensions) || !Array.isArray(answers.repositories) || !Array.isArray(answers.managedFileAdoptions)) {
        throw new Error("Answers extensions, repositories, and managedFileAdoptions must be arrays");
    }
    for (const [index, decision] of answers.repositories.entries()) {
        exactKeys(decision, `answers.repositories[${index}]`, new Set([
            "instanceId", "role", "action", "repository", "visibility", "defaultBranch",
        ]));
        if (!ID.test(decision.instanceId ?? "") || !["source", "distribution"].includes(decision.role)
            || !["existing", "create"].includes(decision.action) || !REPOSITORY.test(decision.repository ?? "")) {
            throw new Error(`answers.repositories[${index}] is invalid`);
        }
        if (decision.action === "create" && (!decision.visibility || !decision.defaultBranch)) {
            throw new Error(`answers.repositories[${index}] creation needs visibility and defaultBranch`);
        }
    }
    return answers;
}

function configFromAnswers(answers) {
    return { schemaVersion: CONFIG_SCHEMA, project: answers.project, extensions: answers.extensions };
}

function githubClientForRelease(instance, token, override) {
    if (override) return override;
    if (!token) throw new Error("github_token or GITHUB_TOKEN is required for GitHub repository verification");
    return createGitHubClient({
        sourceRepository: instance.config.source?.repository,
        publicRepository: instance.config.distribution?.repository,
        sourceToken: token,
        publicToken: token,
    });
}

async function planRepositories(config, registry, decisions, token, githubOverride) {
    const release = config.extensions.find((instance) => registry[instance.extensionId].type === "release");
    const expected = release.config.mode === "local" ? [] : [
        ["source", release.config.source],
        ...(release.config.distribution ? [["distribution", release.config.distribution]] : []),
    ];
    if (!expected.length) {
        if (decisions.length) throw new Error("Local release configuration cannot include repository operations");
        return [];
    }
    const github = githubClientForRelease(release, token, githubOverride);
    if (decisions.length !== expected.length) throw new Error("Repository decisions do not match the release topology");
    const result = [];
    for (const [role, identity] of expected) {
        const decision = decisions.find((candidate) => candidate.instanceId === release.instanceId && candidate.role === role);
        if (!decision || decision.repository !== identity.repository) throw new Error(`Repository decision is missing for ${role}`);
        let actual;
        if (decision.action === "existing") {
            actual = await inspectRepository({ github, repository: decision.repository });
        } else {
            if (decision.visibility !== identity.visibility || decision.defaultBranch !== identity.defaultBranch) {
                throw new Error(`Repository creation does not match configured identity: ${decision.repository}`);
            }
            actual = await createRepository({ github, repository: decision.repository, visibility: decision.visibility, dryRun: true });
            actual.defaultBranch = decision.defaultBranch;
        }
        if (actual.visibility !== identity.visibility || actual.defaultBranch !== identity.defaultBranch
            || actual.archived || actual.disabled) throw new Error(`Repository identity does not match config: ${decision.repository}`);
        result.push({
            instanceId: release.instanceId,
            role,
            action: decision.action,
            identity: { repository: actual.repository, visibility: actual.visibility, defaultBranch: actual.defaultBranch },
        });
    }
    return result;
}

async function runProcessorNodes(root, config, graph, registry, entrypoint) {
    const workflows = [];
    const managedFiles = [];
    const results = {};
    for (const node of nodesForEntrypoint(graph, entrypoint)) {
        const instance = config.extensions.find((candidate) => candidate.instanceId === node.instanceId);
        const manifest = registry[instance.extensionId];
        const processor = manifest.processors.find((candidate) => candidate.id === node.processorId);
        const module = await import(pathToFileURL(resolve(PLUGIN_ROOT, processor.module)).href);
        const callback = module[node.entrypoint];
        if (typeof callback !== "function") throw new Error(`Processor entrypoint is unavailable: ${node.id}`);
        const api = createKernelApi({
            root,
            node,
            managedFileSink: (contribution) => managedFiles.push(contribution),
            workflowSink: (contribution) => workflows.push(contribution),
        });
        results[node.id] = await callback(freeze({
            api,
            config,
            graph,
            instance,
            manifest,
            node,
            inspection: null,
            operation: entrypoint,
            arguments: [],
            execute: false,
        }));
    }
    return { workflows, managedFiles, results };
}

function requiredSecrets(config, graph) {
    const byRole = new Map();
    for (const node of graph.nodes) {
        const instance = config.extensions.find((candidate) => candidate.instanceId === node.instanceId);
        for (const declaration of node.secretRoles) {
            const ownerInstanceId = declaration.sourceInstanceId ?? instance.instanceId;
            const ownerInstance = config.extensions.find((candidate) => candidate.instanceId === ownerInstanceId);
            const name = declaration.configuredName ?? ownerInstance.config.secretNames?.[declaration.role] ?? declaration.defaultName;
            if (!name) continue;
            const key = `${ownerInstanceId}:${declaration.role}`;
            const current = byRole.get(key) ?? {
                instanceId: ownerInstanceId,
                role: declaration.role,
                name,
                required: false,
                scope: "processor",
                processors: [],
            };
            current.required ||= declaration.required;
            current.processors.push(node.id);
            byRole.set(key, current);
        }
    }
    for (const instance of config.extensions) {
        for (const [role, name] of Object.entries(instance.config.secretNames ?? {})) {
            const key = `${instance.instanceId}:${role}`;
            if (!byRole.has(key)) byRole.set(key, {
                instanceId: instance.instanceId,
                role,
                name,
                required: false,
                scope: "local-only",
                processors: [],
            });
        }
    }
    return [...byRole.values()].map((entry) => ({ ...entry, processors: [...new Set(entry.processors)].sort() }))
        .sort((left, right) => left.instanceId.localeCompare(right.instanceId) || left.role.localeCompare(right.role));
}

function digestPlan(plan) {
    const payload = { ...plan };
    delete payload.planDigest;
    return sha256(stableJson(payload));
}

export async function createSetupPlan(root, answers, {
    mode = answers?.mode,
    token = process.env.github_token ?? process.env.GITHUB_TOKEN,
    github = null,
} = {}) {
    validateAnswers(answers, mode);
    const inspection = await inspectProject(root);
    modeAllowed(inspection, mode);
    const registry = await hydrateExtensions(answers.extensions.map(({ extensionId }) => extensionId));
    const config = await validateConfig(configFromAnswers(answers), { extensions: registry });
    const graph = await createProcessorGraph(config, registry);
    const contributions = await runProcessorNodes(resolve(root), config, graph, registry, "setup");
    const repositories = await planRepositories(config, registry, answers.repositories, token, github);
    const managed = await planProjectFiles(resolve(root), config, graph, registry, contributions.workflows, {
        adoptions: answers.managedFileAdoptions,
        contributions: contributions.managedFiles,
    });
    if (managed.conflicts.length) {
        throw new Error(`Setup plan has managed file conflicts: ${managed.conflicts.map(({ path }) => path).join(", ")}`);
    }
    const plan = {
        schemaVersion: PLAN_SCHEMA,
        mode,
        root: resolve(root),
        inspection,
        config,
        graph,
        repositories,
        requiredSecrets: requiredSecrets(config, graph),
        managedFiles: publicManagedPlan(managed),
    };
    plan.planDigest = digestPlan(plan);
    return plan;
}

async function applyRepositories(plan, registry, token, githubOverride) {
    if (!plan.repositories.length) return [];
    const release = plan.config.extensions.find((instance) => registry[instance.extensionId].type === "release");
    const github = githubClientForRelease(release, token, githubOverride);
    const results = [];
    for (const operation of plan.repositories) {
        const identity = operation.identity;
        let result;
        if (operation.action === "existing") {
            result = await inspectRepository({ github, repository: identity.repository });
        } else {
            result = await createRepository({
                github,
                repository: identity.repository,
                visibility: identity.visibility,
                confirmation: `${identity.repository}:${identity.visibility}`,
                dryRun: false,
                initialize: operation.role === "distribution",
            });
        }
        if (result.visibility !== identity.visibility || (result.defaultBranch && result.defaultBranch !== identity.defaultBranch)
            || result.archived || result.disabled) throw new Error(`Repository changed after planning: ${identity.repository}`);
        if (operation.action === "create" && operation.role === "distribution") {
            await ensureDistributionReadme({
                github,
                repository: identity.repository,
                branch: identity.defaultBranch,
                projectName: plan.config.project.name,
            });
        }
        results.push({ instanceId: operation.instanceId, role: operation.role, ...result });
    }
    return results;
}

export async function applySetupPlan(plan, confirmation, {
    token = process.env.github_token ?? process.env.GITHUB_TOKEN,
    github = null,
    failAfter = null,
} = {}) {
    if (plan?.schemaVersion !== PLAN_SCHEMA || !HASH.test(confirmation ?? "")
        || confirmation !== plan.planDigest || digestPlan(plan) !== plan.planDigest) {
        throw new Error("--confirm must exactly match the setup plan SHA-256 digest");
    }
    const root = resolve(plan.root);
    const registry = await hydrateExtensions(plan.config.extensions.map(({ extensionId }) => extensionId));
    const config = await validateConfig(plan.config, { extensions: registry });
    const graph = await createProcessorGraph(config, registry);
    if (stableJson(graph) !== stableJson(plan.graph)) throw new Error("Extension code or processor graph changed after planning");
    const contributions = await runProcessorNodes(root, config, graph, registry, "setup");
    const preflight = await planProjectFiles(root, config, graph, registry, contributions.workflows, {
        adoptions: plan.managedFiles.adoptions,
        contributions: contributions.managedFiles,
    });
    if (stableJson(publicManagedPlan(preflight)) !== stableJson(plan.managedFiles)) {
        throw new Error("Repository files or workflow model changed after the confirmed plan");
    }
    const repositories = await applyRepositories(plan, registry, token, github);
    const managedFiles = await installProjectFiles(root, preflight, {
        expectedPlan: plan.managedFiles,
        configDigest: graph.configDigest,
        graphDigest: graph.graphDigest,
        failAfter,
    });
    return {
        schemaVersion: "release-ops/apply-result/v1",
        success: true,
        root,
        planDigest: plan.planDigest,
        repositories,
        managedFiles,
    };
}

async function readManagedManifest(root) {
    try {
        return JSON.parse(await readFile(resolve(root, ".release-ops", "managed-files.json"), "utf8"));
    } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
    }
}

function adoptedWorkflows(manifest) {
    return Object.entries(manifest?.files ?? {}).flatMap(([path, record]) =>
        record.mode === "adopted" && /^\.github\/workflows\//u.test(path)
            ? [{ path, ownerInstanceId: record.ownerInstanceId, sha256: record.desiredHash }]
            : []);
}

async function auditRemote(config, registry, token, githubOverride, env) {
    const release = config.extensions.find((instance) => registry[instance.extensionId].type === "release");
    if (release.config.mode === "local") {
        const available = new Set(Object.entries(env).filter(([, value]) => value).map(([name]) => name));
        return { remoteVerified: true, check: { status: "not-applicable" }, available };
    }
    if (!token) return {
        remoteVerified: false,
        check: { status: "fail", message: "GitHub credential is unavailable" },
        available: new Set(),
    };
    try {
        const github = githubClientForRelease(release, token, githubOverride);
        const identities = [release.config.source, ...(release.config.distribution ? [release.config.distribution] : [])];
        for (const identity of identities) {
            const actual = await inspectRepository({ github, repository: identity.repository });
            if (actual.visibility !== identity.visibility || actual.defaultBranch !== identity.defaultBranch
                || actual.archived || actual.disabled) throw new Error(`Remote identity mismatch: ${identity.repository}`);
        }
        const metadata = await listSecretMetadata({ github, repository: release.config.source.repository });
        const available = new Set(metadata.secrets.map(({ name }) => name));
        available.add("GITHUB_TOKEN");
        return {
            remoteVerified: true,
            check: { status: "pass" },
            available,
        };
    } catch (error) {
        return { remoteVerified: false, check: { status: "fail", message: error.message }, available: new Set() };
    }
}

export async function auditProject(root, {
    token = process.env.github_token ?? process.env.GITHUB_TOKEN,
    github = null,
    env = process.env,
} = {}) {
    const absoluteRoot = resolve(root);
    const checks = {
        configuration: { status: "fail" },
        graph: { status: "fail" },
        workflows: { status: "fail" },
        managedFiles: { status: "fail" },
        repositories: { status: "fail" },
        secrets: { status: "fail" },
    };
    const extensions = {};
    let config;
    let registry;
    let graph;
    try {
        const raw = JSON.parse(await readFile(resolve(absoluteRoot, ".release-ops", "config.json"), "utf8"));
        registry = await hydrateExtensions(raw.extensions?.map(({ extensionId }) => extensionId) ?? []);
        config = await validateConfig(raw, { extensions: registry });
        checks.configuration = { status: "pass", message: configDigest(config) };
        graph = await createProcessorGraph(config, registry);
    } catch (error) {
        checks.configuration = { status: "fail", message: error.message };
        return { schemaVersion: AUDIT_SCHEMA, success: false, remoteVerified: false, checks, extensions };
    }
    let manifest;
    try {
        const installedGraph = JSON.parse(await readFile(resolve(absoluteRoot, ".release-ops", "processor-graph.json"), "utf8"));
        checks.graph = stableJson(installedGraph) === stableJson(graph)
            ? { status: "pass", message: graph.graphDigest }
            : { status: "fail", message: "Config or extension code does not match the installed processor graph; re-plan/apply is required" };
        manifest = await readManagedManifest(absoluteRoot);
        if (!manifest) throw new Error("Managed file state is missing");
        if (manifest.configDigest !== graph.configDigest || manifest.graphDigest !== graph.graphDigest) {
            throw new Error("Config or graph digest differs from managed state; re-plan/apply is required");
        }
    } catch (error) {
        if (checks.graph.status !== "fail") checks.graph = { status: "fail", message: error.message };
    }
    try {
        const contributions = await runProcessorNodes(absoluteRoot, config, graph, registry, "setup");
        const managed = await planProjectFiles(absoluteRoot, config, graph, registry, contributions.workflows, {
            adoptions: adoptedWorkflows(manifest),
            contributions: contributions.managedFiles,
        });
        const changed = managed.operations.filter(({ operation }) => operation !== "unchanged");
        checks.workflows = manifest?.workflowDigest === managed.workflowDigest
            ? { status: "pass", message: managed.workflowDigest }
            : { status: "fail", message: "Workflow digest differs from managed state; re-plan/apply is required" };
        checks.managedFiles = !changed.length && !managed.conflicts.length
            ? { status: "pass" }
            : { status: "fail", message: `Managed paths changed: ${changed.map(({ path }) => path).join(", ")}` };
    } catch (error) {
        checks.workflows = { status: "fail", message: error.message };
        checks.managedFiles = { status: "fail", message: error.message };
    }
    const secrets = requiredSecrets(config, graph);
    const remote = await auditRemote(config, registry, token, github, env);
    checks.repositories = remote.check;
    const localNames = new Set(Object.entries(env).filter(([, value]) => value).map(([name]) => name));
    const missing = secrets.filter((secret) => secret.required && secret.scope === "processor"
        && !remote.available.has(secret.name) && !localNames.has(secret.name));
    checks.secrets = missing.length
        ? { status: "fail", message: `Missing Secret roles: ${missing.map(({ instanceId, role }) => `${instanceId}:${role}`).join(", ")}` }
        : { status: "pass" };
    try {
        const audit = await runProcessorNodes(absoluteRoot, config, graph, registry, "audit");
        for (const instance of config.extensions) {
            const nodes = graph.nodes.filter((node) => node.instanceId === instance.instanceId && node.stage === "audit");
            const results = nodes.map((node) => audit.results[node.id]).filter(Boolean);
            extensions[instance.instanceId] = results.some(({ status }) => status === "fail")
                ? { status: "fail", message: "Extension audit failed" }
                : { status: results.length ? "configured" : "not-applicable" };
        }
    } catch (error) {
        for (const instance of config.extensions) extensions[instance.instanceId] = { status: "fail", message: error.message };
    }
    const failed = Object.values(checks).some(({ status }) => status === "fail")
        || Object.values(extensions).some(({ status }) => status === "fail");
    return {
        schemaVersion: AUDIT_SCHEMA,
        success: !failed && remote.remoteVerified,
        remoteVerified: remote.remoteVerified,
        checks,
        extensions,
    };
}

export async function writeJson(path, value) {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

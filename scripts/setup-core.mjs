import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

import { AUDIT_SCHEMA, CONFIG_SCHEMA, PLAN_SCHEMA, RELEASE_SCHEMA, loadConfig, validateConfig } from "./config.mjs";
import { createRepository, ensureDistributionReadme, inspectRepository, listSecretMetadata } from "./github-admin.mjs";
import { createGitHubClient } from "./github-client.mjs";
import { BUILD_ADAPTERS, PROVIDERS, adapterById, adapterRequiredSecrets, providerChoices } from "./provider-registry.mjs";
import { installProjectFiles, planProjectFiles } from "./project-installer.mjs";

export const ANSWERS_SCHEMA = "release-ops/setup-answers/v2";
export const INSPECT_SCHEMA = "release-ops/inspect/v2";

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function planDigest(plan) {
    const payload = { ...plan };
    delete payload.planDigest;
    return createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex");
}

function git(root, args) {
    try {
        return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
        return null;
    }
}

async function exists(path) {
    try { await access(path); return true; } catch { return false; }
}

async function walk(root, maxDepth = 4, depth = 0) {
    if (depth > maxDepth) return [];
    const result = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
        if ([".git", ".codegraph", "node_modules", "build", "dist", ".gradle", ".release-ops"].includes(entry.name)) continue;
        const full = join(root, entry.name);
        result.push(full);
        if (entry.isDirectory() && !entry.isSymbolicLink()) result.push(...await walk(full, maxDepth, depth + 1));
    }
    return result;
}

async function detectedAdapters(root) {
    const paths = (await walk(root)).map((path) => path.replaceAll("\\", "/"));
    const names = paths.map((path) => basename(path));
    let packageText = "";
    let pubspecText = "";
    try { packageText = await readFile(join(root, "package.json"), "utf8"); } catch { /* Optional. */ }
    try { pubspecText = await readFile(join(root, "pubspec.yaml"), "utf8"); } catch { /* Optional. */ }
    const joined = `${paths.join("\n")}\n${packageText}`.toLowerCase();
    const detected = [];
    for (const adapter of BUILD_ADAPTERS.filter(({ id }) => id !== "generic")) {
        let matched = adapter.detects.some((pattern) => pattern.startsWith("*.")
            ? names.some((name) => name.endsWith(pattern.slice(1)))
            : joined.includes(pattern.toLowerCase()));
        if (adapter.id === "react-native") matched = /["']react-native["']/u.test(packageText);
        if (adapter.id === "flutter") matched = /sdk:\s*flutter/u.test(pubspecText);
        if (matched) detected.push({ id: adapter.id, status: adapter.status, docs: adapter.docs, targets: adapter.targets });
    }
    return detected;
}

function repositoryRelative(root, path) {
    return relative(resolve(root), path).replaceAll("\\", "/");
}

async function inspectVersionSources(root) {
    const candidates = [];
    const add = (kind, file, reader, key, value = null) => candidates.push({ kind, file, reader, key, value });
    for (const [file, reader] of [["gradle.properties", "gradle-properties"], ["version.properties", "properties"]]) {
        try {
            const text = await readFile(join(root, file), "utf8");
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
        const data = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
        if (typeof data.version === "string" && data.version) add("canonical", "package.json", "package-json", "version", data.version);
    } catch (error) {
        if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    try {
        const text = await readFile(join(root, "pubspec.yaml"), "utf8");
        const match = /^version:\s*([^+\s]+)(?:\+([^\s]+))?/mu.exec(text);
        if (match) {
            add("canonical", "pubspec.yaml", "pubspec", "version", match[1]);
            if (match[2]) add("build-number", "pubspec.yaml", "pubspec", "build", match[2]);
        }
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
    }
    try {
        const text = await readFile(join(root, "project.godot"), "utf8");
        const match = /^config\/version\s*=\s*["']?([^"'\r\n]+)["']?/mu.exec(text);
        if (match) add("canonical", "project.godot", "godot", "config/version", match[1].trim());
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
    }
    try {
        const file = "ProjectSettings/ProjectSettings.asset";
        const text = await readFile(join(root, file), "utf8");
        const version = /^\s*bundleVersion:\s*(.+)$/mu.exec(text);
        const code = /^\s*AndroidBundleVersionCode:\s*(\d+)$/mu.exec(text);
        if (version) add("canonical", file, "unity", "bundleVersion", version[1].trim());
        if (code) add("build-number", file, "unity", "AndroidBundleVersionCode", code[1]);
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
    }
    return candidates;
}

function inspectRepositoryFiles(root, paths) {
    const workflowPattern = /\/\.github\/workflows\/[^/]+\.(?:yml|yaml)$/iu;
    const signingPattern = /(?:^|\/)(?:keystore\.properties|exportoptions\.plist|[^/]+\.(?:jks|keystore|p12|mobileprovision))$/iu;
    return {
        workflows: paths.filter((path) => workflowPattern.test(path.replaceAll("\\", "/"))).map((path) => repositoryRelative(root, path)).sort(),
        signingIndicators: paths.filter((path) => signingPattern.test(path.replaceAll("\\", "/"))).map((path) => repositoryRelative(root, path)).sort(),
    };
}

async function configState(root) {
    const path = join(root, ".release-ops", "config.json");
    if (!(await exists(path))) return { status: "missing" };
    try {
        const raw = JSON.parse(await readFile(path, "utf8"));
        if (raw.schemaVersion === "release-ops/config/v1") {
            return { status: "incompatible", schemaVersion: raw.schemaVersion, action: "reinitialize" };
        }
        return { status: "valid", schemaVersion: validateConfig(raw).schemaVersion };
    } catch (error) {
        return { status: "invalid", error: error.message };
    }
}

export async function inspectProject(root) {
    const paths = await walk(root);
    const adapters = await detectedAdapters(root);
    const unsupported = adapters.filter(({ status }) => status === "unsupported").map(({ id }) => id);
    const repositoryFiles = inspectRepositoryFiles(root, paths);
    return {
        schemaVersion: INSPECT_SCHEMA,
        root: resolve(root),
        projectName: basename(resolve(root)),
        adapters,
        diagnostics: unsupported.map((id) => ({ code: "ADAPTER_UNSUPPORTED", adapter: id })),
        git: {
            remote: git(root, ["config", "--get", "remote.origin.url"]),
            branch: git(root, ["branch", "--show-current"]),
            head: git(root, ["rev-parse", "HEAD"]),
        },
        versionSources: await inspectVersionSources(root),
        signingIndicators: repositoryFiles.signingIndicators,
        workflows: repositoryFiles.workflows,
        config: await configState(root),
        decisions: {
            github: { required: true },
            providerSelection: { required: true, choices: providerChoices() },
        },
        installedProviders: Object.values(PROVIDERS).map(({ id, category, capabilities, docs }) => ({ id, category, capabilities, docs })),
    };
}

function object(value, name) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
}

function selectedProviders(answers) {
    if (!Array.isArray(answers.providerSelection)) throw new Error("providerSelection is required even when no provider is selected");
    if (new Set(answers.providerSelection).size !== answers.providerSelection.length) throw new Error("providerSelection contains duplicates");
    if (answers.providerSelection.includes("none")) {
        if (answers.providerSelection.length !== 1) throw new Error("providerSelection none cannot be combined with a provider");
        return new Set();
    }
    for (const id of answers.providerSelection) if (!PROVIDERS[id]) throw new Error(`Selected provider is not installed: ${id}`);
    return new Set(answers.providerSelection);
}

function repositoryDecision(value, name) {
    object(value, name);
    if (!["existing", "create"].includes(value.action)) throw new Error(`${name}.action must be existing or create`);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.repository ?? "")) throw new Error(`${name}.repository is invalid`);
    if (value.action === "create" && !["private", "public"].includes(value.visibility)) throw new Error(`${name}.visibility is required for creation`);
    if (value.action === "create" && (typeof value.defaultBranch !== "string" || !value.defaultBranch)) {
        throw new Error(`${name}.defaultBranch is required for creation`);
    }
}

async function repositoryPlan(answers, token, githubOverride = null) {
    object(answers.github, "github");
    if (typeof answers.github.enabled !== "boolean") throw new Error("github.enabled must be explicitly true or false");
    if (!answers.github.enabled) return { source: null, distribution: null, releaseMode: "local", actions: [] };
    if (!token) throw new Error("github_token or GITHUB_TOKEN is required to verify GitHub setup");
    repositoryDecision(answers.github.source, "github.source");
    const sourceInput = answers.github.source;
    const github = githubOverride ?? createGitHubClient({
        sourceRepository: sourceInput.repository,
        publicRepository: answers.github.distribution?.repository,
        sourceToken: token,
        publicToken: token,
    });
    const inspectOrPlan = async (decision, expectedVisibility = null) => {
        if (decision.action === "existing") {
            const result = await inspectRepository({ github, repository: decision.repository });
            if (expectedVisibility && result.visibility !== expectedVisibility) throw new Error(`${decision.repository} must be ${expectedVisibility}`);
            if (result.archived || result.disabled) throw new Error(`${decision.repository} is archived or disabled`);
            return {
                identity: {
                    repository: result.repository,
                    owner: result.owner,
                    name: result.name,
                    visibility: result.visibility,
                    defaultBranch: result.defaultBranch,
                },
                action: "existing",
            };
        }
        if (expectedVisibility && decision.visibility !== expectedVisibility) throw new Error(`${decision.repository} must be ${expectedVisibility}`);
        await createRepository({ github, repository: decision.repository, visibility: decision.visibility, dryRun: true });
        return {
            identity: {
                repository: decision.repository,
                owner: decision.repository.split("/")[0],
                name: decision.repository.split("/")[1],
                visibility: decision.visibility,
                defaultBranch: decision.defaultBranch,
            },
            action: "create",
        };
    };
    const source = await inspectOrPlan(sourceInput);
    if (source.identity.visibility === "public") {
        if (answers.github.distribution) throw new Error("A public source repository must not configure a separate distribution repository");
        return { source: source.identity, distribution: null, releaseMode: "same-repository", actions: [{ role: "source", ...source }] };
    }
    repositoryDecision(answers.github.distribution, "github.distribution");
    const distribution = await inspectOrPlan(answers.github.distribution, "public");
    if (distribution.identity.repository === source.identity.repository) throw new Error("Distribution repository must differ from private source");
    return {
        source: source.identity,
        distribution: distribution.identity,
        releaseMode: "dual-repository",
        actions: [{ role: "source", ...source }, { role: "distribution", ...distribution }],
    };
}

function providerConfiguration(answers, selected, githubEnabled) {
    const providers = {};
    for (const [id, manifest] of Object.entries(PROVIDERS)) {
        if (!selected.has(id)) continue;
        object(answers.providers?.[id], `providers.${id}`);
        if (id === "sentry") {
            providers[id] = {
                ...answers.providers[id],
                enabled: true,
                schemaVersion: manifest.configSchemaVersion,
                apiBase: answers.providers[id].apiBase ?? "https://sentry.io/api/0",
                issueSync: githubEnabled,
                lookbackMinutes: answers.providers[id].lookbackMinutes ?? 75,
                schedule: answers.providers[id].schedule ?? "17 * * * *",
                releaseTemplate: answers.providers[id].releaseTemplate ?? "{project}@{version}",
                distTemplate: answers.providers[id].distTemplate ?? "{version}",
                debugArtifacts: answers.providers[id].debugArtifacts ?? [],
            };
        } else {
            providers[id] = { ...answers.providers[id], enabled: true, schemaVersion: manifest.configSchemaVersion };
        }
    }
    return providers;
}

function requiredSecrets(config) {
    const result = new Map();
    for (const unit of config.build.units) for (const name of unit.requiredSecretNames ?? []) result.set(name, "build-and-sign");
    for (const name of adapterRequiredSecrets(config)) result.set(name, "build-and-sign");
    if (config.hosting.github.releaseMode === "dual-repository") result.set("RELEASE_REPO_TOKEN", "public-distribution-write");
    for (const [id, providerConfig] of Object.entries(config.providers)) {
        if (!providerConfig.enabled) continue;
        for (const [role, name] of Object.entries(PROVIDERS[id].requiredSecrets ?? {})) {
            if (role === "projectProvision") continue;
            if (!providerConfig.issueSync && ["incidentRead", "incidentWrite"].includes(role)) continue;
            result.set(name, `${id}:${role}`);
        }
    }
    return [...result].sort(([left], [right]) => left.localeCompare(right)).map(([name, purpose]) => ({ name, purpose }));
}

function configFromAnswers(answers, hosting) {
    object(answers.project, "project");
    object(answers.build, "build");
    object(answers.versioning, "versioning");
    const selected = selectedProviders(answers);
    const publicMode = hosting.releaseMode === "same-repository";
    const config = {
        schemaVersion: CONFIG_SCHEMA,
        project: answers.project,
        build: answers.build,
        versioning: answers.versioning,
        hosting: {
            github: {
                enabled: answers.github.enabled,
                source: hosting.source,
                distribution: hosting.distribution,
                releaseMode: hosting.releaseMode,
            },
        },
        release: {
            workflowFile: ".github/workflows/publish-release.yml",
            tagTemplate: "v{version}",
            titleTemplate: `${answers.project.name} {version}`,
            manifestSchema: RELEASE_SCHEMA,
            publicReadmeSource: null,
            publicReadmeTarget: answers.github.enabled ? (publicMode ? "docs/releases/README.md" : "README.md") : null,
            latestManifest: "latest.json",
            latestCompatibility: "release-ops",
            localOutputDirectory: "dist/release-ops",
            ...answers.release,
            publicReadmeTarget: answers.github.enabled ? (publicMode ? "docs/releases/README.md" : "README.md") : null,
        },
        providers: providerConfiguration(answers, selected, answers.github.enabled),
    };
    return validateConfig(config);
}

function publicManagedPlan(plan) {
    return {
        schemaVersion: plan.schemaVersion,
        operations: plan.operations,
        conflicts: plan.conflicts,
        adoptions: plan.adoptions,
    };
}

export async function createSetupPlan(root, answers, {
    token = process.env.github_token ?? process.env.GITHUB_TOKEN,
    github = null,
} = {}) {
    if (answers?.schemaVersion !== ANSWERS_SCHEMA) throw new Error(`Answers must use ${ANSWERS_SCHEMA}`);
    const inspection = await inspectProject(root);
    const hosting = await repositoryPlan(answers, token, github);
    const config = configFromAnswers(answers, hosting);
    const adapter = adapterById(config.project.adapter);
    if (!adapter) throw new Error("Selected adapter is not installed");
    const managed = await planProjectFiles(root, config, {
        includeConfig: true,
        adoptions: answers.managedFileAdoptions ?? [],
    });
    if (managed.conflicts.length) throw new Error(`Setup plan has managed file conflicts: ${managed.conflicts.map(({ path }) => path).join(", ")}`);
    const plan = {
        schemaVersion: PLAN_SCHEMA,
        root: resolve(root),
        inspection,
        config,
        repositories: hosting.actions,
        requiredSecrets: requiredSecrets(config),
        managedFiles: publicManagedPlan(managed),
    };
    plan.planDigest = planDigest(plan);
    return plan;
}

export async function applySetupPlan(plan, confirmation, {
    token = process.env.github_token ?? process.env.GITHUB_TOKEN,
    github: githubOverride = null,
} = {}) {
    if (plan?.schemaVersion !== PLAN_SCHEMA) throw new Error(`Setup plan must use ${PLAN_SCHEMA}`);
    if (!/^[0-9a-f]{64}$/u.test(confirmation ?? "") || confirmation !== plan.planDigest || planDigest(plan) !== plan.planDigest) {
        throw new Error("--confirm must exactly match the setup plan SHA-256 digest");
    }
    const root = resolve(plan.root);
    const config = validateConfig(plan.config);
    const preflight = await planProjectFiles(root, config, {
        includeConfig: true,
        adoptions: plan.managedFiles.adoptions ?? [],
    });
    if (JSON.stringify(publicManagedPlan(preflight)) !== JSON.stringify(plan.managedFiles)) {
        throw new Error("Repository files changed after the confirmed setup plan");
    }
    const repositoryResults = [];
    if (config.hosting.github.enabled) {
        if (!token) throw new Error("github_token or GITHUB_TOKEN is required to apply GitHub setup");
        const github = githubOverride ?? createGitHubClient({
            sourceRepository: config.hosting.github.source.repository,
            publicRepository: config.hosting.github.distribution?.repository,
            sourceToken: token,
            publicToken: token,
        });
        for (const repository of plan.repositories) {
            let result;
            if (repository.action === "existing") {
                result = await inspectRepository({ github, repository: repository.identity.repository });
            } else {
                result = await createRepository({
                    github,
                    repository: repository.identity.repository,
                    visibility: repository.identity.visibility,
                    confirmation: `${repository.identity.repository}:${repository.identity.visibility}`,
                    dryRun: false,
                    initialize: repository.role === "distribution",
                });
            }
            if (result.visibility !== repository.identity.visibility) throw new Error("Repository visibility changed after planning");
            if (result.defaultBranch && result.defaultBranch !== repository.identity.defaultBranch) {
                throw new Error(`Repository default branch changed after planning: ${repository.identity.repository}`);
            }
            if (repository.role === "distribution" && repository.action === "create") {
                await ensureDistributionReadme({
                    github,
                    repository: repository.identity.repository,
                    branch: repository.identity.defaultBranch,
                    projectName: config.project.name,
                });
            }
            repositoryResults.push({ role: repository.role, ...result });
        }
    }
    const managedFiles = await installProjectFiles(root, config, {
        includeConfig: true,
        expectedPlan: plan.managedFiles,
        adoptions: plan.managedFiles.adoptions ?? [],
    });
    return {
        schemaVersion: "release-ops/apply-result/v2",
        success: true,
        root,
        planDigest: plan.planDigest,
        repositories: repositoryResults,
        managedFiles,
    };
}

export async function auditProject(root, {
    token = process.env.github_token ?? process.env.GITHUB_TOKEN,
    github: githubOverride = null,
    env = process.env,
} = {}) {
    const checks = {
        configuration: { status: "fail" },
        managedFiles: { status: "fail" },
        localBuild: { status: "configured" },
        githubHosting: { status: "disabled" },
        releasePublication: { status: "configured" },
        providers: {},
        incidentResolution: { status: "not-applicable" },
    };
    let config;
    try {
        config = await loadConfig(root);
        checks.configuration = { status: "pass", schemaVersion: config.schemaVersion };
        const managed = await planProjectFiles(root, config, { includeConfig: true });
        const changed = managed.operations.filter(({ operation }) => operation !== "unchanged");
        checks.managedFiles = changed.length || managed.conflicts.length
            ? { status: "fail", changed: changed.map(({ path, operation }) => ({ path, operation })), conflicts: managed.conflicts }
            : { status: "pass" };
    } catch (error) {
        checks.configuration = { status: "fail", error: error.message };
        return { schemaVersion: AUDIT_SCHEMA, success: false, remoteVerified: false, checks };
    }
    let remoteVerified = !config.hosting.github.enabled;
    const availableSecrets = new Set();
    if (!config.hosting.github.enabled) {
        for (const [name, value] of Object.entries(env)) if (value) availableSecrets.add(name);
    }
    if (config.hosting.github.enabled) {
        if (!token) {
            checks.githubHosting = { status: "fail", reason: "credential-unavailable" };
        } else {
            try {
                const github = githubOverride ?? createGitHubClient({
                    sourceRepository: config.hosting.github.source.repository,
                    publicRepository: config.hosting.github.distribution?.repository,
                    sourceToken: token,
                    publicToken: token,
                });
                const identities = [config.hosting.github.source, ...(config.hosting.github.distribution ? [config.hosting.github.distribution] : [])];
                const repositories = [];
                for (const identity of identities) {
                    const actual = await inspectRepository({ github, repository: identity.repository });
                    if (actual.visibility !== identity.visibility || actual.defaultBranch !== identity.defaultBranch || actual.archived || actual.disabled) {
                        throw new Error(`Remote repository identity does not match configuration: ${identity.repository}`);
                    }
                    repositories.push(actual);
                }
                const metadata = await listSecretMetadata({ github, repository: config.hosting.github.source.repository });
                metadata.secrets.forEach(({ name }) => availableSecrets.add(name));
                checks.githubHosting = { status: "pass", repositories };
                remoteVerified = true;
            } catch (error) {
                checks.githubHosting = { status: "fail", reason: "remote-verification-failed", error: error.message };
            }
        }
    }
    const required = requiredSecrets(config);
    const buildSecretNames = required.filter(({ purpose }) => purpose === "build-and-sign").map(({ name }) => name);
    const missingLocalBuild = config.hosting.github.enabled
        ? []
        : buildSecretNames.filter((name) => !availableSecrets.has(name));
    checks.localBuild = missingLocalBuild.length
        ? { status: "fail", missingEnvironmentNames: missingLocalBuild }
        : {
            status: "configured",
            units: config.build.units.map(({ id, target, runner }) => ({ id, target, runner })),
            requiredSecretNames: buildSecretNames,
        };
    for (const [id] of Object.entries(PROVIDERS)) {
        const providerConfig = config.providers[id];
        if (!providerConfig?.enabled) checks.providers[id] = { status: "disabled" };
        else {
            const missing = required.filter(({ purpose }) => purpose.startsWith(`${id}:`)).map(({ name }) => name).filter((name) => !availableSecrets.has(name));
            checks.providers[id] = missing.length ? { status: "fail", missingSecretMetadata: missing } : { status: "pass" };
            if (providerConfig.issueSync) checks.incidentResolution = missing.length ? { status: "fail" } : { status: "configured" };
        }
    }
    const missingRelease = required.filter(({ purpose }) => !purpose.includes(":"))
        .map(({ name }) => name).filter((name) => config.hosting.github.enabled && !availableSecrets.has(name));
    if (missingRelease.length) checks.releasePublication = { status: "fail", missingSecretMetadata: missingRelease };
    const failed = Object.values(checks).some((value) => value?.status === "fail")
        || Object.values(checks.providers).some(({ status }) => status === "fail");
    return { schemaVersion: AUDIT_SCHEMA, success: !failed && remoteVerified, remoteVerified, checks };
}

export async function writeJson(path, value) {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { adapterById, providerById } from "./provider-registry.mjs";
import { assertRelativeRepositoryPath } from "./path-safety.mjs";

export const CONFIG_SCHEMA = "release-ops/config/v2";
export const PLAN_SCHEMA = "release-ops/setup-plan/v2";
export const AUDIT_SCHEMA = "release-ops/audit/v2";
export const RELEASE_SCHEMA = "release-ops-release/v2";

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,99}$/u;
const SECRET_VALUE_KEY = /(?:token|secret|password|privatekey|keystore)/iu;

function object(value, name) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
}

function string(value, name, pattern = null) {
    if (typeof value !== "string" || !value.trim() || (pattern && !pattern.test(value))) throw new Error(`${name} is invalid`);
}

function optionalString(value, name, pattern = null) {
    if (value !== null && value !== undefined) string(value, name, pattern);
}

function stringArray(value, name, pattern = null) {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry || (pattern && !pattern.test(entry)))) {
        throw new Error(`${name} must be an array of valid strings`);
    }
}

function noCredentialValues(value, path = "config") {
    if (Array.isArray(value)) return value.forEach((child, index) => noCredentialValues(child, `${path}[${index}]`));
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
        const normalized = key.replaceAll(/[^A-Za-z0-9]/gu, "").toLowerCase();
        if (SECRET_VALUE_KEY.test(normalized) && !["requiredsecretnames", "requiredsecrets"].includes(normalized)) {
            throw new Error(`${path}.${key} may not contain credential material`);
        }
        noCredentialValues(child, `${path}.${key}`);
    }
}

function repositoryIdentity(value, name, visibility = null) {
    object(value, name);
    string(value.repository, `${name}.repository`, REPOSITORY_PATTERN);
    string(value.owner, `${name}.owner`, /^[A-Za-z0-9_.-]+$/u);
    string(value.name, `${name}.name`, /^[A-Za-z0-9_.-]+$/u);
    if (value.repository !== `${value.owner}/${value.name}`) throw new Error(`${name} remote identity is inconsistent`);
    string(value.defaultBranch, `${name}.defaultBranch`, /^[A-Za-z0-9._/-]+$/u);
    if (visibility && value.visibility !== visibility) throw new Error(`${name}.visibility must be ${visibility}`);
    if (!visibility && !["private", "public"].includes(value.visibility)) throw new Error(`${name}.visibility is invalid`);
}

function command(value, name) {
    object(value, name);
    string(value.executable, `${name}.executable`);
    stringArray(value.args, `${name}.args`);
    if (Object.hasOwn(value, "shell")) throw new Error(`${name}.shell is forbidden`);
}

function artifact(value, name) {
    object(value, name);
    string(value.id, `${name}.id`, ID_PATTERN);
    assertRelativeRepositoryPath(value.path, `${name}.path`);
    string(value.nameTemplate, `${name}.nameTemplate`);
    string(value.contentType, `${name}.contentType`);
    string(value.platform, `${name}.platform`);
    string(value.architecture, `${name}.architecture`);
}

function buildUnit(value, index, adapter) {
    const name = `build.units[${index}]`;
    object(value, name);
    string(value.id, `${name}.id`, ID_PATTERN);
    string(value.target, `${name}.target`, ID_PATTERN);
    string(value.runner, `${name}.runner`, /^(?:(?:ubuntu|windows|macos)-(?:latest|\d+(?:\.\d+)?)|self-hosted)$/u);
    if (value.runner === "self-hosted") {
        if (!adapter.selfHostedFallback) throw new Error(`${name} cannot use a self-hosted runner with ${adapter.id}`);
        string(value.selfHostedReason, `${name}.selfHostedReason`);
    } else if (value.selfHostedReason !== undefined) {
        throw new Error(`${name}.selfHostedReason is only valid for self-hosted runners`);
    }
    if (adapter.id === "unity") {
        if (value.command !== undefined && value.command !== null) command(value.command, `${name}.command`);
    } else {
        command(value.command, `${name}.command`);
    }
    stringArray(value.requiredSecretNames ?? [], `${name}.requiredSecretNames`, SECRET_NAME_PATTERN);
    if (!Array.isArray(value.artifacts) || !value.artifacts.length) throw new Error(`${name}.artifacts must not be empty`);
    value.artifacts.forEach((entry, artifactIndex) => artifact(entry, `${name}.artifacts[${artifactIndex}]`));
    if (adapter.id !== "generic" && value.runner !== "self-hosted") {
        const target = adapter.targets.find((entry) => entry.id === value.target && entry.runner === value.runner);
        if (!target) throw new Error(`${name} target/runner is unsupported by ${adapter.id}`);
    }
}

function versionSource(value, name) {
    object(value, name);
    assertRelativeRepositoryPath(value.file, `${name}.file`);
    if (!["properties", "json", "text", "gradle-properties", "package-json", "pubspec", "godot", "unity"].includes(value.reader)) {
        throw new Error(`${name}.reader is unsupported`);
    }
    string(value.key, `${name}.key`);
}

function validateProviderConfig(id, provider, githubEnabled) {
    const manifest = providerById(id);
    if (!manifest) throw new Error(`providers.${id} is not installed`);
    object(provider, `providers.${id}`);
    if (typeof provider.enabled !== "boolean") throw new Error(`providers.${id}.enabled must be boolean`);
    if (provider.schemaVersion !== manifest.configSchemaVersion) throw new Error(`providers.${id}.schemaVersion is unsupported`);
    if (!provider.enabled) return;
    if (id === "sentry") {
        string(provider.organization, "providers.sentry.organization", /^[A-Za-z0-9_-]+$/u);
        string(provider.project, "providers.sentry.project", /^[A-Za-z0-9_-]+$/u);
        string(provider.apiBase, "providers.sentry.apiBase");
        const base = new URL(provider.apiBase);
        if (base.protocol !== "https:" || !base.pathname.endsWith("/api/0")) throw new Error("providers.sentry.apiBase must be an HTTPS /api/0 endpoint");
        if (typeof provider.issueSync !== "boolean") throw new Error("providers.sentry.issueSync must be boolean");
        if (provider.issueSync && !githubEnabled) throw new Error("Sentry issueSync requires GitHub");
        if (!Number.isSafeInteger(provider.lookbackMinutes) || provider.lookbackMinutes < 75) {
            throw new Error("providers.sentry.lookbackMinutes must be at least 75");
        }
        if (!/^[-*/0-9,]+\s+[-*/0-9,]+\s+[-*/0-9,]+\s+[-*/0-9,]+\s+[-*/0-9,]+$/u.test(provider.schedule)) {
            throw new Error("providers.sentry.schedule is invalid");
        }
        optionalString(provider.releaseTemplate, "providers.sentry.releaseTemplate");
        optionalString(provider.distTemplate, "providers.sentry.distTemplate");
        if (!Array.isArray(provider.debugArtifacts ?? [])) throw new Error("providers.sentry.debugArtifacts must be an array");
        for (const [index, debugArtifact] of (provider.debugArtifacts ?? []).entries()) {
            object(debugArtifact, `providers.sentry.debugArtifacts[${index}]`);
            assertRelativeRepositoryPath(debugArtifact.path, `providers.sentry.debugArtifacts[${index}].path`);
            if (!["proguard", "source-map", "dif", "dart-symbol", "bcsymbolmap", "breakpad", "dsym", "elf", "jvm", "pdb", "pe", "portablepdb", "sourcebundle", "wasm"].includes(debugArtifact.type)) {
                throw new Error(`providers.sentry.debugArtifacts[${index}].type is unsupported`);
            }
            optionalString(debugArtifact.unit, `providers.sentry.debugArtifacts[${index}].unit`, ID_PATTERN);
        }
    }
}

export function validateConfig(config) {
    object(config, "config");
    noCredentialValues(config);
    if (config.schemaVersion !== CONFIG_SCHEMA) throw new Error(`schemaVersion must be ${CONFIG_SCHEMA}`);
    object(config.project, "project");
    string(config.project.name, "project.name");
    string(config.project.adapter, "project.adapter", ID_PATTERN);
    const adapter = adapterById(config.project.adapter);
    if (!adapter) throw new Error("project.adapter is not installed");
    if (adapter.status === "unsupported") throw new Error(`project.adapter ${adapter.id} is detected but unsupported`);
    if (adapter.id === "godot") {
        object(config.project.adapterOptions, "project.adapterOptions");
        string(config.project.adapterOptions.godotVersion, "project.adapterOptions.godotVersion", /^\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.-]+)?$/u);
    }
    if (adapter.id === "unity") {
        object(config.project.adapterOptions, "project.adapterOptions");
        if (!["personal", "professional"].includes(config.project.adapterOptions.license)) {
            throw new Error("project.adapterOptions.license must be personal or professional");
        }
        if (config.project.adapterOptions.projectPath !== ".") {
            assertRelativeRepositoryPath(config.project.adapterOptions.projectPath, "project.adapterOptions.projectPath");
        }
    }

    object(config.build, "build");
    if (!Array.isArray(config.build.units) || !config.build.units.length) throw new Error("build.units must not be empty");
    config.build.units.forEach((unit, index) => buildUnit(unit, index, adapter));
    if (new Set(config.build.units.map(({ id }) => id)).size !== config.build.units.length) throw new Error("build unit ids must be unique");

    object(config.versioning, "versioning");
    versionSource(config.versioning.canonical, "versioning.canonical");
    if (!Array.isArray(config.versioning.buildNumbers ?? [])) throw new Error("versioning.buildNumbers must be an array");
    (config.versioning.buildNumbers ?? []).forEach((entry, index) => {
        string(entry.id, `versioning.buildNumbers[${index}].id`, ID_PATTERN);
        versionSource(entry.source, `versioning.buildNumbers[${index}].source`);
    });
    assertRelativeRepositoryPath(config.versioning.changelogPattern.replaceAll("{version}", "0.0.0"), "versioning.changelogPattern");
    if (typeof config.versioning.requiresChinese !== "boolean") throw new Error("versioning.requiresChinese must be boolean");

    object(config.hosting, "hosting");
    object(config.hosting.github, "hosting.github");
    const github = config.hosting.github;
    if (typeof github.enabled !== "boolean") throw new Error("hosting.github.enabled must be boolean");
    if (github.enabled) {
        repositoryIdentity(github.source, "hosting.github.source");
        if (github.source.visibility === "public") {
            if (github.releaseMode !== "same-repository" || github.distribution !== null) {
                throw new Error("public sources must use same-repository with no separate distribution identity");
            }
        } else {
            if (github.releaseMode !== "dual-repository") throw new Error("private sources must use dual-repository");
            repositoryIdentity(github.distribution, "hosting.github.distribution", "public");
            if (github.distribution.repository === github.source.repository) throw new Error("distribution repository must differ from private source");
        }
    } else if (github.releaseMode !== "local" || github.source !== null || github.distribution !== null) {
        throw new Error("GitHub-disabled projects must use local mode without repository identities");
    }

    object(config.release, "release");
    assertRelativeRepositoryPath(config.release.workflowFile, "release.workflowFile");
    string(config.release.tagTemplate, "release.tagTemplate");
    string(config.release.titleTemplate, "release.titleTemplate");
    if (config.release.manifestSchema !== RELEASE_SCHEMA) throw new Error(`release.manifestSchema must be ${RELEASE_SCHEMA}`);
    optionalString(config.release.publicReadmeSource, "release.publicReadmeSource");
    if (config.release.publicReadmeSource) assertRelativeRepositoryPath(config.release.publicReadmeSource, "release.publicReadmeSource");
    optionalString(config.release.publicReadmeTarget, "release.publicReadmeTarget");
    if (config.release.publicReadmeTarget) assertRelativeRepositoryPath(config.release.publicReadmeTarget, "release.publicReadmeTarget");
    if (github.enabled && github.releaseMode === "same-repository" && config.release.publicReadmeTarget === "README.md") {
        throw new Error("same-repository publication must preserve the root README");
    }
    if (github.enabled && github.releaseMode === "dual-repository" && config.release.publicReadmeTarget !== "README.md") {
        throw new Error("dual-repository publication must manage the distribution root README");
    }
    assertRelativeRepositoryPath(config.release.latestManifest, "release.latestManifest");
    assertRelativeRepositoryPath(config.release.localOutputDirectory, "release.localOutputDirectory");
    if (!["release-ops", "android-version-code-v1"].includes(config.release.latestCompatibility)) {
        throw new Error("release.latestCompatibility is unsupported");
    }
    if (config.release.latestCompatibility === "android-version-code-v1") {
        string(config.release.latestBuildNumberId, "release.latestBuildNumberId", ID_PATTERN);
        if (!config.versioning.buildNumbers.some(({ id }) => id === config.release.latestBuildNumberId)) {
            throw new Error("release.latestBuildNumberId must reference a configured build number");
        }
        if (!Number.isSafeInteger(config.release.minimumSupportedVersionCode)
            || config.release.minimumSupportedVersionCode <= 0) {
            throw new Error("release.minimumSupportedVersionCode must be a positive integer");
        }
    }

    object(config.providers, "providers");
    for (const [id, provider] of Object.entries(config.providers)) validateProviderConfig(id, provider, github.enabled);
    return config;
}

export async function loadConfig(root = process.cwd()) {
    const path = resolve(root, ".release-ops", "config.json");
    const text = await readFile(path, "utf8");
    return validateConfig(JSON.parse(text));
}

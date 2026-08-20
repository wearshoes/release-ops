import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { adapterById, PROVIDERS } from "./provider-registry.mjs";

export const CONFIG_SCHEMA = "release-ops/config/v1";
export const RELEASE_SCHEMA = "release-ops-release/v1";

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SECRET_VALUE_KEY = /(?:token|secret|password|privatekey|keystore)/iu;

function assertObject(value, name) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${name} must be an object`);
    }
}

function assertString(value, name, pattern = null) {
    if (typeof value !== "string" || value.trim() === "" || (pattern && !pattern.test(value))) {
        throw new Error(`${name} is invalid`);
    }
}

function assertOptionalString(value, name, pattern = null) {
    if (value !== null && value !== undefined) assertString(value, name, pattern);
}

function assertStringArray(value, name) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
        throw new Error(`${name} must be an array of non-empty strings`);
    }
}

function assertNoSecretValues(value, path = "config") {
    if (Array.isArray(value)) {
        value.forEach((item, index) => assertNoSecretValues(item, `${path}[${index}]`));
        return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
        const normalizedKey = key.replaceAll(/[^A-Za-z0-9]/gu, "").toLowerCase();
        if (SECRET_VALUE_KEY.test(normalizedKey) && normalizedKey !== "requiredsecretnames") {
            throw new Error(`${path}.${key} may not contain credential material`);
        }
        assertNoSecretValues(child, `${path}.${key}`);
    }
}

function validateArtifact(artifact, index) {
    assertObject(artifact, `build.artifacts[${index}]`);
    assertString(artifact.id, `build.artifacts[${index}].id`, /^[a-z0-9][a-z0-9-]{0,63}$/u);
    assertString(artifact.path, `build.artifacts[${index}].path`);
    assertString(artifact.nameTemplate, `build.artifacts[${index}].nameTemplate`);
    assertString(artifact.contentType, `build.artifacts[${index}].contentType`);
    assertString(artifact.platform, `build.artifacts[${index}].platform`);
    assertString(artifact.architecture, `build.artifacts[${index}].architecture`);
}

export function validateConfig(config) {
    assertObject(config, "config");
    assertNoSecretValues(config);
    if (config.schemaVersion !== CONFIG_SCHEMA) throw new Error(`schemaVersion must be ${CONFIG_SCHEMA}`);

    assertObject(config.project, "project");
    assertString(config.project.name, "project.name");
    assertString(config.project.adapter, "project.adapter");
    if (!adapterById(config.project.adapter)) throw new Error("project.adapter is unsupported");

    assertObject(config.build, "build");
    assertString(config.build.command, "build.command");
    if (!Array.isArray(config.build.artifacts) || config.build.artifacts.length === 0) {
        throw new Error("build.artifacts must contain at least one artifact");
    }
    config.build.artifacts.forEach(validateArtifact);
    if (config.build.requiredSecretNames !== undefined) {
        assertStringArray(config.build.requiredSecretNames, "build.requiredSecretNames");
        for (const name of config.build.requiredSecretNames) {
            if (!/^[A-Z_][A-Z0-9_]{0,99}$/u.test(name)) throw new Error("build.requiredSecretNames contains an invalid name");
        }
    }

    assertObject(config.versioning, "versioning");
    assertString(config.versioning.file, "versioning.file");
    assertString(config.versioning.versionKey, "versioning.versionKey");
    if (config.versioning.reader !== undefined && !["properties", "json"].includes(config.versioning.reader)) {
        throw new Error("versioning.reader must be properties or json");
    }
    assertOptionalString(config.versioning.codeKey, "versioning.codeKey");
    assertString(config.versioning.changelogPattern, "versioning.changelogPattern");
    if (config.versioning.requiresChinese !== undefined && typeof config.versioning.requiresChinese !== "boolean") {
        throw new Error("versioning.requiresChinese must be boolean");
    }

    assertObject(config.hosting, "hosting");
    assertObject(config.hosting.github, "hosting.github");
    if (typeof config.hosting.github.enabled !== "boolean") throw new Error("hosting.github.enabled must be boolean");
    const github = config.hosting.github;
    if (github.enabled) {
        assertString(github.sourceRepository, "hosting.github.sourceRepository", REPOSITORY_PATTERN);
        if (!["private", "public"].includes(github.sourceVisibility)) throw new Error("sourceVisibility must be private or public");
        assertString(github.defaultBranch, "hosting.github.defaultBranch", /^[A-Za-z0-9._/-]+$/u);
        if (github.sourceVisibility === "public" && github.releaseMode !== "same-repository") {
            throw new Error("public sources must use same-repository release mode");
        }
        if (github.sourceVisibility === "private") {
            if (github.releaseMode !== "dual-repository") throw new Error("private sources must use dual-repository release mode");
            assertString(github.publicRepository, "hosting.github.publicRepository", REPOSITORY_PATTERN);
            if (github.publicRepository === github.sourceRepository) throw new Error("publicRepository must differ from the private source");
        }
    } else if (github.releaseMode !== "local") {
        throw new Error("GitHub-disabled projects must use local release mode");
    }

    assertObject(config.release, "release");
    assertString(config.release.workflowFile, "release.workflowFile");
    assertString(config.release.tagTemplate, "release.tagTemplate");
    assertString(config.release.titleTemplate, "release.titleTemplate");
    if (config.release.manifestSchema !== RELEASE_SCHEMA) throw new Error(`release.manifestSchema must be ${RELEASE_SCHEMA}`);
    assertOptionalString(config.release.publicReadmeSource, "release.publicReadmeSource");
    assertOptionalString(config.release.publicReadmeTarget, "release.publicReadmeTarget");
    assertString(config.release.latestManifest, "release.latestManifest");
    if (config.release.latestCompatibility !== undefined
        && !["release-ops", "android-version-code-v1"].includes(config.release.latestCompatibility)) {
        throw new Error("release.latestCompatibility is unsupported");
    }
    if (config.release.minimumSupportedVersionCode !== undefined
        && (!Number.isSafeInteger(config.release.minimumSupportedVersionCode) || config.release.minimumSupportedVersionCode <= 0)) {
        throw new Error("release.minimumSupportedVersionCode must be a positive integer");
    }

    assertObject(config.providers, "providers");
    for (const [id, provider] of Object.entries(config.providers)) {
        if (!PROVIDERS[id]) throw new Error(`providers.${id} is not installed`);
        assertObject(provider, `providers.${id}`);
        if (typeof provider.enabled !== "boolean") throw new Error(`providers.${id}.enabled must be boolean`);
        if (provider.schemaVersion !== PROVIDERS[id].schemaVersion) throw new Error(`providers.${id}.schemaVersion is unsupported`);
        if (id === "sentry" && provider.enabled) {
            assertString(provider.organization, "providers.sentry.organization", /^[A-Za-z0-9_-]+$/u);
            assertString(provider.project, "providers.sentry.project", /^[A-Za-z0-9_-]+$/u);
            assertString(provider.host, "providers.sentry.host", /^[A-Za-z0-9.-]+$/u);
            if (provider.issueSync && !github.enabled) throw new Error("Sentry issueSync requires GitHub");
            if (provider.schedule !== undefined && !/^[-*/0-9,]+\s+[-*/0-9,]+\s+[-*/0-9,]+\s+[-*/0-9,]+\s+[-*/0-9,]+$/u.test(provider.schedule)) {
                throw new Error("providers.sentry.schedule is invalid");
            }
            assertOptionalString(provider.releaseTemplate, "providers.sentry.releaseTemplate");
            assertOptionalString(provider.distTemplate, "providers.sentry.distTemplate");
            if (provider.debugArtifacts !== undefined) {
                if (!Array.isArray(provider.debugArtifacts)) throw new Error("providers.sentry.debugArtifacts must be an array");
                provider.debugArtifacts.forEach((artifact, index) => {
                    assertObject(artifact, `providers.sentry.debugArtifacts[${index}]`);
                    assertString(artifact.path, `providers.sentry.debugArtifacts[${index}].path`);
                    if (!["proguard", "source-map", "dif", "dart-symbol"].includes(artifact.type)) {
                        throw new Error(`providers.sentry.debugArtifacts[${index}].type is unsupported`);
                    }
                });
            }
        }
    }
    return config;
}

export async function loadConfig(root = process.cwd()) {
    const path = resolve(root, ".release-ops", "config.json");
    const text = await readFile(path, "utf8");
    return validateConfig(JSON.parse(text));
}

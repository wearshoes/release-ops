import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadExtensions } from "./extension-registry.mjs";
import { validateSchema } from "./schema.mjs";
import { stableJson, sha256 } from "./stable.mjs";

export const CONFIG_SCHEMA = "release-ops/config/v1";
export const RELEASE_SCHEMA = "release-ops/release-manifest/v1";

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const CREDENTIAL_VALUE = /(?:github_pat_|ghp_|sntrys_|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{16,})/iu;
const CREDENTIAL_KEY = /^(?:token|password|secret|secretValue|privateKey|keystoreBase64)$/iu;

function exactKeys(value, name, allowed) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
    for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${name}.${key} is not supported`);
}

function rejectCredentialValues(value, path = "config") {
    if (typeof value === "string" && CREDENTIAL_VALUE.test(value)) throw new Error(`${path} contains credential material`);
    if (Array.isArray(value)) return value.forEach((item, index) => rejectCredentialValues(item, `${path}[${index}]`));
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
        if (CREDENTIAL_KEY.test(key)) throw new Error(`${path}.${key} may not store credential material`);
        rejectCredentialValues(item, `${path}.${key}`);
    }
}

export async function validateConfig(input, { extensions = null } = {}) {
    const registry = extensions ?? await loadExtensions();
    exactKeys(input, "config", new Set(["schemaVersion", "project", "extensions"]));
    if (input.schemaVersion !== CONFIG_SCHEMA) throw new Error(`schemaVersion must be ${CONFIG_SCHEMA}`);
    exactKeys(input.project, "project", new Set(["name"]));
    if (typeof input.project.name !== "string" || !input.project.name.trim()) throw new Error("project.name is invalid");
    if (!Array.isArray(input.extensions) || input.extensions.length < 2) throw new Error("extensions must contain a stack and release instance");
    const instanceIds = new Set();
    let stackCount = 0;
    let releaseCount = 0;
    const buildUnitIds = new Set();
    for (const [index, instance] of input.extensions.entries()) {
        exactKeys(instance, `extensions[${index}]`, new Set(["instanceId", "extensionId", "configSchemaVersion", "config"]));
        if (!ID.test(instance.instanceId ?? "") || !ID.test(instance.extensionId ?? "")) throw new Error(`extensions[${index}] identity is invalid`);
        if (instanceIds.has(instance.instanceId)) throw new Error(`Duplicate extension instance: ${instance.instanceId}`);
        instanceIds.add(instance.instanceId);
        const manifest = registry[instance.extensionId];
        if (!manifest) throw new Error(`Extension is not installed: ${instance.extensionId}`);
        if (manifest.status === "diagnostic") throw new Error(`Extension is diagnostic-only: ${instance.extensionId}`);
        if (instance.configSchemaVersion !== manifest.configSchemaVersion) throw new Error(`Extension config schema is unsupported: ${instance.instanceId}`);
        validateSchema(instance.config, manifest.configSchemaObject, `extensions[${index}].config`);
        if (manifest.type === "stack") {
            stackCount += 1;
            const requiredToolchainRoles = manifest.processors.flatMap((processor) =>
                processor.secretRoles.filter(({ required }) => required).map(({ role }) => role));
            for (const unit of instance.config.buildUnits) {
                if (buildUnitIds.has(unit.id)) throw new Error(`Build unit has multiple owners: ${unit.id}`);
                buildUnitIds.add(unit.id);
                if (unit.runner === "self-hosted" && !unit.selfHostedReason) {
                    throw new Error(`Self-hosted build unit requires a reason: ${unit.id}`);
                }
                if (unit.runner !== "self-hosted" && unit.selfHostedReason !== undefined) {
                    throw new Error(`Hosted build unit cannot declare selfHostedReason: ${unit.id}`);
                }
                const expectedRunner = manifest.targets[unit.target];
                if (Object.keys(manifest.targets).length && unit.runner !== "self-hosted" && !expectedRunner) {
                    throw new Error(`Stack ${instance.instanceId} does not support hosted target ${unit.target}`);
                }
                if (expectedRunner && unit.runner !== "self-hosted" && unit.runner !== expectedRunner) {
                    throw new Error(`Stack ${instance.instanceId} target ${unit.target} requires runner ${expectedRunner}`);
                }
                if (manifest.status === "credential-gated") {
                    for (const role of requiredToolchainRoles) {
                        if (!unit.requiredSecretRoles.includes(role) || !instance.config.secretNames?.[role]) {
                            throw new Error(`Credential-gated stack ${instance.instanceId} requires Secret role ${role}`);
                        }
                    }
                }
            }
        }
        if (manifest.type === "release") {
            releaseCount += 1;
            const release = instance.config;
            if (release.mode === "local" && (release.source !== undefined || release.distribution !== undefined)) {
                throw new Error("Local release cannot configure GitHub repositories");
            }
            if (release.mode === "local" && release.manifest.compatibility !== "release-ops") {
                throw new Error("Local release supports only the standard release manifest");
            }
            if (release.mode === "same-repository" && (release.source?.visibility !== "public" || release.distribution !== null)) {
                throw new Error("same-repository requires a public source and no distribution repository");
            }
            if (release.mode === "dual-repository") {
                if (release.source?.visibility !== "private" || release.distribution?.visibility !== "public") {
                    throw new Error("dual-repository requires private source and public distribution identities");
                }
                if (release.source.repository === release.distribution.repository) throw new Error("Distribution repository must differ from source");
            }
            if (release.manifest.compatibility === "android-version-code-v1"
                && (!release.manifest.latestBuildNumberId || !Number.isSafeInteger(release.manifest.minimumSupportedBuildNumber))) {
                throw new Error("Android latest compatibility requires a build number id and minimum build number");
            }
        }
    }
    if (!stackCount) throw new Error("At least one stack extension is required");
    if (releaseCount !== 1) throw new Error("Exactly one release extension is required");
    for (const instance of input.extensions) {
        const manifest = registry[instance.extensionId];
        if (manifest.type === "signing") {
            for (const unitId of instance.config.buildUnitIds) {
                if (!buildUnitIds.has(unitId)) throw new Error(`Signing instance references an unknown build unit: ${unitId}`);
            }
            const declared = new Set(manifest.processors.flatMap((processor) => processor.secretRoles.map(({ role }) => role)));
            for (const role of Object.keys(instance.config.secretNames)) {
                if (!declared.has(role)) throw new Error(`Signing instance maps an undeclared Secret role: ${role}`);
            }
        }
        if (manifest.type === "provider" && instance.config.issueSync === true) {
            const release = input.extensions.find((candidate) => registry[candidate.extensionId].type === "release");
            if (release.config.mode === "local") throw new Error("Provider issue sync requires a GitHub release extension");
            if (release.config.source.visibility !== "private") throw new Error("Provider issue sync requires a private source repository");
        }
    }
    rejectCredentialValues(input);
    return input;
}

export async function loadConfig(root = process.cwd(), options = {}) {
    const input = JSON.parse(await readFile(resolve(root, ".release-ops", "config.json"), "utf8"));
    return validateConfig(input, options);
}

export function configDigest(config) {
    return sha256(stableJson(config));
}

export function extensionInstances(config, registry, type = null) {
    return config.extensions.filter((instance) => !type || registry[instance.extensionId]?.type === type);
}

export function instanceById(config, instanceId) {
    return config.extensions.find((instance) => instance.instanceId === instanceId) ?? null;
}

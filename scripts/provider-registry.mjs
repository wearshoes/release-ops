import { readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ADAPTER_SCHEMA = "release-ops/adapter/v2";
export const PROVIDER_SCHEMA = "release-ops/provider/v2";

const HERE = dirname(fileURLToPath(import.meta.url));

function manifestRoot(name, { optional = false } = {}) {
    const candidates = [resolve(HERE, "..", name), resolve(HERE, name)];
    for (const candidate of candidates) {
        try {
            readdirSync(candidate, { withFileTypes: true });
            return candidate;
        } catch {
            // Try the next source/runtime layout.
        }
    }
    if (optional) return null;
    throw new Error(`Release Ops ${name} manifest root is unavailable`);
}

function stringArray(value, name) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
        throw new Error(`${name} must be an array of non-empty strings`);
    }
}

function manifestPath(value, name) {
    if (typeof value !== "string" || !value || isAbsolute(value)) throw new Error(`${name} must be relative`);
    const segments = value.replaceAll("\\", "/").split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
        throw new Error(`${name} contains an unsafe path segment`);
    }
    return value;
}

function readManifests(root, filename, validate) {
    const result = {};
    if (!root) return Object.freeze(result);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const path = join(root, entry.name, filename);
        let data;
        try {
            data = JSON.parse(readFileSync(path, "utf8"));
        } catch (error) {
            if (error?.code === "ENOENT") continue;
            throw new Error(`Invalid manifest ${path}: ${error.message}`);
        }
        validate(data, entry.name, root);
        if (result[data.id]) throw new Error(`Duplicate manifest id: ${data.id}`);
        result[data.id] = Object.freeze({ ...data, manifestDirectory: join(root, entry.name) });
    }
    return Object.freeze(result);
}

function validateAdapter(adapter, folder) {
    if (adapter?.schemaVersion !== ADAPTER_SCHEMA || adapter.id !== folder) {
        throw new Error(`Adapter ${folder} must use ${ADAPTER_SCHEMA} and match its folder`);
    }
    if (!["supported", "credential-gated", "unsupported"].includes(adapter.status)) {
        throw new Error(`Adapter ${folder} has an invalid status`);
    }
    stringArray(adapter.detects, `Adapter ${folder} detects`);
    stringArray(adapter.artifactTypes, `Adapter ${folder} artifactTypes`);
    if (!Array.isArray(adapter.targets) || adapter.targets.some((target) =>
        !target || typeof target.id !== "string" || typeof target.runner !== "string")) {
        throw new Error(`Adapter ${folder} targets are invalid`);
    }
    manifestPath(adapter.docs, `Adapter ${folder} docs`);
    if (adapter.credentialProfiles !== undefined) {
        if (!adapter.credentialProfiles || typeof adapter.credentialProfiles !== "object" || Array.isArray(adapter.credentialProfiles)) {
            throw new Error(`Adapter ${folder} credentialProfiles are invalid`);
        }
        for (const [profile, names] of Object.entries(adapter.credentialProfiles)) {
            if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(profile)) throw new Error(`Adapter ${folder} credential profile is invalid`);
            stringArray(names, `Adapter ${folder} credentialProfiles.${profile}`);
            if (names.some((name) => !/^[A-Z_][A-Z0-9_]{0,99}$/u.test(name))) {
                throw new Error(`Adapter ${folder} credentialProfiles.${profile} contains an invalid Secret name`);
            }
        }
    }
    if (adapter.selfHostedFallback !== undefined && typeof adapter.selfHostedFallback !== "boolean") {
        throw new Error(`Adapter ${folder} selfHostedFallback must be boolean`);
    }
    if (adapter.selfHostedConditions !== undefined) {
        stringArray(adapter.selfHostedConditions, `Adapter ${folder} selfHostedConditions`);
        if (!adapter.selfHostedFallback) throw new Error(`Adapter ${folder} selfHostedConditions require selfHostedFallback`);
    }
}

const CAPABILITIES = new Set([
    "configure", "audit", "requiredSecrets", "buildHooks", "scheduledIngest", "incidentIntake", "resolve",
]);

function validateProvider(provider, folder, root) {
    if (provider?.schemaVersion !== PROVIDER_SCHEMA || provider.id !== folder) {
        throw new Error(`Provider ${folder} must use ${PROVIDER_SCHEMA} and match its folder`);
    }
    if (provider.installed !== true) throw new Error(`Provider ${folder} is not installed`);
    stringArray(provider.capabilities, `Provider ${folder} capabilities`);
    if (provider.capabilities.some((capability) => !CAPABILITIES.has(capability))) {
        throw new Error(`Provider ${folder} declares an unknown capability`);
    }
    if (typeof provider.configSchemaVersion !== "string" || !provider.configSchemaVersion) {
        throw new Error(`Provider ${folder} configSchemaVersion is required`);
    }
    manifestPath(provider.configSchema, `Provider ${folder} configSchema`);
    try {
        const schema = JSON.parse(readFileSync(join(root, folder, provider.configSchema), "utf8"));
        if (!JSON.stringify(schema).includes(provider.configSchemaVersion)) {
            throw new Error("schema does not declare configSchemaVersion");
        }
    } catch (error) {
        throw new Error(`Provider ${folder} config schema is invalid: ${error.message}`);
    }
    for (const name of Object.values(provider.requiredSecrets ?? {})) {
        if (!/^[A-Z_][A-Z0-9_]{0,99}$/u.test(name)) throw new Error(`Provider ${folder} Secret name is invalid`);
    }
    stringArray(provider.runtimeFiles ?? [], `Provider ${folder} runtimeFiles`);
    provider.runtimeFiles.forEach((path) => manifestPath(path, `Provider ${folder} runtime file`));
    manifestPath(provider.docs, `Provider ${folder} docs`);
    if (provider.buildHook) {
        manifestPath(provider.buildHook.script, `Provider ${folder} build hook script`);
        if (!provider.runtimeFiles.includes(provider.buildHook.script)) throw new Error(`Provider ${folder} build hook is not a runtime file`);
        if (!provider.requiredSecrets?.[provider.buildHook.secretRole]) throw new Error(`Provider ${folder} build hook Secret role is unavailable`);
    }
    if (provider.capabilities.includes("buildHooks") !== Boolean(provider.buildHook)) {
        throw new Error(`Provider ${folder} buildHooks capability does not match its implementation`);
    }
    for (const managed of provider.managedFiles ?? []) {
        manifestPath(managed.source, `Provider ${folder} managed source`);
        manifestPath(managed.target, `Provider ${folder} managed target`);
    }
}

export const ADAPTERS = readManifests(manifestRoot("adapters"), "adapter.json", validateAdapter);
export const BUILD_ADAPTERS = Object.freeze(Object.values(ADAPTERS));
export const PROVIDERS = readManifests(manifestRoot("providers", { optional: true }), "provider.json", validateProvider);

export function providerChoices() {
    return ["none", ...Object.keys(PROVIDERS).sort()];
}

export function adapterById(id) {
    return ADAPTERS[id] ?? null;
}

export function providerById(id) {
    return PROVIDERS[id] ?? null;
}

export function adapterRequiredSecrets(config) {
    const adapter = adapterById(config?.project?.adapter);
    if (!adapter?.credentialProfiles) return [];
    const profile = config.project.adapterOptions?.license;
    const names = adapter.credentialProfiles[profile];
    if (!names) throw new Error(`Adapter ${adapter.id} credential profile is unavailable: ${profile ?? "missing"}`);
    return [...names];
}

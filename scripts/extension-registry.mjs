import { readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Files } from "./stable.mjs";

export const EXTENSION_SCHEMA = "release-ops/extension/v1";
export const PROCESSOR_SCHEMA = "release-ops/processor/v1";
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const CAPABILITY = /^[a-z][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?$/u;
const STAGES = new Set([
    "inspect", "configure", "plan", "preflight", "prepare", "build", "sign", "debug-artifacts",
    "collect", "publish-stage", "publish-finalize", "scheduled-ingest", "resolve", "audit",
]);
const TYPES = new Set(["stack", "signing", "release", "provider"]);
const STATUSES = new Set(["supported", "credential-gated", "diagnostic"]);
const HOSTED_RUNNER = /^(?:ubuntu|windows|macos)-(?:latest|[0-9]+(?:\.[0-9]+)?)$/u;
const QUESTION_TYPES = new Set([
    "boolean", "build-units", "build-unit-selection", "github-distribution", "github-repository",
    "path", "sentry-project", "versioning",
]);

function freeze(value) {
    if (Array.isArray(value)) value.forEach(freeze);
    else if (value && typeof value === "object") Object.values(value).forEach(freeze);
    return Object.freeze(value);
}

function exactKeys(value, name, allowed) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
    for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${name}.${key} is not supported`);
}

function repositoryPath(value, name) {
    if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\0")) {
        throw new Error(`${name} must be a repository-relative path`);
    }
    const normalized = value.replaceAll("\\", "/");
    if (normalized.split("/").includes("..")) throw new Error(`${name} must stay inside the plugin`);
    return normalized;
}

function validateRequirement(value, name) {
    exactKeys(value, name, new Set(["capability", "cardinality", "optional"]));
    if (!CAPABILITY.test(value.capability ?? "") || !["one", "many"].includes(value.cardinality)
        || typeof value.optional !== "boolean") throw new Error(`${name} is invalid`);
}

function detectionPattern(value, name) {
    if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\0")) {
        throw new Error(`${name} is invalid`);
    }
    const normalized = value.replaceAll("\\", "/");
    if (normalized.split("/").includes("..") || (normalized.includes("*") && !/^\*\.[A-Za-z0-9._-]+$/u.test(normalized))) {
        throw new Error(`${name} is invalid`);
    }
    return normalized;
}

function validateDetection(detection, manifestId) {
    exactKeys(detection, `Extension ${manifestId} detection`, new Set(["all", "any", "content"]));
    for (const key of ["all", "any"]) {
        if (!Array.isArray(detection[key])) throw new Error(`Extension ${manifestId} detection.${key} is invalid`);
        detection[key] = detection[key].map((value, index) => detectionPattern(value, `Extension ${manifestId} detection.${key}[${index}]`));
    }
    if (!Array.isArray(detection.content)) throw new Error(`Extension ${manifestId} detection.content is invalid`);
    for (const [index, rule] of detection.content.entries()) {
        exactKeys(rule, `Extension ${manifestId} detection.content[${index}]`, new Set(["path", "pattern"]));
        rule.path = repositoryPath(rule.path, `Extension ${manifestId} detection.content[${index}].path`);
        if (typeof rule.pattern !== "string" || !rule.pattern) throw new Error(`Extension ${manifestId} detection pattern is invalid`);
        try {
            new RegExp(rule.pattern, "u");
        } catch {
            throw new Error(`Extension ${manifestId} detection pattern is invalid`);
        }
    }
}

function validateQuestions(questions, manifestId) {
    if (!Array.isArray(questions)) throw new Error(`Extension ${manifestId} questions are invalid`);
    const ids = new Set();
    for (const [index, question] of questions.entries()) {
        exactKeys(question, `Extension ${manifestId} questions[${index}]`, new Set(["id", "type", "required"]));
        if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(question.id ?? "") || ids.has(question.id)
            || !QUESTION_TYPES.has(question.type) || typeof question.required !== "boolean") {
            throw new Error(`Extension ${manifestId} question is invalid`);
        }
        ids.add(question.id);
    }
}

function validateProcessor(processor) {
    exactKeys(processor, "processor", new Set([
        "schemaVersion", "id", "stage", "module", "entrypoint", "requires", "provides", "before", "after",
        "secretRoles", "permissions",
    ]));
    if (processor.schemaVersion !== PROCESSOR_SCHEMA || !ID.test(processor.id ?? "") || !STAGES.has(processor.stage)) {
        throw new Error("Processor identity or stage is invalid");
    }
    processor.module = repositoryPath(processor.module, `Processor ${processor.id} module`);
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(processor.entrypoint ?? "")) throw new Error(`Processor ${processor.id} entrypoint is invalid`);
    if (!Array.isArray(processor.requires) || !Array.isArray(processor.provides)) throw new Error(`Processor ${processor.id} capabilities are invalid`);
    processor.requires.forEach((item, index) => validateRequirement(item, `Processor ${processor.id} requires[${index}]`));
    for (const item of processor.provides) {
        exactKeys(item, `Processor ${processor.id} provide`, new Set(["capability", "merge", "key"]));
        if (!CAPABILITY.test(item.capability ?? "") || !["exclusive", "append", "keyed"].includes(item.merge)) {
            throw new Error(`Processor ${processor.id} provide is invalid`);
        }
        if (item.merge === "keyed" && (typeof item.key !== "string" || !item.key)) throw new Error(`Processor ${processor.id} keyed provide needs a key`);
        if (item.merge !== "keyed" && item.key !== undefined) throw new Error(`Processor ${processor.id} non-keyed provide cannot declare a key`);
    }
    for (const key of ["before", "after"]) {
        if (!Array.isArray(processor[key]) || new Set(processor[key]).size !== processor[key].length
            || processor[key].some((id) => !ID.test(id))) throw new Error(`Processor ${processor.id} ${key} is invalid`);
    }
    if (!Array.isArray(processor.secretRoles)) throw new Error(`Processor ${processor.id} secret roles are invalid`);
    const roles = new Set();
    for (const role of processor.secretRoles) {
        exactKeys(role, `Processor ${processor.id} secret role`, new Set(["role", "required", "defaultName"]));
        if (!ID.test(role.role ?? "") || roles.has(role.role) || typeof role.required !== "boolean"
            || (role.defaultName !== undefined && !/^[A-Z_][A-Z0-9_]{0,99}$/u.test(role.defaultName))) {
            throw new Error(`Processor ${processor.id} secret role is invalid`);
        }
        roles.add(role.role);
    }
    exactKeys(processor.permissions, `Processor ${processor.id} permissions`, new Set(["commands", "networkOrigins", "outputRoots"]));
    if (!Array.isArray(processor.permissions.commands) || !Array.isArray(processor.permissions.networkOrigins)) {
        throw new Error(`Processor ${processor.id} permissions are invalid`);
    }
    const commandIds = new Set();
    for (const command of processor.permissions.commands) {
        exactKeys(command, `Processor ${processor.id} command`, new Set(["id", "executable", "argsPrefix"]));
        if (!ID.test(command.id ?? "") || commandIds.has(command.id) || typeof command.executable !== "string" || !command.executable
            || (command.argsPrefix !== undefined && (!Array.isArray(command.argsPrefix)
                || command.argsPrefix.some((item) => typeof item !== "string")))) throw new Error(`Processor ${processor.id} command is invalid`);
        commandIds.add(command.id);
    }
    for (const origin of processor.permissions.networkOrigins) {
        if (/^config-origin:[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/u.test(origin)) continue;
        const url = new URL(origin);
        if (url.protocol !== "https:" || url.origin !== origin) throw new Error(`Processor ${processor.id} network origin is invalid`);
    }
    if (processor.permissions.outputRoots !== undefined
        && (!Array.isArray(processor.permissions.outputRoots)
            || processor.permissions.outputRoots.some((value) => !/^config:[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/u.test(value)))) {
        throw new Error(`Processor ${processor.id} output roots are invalid`);
    }
    return processor;
}

function validateManifest(manifest, directory, path) {
    exactKeys(manifest, "extension", new Set([
        "schemaVersion", "id", "type", "version", "status", "configSchemaVersion", "configSchema", "docs",
        "dependencies", "detection", "questions", "targets", "processors", "runtimeFiles",
    ]));
    if (manifest.schemaVersion !== EXTENSION_SCHEMA || !ID.test(manifest.id ?? "") || !TYPES.has(manifest.type)
        || !STATUSES.has(manifest.status) || !/^\d+\.\d+\.\d+$/u.test(manifest.version ?? "")) {
        throw new Error(`Extension manifest is invalid: ${path}`);
    }
    if (directory.replaceAll("\\", "/").split("/").at(-1) !== manifest.id) throw new Error(`Extension folder does not match id: ${manifest.id}`);
    if (!/^release-ops\/extension-config\/[a-z0-9-]+\/v[1-9][0-9]*$/u.test(manifest.configSchemaVersion ?? "")) {
        throw new Error(`Extension config schema version is invalid: ${manifest.id}`);
    }
    manifest.configSchema = repositoryPath(manifest.configSchema, `Extension ${manifest.id} config schema`);
    manifest.docs = repositoryPath(manifest.docs, `Extension ${manifest.id} docs`);
    if (!Array.isArray(manifest.dependencies) || !Array.isArray(manifest.processors) || !manifest.processors.length
        || !Array.isArray(manifest.runtimeFiles) || new Set(manifest.runtimeFiles).size !== manifest.runtimeFiles.length) {
        throw new Error(`Extension ${manifest.id} collections are invalid`);
    }
    validateQuestions(manifest.questions, manifest.id);
    if (manifest.type === "stack") validateDetection(manifest.detection, manifest.id);
    else if (manifest.detection !== undefined) throw new Error(`Non-stack extension ${manifest.id} cannot declare detection`);
    manifest.dependencies.forEach((item, index) => validateRequirement(item, `Extension ${manifest.id} dependencies[${index}]`));
    if (manifest.type === "stack") {
        exactKeys(manifest.targets, `Extension ${manifest.id} targets`, new Set(Object.keys(manifest.targets ?? {})));
        for (const [target, runner] of Object.entries(manifest.targets)) {
            if (!ID.test(target) || !HOSTED_RUNNER.test(runner)) throw new Error(`Extension ${manifest.id} target ${target} is invalid`);
        }
    } else if (manifest.targets !== undefined) {
        throw new Error(`Non-stack extension ${manifest.id} cannot declare targets`);
    }
    manifest.processors.forEach(validateProcessor);
    if (new Set(manifest.processors.map(({ id }) => id)).size !== manifest.processors.length) {
        throw new Error(`Extension ${manifest.id} has duplicate processor ids`);
    }
    manifest.runtimeFiles = manifest.runtimeFiles.map((item) => repositoryPath(item, `Extension ${manifest.id} runtime file`));
    return manifest;
}

async function manifestDirectories(root) {
    const result = [];
    const extensionRoot = join(root, "extensions");
    for (const type of await readdir(extensionRoot, { withFileTypes: true })) {
        if (!type.isDirectory() || type.name.startsWith("_")) continue;
        for (const entry of await readdir(join(extensionRoot, type.name), { withFileTypes: true })) {
            if (entry.isDirectory() && !entry.name.startsWith("_")) result.push(join(extensionRoot, type.name, entry.name));
        }
    }
    return result.sort();
}

export async function loadExtensionCatalog({ root = PLUGIN_ROOT } = {}) {
    const result = {};
    for (const directory of await manifestDirectories(root)) {
        const manifestPath = join(directory, "extension.json");
        const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")), directory, manifestPath);
        if (result[manifest.id]) throw new Error(`Duplicate extension id: ${manifest.id}`);
        result[manifest.id] = freeze({ ...manifest, manifestDirectory: directory, manifestPath });
    }
    return freeze(result);
}

async function hydrateManifest(manifest, root) {
    const schemaPath = resolve(root, manifest.configSchema);
    const docsPath = resolve(root, manifest.docs);
    const modulePaths = manifest.processors.map((processor) => resolve(root, processor.module));
    const runtimePaths = manifest.runtimeFiles.map((item) => resolve(root, item));
    const configSchemaObject = JSON.parse(await readFile(schemaPath, "utf8"));
    await readFile(docsPath, "utf8");
    const codePaths = [...new Set([manifest.manifestPath, schemaPath, ...modulePaths, ...runtimePaths])];
    for (const file of codePaths) await readFile(file);
    return freeze({
        ...manifest,
        configSchemaObject,
        schemaPath,
        docsPath,
        modulePaths,
        runtimePaths,
        codePaths,
        codeSha256: await sha256Files(codePaths),
    });
}

export async function hydrateExtensions(ids, { root = PLUGIN_ROOT, catalog = null } = {}) {
    const source = catalog ?? await loadExtensionCatalog({ root });
    const unique = [...new Set(ids)].sort();
    const result = {};
    for (const id of unique) {
        if (!source[id]) throw new Error(`Extension is not installed: ${id}`);
        result[id] = await hydrateManifest(source[id], root);
    }
    return freeze(result);
}

export async function loadExtensions({ root = PLUGIN_ROOT, ids = null } = {}) {
    const catalog = await loadExtensionCatalog({ root });
    return hydrateExtensions(ids ?? Object.keys(catalog), { root, catalog });
}

export function publicExtension(manifest) {
    return {
        id: manifest.id,
        type: manifest.type,
        version: manifest.version,
        status: manifest.status,
        docs: manifest.docs,
        configSchemaVersion: manifest.configSchemaVersion,
        questions: manifest.questions ?? [],
        targets: manifest.targets ?? null,
        detection: manifest.detection ?? null,
    };
}

export function relativePluginPath(path, root = PLUGIN_ROOT) {
    return relative(root, path).replaceAll("\\", "/");
}

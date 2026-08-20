#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { isMainModule } from "./cli-entry.mjs";
import { createKernelApi } from "./kernel-api.mjs";

function freeze(value) {
    if (Array.isArray(value)) value.forEach(freeze);
    else if (value && typeof value === "object") Object.values(value).forEach(freeze);
    return Object.freeze(value);
}

function secretEnvironmentName(role) {
    return `RELEASE_OPS_SECRET_${role.toUpperCase().replaceAll("-", "_")}`;
}

export async function executeNode({
    root = process.cwd(),
    nodeId,
    operation,
    arguments: args = [],
    config = null,
    graph = null,
    moduleRoot = null,
    secretValues: providedSecretValues = null,
    execFileImpl,
    fetchImpl,
}) {
    const releaseOpsRoot = resolve(root, ".release-ops");
    const loadedConfig = config ?? JSON.parse(await readFile(resolve(releaseOpsRoot, "config.json"), "utf8"));
    const loadedGraph = graph ?? JSON.parse(await readFile(resolve(releaseOpsRoot, "processor-graph.json"), "utf8"));
    const node = loadedGraph.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error(`Processor node is not configured: ${nodeId}`);
    const instance = loadedConfig.extensions.find((candidate) => candidate.instanceId === node.instanceId);
    if (!instance) throw new Error(`Processor instance is not configured: ${node.instanceId}`);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(operation ?? "")) throw new Error("Processor operation is invalid");
    const environmentSecretValues = Object.fromEntries(node.secretRoles.flatMap(({ role }) => {
        const declaration = node.secretRoles.find((candidate) => candidate.role === role);
        const configuredName = declaration.configuredName ?? instance.config.secretNames?.[role] ?? declaration.defaultName;
        const value = process.env[secretEnvironmentName(role)] ?? process.env[configuredName];
        return value === undefined ? [] : [[role, value]];
    }));
    const secretValues = providedSecretValues ?? environmentSecretValues;
    const api = createKernelApi({
        root,
        node,
        secretValues,
        secretNames: Object.fromEntries(node.secretRoles.flatMap((declaration) =>
            declaration.configuredName ? [[declaration.role, declaration.configuredName]] : [])),
        execFileImpl,
        fetchImpl,
    });
    const runtimeRoot = moduleRoot ?? resolve(releaseOpsRoot, "runtime");
    const modulePath = resolve(runtimeRoot, node.module);
    const moduleRelative = relative(runtimeRoot, modulePath);
    if (!moduleRelative || moduleRelative === ".." || moduleRelative.startsWith(`..\\`)
        || moduleRelative.startsWith("../") || isAbsolute(moduleRelative)) {
        throw new Error("Processor module escapes the runtime root");
    }
    const module = await import(pathToFileURL(modulePath).href);
    const entrypoint = module[node.entrypoint];
    if (typeof entrypoint !== "function") throw new Error(`Processor entrypoint is unavailable: ${node.entrypoint}`);
    return entrypoint(freeze({
        api,
        config: loadedConfig,
        graph: loadedGraph,
        instance,
        node,
        operation,
        arguments: args,
        execute: true,
    }));
}

async function main() {
    const nodeId = process.env.RELEASE_OPS_NODE;
    const operation = process.env.RELEASE_OPS_OPERATION;
    let args;
    try {
        args = JSON.parse(process.env.RELEASE_OPS_ARGUMENTS ?? "[]");
    } catch (error) {
        throw new Error("RELEASE_OPS_ARGUMENTS must be JSON", { cause: error });
    }
    if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) throw new Error("Processor arguments must be strings");
    const result = await executeNode({ nodeId, operation, arguments: args });
    process.stdout.write(`${JSON.stringify(result ?? null)}\n`);
}

if (isMainModule(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`Release Ops processor failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

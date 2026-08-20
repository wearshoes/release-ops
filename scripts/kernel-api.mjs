import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileDefault = promisify(execFileCallback);

function frozen(value) {
    if (Array.isArray(value)) value.forEach(frozen);
    else if (value && typeof value === "object") Object.values(value).forEach(frozen);
    return Object.freeze(value);
}

function commandById(node, id) {
    const command = node.permissions.commands.find((candidate) => candidate.id === id);
    if (!command) throw new Error(`Processor ${node.id} cannot execute command ${id}`);
    return command;
}

function secretRoleById(node, role) {
    const declaration = node.secretRoles.find((candidate) => candidate.role === role);
    if (!declaration) throw new Error(`Processor ${node.id} cannot access Secret role ${role}`);
    return declaration;
}

async function safeReadPath(root, relativePath) {
    if (typeof relativePath !== "string" || !relativePath || isAbsolute(relativePath) || relativePath.includes("\0")) {
        throw new Error("Repository read path is invalid");
    }
    const normalized = relativePath.replaceAll("\\", "/");
    if (normalized.split("/").includes("..")) throw new Error("Repository read path escapes the root");
    const rootReal = await realpath(root);
    const target = resolve(rootReal, normalized);
    const targetReal = await realpath(target);
    const rel = relative(rootReal, targetReal);
    if (rel === ".." || rel.startsWith(`..\\`) || rel.startsWith("../") || isAbsolute(rel)) {
        throw new Error("Repository read path crosses a symlink boundary");
    }
    return targetReal;
}

function isInside(root, target) {
    const rel = relative(root, target);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..\\`) && !rel.startsWith("../") && !isAbsolute(rel));
}

async function nearestExisting(path) {
    let current = path;
    while (true) {
        try {
            await access(current);
            return current;
        } catch (error) {
            if (error?.code !== "ENOENT") throw error;
        }
        const parent = dirname(current);
        if (parent === current) throw new Error("Output path has no existing ancestor");
        current = parent;
    }
}

async function safeOutputPath(root, relativePath, outputRoots) {
    if (typeof relativePath !== "string" || !relativePath || isAbsolute(relativePath) || relativePath.includes("\0")) {
        throw new Error("Repository output path is invalid");
    }
    const normalized = relativePath.replaceAll("\\", "/");
    if (normalized.split("/").includes("..")) throw new Error("Repository output path escapes the root");
    const rootReal = await realpath(root);
    const target = resolve(rootReal, normalized);
    const allowed = outputRoots.some((outputRoot) => isInside(resolve(rootReal, outputRoot), target));
    if (!allowed) throw new Error("Processor cannot write outside its declared output roots");
    const existing = await nearestExisting(target);
    const existingReal = await realpath(existing);
    if (!isInside(rootReal, existingReal)) throw new Error("Repository output path crosses a symlink boundary");
    return target;
}

function childEnvironment(secretEnvironment) {
    const result = { ...secretEnvironment };
    for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
        if (process.env[name]) result[name] = process.env[name];
    }
    return result;
}

export function createKernelApi({
    root,
    node,
    secretValues = {},
    secretNames = {},
    execFileImpl = execFileDefault,
    fetchImpl = globalThis.fetch,
    managedFileSink = () => { throw new Error("Managed files are unavailable in this stage"); },
    workflowSink = () => { throw new Error("Workflow contributions are unavailable in this stage"); },
}) {
    const api = {
        async readText(path) {
            return readFile(await safeReadPath(root, path), "utf8");
        },
        async readBytes(path) {
            return readFile(await safeReadPath(root, path));
        },
        async readJson(path) {
            return JSON.parse(await api.readText(path));
        },
        async exists(path) {
            try {
                await access(await safeReadPath(root, path));
                return true;
            } catch (error) {
                if (error?.code === "ENOENT") return false;
                throw error;
            }
        },
        async execFile(commandId, args = [], {
            secretRoles = [], secretEnvironment: secretEnvironmentNames = {}, environment = {}, configuredCommand = null,
        } = {}) {
            if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) throw new Error("execFile args must be strings");
            if (!environment || typeof environment !== "object" || Array.isArray(environment)
                || Object.entries(environment).some(([name, value]) => !/^[A-Z_][A-Z0-9_]{0,99}$/u.test(name)
                    || typeof value !== "string" || value.includes("\0"))) {
                throw new Error("execFile environment must contain safe string values");
            }
            const command = commandById(node, commandId);
            const selected = command.executable === "config:command"
                ? configuredCommand
                : { executable: command.executable, args: command.argsPrefix ?? [] };
            if (!selected || typeof selected.executable !== "string" || !selected.executable
                || !Array.isArray(selected.args) || selected.args.some((item) => typeof item !== "string")) {
                throw new Error(`Processor ${node.id} configured command is invalid`);
            }
            const secretEnvironment = { ...environment };
            for (const role of secretRoles) {
                const declaration = secretRoleById(node, role);
                const name = secretNames[role] ?? declaration.configuredName ?? declaration.defaultName;
                if (!name || secretValues[role] === undefined) {
                    if (declaration.required) throw new Error(`Required Secret role is unavailable: ${role}`);
                    continue;
                }
                const environmentName = secretEnvironmentNames[role] ?? name;
                if (!/^[A-Z_][A-Z0-9_]{0,99}$/u.test(environmentName ?? "")) {
                    throw new Error(`Processor ${node.id} Secret environment name is invalid for ${role}`);
                }
                secretEnvironment[environmentName] = secretValues[role];
            }
            return execFileImpl(selected.executable, [...selected.args, ...args], {
                cwd: root,
                env: childEnvironment(secretEnvironment),
                shell: false,
                windowsHide: true,
                encoding: "utf8",
            });
        },
        async request(origin, path, options = {}) {
            if (!node.permissions.networkOrigins.includes(origin)) throw new Error(`Processor ${node.id} cannot access ${origin}`);
            const base = new URL(origin);
            const parsed = new URL(path, `${base.origin}/`);
            if (parsed.origin !== base.origin || parsed.username || parsed.password || parsed.protocol !== "https:") {
                throw new Error(`Processor ${node.id} cannot access ${parsed.origin}`);
            }
            const method = String(options.method ?? "GET").toUpperCase();
            if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("HTTP method is not allowed");
            const headers = new Headers(options.headers ?? {});
            if (headers.has("authorization") || headers.has("cookie")) throw new Error("Extension cannot provide credential headers");
            if (options.secretRole) {
                const declaration = secretRoleById(node, options.secretRole);
                const value = secretValues[options.secretRole];
                if (value === undefined && declaration.required) throw new Error(`Required Secret role is unavailable: ${options.secretRole}`);
                if (value !== undefined) headers.set("authorization", `Bearer ${value}`);
            }
            let body = options.body;
            if (options.json !== undefined) {
                if (body !== undefined) throw new Error("HTTP request cannot contain both body and json");
                body = JSON.stringify(options.json);
                headers.set("content-type", "application/json; charset=utf-8");
            } else if (options.contentType) {
                headers.set("content-type", options.contentType);
            }
            const {
                secretRole: _secretRole,
                json: _json,
                contentType: _contentType,
                headers: _headers,
                ...requestOptions
            } = options;
            return fetchImpl(parsed, { ...requestOptions, headers, method, body, redirect: "error" });
        },
        async writeOutput(path, value) {
            const outputRoots = node.permissions.outputRoots ?? [];
            if (!outputRoots.length) throw new Error(`Processor ${node.id} cannot write release output`);
            if (typeof value !== "string" && !(value instanceof Uint8Array)) throw new Error("Release output must be text or bytes");
            const target = await safeOutputPath(root, path, outputRoots);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, value);
            return frozen({ path: path.replaceAll("\\", "/"), size: typeof value === "string" ? new TextEncoder().encode(value).length : value.byteLength });
        },
        addManagedFile(contribution) {
            if (!contribution || typeof contribution.path !== "string" || typeof contribution.content !== "string") {
                throw new Error("Managed file contribution is invalid");
            }
            return managedFileSink(frozen({ ...contribution, ownerInstanceId: node.instanceId }));
        },
        addWorkflow(contribution) {
            if (!contribution || typeof contribution.path !== "string" || !contribution.model) throw new Error("Workflow contribution is invalid");
            return workflowSink(frozen({ ...contribution, ownerInstanceId: node.instanceId }));
        },
    };
    return frozen(api);
}

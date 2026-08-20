#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { applySetupPlan, auditProject, createSetupPlan, inspectProject, writeJson } from "./setup-core.mjs";

function parseArguments(values) {
    const command = values[0] ?? "inspect";
    const args = new Map();
    for (let index = 1; index < values.length; index += 2) {
        const key = values[index];
        const value = values[index + 1];
        if (!key?.startsWith("--") || value === undefined || args.has(key)) {
            throw new Error("Arguments must use unique --name value pairs");
        }
        args.set(key, value);
    }
    return { command, args };
}

function required(args, key) {
    const value = args.get(key);
    if (!value) throw new Error(`${key} is required`);
    return value;
}

async function readJson(path, name) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
        throw new Error(`${name} is not valid UTF-8 JSON`, { cause: error });
    }
}

async function main() {
    const { command, args } = parseArguments(process.argv.slice(2));
    const root = resolve(args.get("--root") ?? process.cwd());
    let result;
    if (command === "inspect") {
        result = await inspectProject(root);
    } else if (command === "plan") {
        result = await createSetupPlan(root, await readJson(resolve(required(args, "--answers")), "Setup answers"));
    } else if (command === "apply") {
        result = await applySetupPlan(
            await readJson(resolve(required(args, "--plan")), "Setup plan"),
            required(args, "--confirm"),
        );
    } else if (command === "audit") {
        result = await auditProject(root);
        if (!result.success) process.exitCode = 1;
    } else {
        throw new Error("Use inspect, plan, apply, or audit");
    }
    if (args.has("--out")) await writeJson(resolve(args.get("--out")), result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
    process.stderr.write(`Release Ops failed: ${error.message}\n`);
    process.exitCode = 1;
});

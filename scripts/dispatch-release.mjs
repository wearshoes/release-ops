#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config.mjs";
import { createGitHubClient } from "./github-client.mjs";
import { dispatchWorkflowAndWait } from "./workflow-dispatch.mjs";

export const RELEASE_DISPATCH_SCHEMA = "release-ops-release-dispatch/v2";

function validateInputs(config, { version, buildNumbers, sourceSha, correlation }) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) throw new Error("Version must use semantic version format");
    if (!buildNumbers || typeof buildNumbers !== "object" || Array.isArray(buildNumbers)) throw new Error("Build numbers must be an object");
    if (!/^[0-9a-f]{40}$/u.test(sourceSha)) throw new Error("Source SHA must be a full lowercase commit SHA");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(correlation)) {
        throw new Error("Correlation id must be a UUID v4");
    }
    if (!config.hosting.github.enabled) throw new Error("GitHub releases are disabled");
}

export function releaseRunTitle(version, sourceSha, correlation) {
    return `Release v${version} from ${sourceSha} [${correlation}]`;
}

export async function dispatchRelease({ github, config, version, buildNumbers = {}, sourceSha, correlation, ...timing }) {
    validateInputs(config, { version, buildNumbers, sourceSha, correlation });
    const repository = config.hosting.github.source.repository;
    const workflow = config.release.workflowFile.split("/").at(-1);
    const title = releaseRunTitle(version, sourceSha, correlation);
    const run = await dispatchWorkflowAndWait({
        github,
        repository,
        workflow,
        branch: config.hosting.github.source.defaultBranch,
        title,
        inputs: {
            version,
            buildNumbers: JSON.stringify(buildNumbers),
            sourceSha,
            correlation,
        },
        label: "Release",
        ...timing,
    });
    return {
        schemaVersion: RELEASE_DISPATCH_SCHEMA,
        success: true,
        repository,
        version,
        buildNumbers,
        sourceSha,
        correlation,
        runId: run.id,
        runUrl: run.html_url,
    };
}

async function main() {
    const values = new Map();
    for (let index = 2; index < process.argv.length; index += 2) {
        const key = process.argv[index];
        const value = process.argv[index + 1];
        if (!key?.startsWith("--") || value === undefined || values.has(key)) throw new Error("Arguments must use unique --name value pairs");
        values.set(key, value);
    }
    const config = await loadConfig(values.get("--root") ?? process.cwd());
    const token = process.env.github_token ?? process.env.GITHUB_TOKEN;
    const github = createGitHubClient({ sourceRepository: config.hosting.github.source.repository, sourceToken: token });
    const result = await dispatchRelease({
        github,
        config,
        version: values.get("--version") ?? "",
        buildNumbers: JSON.parse(values.get("--build-numbers") ?? "{}"),
        sourceSha: values.get("--sha") ?? "",
        correlation: values.get("--correlation") ?? randomUUID(),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        process.stderr.write(`Release dispatch failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

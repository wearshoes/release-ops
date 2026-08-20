#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config.mjs";
import { createGitHubClient } from "./github-client.mjs";
import { createSentryClient } from "./sentry-client.mjs";
import { syncSentryIncidents } from "./sentry-incidents.mjs";

async function main() {
    const rootIndex = process.argv.indexOf("--root");
    const root = resolve(rootIndex >= 0 ? process.argv[rootIndex + 1] : process.cwd());
    const config = await loadConfig(root);
    const repository = config.hosting.github.sourceRepository;
    const result = await syncSentryIncidents({
        config,
        sentry: createSentryClient({ token: process.env.SENTRY_AUTH_TOKEN }),
        github: createGitHubClient({ sourceRepository: repository, sourceToken: process.env.GITHUB_TOKEN ?? process.env.github_token }),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        process.stderr.write(`Sentry synchronization failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

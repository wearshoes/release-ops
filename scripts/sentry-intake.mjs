#!/usr/bin/env node

import { resolve } from "node:path";

import { isMainModule } from "./cli-entry.mjs";
import { loadConfig } from "./config.mjs";
import { incidentProviderConfig, releaseConfig } from "./config-query.mjs";
import { createGitHubClient } from "./github-client.mjs";
import { parseIncidentBody } from "./sentry-incidents.mjs";

function sanitizedIssue(issue, expectedRepository, expectedProject) {
    if (!Number.isSafeInteger(issue?.number) || !["open", "closed"].includes(issue?.state)) throw new Error("GitHub returned invalid Issue metadata");
    if (issue.html_url !== `https://github.com/${expectedRepository}/issues/${issue.number}`) throw new Error("GitHub Issue repository identity is invalid");
    if (!issue.labels?.some(({ name }) => name === "sentry") || !issue.labels?.some(({ name }) => name === "automated-error")) {
        throw new Error("GitHub Issue is missing managed Sentry labels");
    }
    const incident = parseIncidentBody(issue.body);
    if (incident.project !== expectedProject) throw new Error("GitHub Issue Sentry project is invalid");
    return { issueNumber: issue.number, state: issue.state, title: issue.title, url: issue.html_url, incident };
}

export async function intake({ config, github, command, issueNumber = null }) {
    const repository = releaseConfig(config).source.repository;
    const project = incidentProviderConfig(config).project;
    if (command === "show") {
        if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new Error("show requires a positive Issue number");
        const issue = (await github.request(`/repos/${repository}/issues/${issueNumber}`)).data;
        return { schemaVersion: "release-ops-sentry-intake/v1", ...sanitizedIssue(issue, repository, project) };
    }
    if (command !== "list") throw new Error("Use list or show");
    const issues = (await github.request(`/repos/${repository}/issues?state=open&labels=sentry,automated-error&per_page=100`)).data;
    if (!Array.isArray(issues)) throw new Error("GitHub returned an invalid Issue list");
    return {
        schemaVersion: "release-ops-sentry-intake-list/v1",
        issues: issues.filter((issue) => !issue.pull_request).map((issue) => sanitizedIssue(issue, repository, project)),
    };
}

async function main() {
    const command = process.argv[2];
    const rootIndex = process.argv.indexOf("--root");
    const issueIndex = process.argv.indexOf("--issue");
    const root = resolve(rootIndex >= 0 ? process.argv[rootIndex + 1] : process.cwd());
    const config = await loadConfig(root);
    const repository = releaseConfig(config).source.repository;
    const result = await intake({
        config,
        github: createGitHubClient({ sourceRepository: repository, sourceToken: process.env.github_token ?? process.env.GITHUB_TOKEN }),
        command,
        issueNumber: issueIndex >= 0 ? Number(process.argv[issueIndex + 1]) : null,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`Sentry intake failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

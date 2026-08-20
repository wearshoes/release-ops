#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { isMainModule } from "./cli-entry.mjs";
import { loadConfig } from "./config.mjs";
import { createGitHubClient } from "./github-client.mjs";
import { createSentryClient } from "./sentry-client.mjs";
import { parseIncidentBody, resolveSentryIncident } from "./sentry-incidents.mjs";

function trailers(message) {
    const issueLines = [...String(message).matchAll(/^Issues:\s*(.+)$/gmu)];
    const commitLines = [...String(message).matchAll(/^Commit-ID:\s*(\S+)\s*$/gmu)];
    if (!issueLines.length && !commitLines.length) return null;
    if (issueLines.length !== 1 || commitLines.length !== 1) throw new Error("Resolution commit must contain one Issues and one Commit-ID trailer");
    const tokens = issueLines[0][1].trim().split(/\s+/u);
    if (!tokens.length || tokens.some((token) => !/^#[1-9]\d*$/u.test(token))) throw new Error("Issues trailer is invalid");
    const issues = tokens.map((token) => Number(token.slice(1)));
    if (new Set(issues).size !== issues.length) throw new Error("Issues trailer contains duplicates");
    return { issues, commit: commitLines[0][1] };
}

export function planResolutions(event, isAncestor) {
    const commits = Array.isArray(event?.commits) ? event.commits : [];
    const bindings = [];
    const seen = new Set();
    for (const commit of commits) {
        const parsed = trailers(commit?.message);
        if (!parsed) continue;
        const commitSha = parsed.commit === "HEAD" ? commit.id : parsed.commit;
        if (!/^[0-9a-f]{40}$/u.test(commitSha)) throw new Error("Commit-ID must be HEAD or a full lowercase SHA");
        if (!isAncestor(commitSha, event.after)) throw new Error("Commit-ID is not an ancestor of the pushed default-branch head");
        for (const issueNumber of parsed.issues) {
            if (seen.has(issueNumber)) throw new Error("An Issue may appear only once in one push");
            seen.add(issueNumber);
            bindings.push({ issueNumber, commitSha, subject: String(commit.message).split(/\r?\n/u)[0].slice(0, 200) });
        }
    }
    return bindings.sort((left, right) => left.issueNumber - right.issueNumber);
}

export async function applyResolutions({ config, bindings, github, sentryRead, sentryWrite }) {
    const repository = config.hosting.github.source.repository;
    const results = [];
    for (const binding of bindings) {
        try {
            const issue = (await github.request(`/repos/${repository}/issues/${binding.issueNumber}`)).data;
            let kind = "github";
            try {
                parseIncidentBody(issue.body);
                kind = "sentry";
            } catch (error) {
                if (String(issue.body ?? "").includes("release-ops-sentry:")) throw error;
            }
            if (kind === "sentry") {
                await resolveSentryIncident({ config, issue, commitSha: binding.commitSha, sentryRead, sentryWrite, github });
            }
            await github.request(`/repos/${repository}/issues/${issue.number}/comments`, {
                method: "POST",
                json: { body: `Resolved by commit https://github.com/${repository}/commit/${binding.commitSha}\n\n${binding.subject}` },
            });
            await github.request(`/repos/${repository}/issues/${issue.number}`, { method: "PATCH", json: { state: "closed" } });
            results.push({ issueNumber: binding.issueNumber, kind, result: "resolved" });
        } catch (error) {
            results.push({ issueNumber: binding.issueNumber, kind: "unknown", result: "failed", errorCategory: "RESOLUTION_FAILED" });
        }
    }
    return { schemaVersion: "release-ops-issue-resolution-batch/v2", results, success: results.every(({ result }) => result === "resolved") };
}

function completePushEvent(root, event) {
    const before = String(event?.before ?? "");
    const after = String(event?.after ?? "");
    if (!/^[0-9a-f]{40}$/u.test(after)) throw new Error("Push event after SHA is invalid");
    const range = /^0{40}$/u.test(before) || !/^[0-9a-f]{40}$/u.test(before) ? after : `${before}..${after}`;
    const shas = execFileSync("git", ["-C", root, "rev-list", "--reverse", range], { encoding: "utf8" })
        .trim().split(/\r?\n/u).filter(Boolean);
    const commits = shas.map((id) => ({
        id,
        message: execFileSync("git", ["-C", root, "show", "-s", "--format=%B", id], { encoding: "utf8" }).trimEnd(),
    }));
    return { ...event, after, commits };
}

async function main() {
    const rootIndex = process.argv.indexOf("--root");
    const root = resolve(rootIndex >= 0 ? process.argv[rootIndex + 1] : process.cwd());
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
    const config = await loadConfig(root);
    const bindings = planResolutions(completePushEvent(root, event), (target, head) => {
        try {
            execFileSync("git", ["-C", root, "merge-base", "--is-ancestor", target, head], { stdio: "ignore" });
            return true;
        } catch {
            return false;
        }
    });
    const github = createGitHubClient({ sourceRepository: config.hosting.github.source.repository, sourceToken: process.env.GITHUB_TOKEN });
    const result = await applyResolutions({
        config,
        bindings,
        github,
        sentryRead: createSentryClient({ token: process.env.SENTRY_AUTH_TOKEN, apiBase: config.providers.sentry.apiBase }),
        sentryWrite: createSentryClient({ token: process.env.SENTRY_WRITE_TOKEN, apiBase: config.providers.sentry.apiBase }),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.success) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`Issue resolution failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

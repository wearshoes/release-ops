#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { createGitHubClient } from "./github-client.mjs";

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function parsePairs(values) {
    const command = values[0];
    const args = new Map();
    for (let index = 1; index < values.length; index += 1) {
        const key = values[index];
        if (key === "--dry-run") {
            if (args.has(key)) throw new Error(`Duplicate argument: ${key}`);
            args.set(key, true);
            continue;
        }
        const value = values[index + 1];
        if (!key?.startsWith("--") || !value || value.startsWith("--") || args.has(key)) {
            throw new Error(`Argument requires one value: ${key}`);
        }
        args.set(key, value);
        index += 1;
    }
    return { command, args };
}

function required(args, key) {
    const value = args.get(key);
    if (!value) throw new Error(`${key} is required`);
    return value;
}

function validateRepository(repository) {
    if (!REPOSITORY_PATTERN.test(repository)) throw new Error("Repository must use owner/name format");
    return repository;
}

function sanitizedRepository(data) {
    if (!data || typeof data !== "object") throw new Error("GitHub returned invalid repository metadata");
    const visibility = data.visibility ?? (data.private ? "private" : "public");
    if (!["private", "public"].includes(visibility)) throw new Error("GitHub returned unsupported visibility");
    if (!REPOSITORY_PATTERN.test(data.full_name ?? "") || typeof data.default_branch !== "string") {
        throw new Error("GitHub returned invalid repository identity");
    }
    const [owner, name] = data.full_name.split("/");
    return {
        repository: data.full_name,
        owner,
        name,
        visibility,
        defaultBranch: data.default_branch,
        archived: Boolean(data.archived),
        disabled: Boolean(data.disabled),
    };
}

export async function inspectRepository({ github, repository }) {
    validateRepository(repository);
    const response = await github.request(`/repos/${repository}`);
    return { schemaVersion: "release-ops-github-repository/v1", exists: true, ...sanitizedRepository(response.data) };
}

export async function createRepository({ github, repository, visibility, confirmation, dryRun = true, initialize = false }) {
    validateRepository(repository);
    if (!["private", "public"].includes(visibility)) throw new Error("Visibility must be private or public");
    const existing = await github.request(`/repos/${repository}`, { allowNotFound: true });
    if (existing.data) {
        const inspected = sanitizedRepository(existing.data);
        if (inspected.visibility !== visibility) throw new Error("Existing repository visibility does not match the request");
        return { schemaVersion: "release-ops-github-repository/v1", created: false, dryRun, ...inspected };
    }
    const [owner, name] = repository.split("/");
    if (dryRun) {
        const currentUser = (await github.request("/user")).data;
        if (currentUser?.login?.toLowerCase() !== owner.toLowerCase()) {
            const organization = (await github.request(`/orgs/${encodeURIComponent(owner)}`)).data;
            if (organization?.login?.toLowerCase() !== owner.toLowerCase()) throw new Error("GitHub repository owner could not be verified");
        }
        return {
            schemaVersion: "release-ops-github-repository/v1",
            created: false,
            dryRun: true,
            repository,
            owner,
            name,
            visibility,
        };
    }
    if (confirmation !== `${repository}:${visibility}`) {
        throw new Error("Creation requires --confirm owner/name:visibility");
    }
    const currentUser = (await github.request("/user")).data;
    const path = currentUser?.login?.toLowerCase() === owner.toLowerCase()
        ? "/user/repos"
        : `/orgs/${encodeURIComponent(owner)}/repos`;
    const created = await github.request(path, {
        method: "POST",
        json: { name, private: visibility === "private", has_issues: true, auto_init: initialize },
    });
    const inspected = sanitizedRepository(created.data);
    if (inspected.repository !== repository || inspected.visibility !== visibility) {
        throw new Error("GitHub created an unexpected repository");
    }
    return { schemaVersion: "release-ops-github-repository/v1", created: true, dryRun: false, ...inspected };
}

export async function listSecretMetadata({ github, repository }) {
    validateRepository(repository);
    const data = (await github.request(`/repos/${repository}/actions/secrets?per_page=100`)).data;
    if (!Array.isArray(data?.secrets)) throw new Error("GitHub returned invalid Secret metadata");
    return {
        schemaVersion: "release-ops-github-secrets/v1",
        repository,
        secrets: data.secrets.map(({ name, updated_at: updatedAt }) => ({ name, updatedAt })),
    };
}

export async function ensureDistributionReadme({ github, repository, branch, projectName }) {
    validateRepository(repository);
    if (typeof branch !== "string" || !branch) throw new Error("Distribution default branch is required");
    if (typeof projectName !== "string" || !projectName.trim()) throw new Error("Project name is required for the distribution README");
    const [, repositoryName] = repository.split("/");
    const marker = "<!-- release-ops-managed-distribution-readme:v2 -->";
    const desired = `${marker}\n# ${projectName} Releases\n\nThis repository distributes verified public release artifacts.\n\n- [Latest release](https://github.com/${repository}/releases/latest)\n- [Machine-readable latest.json](https://raw.githubusercontent.com/${repository}/${branch}/latest.json)\n\nRelease Ops manages this README and the release metadata.\n`;
    const apiPath = `/repos/${repository}/contents/README.md`;
    const existing = await github.request(`${apiPath}?ref=${encodeURIComponent(branch)}`, { allowNotFound: true });
    let current = null;
    if (existing.data?.content && existing.data?.encoding === "base64") {
        current = Buffer.from(existing.data.content.replaceAll(/\s/gu, ""), "base64").toString("utf8");
    } else if (existing.data) {
        throw new Error("GitHub returned unreadable distribution README metadata");
    }
    if (current === desired) return { schemaVersion: "release-ops-distribution-readme/v2", repository, updated: false };
    const autoInitialized = current === `# ${repositoryName}\n` || current === `# ${repositoryName}\r\n`;
    if (current !== null && !current.includes(marker) && !autoInitialized) {
        throw new Error("Distribution README is project-owned and cannot be replaced automatically");
    }
    await github.request(apiPath, {
        method: "PUT",
        json: {
            message: "docs: initialize public release repository",
            content: Buffer.from(desired, "utf8").toString("base64"),
            branch,
            ...(existing.data?.sha ? { sha: existing.data.sha } : {}),
        },
    });
    return { schemaVersion: "release-ops-distribution-readme/v2", repository, updated: true };
}

async function main() {
    const { command, args } = parsePairs(process.argv.slice(2));
    if (!command || args.has("--help") || command === "--help") {
        process.stdout.write("Usage: github-admin.mjs inspect|create|secrets --repository owner/name [options]\n");
        return;
    }
    const repository = validateRepository(required(args, "--repository"));
    const token = process.env.github_token ?? process.env.GITHUB_TOKEN;
    const github = createGitHubClient({ sourceRepository: repository, sourceToken: token });
    let result;
    if (command === "inspect") result = await inspectRepository({ github, repository });
    else if (command === "secrets") result = await listSecretMetadata({ github, repository });
    else if (command === "create") {
        result = await createRepository({
            github,
            repository,
            visibility: required(args, "--visibility"),
            confirmation: args.get("--confirm"),
            dryRun: args.has("--dry-run"),
        });
    } else throw new Error(`Unknown command: ${command}`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        process.stderr.write(`GitHub administration failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { CONFIG_SCHEMA, RELEASE_SCHEMA, loadConfig, validateConfig } from "./config.mjs";
import { createGitHubClient } from "./github-client.mjs";
import { createRepository, inspectRepository } from "./github-admin.mjs";
import { installProjectFiles } from "./project-installer.mjs";
import { BUILD_ADAPTERS, PROVIDERS, adapterById, providerChoices } from "./provider-registry.mjs";

function parseArguments(values) {
    const command = values[0] ?? "inspect";
    const result = new Map();
    for (let index = 1; index < values.length; index += 2) {
        const key = values[index];
        const value = values[index + 1];
        if (!key?.startsWith("--") || value === undefined || result.has(key)) {
            throw new Error("Arguments must use unique --name value pairs");
        }
        result.set(key, value);
    }
    return { command, args: result };
}

async function exists(path) {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

async function walk(root, maxDepth = 3, depth = 0) {
    if (depth > maxDepth) return [];
    const result = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
        if ([".git", "node_modules", "build", "dist", ".gradle"].includes(entry.name)) continue;
        const full = join(root, entry.name);
        result.push(full);
        if (entry.isDirectory()) result.push(...await walk(full, maxDepth, depth + 1));
    }
    return result;
}

function git(root, args) {
    try {
        return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
        return null;
    }
}

async function detectAdapters(root) {
    const paths = (await walk(root)).map((path) => path.replaceAll("\\", "/"));
    const names = paths.map((path) => basename(path));
    const joined = paths.join("\n").toLowerCase();
    const detected = [];
    for (const adapter of BUILD_ADAPTERS.filter(({ id }) => id !== "generic")) {
        const matched = adapter.detects.some((pattern) => {
            if (pattern.startsWith("*.")) return names.some((name) => name.endsWith(pattern.slice(1)));
            return joined.includes(pattern.toLowerCase());
        });
        if (matched) detected.push(adapter.id);
    }
    return [...new Set(detected)];
}

async function inspect(root) {
    const configPath = join(root, ".release-ops", "config.json");
    let config = null;
    let configError = null;
    if (await exists(configPath)) {
        try {
            config = await loadConfig(root);
        } catch (error) {
            configError = error.message;
        }
    }
    return {
        schemaVersion: "release-ops-inspect/v1",
        root,
        projectName: basename(root),
        adapters: await detectAdapters(root),
        git: {
            repository: git(root, ["config", "--get", "remote.origin.url"]),
            branch: git(root, ["branch", "--show-current"]),
            head: git(root, ["rev-parse", "HEAD"]),
        },
        providerChoices: providerChoices(),
        configPresent: config !== null,
        configError,
        config,
    };
}

function booleanValue(args, key, fallback = false) {
    const value = args.get(key);
    if (value === undefined) return fallback;
    if (!["true", "false"].includes(value)) throw new Error(`${key} must be true or false`);
    return value === "true";
}

function required(args, key) {
    const value = args.get(key);
    if (!value) throw new Error(`${key} is required`);
    return value;
}

function createConfig(root, args) {
    const githubEnabled = booleanValue(args, "--github");
    const visibility = githubEnabled ? required(args, "--visibility") : "none";
    const sourceRepository = githubEnabled ? required(args, "--repository") : null;
    const adapter = required(args, "--adapter");
    if (!adapterById(adapter)) throw new Error("--adapter is unsupported");
    const sentryEnabled = booleanValue(args, "--sentry");
    const publicRepository = githubEnabled && visibility === "private"
        ? required(args, "--public-repository")
        : null;
    return validateConfig({
        schemaVersion: CONFIG_SCHEMA,
        project: {
            name: args.get("--project-name") ?? basename(root),
            adapter,
        },
        build: {
            command: required(args, "--build-command"),
            requiredSecretNames: (args.get("--required-secrets") ?? "")
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean),
            artifacts: [{
                id: "primary",
                path: required(args, "--artifact-path"),
                nameTemplate: required(args, "--artifact-name"),
                contentType: args.get("--content-type") ?? "application/octet-stream",
                platform: args.get("--platform") ?? adapter,
                architecture: args.get("--architecture") ?? "any",
            }],
        },
        versioning: {
            file: required(args, "--version-file"),
            reader: args.get("--version-reader") ?? "properties",
            versionKey: required(args, "--version-key"),
            codeKey: args.get("--code-key") ?? null,
            changelogPattern: args.get("--changelog-pattern") ?? "docs/releases/v{version}.md",
            requiresChinese: booleanValue(args, "--requires-chinese"),
        },
        hosting: {
            github: {
                enabled: githubEnabled,
                sourceRepository,
                sourceVisibility: visibility,
                defaultBranch: args.get("--default-branch") ?? "main",
                releaseMode: githubEnabled ? (visibility === "private" ? "dual-repository" : "same-repository") : "local",
                publicRepository,
            },
        },
        release: {
            workflowFile: ".github/workflows/publish-release.yml",
            tagTemplate: "v{version}",
            titleTemplate: `${args.get("--project-name") ?? basename(root)} {version}`,
            manifestSchema: RELEASE_SCHEMA,
            publicReadmeSource: args.get("--public-readme-source") ?? null,
            publicReadmeTarget: args.get("--public-readme-target")
                ?? (visibility === "private" ? "README.md" : "docs/releases/README.md"),
            latestManifest: args.get("--latest-manifest") ?? "latest.json",
            latestCompatibility: args.get("--latest-compatibility") ?? "release-ops",
            minimumSupportedVersionCode: Number(args.get("--minimum-version-code") ?? "1"),
            localOutputDirectory: args.get("--local-output") ?? "dist/release-ops",
        },
        providers: {
            sentry: {
                enabled: sentryEnabled,
                schemaVersion: PROVIDERS.sentry.schemaVersion,
                organization: sentryEnabled ? required(args, "--sentry-org") : "disabled",
                project: sentryEnabled ? required(args, "--sentry-project") : "disabled",
                host: sentryEnabled ? required(args, "--sentry-host") : "disabled.invalid",
                issueSync: sentryEnabled && githubEnabled && booleanValue(args, "--sentry-issue-sync", true),
                schedule: args.get("--sentry-schedule") ?? "17 * * * *",
                releaseTemplate: args.get("--sentry-release-template") ?? "{project}@{version}",
                distTemplate: args.get("--sentry-dist-template") ?? "{versionCode}",
                debugArtifacts: [],
            },
        },
    });
}

async function verifyHosting(config, args, dryRun) {
    const hosting = config.hosting.github;
    if (!hosting.enabled) return [];
    const token = process.env.github_token ?? process.env.GITHUB_TOKEN;
    if (!token) throw new Error("github_token or GITHUB_TOKEN is required to verify GitHub hosting");
    const github = createGitHubClient({ sourceRepository: hosting.sourceRepository, sourceToken: token });
    const verify = async (repository, visibility, action, confirmation) => {
        if (action === "create") {
            return createRepository({ github, repository, visibility, confirmation, dryRun });
        }
        if (action !== "existing") throw new Error("Repository action must be existing or create");
        const result = await inspectRepository({ github, repository });
        if (result.visibility !== visibility) throw new Error(`${repository} visibility does not match ${visibility}`);
        return result;
    };
    const results = [await verify(
        hosting.sourceRepository,
        hosting.sourceVisibility,
        args.get("--repository-action") ?? "existing",
        args.get("--confirm-create"),
    )];
    if (hosting.releaseMode === "dual-repository") {
        results.push(await verify(
            hosting.publicRepository,
            "public",
            args.get("--public-repository-action") ?? "existing",
            args.get("--confirm-public-create"),
        ));
    }
    return results;
}

function adoptGitHubConfig(existing, args) {
    if (!booleanValue(args, "--github", true)) throw new Error("adopt-github requires --github true");
    const visibility = required(args, "--visibility");
    if (!["private", "public"].includes(visibility)) throw new Error("--visibility must be private or public");
    const sourceRepository = required(args, "--repository");
    const publicRepository = visibility === "private" ? required(args, "--public-repository") : null;
    return validateConfig({
        ...existing,
        hosting: {
            github: {
                enabled: true,
                sourceRepository,
                sourceVisibility: visibility,
                defaultBranch: args.get("--default-branch") ?? existing.hosting.github.defaultBranch ?? "main",
                releaseMode: visibility === "private" ? "dual-repository" : "same-repository",
                publicRepository,
            },
        },
        providers: {
            ...existing.providers,
            ...(existing.providers.sentry ? {
                sentry: {
                    ...existing.providers.sentry,
                    issueSync: existing.providers.sentry.enabled
                        && booleanValue(args, "--sentry-issue-sync", true),
                },
            } : {}),
        },
    });
}

async function main() {
    const { command, args } = parseArguments(process.argv.slice(2));
    const root = resolve(args.get("--root") ?? process.cwd());
    if (command === "inspect") {
        process.stdout.write(`${JSON.stringify(await inspect(root), null, 2)}\n`);
        return;
    }
    if (command === "audit") {
        const config = await loadConfig(root);
        let repositories = [];
        let remoteVerified = false;
        if (config.hosting.github.enabled && (process.env.github_token || process.env.GITHUB_TOKEN)) {
            const hosting = config.hosting.github;
            const github = createGitHubClient({
                sourceRepository: hosting.sourceRepository,
                sourceToken: process.env.github_token ?? process.env.GITHUB_TOKEN,
            });
            repositories = [await inspectRepository({ github, repository: hosting.sourceRepository })];
            if (hosting.releaseMode === "dual-repository") {
                repositories.push(await inspectRepository({ github, repository: hosting.publicRepository }));
            }
            remoteVerified = true;
        }
        process.stdout.write(`${JSON.stringify({ schemaVersion: "release-ops-audit/v1", success: true, remoteVerified, repositories, config }, null, 2)}\n`);
        return;
    }
    if (command === "upgrade") {
        const config = await loadConfig(root);
        const dryRun = booleanValue(args, "--dry-run", true);
        const output = { schemaVersion: "release-ops-upgrade/v1", dryRun, root, config };
        if (!dryRun) output.managedFiles = await installProjectFiles(root, config, { upgrade: true });
        process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
        return;
    }
    if (!["init", "adopt-github"].includes(command)) throw new Error(`Unknown command: ${command}`);
    if (command === "adopt-github" && !(await exists(join(root, ".release-ops", "config.json")))) {
        throw new Error("adopt-github requires an existing Release Ops configuration");
    }
    const config = command === "adopt-github"
        ? adoptGitHubConfig(await loadConfig(root), args)
        : createConfig(root, args);
    const dryRun = booleanValue(args, "--dry-run", true);
    const repositories = await verifyHosting(config, args, dryRun);
    const output = { schemaVersion: "release-ops-plan/v1", dryRun, root, config, repositories };
    if (!dryRun) {
        const repository = config.hosting.github.sourceRepository;
        if (config.hosting.github.enabled && args.get("--confirm-repository") !== repository) {
            throw new Error("--confirm-repository must match the configured GitHub repository");
        }
        const directory = join(root, ".release-ops");
        const path = join(directory, "config.json");
        if (command === "init" && await exists(path)) throw new Error("Release Ops configuration already exists; use audit, adopt-github, or upgrade");
        await mkdir(directory, { recursive: true });
        await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
        output.managedFiles = await installProjectFiles(root, config, { upgrade: command === "adopt-github" });
        output.written = path;
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
    process.stderr.write(`Release Ops failed: ${error.message}\n`);
    process.exitCode = 1;
});

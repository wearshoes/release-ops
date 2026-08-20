import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIG_SCHEMA, RELEASE_SCHEMA } from "../config.mjs";

function stackConfig({ extensionId = "generic", requiredSecretRoles = [] } = {}) {
    return {
        instanceId: "application",
        extensionId,
        configSchemaVersion: `release-ops/extension-config/${extensionId}/v1`,
        config: {
            root: ".",
            buildUnits: [{
                id: "desktop",
                target: "windows",
                runner: "windows-latest",
                command: { executable: "node", args: ["-e", "process.exit(0)"] },
                requiredSecretRoles,
                artifacts: [{
                    id: "primary",
                    path: "build/example.bin",
                    nameTemplate: "example-v{version}.bin",
                    contentType: "application/octet-stream",
                    platform: "windows",
                    architecture: "x64",
                }],
                debugArtifacts: [],
            }],
            versioning: {
                canonical: { file: "version.properties", reader: "properties", key: "VERSION" },
                buildNumbers: [{
                    id: "windows",
                    source: { file: "version.properties", reader: "properties", key: "CODE" },
                }],
                changelogPattern: "docs/v{version}.md",
                requiresChinese: false,
            },
        },
    };
}

function signingConfig() {
    return {
        instanceId: "application-signing",
        extensionId: "generic-command",
        configSchemaVersion: "release-ops/extension-config/generic-command/v1",
        config: {
            buildUnitIds: ["desktop"],
            secretNames: { credential: "SIGNING_CREDENTIAL" },
            command: { executable: "node", args: ["-e", "process.exit(0)"] },
        },
    };
}

function releaseConfig({ mode = "local" } = {}) {
    const github = mode !== "local";
    const source = github ? {
        repository: "private-owner/private-source",
        visibility: mode === "same-repository" ? "public" : "private",
        defaultBranch: "main",
    } : undefined;
    const distribution = mode === "dual-repository" ? {
        repository: "public-owner/example-releases",
        visibility: "public",
        defaultBranch: "main",
    } : mode === "same-repository" ? null : undefined;
    return {
        instanceId: "release",
        extensionId: github ? "github" : "local",
        configSchemaVersion: `release-ops/extension-config/${github ? "github" : "local"}/v1`,
        config: {
            mode,
            workflowFile: ".github/workflows/publish-release.yml",
            tagTemplate: "v{version}",
            titleTemplate: "Example {version}",
            localOutputDirectory: "dist/releases",
            ...(source ? { source } : {}),
            ...(distribution !== undefined ? { distribution } : {}),
            publicReadmeSource: "docs/public.md",
            publicReadmeTarget: mode === "dual-repository" ? "README.md" : "docs/releases/README.md",
            manifest: {
                schemaVersion: RELEASE_SCHEMA,
                assetName: "release-manifest.json",
                latestPath: "latest.json",
                compatibility: "release-ops",
                latestBuildNumberId: null,
                minimumSupportedBuildNumber: null,
            },
            dispatch: {
                versionInput: "version",
                sourceShaInput: "sourceSha",
                correlationInput: "correlation",
                buildNumberInputs: { windows: "buildNumbers" },
            },
            secretNames: mode === "dual-repository" ? {
                "source-release": "GITHUB_TOKEN",
                "distribution-release": "RELEASE_REPO_TOKEN",
            } : github ? { "source-release": "GITHUB_TOKEN" } : {},
        },
    };
}

function sentryConfig() {
    return {
        instanceId: "sentry",
        extensionId: "sentry",
        configSchemaVersion: "release-ops/extension-config/sentry/v1",
        config: {
            organization: "owner",
            project: "example",
            apiBase: "https://sentry.io/api/0",
            schedule: "17 * * * *",
            lookbackMinutes: 75,
            releaseTemplate: "application@{version}",
            debugReleaseTemplate: "application-debug@{version}",
            distTemplate: "{windows}",
            debugArtifacts: [],
            issueSync: true,
            incidentNamespace: "example-sentry",
            secretNames: {
                "project-provision": "SENTRY_PROJECT_ADMIN_TOKEN",
                "build-upload": "SENTRY_ORG_CI_TOKEN",
                "incident-read": "SENTRY_AUTH_TOKEN",
                "incident-write": "SENTRY_WRITE_TOKEN",
            },
            workflows: {
                issueFile: ".github/workflows/sentry-issues.yml",
                resolveFile: ".github/workflows/resolve-issues.yml",
                intakeCommand: { executable: "node", args: ["scripts/sentry-sync.mjs"] },
                resolveCommand: { executable: "node", args: ["scripts/sentry-resolver.mjs"] },
            },
        },
    };
}

export function baseConfig({ mode = "local", sentry = false, signing = false, stack = "generic" } = {}) {
    const requiredSecretRoles = signing ? ["credential"] : [];
    return {
        schemaVersion: CONFIG_SCHEMA,
        project: { name: "Example" },
        extensions: [
            stackConfig({ extensionId: stack, requiredSecretRoles }),
            ...(signing ? [signingConfig()] : []),
            releaseConfig({ mode }),
            ...(sentry ? [sentryConfig()] : []),
        ],
    };
}

export function answersFor(config, mode = "initialize", repositories = []) {
    return {
        schemaVersion: "release-ops/setup-answers/v1",
        mode,
        project: config.project,
        extensions: config.extensions,
        repositories,
        managedFileAdoptions: [],
    };
}

export async function fixtureRoot(prefix = "release-ops-contract-") {
    const root = await mkdtemp(join(tmpdir(), prefix));
    await mkdir(join(root, "build"));
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "build", "example.bin"), Buffer.from([1, 2, 3, 4]));
    await writeFile(join(root, "version.properties"), "VERSION=1.2.3\nCODE=9\n", "utf8");
    await writeFile(join(root, "docs", "v1.2.3.md"), "Release notes\n", "utf8");
    await writeFile(join(root, "docs", "public.md"), "# Public downloads\n", "utf8");
    return root;
}

export const SOURCE_SHA = "b".repeat(40);
export const BUILD_NUMBERS = { windows: 9 };

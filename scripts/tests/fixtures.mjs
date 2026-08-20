import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIG_SCHEMA, RELEASE_SCHEMA, validateConfig } from "../config.mjs";
import { PROVIDERS } from "../provider-registry.mjs";

export function baseConfig({ mode = "dual-repository", github = true, sentry = false, adapter = "generic" } = {}) {
    const sourceVisibility = mode === "same-repository" ? "public" : "private";
    const source = github ? {
        repository: "private-owner/private-source",
        owner: "private-owner",
        name: "private-source",
        visibility: sourceVisibility,
        defaultBranch: "main",
    } : null;
    const distribution = github && mode === "dual-repository"
        ? {
            repository: "public-owner/example-releases",
            owner: "public-owner",
            name: "example-releases",
            visibility: "public",
            defaultBranch: "main",
        }
        : null;
    return validateConfig({
        schemaVersion: CONFIG_SCHEMA,
        project: { name: "Example", adapter },
        build: {
            units: [{
                id: "desktop",
                target: "windows",
                runner: "windows-latest",
                command: { executable: "node", args: ["-e", "process.exit(0)"] },
                requiredSecretNames: [],
                artifacts: [{
                    id: "primary",
                    path: "build/example.bin",
                    nameTemplate: "example-v{version}.bin",
                    contentType: "application/octet-stream",
                    platform: "windows",
                    architecture: "x64",
                }],
            }],
        },
        versioning: {
            canonical: { file: "version.properties", reader: "properties", key: "VERSION" },
            buildNumbers: [{ id: "windows", source: { file: "version.properties", reader: "properties", key: "CODE" } }],
            changelogPattern: "docs/v{version}.md",
            requiresChinese: false,
        },
        hosting: {
            github: { enabled: github, source, distribution, releaseMode: github ? mode : "local" },
        },
        release: {
            workflowFile: ".github/workflows/publish-release.yml",
            tagTemplate: "v{version}",
            titleTemplate: "Example {version}",
            manifestSchema: RELEASE_SCHEMA,
            publicReadmeSource: "docs/public.md",
            publicReadmeTarget: mode === "dual-repository" ? "README.md" : "docs/releases/README.md",
            latestManifest: "latest.json",
            latestCompatibility: "release-ops",
            localOutputDirectory: "dist/releases",
        },
        providers: sentry ? {
            sentry: {
                enabled: true,
                schemaVersion: PROVIDERS.sentry.configSchemaVersion,
                organization: "owner",
                project: "example",
                apiBase: "https://owner.sentry.io/api/0",
                issueSync: github,
                lookbackMinutes: 75,
                schedule: "17 * * * *",
                releaseTemplate: "application@example-{version}",
                distTemplate: "{windows}",
                debugArtifacts: [],
            },
        } : {},
    });
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

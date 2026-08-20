import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditReleaseEntry } from "../release-entry.mjs";

const sha = "d".repeat(40);

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "release-ops-entry-"));
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "version.properties"), "VERSION=1.2.3\nCODE=8\n", "utf8");
    await writeFile(join(root, "docs", "v1.2.3.md"), "Release notes\n", "utf8");
    return root;
}

function config() {
    return {
        build: { requiredSecretNames: ["SIGNING_KEY"] },
        versioning: {
            file: "version.properties",
            reader: "properties",
            versionKey: "VERSION",
            codeKey: "CODE",
            changelogPattern: "docs/v{version}.md",
        },
        hosting: { github: { sourceRepository: "owner/example", defaultBranch: "main", releaseMode: "dual-repository" } },
        providers: { sentry: { enabled: true } },
    };
}

test("release entry binds a clean local HEAD to remote and Secret metadata", async () => {
    const root = await fixture();
    const gitImpl = (ignoredRoot, args) => {
        const command = args.join(" ");
        if (command === "status --porcelain") return "";
        if (command === "branch --show-current") return "main";
        if (command === "rev-parse HEAD") return sha;
        if (command.startsWith("ls-remote")) return `${sha}\trefs/heads/main`;
        throw new Error(command);
    };
    const github = {
        request: async () => ({ data: { secrets: [
            { name: "SIGNING_KEY", updated_at: "now" },
            { name: "RELEASE_REPO_TOKEN", updated_at: "now" },
            { name: "SENTRY_ORG_CI_TOKEN", updated_at: "now" },
        ] } }),
    };
    const result = await auditReleaseEntry({ config: config(), root, version: "1.2.3", versionCode: 8, github, gitImpl });
    assert.equal(result.sourceSha, sha);
});

test("release entry refuses missing Secret metadata", async () => {
    const root = await fixture();
    const gitImpl = (ignoredRoot, args) => args[0] === "status" ? "" : args[0] === "branch" ? "main" : args[0] === "rev-parse" ? sha : `${sha}\trefs/heads/main`;
    const github = { request: async () => ({ data: { secrets: [] } }) };
    await assert.rejects(
        auditReleaseEntry({ config: config(), root, version: "1.2.3", versionCode: 8, github, gitImpl }),
        /RELEASE_REPO_TOKEN.*SENTRY_ORG_CI_TOKEN.*SIGNING_KEY/u,
    );
});

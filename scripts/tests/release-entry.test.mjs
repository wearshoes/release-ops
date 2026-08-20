import assert from "node:assert/strict";
import test from "node:test";

import { auditReleaseEntry } from "../release-entry.mjs";
import { baseConfig, fixtureRoot } from "./fixtures.mjs";

const sha = "d".repeat(40);

function config() {
    return structuredClone(baseConfig({ mode: "dual-repository", sentry: true, signing: true }));
}

function gitFixture(ignoredRoot, args) {
    const command = args.join(" ");
    if (command === "status --porcelain") return "";
    if (command === "branch --show-current") return "main";
    if (command === "rev-parse HEAD") return sha;
    if (command.startsWith("ls-remote")) return `${sha}\trefs/heads/main`;
    throw new Error(command);
}

test("release entry binds canonical version/build numbers to remote HEAD and Secret metadata", async () => {
    const root = await fixtureRoot("release-ops-entry-");
    const github = { request: async () => ({ data: { secrets: [
        { name: "SIGNING_CREDENTIAL", updated_at: "now" },
        { name: "RELEASE_REPO_TOKEN", updated_at: "now" },
        { name: "SENTRY_ORG_CI_TOKEN", updated_at: "now" },
    ] } }) };
    const result = await auditReleaseEntry({ config: config(), root, version: "1.2.3", github, gitImpl: gitFixture });
    assert.equal(result.sourceSha, sha);
    assert.deepEqual(result.buildNumbers, { windows: 9 });
});

test("release entry refuses missing build and publication Secret metadata", async () => {
    const root = await fixtureRoot("release-ops-entry-missing-");
    const github = { request: async () => ({ data: { secrets: [] } }) };
    await assert.rejects(
        auditReleaseEntry({ config: config(), root, version: "1.2.3", github, gitImpl: gitFixture }),
        /RELEASE_REPO_TOKEN.*SENTRY_ORG_CI_TOKEN.*SIGNING_CREDENTIAL/u,
    );
});

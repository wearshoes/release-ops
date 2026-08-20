import assert from "node:assert/strict";
import test from "node:test";

import { createRepository, ensureDistributionReadme, inspectRepository, listSecretMetadata } from "../github-admin.mjs";

function repository(overrides = {}) {
    return {
        full_name: "wearshoes/example",
        visibility: "private",
        private: true,
        default_branch: "main",
        archived: false,
        disabled: false,
        ...overrides,
    };
}

test("inspect returns only trusted repository metadata", async () => {
    const github = { request: async () => ({ data: repository({ private_field: "ignore" }) }) };
    assert.deepEqual(await inspectRepository({ github, repository: "wearshoes/example" }), {
        schemaVersion: "release-ops-github-repository/v1",
        exists: true,
        repository: "wearshoes/example",
        owner: "wearshoes",
        name: "example",
        visibility: "private",
        defaultBranch: "main",
        archived: false,
        disabled: false,
    });
});

test("repository creation verifies visibility and exact confirmation", async () => {
    const writes = [];
    const github = {
        request: async (path, options = {}) => {
            if (path === "/repos/wearshoes/example") return { data: null };
            if (path === "/user") return { data: { login: "wearshoes" } };
            if (path === "/user/repos" && options.method === "POST") {
                writes.push(options.json);
                return { data: repository() };
            }
            throw new Error(`unexpected ${path}`);
        },
    };
    await assert.rejects(
        createRepository({ github, repository: "wearshoes/example", visibility: "private", dryRun: false }),
        /requires --confirm/u,
    );
    const result = await createRepository({
        github,
        repository: "wearshoes/example",
        visibility: "private",
        confirmation: "wearshoes/example:private",
        dryRun: false,
    });
    assert.equal(result.created, true);
    assert.deepEqual(writes, [{ name: "example", private: true, has_issues: true, auto_init: false }]);
});

test("a new public distribution repository can be initialized before managed README updates", async () => {
    const writes = [];
    const github = {
        request: async (path, options = {}) => {
            if (path === "/repos/wearshoes/example-releases") return { data: null };
            if (path === "/user") return { data: { login: "wearshoes" } };
            if (path === "/user/repos" && options.method === "POST") {
                writes.push(options.json);
                return { data: repository({ full_name: "wearshoes/example-releases", visibility: "public", private: false }) };
            }
            throw new Error(`unexpected ${path}`);
        },
    };
    await createRepository({
        github,
        repository: "wearshoes/example-releases",
        visibility: "public",
        confirmation: "wearshoes/example-releases:public",
        dryRun: false,
        initialize: true,
    });
    assert.equal(writes[0].auto_init, true);
});

test("distribution README initialization is marked, idempotent, and preserves project-owned content", async () => {
    const writes = [];
    let content = Buffer.from("# example-releases\n", "utf8").toString("base64");
    const github = { request: async (path, options = {}) => {
        if (options.method === "PUT") {
            writes.push(options.json);
            content = options.json.content;
            return { data: { content: { sha: "new" } } };
        }
        return { data: { sha: "old", encoding: "base64", content } };
    } };
    const input = { github, repository: "wearshoes/example-releases", branch: "main", projectName: "Example" };
    assert.equal((await ensureDistributionReadme(input)).updated, true);
    assert.equal((await ensureDistributionReadme(input)).updated, false);
    assert.equal(writes.length, 1);
    assert.match(Buffer.from(content, "base64").toString("utf8"), /release-ops-managed-distribution-readme:v2/u);

    const projectOwned = { request: async () => ({ data: {
        sha: "manual", encoding: "base64", content: Buffer.from("# Manual\n", "utf8").toString("base64"),
    } }) };
    await assert.rejects(ensureDistributionReadme({ ...input, github: projectOwned }), /project-owned/u);
});

test("existing repository visibility cannot be silently changed", async () => {
    const github = { request: async () => ({ data: repository({ visibility: "public", private: false }) }) };
    await assert.rejects(
        createRepository({ github, repository: "wearshoes/example", visibility: "private" }),
        /visibility does not match/u,
    );
});

test("Secret listing returns metadata but no values", async () => {
    const github = {
        request: async () => ({ data: { secrets: [{ name: "TOKEN", updated_at: "2026-08-20T00:00:00Z", value: "leak" }] } }),
    };
    const result = await listSecretMetadata({ github, repository: "wearshoes/example" });
    assert.deepEqual(result.secrets, [{ name: "TOKEN", updatedAt: "2026-08-20T00:00:00Z" }]);
    assert.doesNotMatch(JSON.stringify(result), /leak/u);
});

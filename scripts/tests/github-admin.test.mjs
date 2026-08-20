import assert from "node:assert/strict";
import test from "node:test";

import { createRepository, inspectRepository, listSecretMetadata } from "../github-admin.mjs";

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

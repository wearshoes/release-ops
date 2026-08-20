import assert from "node:assert/strict";
import test from "node:test";

import { parseArguments, provisionProject } from "../sentry-project.mjs";

function response(status, data) {
    return new Response(data === undefined ? undefined : JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function options(overrides = {}) {
    return {
        command: "create",
        org: "wearshoes",
        team: "wearshoes",
        name: "Example",
        slug: "example",
        platform: "android",
        dryRun: false,
        ...overrides,
    };
}

test("create requires an exact slug confirmation", () => {
    assert.throws(
        () => parseArguments(["create", "--org", "wearshoes", "--team", "wearshoes", "--name", "Example", "--slug", "example", "--platform", "android"]),
        /--confirm-slug/u,
    );
    assert.equal(
        parseArguments(["create", "--org", "wearshoes", "--team", "wearshoes", "--name", "Example", "--slug", "example", "--platform", "android", "--confirm-slug", "example"]).slug,
        "example",
    );
});

test("project provisioning accepts only HTTPS apiBase endpoints", () => {
    const common = ["inspect", "--org", "wearshoes", "--team", "wearshoes", "--slug", "example"];
    assert.equal(parseArguments([...common, "--api-base", "https://self.example/api/0"]).apiBase, "https://self.example/api/0");
    assert.throws(() => parseArguments([...common, "--api-base", "http://self.example/api/0"]), /HTTPS/u);
});

test("dry-run validates the team and plans without a POST", async () => {
    const calls = [];
    const fetchImpl = async (url, request) => {
        calls.push({ url: url.toString(), method: request.method });
        if (url.pathname.endsWith("/teams/wearshoes/wearshoes/")) return response(200, { slug: "wearshoes" });
        if (url.pathname.endsWith("/projects/wearshoes/example/")) return response(404, { detail: "not found" });
        throw new Error("unexpected request");
    };
    const result = await provisionProject(options({ dryRun: true }), {
        token: "secret-token",
        fetchImpl,
        baseUrl: "https://sentry.test/api/0/",
    });
    assert.equal(result.wouldCreate, true);
    assert.equal(calls.some((call) => call.method === "POST"), false);
});

test("create posts once and returns only the public DSN", async () => {
    const writes = [];
    const fetchImpl = async (url, request) => {
        if (url.pathname.endsWith("/teams/wearshoes/wearshoes/")) return response(200, { slug: "wearshoes" });
        if (url.pathname.endsWith("/projects/wearshoes/example/") && request.method === "GET") return response(404, {});
        if (url.pathname.endsWith("/teams/wearshoes/wearshoes/projects/") && request.method === "POST") {
            writes.push(JSON.parse(request.body));
            return response(201, { slug: "example", name: "Example", platform: "android", organization: { slug: "wearshoes" }, team: { slug: "wearshoes" } });
        }
        if (url.pathname.endsWith("/projects/wearshoes/example/keys/")) {
            return response(200, [{ dsn: { public: "https://public@example.ingest.sentry.io/123", secret: "must-not-return" } }]);
        }
        throw new Error(`unexpected request ${url}`);
    };
    const result = await provisionProject(options(), {
        token: "secret-token",
        fetchImpl,
        baseUrl: "https://sentry.test/api/0/",
    });
    assert.equal(result.created, true);
    assert.equal(result.publicDsn, "https://public@example.ingest.sentry.io/123");
    assert.deepEqual(writes, [{ name: "Example", slug: "example", platform: "android", default_rules: true }]);
    assert.doesNotMatch(JSON.stringify(result), /secret-token|must-not-return/u);
});

test("existing project is idempotent and is not created again", async () => {
    let posts = 0;
    const fetchImpl = async (url, request) => {
        if (request.method === "POST") posts += 1;
        if (url.pathname.endsWith("/teams/wearshoes/wearshoes/")) return response(200, { slug: "wearshoes" });
        if (url.pathname.endsWith("/projects/wearshoes/example/")) return response(200, { slug: "example", name: "Example", platform: "android" });
        if (url.pathname.endsWith("/projects/wearshoes/example/keys/")) return response(200, []);
        throw new Error("unexpected request");
    };
    const result = await provisionProject(options(), {
        token: "secret-token",
        fetchImpl,
        baseUrl: "https://sentry.test/api/0/",
    });
    assert.equal(posts, 0);
    assert.equal(result.existed, true);
});

test("API errors do not expose response bodies or tokens", async () => {
    const fetchImpl = async () => response(403, { detail: "private server response" });
    await assert.rejects(
        provisionProject(options({ dryRun: true }), {
            token: "secret-token",
            fetchImpl,
            baseUrl: "https://sentry.test/api/0/",
        }),
        (error) => {
            assert.match(error.message, /HTTP 403/u);
            assert.doesNotMatch(error.message, /private server response|secret-token/u);
            return true;
        },
    );
});

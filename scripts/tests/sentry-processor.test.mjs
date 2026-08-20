import assert from "node:assert/strict";
import test from "node:test";

import { createKernelApi } from "../kernel-api.mjs";
import { renderIncident, sanitizeIncident } from "../processors/sentry-lifecycle.mjs";
import { debugArtifactsProcessor, resolveProcessor, scheduledIngestProcessor } from "../processors/sentry.mjs";
import { baseConfig, BUILD_NUMBERS, fixtureRoot, SOURCE_SHA } from "./fixtures.mjs";

function sentryInstance(config) {
    return config.extensions.find(({ instanceId }) => instanceId === "sentry");
}

function group(status = "unresolved") {
    return {
        id: "1234",
        shortId: "EXAMPLE-1",
        permalink: "https://sentry.io/issues/1234/?query=private",
        status,
        level: "error",
        firstSeen: "2026-08-20T00:00:00Z",
        lastSeen: "2026-08-20T01:00:00Z",
        count: "3",
        project: { slug: "example" },
        metadata: { type: "TypeError", value: "private prompt" },
    };
}

function event() {
    return {
        eventID: "event-1",
        environment: "production",
        release: { version: "application@1.2.3" },
        user: { email: "private@example.test" },
        request: { data: "private body" },
        exception: { values: [{
            type: "TypeError",
            value: "private prompt",
            stacktrace: { frames: [{
                inApp: true,
                module: "app.reader",
                function: "load",
                filename: "C:/private/src/Reader.ts",
                lineNo: 12,
                vars: { token: "github_pat_secret" },
            }] },
        }] },
    };
}

function json(data, status = 200, headers = {}) {
    return status === 204
        ? new Response(null, { status, headers })
        : new Response(JSON.stringify(data), { status, headers });
}

function processorNode({ id, commands = [], roles = [], origins = [] }) {
    return {
        id: `sentry:${id}`,
        instanceId: "sentry",
        permissions: { commands, networkOrigins: origins, outputRoots: [] },
        secretRoles: roles,
    };
}

test("debug artifact processor uploads Proguard through shell:false with only the build role", async () => {
    const root = await fixtureRoot("release-ops-sentry-processor-");
    const config = baseConfig({ mode: "dual-repository", sentry: true });
    const instance = sentryInstance(config);
    instance.config.debugArtifacts = [{ type: "proguard", path: "build/example.bin", buildUnitId: "desktop" }];
    const calls = [];
    const api = createKernelApi({
        root,
        node: processorNode({
            id: "debug",
            commands: [{ id: "sentry-cli", executable: "sentry-cli" }],
            roles: [{ role: "build-upload", required: true, defaultName: "SENTRY_ORG_CI_TOKEN" }],
        }),
        secretNames: instance.config.secretNames,
        secretValues: { "build-upload": "ci-value" },
        execFileImpl: async (...args) => { calls.push(args); return { stdout: "" }; },
    });
    const result = await debugArtifactsProcessor({
        api,
        config,
        instance,
        arguments: ["desktop", "1.2.3", JSON.stringify(BUILD_NUMBERS), SOURCE_SHA],
        execute: true,
    });
    assert.equal(result.commandCount, 1);
    assert.equal(calls[0][0], "sentry-cli");
    assert.equal(calls[0][2].shell, false);
    assert.equal(calls[0][2].env.SENTRY_AUTH_TOKEN, "ci-value");
    assert.equal(calls[0][2].env.SENTRY_ORG_CI_TOKEN, undefined);
    assert.equal(calls[0][2].env.SENTRY_URL, "https://sentry.io");
});

test("scheduled ingest uses the 75-minute window and writes only sanitized issue data", async () => {
    const config = baseConfig({ mode: "dual-repository", sentry: true });
    const instance = sentryInstance(config);
    const calls = [];
    const writes = [];
    const api = createKernelApi({
        root: process.cwd(),
        node: processorNode({
            id: "ingest",
            roles: [
                { role: "github-token", required: false, defaultName: "GITHUB_TOKEN" },
                { role: "incident-read", required: true, defaultName: "SENTRY_AUTH_TOKEN" },
            ],
            origins: ["https://sentry.io", "https://api.github.com"],
        }),
        secretValues: { "github-token": "github", "incident-read": "read" },
        fetchImpl: async (url, options) => {
            calls.push(String(url));
            const path = `${url.pathname}${url.search}`;
            if (url.origin === "https://api.github.com" && path.includes("/labels?")) {
                return json([{ name: "sentry" }, { name: "automated-error" }]);
            }
            if (url.origin === "https://api.github.com" && path.includes("/issues?")) return json([]);
            if (url.origin === "https://api.github.com" && path.endsWith("/issues") && options.method === "POST") {
                writes.push(JSON.parse(options.body));
                return json({ number: 1 }, 201);
            }
            if (url.origin === "https://sentry.io" && path.includes("/organizations/owner/issues/?")) return json([group()]);
            if (url.origin === "https://sentry.io" && path.endsWith("/issues/1234/events/latest/")) return json(event());
            throw new Error(`Unexpected ${options.method} ${url}`);
        },
    });
    const result = await scheduledIngestProcessor({ api, config, instance, execute: true });
    assert.equal(result.created, 1);
    assert.equal(calls.some((value) => value.includes("statsPeriod=75m")), true);
    const rendered = JSON.stringify(writes[0]);
    assert.match(rendered, /release-ops-sentry:v2/u);
    assert.doesNotMatch(rendered, /private prompt|private@example|private body|github_pat|C:\/private/iu);
});

test("resolver prevalidates trailers and closes an explicitly bound ordinary Issue", async () => {
    const config = baseConfig({ mode: "dual-repository", sentry: true });
    const instance = sentryInstance(config);
    const writes = [];
    const execFileImpl = async (executable, args) => {
        assert.equal(executable, "git");
        if (args[0] === "rev-list") return { stdout: `${SOURCE_SHA}\n` };
        if (args[0] === "show") return { stdout: "fix: ordinary\n\nIssues: #7\nCommit-ID: HEAD\n" };
        if (args[0] === "merge-base") return { stdout: "" };
        throw new Error(`Unexpected git command ${args.join(" ")}`);
    };
    const api = createKernelApi({
        root: process.cwd(),
        node: processorNode({
            id: "resolve",
            commands: [{ id: "git", executable: "git" }],
            roles: [
                { role: "github-token", required: false, defaultName: "GITHUB_TOKEN" },
                { role: "incident-read", required: true, defaultName: "SENTRY_AUTH_TOKEN" },
                { role: "incident-write", required: true, defaultName: "SENTRY_WRITE_TOKEN" },
            ],
            origins: ["https://sentry.io", "https://api.github.com"],
        }),
        secretValues: { "github-token": "github", "incident-read": "read", "incident-write": "write" },
        execFileImpl,
        fetchImpl: async (url, options) => {
            if (options.method === "GET" && url.pathname.endsWith("/issues/7")) {
                return json({ number: 7, body: "Ordinary Issue", labels: [], state: "open" });
            }
            writes.push({ path: url.pathname, method: options.method, body: options.body ? JSON.parse(options.body) : null });
            return json({}, options.method === "POST" ? 201 : 200);
        },
    });
    const result = await resolveProcessor({
        api, config, instance, arguments: ["0".repeat(40), SOURCE_SHA], execute: true,
    });
    assert.equal(result.success, true);
    assert.deepEqual(writes.map(({ method }) => method), ["POST", "PATCH"]);
    assert.match(writes[0].body.body, new RegExp(SOURCE_SHA, "u"));
});

test("resolver does not replay a Sentry PUT after an unresolved start marker", async () => {
    const config = baseConfig({ mode: "dual-repository", sentry: true });
    const instance = sentryInstance(config);
    const incident = sanitizeIncident(group(), event(), { project: "example", host: "sentry.io" });
    const issue = {
        number: 7,
        state: "open",
        ...renderIncident(incident),
        labels: [{ name: "sentry" }, { name: "automated-error" }],
    };
    let sentryWrites = 0;
    const api = createKernelApi({
        root: process.cwd(),
        node: processorNode({
            id: "resolve",
            commands: [{ id: "git", executable: "git" }],
            roles: [
                { role: "github-token", required: false, defaultName: "GITHUB_TOKEN" },
                { role: "incident-read", required: true, defaultName: "SENTRY_AUTH_TOKEN" },
                { role: "incident-write", required: true, defaultName: "SENTRY_WRITE_TOKEN" },
            ],
            origins: ["https://sentry.io", "https://api.github.com"],
        }),
        secretValues: { "github-token": "github", "incident-read": "read", "incident-write": "write" },
        execFileImpl: async (executable, args) => {
            if (args[0] === "rev-list") return { stdout: `${SOURCE_SHA}\n` };
            if (args[0] === "show") return { stdout: "fix: incident\n\nIssues: #7\nCommit-ID: HEAD\n" };
            return { stdout: "" };
        },
        fetchImpl: async (url, options) => {
            const path = `${url.pathname}${url.search}`;
            if (url.origin === "https://api.github.com" && options.method === "GET" && url.pathname.endsWith("/issues/7")) return json(issue);
            if (url.origin === "https://api.github.com" && path.endsWith("/comments?per_page=100")) {
                return json([{ body: `<!-- release-ops-sentry-resolve:v2 issue_id=1234 commit=${SOURCE_SHA} state=start -->` }]);
            }
            if (url.origin === "https://sentry.io" && path.endsWith("/organizations/owner/issues/1234/")) return json(group());
            if (url.origin === "https://sentry.io" && path.endsWith("/issues/1234/events/latest/")) return json(event());
            if (url.origin === "https://sentry.io" && options.method === "PUT") sentryWrites += 1;
            return json({});
        },
    });
    await assert.rejects(resolveProcessor({
        api, config, instance, arguments: ["0".repeat(40), SOURCE_SHA], execute: true,
    }), /Issue resolution failed/u);
    assert.equal(sentryWrites, 0);
});

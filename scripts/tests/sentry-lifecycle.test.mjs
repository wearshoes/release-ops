import assert from "node:assert/strict";
import test from "node:test";

import { PROVIDERS } from "../provider-registry.mjs";
import { applyResolutions, planResolutions } from "../sentry-resolver.mjs";
import { renderIncident, sanitizeSentryIncident, syncSentryIncidents } from "../sentry-incidents.mjs";

function config() {
    return {
        hosting: { github: { enabled: true, sourceRepository: "owner/example" } },
        providers: {
            sentry: {
                enabled: true,
                issueSync: true,
                schemaVersion: PROVIDERS.sentry.schemaVersion,
                organization: "owner",
                project: "example",
                host: "owner.sentry.io",
            },
        },
    };
}

function group() {
    return {
        id: "1234",
        shortId: "EXAMPLE-1",
        permalink: "https://owner.sentry.io/issues/1234/?query=private",
        status: "unresolved",
        level: "error",
        firstSeen: "2026-08-20T00:00:00Z",
        lastSeen: "2026-08-20T01:00:00Z",
        count: "3",
        metadata: { type: "TypeError", value: "secret prompt" },
    };
}

function event() {
    return {
        eventID: "event-1",
        environment: "production",
        release: { version: "example@1.0.0" },
        user: { email: "private@example.test" },
        request: { data: "private body" },
        exception: { values: [{
            type: "TypeError",
            value: "secret prompt",
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

test("sanitizer excludes messages, user, request, locals, and source paths", () => {
    const incident = sanitizeSentryIncident(group(), event(), { project: "example", host: "owner.sentry.io" });
    const rendered = JSON.stringify(renderIncident(incident));
    assert.doesNotMatch(rendered, /secret prompt|private@example|private body|github_pat|C:\/private/iu);
    assert.match(rendered, /Reader\.ts/u);
});

test("sync creates one fixed-schema Issue without raw event content", async () => {
    const writes = [];
    const sentry = {
        request: async (path) => path.includes("events/latest") ? { data: event() } : { data: [group()] },
    };
    const github = {
        request: async (path, options = {}) => {
            if (path.includes("/labels?")) return { data: [{ name: "sentry" }, { name: "automated-error" }] };
            if (path.includes("/issues?")) return { data: [] };
            if (options.method === "POST") {
                writes.push(options.json);
                return { data: { number: 1 } };
            }
            throw new Error(`unexpected ${path}`);
        },
    };
    const result = await syncSentryIncidents({ config: config(), sentry, github });
    assert.equal(result.created, 1);
    assert.equal(writes.length, 1);
    assert.match(writes[0].body, /release-ops-sentry:v1/u);
    assert.doesNotMatch(writes[0].body, /secret prompt|private@example|github_pat/iu);
});

test("resolver writes Sentry before commenting and closing GitHub", async () => {
    const incident = sanitizeSentryIncident(group(), event(), { project: "example", host: "owner.sentry.io" });
    const rendered = renderIncident(incident);
    const issue = {
        number: 7,
        state: "open",
        title: rendered.title,
        body: rendered.body,
        html_url: "https://github.com/owner/example/issues/7",
        labels: [{ name: "sentry" }, { name: "automated-error" }],
    };
    const order = [];
    const github = {
        request: async (path, options = {}) => {
            if (options.method === undefined) return { data: issue };
            order.push(path.endsWith("/comments") ? "comment" : "close");
            return { data: {} };
        },
    };
    const sentryRead = {
        request: async (path) => path.includes("events/latest")
            ? { data: event() }
            : { data: { id: "1234", project: { slug: "example" } } },
    };
    const sentryWrite = { request: async () => { order.push("sentry"); return { data: { status: "resolved" } }; } };
    const result = await applyResolutions({
        config: config(),
        bindings: [{ issueNumber: 7, commitSha: "e".repeat(40), subject: "fix: reader" }],
        github,
        sentryRead,
        sentryWrite,
    });
    assert.equal(result.success, true);
    assert.deepEqual(order, ["sentry", "comment", "close"]);
});

test("commit trailers bind multiple Issues and reject duplicates before writes", () => {
    const sha = "f".repeat(40);
    const eventPayload = {
        after: sha,
        commits: [{ id: sha, message: "fix: two incidents\n\nIssues: #7 #12\nCommit-ID: HEAD" }],
    };
    assert.deepEqual(planResolutions(eventPayload, () => true).map(({ issueNumber }) => issueNumber), [7, 12]);
    eventPayload.commits.push({ id: "a".repeat(40), message: `fix: duplicate\n\nIssues: #7\nCommit-ID: ${sha}` });
    assert.throws(() => planResolutions(eventPayload, () => true), /only once/u);
});

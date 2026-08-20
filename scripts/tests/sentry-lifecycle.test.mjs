import assert from "node:assert/strict";
import test from "node:test";

import { createSentryClient } from "../sentry-client.mjs";
import { renderIncident, resolveSentryIncident, sanitizeSentryIncident, syncSentryIncidents } from "../sentry-incidents.mjs";
import { applyResolutions, planResolutions } from "../sentry-resolver.mjs";
import { baseConfig } from "./fixtures.mjs";

function config() {
    return baseConfig({ mode: "dual-repository", sentry: true });
}

function group(status = "unresolved") {
    return {
        id: "1234", shortId: "EXAMPLE-1", permalink: "https://sentry.io/issues/1234/?query=private",
        status, level: "error", firstSeen: "2026-08-20T00:00:00Z", lastSeen: "2026-08-20T01:00:00Z",
        count: "3", project: { slug: "example" }, metadata: { type: "TypeError", value: "secret prompt" },
    };
}

function event() {
    return {
        eventID: "event-1", environment: "production", release: { version: "example@1.0.0" },
        user: { email: "private@example.test" }, request: { data: "private body" },
        exception: { values: [{
            type: "TypeError", value: "secret prompt",
            stacktrace: { frames: [{ inApp: true, module: "app.reader", function: "load", filename: "C:/private/src/Reader.ts", lineNo: 12, vars: { token: "github_pat_secret" } }] },
        }] },
    };
}

test("sanitizer excludes messages, user, request, locals, and source paths", () => {
    const incident = sanitizeSentryIncident(group(), event(), { project: "example", host: "sentry.io" });
    const rendered = JSON.stringify(renderIncident(incident));
    assert.doesNotMatch(rendered, /secret prompt|private@example|private body|github_pat|C:\/private/iu);
    assert.match(rendered, /Reader\.ts/u);
    assert.match(rendered, /release-ops-sentry:v2/u);
});

test("Sentry pagination follows only rel=next results=true links", async () => {
    const calls = [];
    const client = createSentryClient({
        token: "not-logged",
        apiBase: "https://owner.sentry.io/api/0",
        fetchImpl: async (url) => {
            calls.push(String(url));
            const second = String(url).includes("cursor=two");
            return new Response(JSON.stringify(second ? [{ id: 2 }] : [{ id: 1 }]), {
                status: 200,
                headers: second ? {} : { Link: '<https://owner.sentry.io/api/0/issues/?cursor=two>; rel="next"; results="true"' },
            });
        },
    });
    assert.deepEqual(await client.paginate("/issues/"), [{ id: 1 }, { id: 2 }]);
    assert.equal(calls.length, 2);
});

test("sync uses a 75-minute overlap and creates one fixed-schema Issue", async () => {
    const writes = [];
    let requestedPath = "";
    const sentry = {
        paginate: async (path) => { requestedPath = path; return [group()]; },
        request: async (path) => path.includes("events/latest") ? { data: event() } : { data: group() },
    };
    const github = {
        request: async (path, options = {}) => {
            if (path.includes("/labels?")) return { data: [{ name: "sentry" }, { name: "automated-error" }] };
            if (path.includes("/issues?")) return { data: [] };
            if (options.method === "POST") { writes.push(options.json); return { data: { number: 1 } }; }
            throw new Error(`unexpected ${path}`);
        },
    };
    const result = await syncSentryIncidents({ config: config(), sentry, github });
    assert.match(requestedPath, /statsPeriod=75m/u);
    assert.equal(result.created, 1);
    assert.match(writes[0].body, /release-ops-sentry:v2/u);
    assert.doesNotMatch(writes[0].body, /secret prompt|private@example|github_pat/iu);
});

test("resolver records start/applied markers around the non-replayed Sentry write", async () => {
    const incident = sanitizeSentryIncident(group(), event(), { project: "example", host: "sentry.io" });
    const issue = { number: 7, state: "open", ...renderIncident(incident), labels: [{ name: "sentry" }, { name: "automated-error" }] };
    const order = [];
    const github = {
        request: async (path, options = {}) => {
            if (path.endsWith("comments?per_page=100")) return { data: [] };
            if (options.method === undefined) return { data: issue };
            if (path.endsWith("/comments")) {
                const body = options.json.body;
                order.push(body.includes("state=start") ? "start" : body.includes("state=applied") ? "applied" : "resolved-comment");
            } else order.push("close");
            return { data: {} };
        },
    };
    const sentryRead = { request: async (path) => path.includes("events/latest") ? { data: event() } : { data: group() } };
    const sentryWrite = { request: async () => { order.push("sentry"); return { data: { status: "resolved" } }; } };
    const result = await applyResolutions({
        config: config(), bindings: [{ issueNumber: 7, commitSha: "e".repeat(40), subject: "fix: reader" }], github, sentryRead, sentryWrite,
    });
    assert.equal(result.success, true);
    assert.deepEqual(order, ["start", "sentry", "applied", "resolved-comment", "close"]);
});

test("an unresolved start marker blocks replay of an uncertain Sentry PUT", async () => {
    const incident = sanitizeSentryIncident(group(), event(), { project: "example", host: "sentry.io" });
    const issue = { number: 7, ...renderIncident(incident) };
    let writes = 0;
    const github = { request: async (path) => path.endsWith("comments?per_page=100")
        ? { data: [{ body: `<!-- release-ops-sentry-resolve:v2 issue_id=1234 commit=${"e".repeat(40)} state=start -->` }] }
        : { data: {} } };
    await assert.rejects(resolveSentryIncident({
        config: config(), issue, commitSha: "e".repeat(40), github,
        sentryRead: { request: async (path) => path.includes("events/latest") ? { data: event() } : { data: group("unresolved") } },
        sentryWrite: { request: async () => { writes += 1; } },
    }), /SENTRY_WRITE_UNCERTAIN/u);
    assert.equal(writes, 0);
});

test("commit trailers bind multiple Issues and reject duplicates before writes", () => {
    const sha = "f".repeat(40);
    const payload = { after: sha, commits: [{ id: sha, message: "fix: two incidents\n\nIssues: #7 #12\nCommit-ID: HEAD" }] };
    assert.deepEqual(planResolutions(payload, () => true).map(({ issueNumber }) => issueNumber), [7, 12]);
    payload.commits.push({ id: "a".repeat(40), message: `fix: duplicate\n\nIssues: #7\nCommit-ID: ${sha}` });
    assert.throws(() => planResolutions(payload, () => true), /only once/u);
});

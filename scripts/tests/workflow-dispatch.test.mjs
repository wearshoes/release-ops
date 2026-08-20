import assert from "node:assert/strict";
import test from "node:test";

import { CONFIG_SCHEMA, RELEASE_SCHEMA } from "../config.mjs";
import { dispatchRelease, releaseRunTitle } from "../dispatch-release.mjs";
import { PROVIDERS } from "../provider-registry.mjs";

const sha = "a".repeat(40);
const correlation = "11111111-2222-4333-8444-555555555555";

function config() {
    return {
        schemaVersion: CONFIG_SCHEMA,
        project: { name: "Example", adapter: "generic" },
        build: { units: [] },
        versioning: {},
        hosting: { github: { enabled: true, source: { repository: "owner/example", defaultBranch: "trunk" } } },
        release: { workflowFile: ".github/workflows/publish-release.yml", manifestSchema: RELEASE_SCHEMA },
        providers: { sentry: { schemaVersion: PROVIDERS.sentry.configSchemaVersion, enabled: false } },
    };
}

function run(id, title) {
    return {
        id,
        event: "workflow_dispatch",
        head_branch: "trunk",
        html_url: `https://github.com/owner/example/actions/runs/${id}`,
        display_title: title,
        status: "completed",
        conclusion: "success",
    };
}

test("dispatch uses a returned fixed run id", async () => {
    const title = releaseRunTitle("1.2.3", sha, correlation);
    const calls = [];
    const github = {
        request: async (path, options = {}) => {
            calls.push({ path, options });
            if (path.endsWith("/dispatches")) return { data: { workflow_run_id: 41 } };
            if (path.endsWith("/actions/runs/41")) return { data: run(41, title) };
            throw new Error(`unexpected ${path}`);
        },
    };
    const result = await dispatchRelease({
        github,
        config: config(),
        version: "1.2.3",
        buildNumbers: { android: 7 },
        sourceSha: sha,
        correlation,
        sleep: async () => {},
    });
    assert.equal(result.runId, 41);
    assert.equal(calls.filter(({ options }) => options.method === "POST").length, 1);
    const dispatch = calls.find(({ options }) => options.method === "POST");
    assert.equal(dispatch.options.json.inputs.version, "1.2.3");
    assert.equal(Object.hasOwn(dispatch.options.json.inputs, "versionName"), false);
});

test("ambiguous dispatch adopts one correlated run without resending", async () => {
    const title = releaseRunTitle("1.2.3", sha, correlation);
    let posts = 0;
    const github = {
        request: async (path, options = {}) => {
            if (options.method === "POST") {
                posts += 1;
                throw new Error("network ended before a response");
            }
            if (path.includes("/runs?")) return { data: { workflow_runs: [run(52, title)] } };
            throw new Error(`unexpected ${path}`);
        },
    };
    const result = await dispatchRelease({
        github,
        config: config(),
        version: "1.2.3",
        buildNumbers: { android: 7 },
        sourceSha: sha,
        correlation,
        sleep: async () => {},
    });
    assert.equal(result.runId, 52);
    assert.equal(posts, 1);
});

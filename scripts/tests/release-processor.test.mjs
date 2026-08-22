import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createKernelApi } from "../kernel-api.mjs";
import { planReleaseProcessor, preflightProcessor, publishProcessor } from "../processors/release.mjs";
import { baseConfig, BUILD_NUMBERS, fixtureRoot, SOURCE_SHA } from "./fixtures.mjs";

function releaseInstance(config) {
    return config.extensions.find(({ instanceId }) => instanceId === "release");
}

test("local release processor writes artifacts and the standard manifest through Kernel output", async () => {
    const root = await fixtureRoot("release-ops-local-processor-");
    const config = baseConfig();
    const instance = releaseInstance(config);
    const node = {
        id: "release:publish",
        instanceId: "release",
        permissions: { commands: [], networkOrigins: [], outputRoots: [instance.config.localOutputDirectory] },
        secretRoles: [],
    };
    const result = await publishProcessor({
        api: createKernelApi({ root, node }),
        config,
        instance,
        arguments: ["1.2.3", JSON.stringify(BUILD_NUMBERS), SOURCE_SHA, "local-correlation"],
        execute: true,
    });
    const outputRoot = join(root, "dist", "releases", "v1.2.3");
    assert.deepEqual(await readFile(join(outputRoot, "example-v1.2.3.bin")), Buffer.from([1, 2, 3, 4]));
    const manifest = JSON.parse(await readFile(join(outputRoot, "release-manifest.json"), "utf8"));
    assert.equal(manifest.schemaVersion, "release-ops/release-manifest/v1");
    assert.equal(manifest.artifacts[0].sha256, "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a");
    assert.equal(result.outputRoot, "dist/releases/v1.2.3");
    assert.equal(await readFile(join(outputRoot, "CHANGELOG.md"), "utf8"), "Release notes\n");
});

test("same-repository workflow does not expose the optional distribution Secret", () => {
    const config = baseConfig({ mode: "same-repository" });
    const instance = releaseInstance(config);
    const workflows = [];
    const graph = {
        order: ["application:build", "release:publish"],
        buildUnitOwners: { desktop: "application" },
        nodes: [
            { id: "application:build", instanceId: "application", stage: "build", secretRoles: [] },
            {
                id: "release:publish",
                instanceId: "release",
                stage: "publish-finalize",
                secretRoles: [
                    { role: "source-release", required: true, defaultName: "GITHUB_TOKEN" },
                    { role: "distribution-release", required: false, defaultName: "RELEASE_REPO_TOKEN" },
                ],
            },
        ],
    };
    planReleaseProcessor({ api: { addWorkflow: (value) => workflows.push(value) }, config, graph, instance });
    const publishStep = workflows[0].model.jobs.publish.steps.at(-1);
    assert.deepEqual(publishStep.secretRoles, { "source-release": "GITHUB_TOKEN" });
});

test("single build unit publishes in one job without Actions artifact storage", () => {
    const config = baseConfig({ mode: "dual-repository" });
    const instance = releaseInstance(config);
    const workflows = [];
    const graph = {
        order: ["application:build", "release:publish"],
        buildUnitOwners: { desktop: "application" },
        nodes: [
            { id: "application:build", instanceId: "application", stage: "build", secretRoles: [] },
            {
                id: "release:publish",
                instanceId: "release",
                stage: "publish-finalize",
                secretRoles: [
                    { role: "source-release", required: true, defaultName: "GITHUB_TOKEN" },
                    { role: "distribution-release", required: false, defaultName: "RELEASE_REPO_TOKEN" },
                ],
            },
        ],
    };

    planReleaseProcessor({ api: { addWorkflow: (value) => workflows.push(value) }, config, graph, instance });

    const jobs = workflows[0].model.jobs;
    assert.deepEqual(Object.keys(jobs), ["publish"]);
    assert.equal(jobs.publish["runs-on"], "windows-latest");
    assert.equal(jobs.publish.needs, undefined);
    assert.deepEqual(
        jobs.publish.steps.filter(({ processor }) => processor).map(({ processor }) => processor),
        ["application:build", "release:publish"],
    );
    assert.equal(jobs.publish.steps.some(({ uses }) => /actions\/(?:upload|download)-artifact@/u.test(uses ?? "")), false);
});

test("GitHub processor publishes the same bytes to private and public drafts through role-scoped HTTPS", async () => {
    const root = await fixtureRoot("release-ops-github-processor-");
    const config = baseConfig({ mode: "dual-repository" });
    const instance = releaseInstance(config);
    const releases = new Map();
    const uploads = [];
    const calls = [];
    let nextId = 1;
    const api = createKernelApi({
        root,
        node: {
            id: "release:publish",
            instanceId: "release",
            permissions: {
                commands: [], outputRoots: [], networkOrigins: ["https://api.github.com", "https://uploads.github.com"],
            },
            secretRoles: [
                { role: "source-release", required: true, defaultName: "GITHUB_TOKEN" },
                { role: "distribution-release", required: false, defaultName: "RELEASE_REPO_TOKEN" },
            ],
        },
        secretNames: instance.config.secretNames,
        secretValues: { "source-release": "source-role", "distribution-release": "distribution-role" },
        fetchImpl: async (url, options) => {
            const path = `${url.pathname}${url.search}`;
            const repository = /^\/repos\/([^/]+\/[^/]+)/u.exec(path)?.[1];
            calls.push({ origin: url.origin, path, method: options.method, authorization: options.headers.get("authorization") });
            if (path.includes("/releases/tags/")) return new Response(null, { status: 404 });
            if (/\/releases\?per_page=100$/u.test(path)) return new Response("[]", { status: 200 });
            if (/\/releases$/u.test(path) && options.method === "POST") {
                const payload = JSON.parse(options.body);
                const release = {
                    id: nextId++, ...payload, assets: [],
                    html_url: `https://github.com/${repository}/releases/tag/${payload.tag_name}`,
                };
                releases.set(repository, release);
                return new Response(JSON.stringify(release), { status: 201 });
            }
            if (url.origin === "https://uploads.github.com" && path.includes("/assets?name=")) {
                uploads.push({
                    repository,
                    name: decodeURIComponent(path.split("name=")[1]),
                    body: Buffer.from(options.body),
                    authorization: options.headers.get("authorization"),
                });
                return new Response("{}", { status: 201 });
            }
            if (path.includes("/contents/") && options.method === "GET") return new Response(null, { status: 404 });
            if (path.includes("/contents/") && options.method === "PUT") return new Response("{}", { status: 200 });
            if (/\/releases\/\d+$/u.test(path) && options.method === "PATCH") {
                const release = releases.get(repository);
                release.draft = false;
                return new Response(JSON.stringify(release), { status: 200 });
            }
            throw new Error(`Unexpected ${options.method} ${url}`);
        },
    });
    const result = await publishProcessor({
        api,
        config,
        instance,
        arguments: ["1.2.3", JSON.stringify(BUILD_NUMBERS), SOURCE_SHA, "11111111-2222-4333-8444-555555555555"],
        execute: true,
    });
    const binaries = uploads.filter(({ name }) => name.endsWith(".bin"));
    assert.equal(binaries.length, 2);
    assert.deepEqual(binaries[0].body, binaries[1].body);
    assert.deepEqual(binaries.map(({ authorization }) => authorization), ["Bearer source-role", "Bearer distribution-role"]);
    assert.equal(result.manifest.schemaVersion, "release-ops/release-manifest/v1");
    assert.doesNotMatch(JSON.stringify(result.manifest), /private-owner|private-source|bbbbbbbb|correlation/iu);
    assert.deepEqual(calls.filter(({ method, path }) => method === "PATCH" && /\/releases\/\d+$/u.test(path))
        .map(({ path }) => path.split("/").slice(2, 4).join("/")), [
        "private-owner/private-source", "public-owner/example-releases",
    ]);
});

test("GitHub preflight dispatches once and fixes the uniquely correlated run id", async () => {
    const config = baseConfig({ mode: "dual-repository" });
    const instance = releaseInstance(config);
    const correlation = "11111111-2222-4333-8444-555555555555";
    const title = `Release v1.2.3 from ${SOURCE_SHA} [${correlation}]`;
    let dispatches = 0;
    const api = createKernelApi({
        root: process.cwd(),
        node: {
            id: "release:preflight",
            instanceId: "release",
            permissions: { commands: [], outputRoots: [], networkOrigins: ["https://api.github.com"] },
            secretRoles: [{ role: "source-release", required: true, defaultName: "GITHUB_TOKEN" }],
        },
        secretValues: { "source-release": "source-role" },
        fetchImpl: async (url, options) => {
            const path = `${url.pathname}${url.search}`;
            if (path.includes("/actions/secrets?")) return new Response('{"secrets":[]}', { status: 200 });
            if (path.endsWith("/dispatches") && options.method === "POST") {
                dispatches += 1;
                return new Response(null, { status: 204 });
            }
            if (path.includes("/runs?event=workflow_dispatch")) {
                return new Response(JSON.stringify({ workflow_runs: [{
                    id: 99,
                    event: "workflow_dispatch",
                    head_branch: "main",
                    display_title: title,
                    status: "completed",
                    conclusion: "success",
                    html_url: "https://github.com/private-owner/private-source/actions/runs/99",
                }] }), { status: 200 });
            }
            throw new Error(`Unexpected ${options.method} ${url}`);
        },
    });
    const result = await preflightProcessor({
        api,
        config,
        graph: { nodes: [] },
        instance,
        operation: "dispatch",
        arguments: ["1.2.3", JSON.stringify(BUILD_NUMBERS), SOURCE_SHA, correlation],
        execute: true,
        timing: { now: () => 0, sleep: async () => {}, timeoutMs: 1, pollIntervalMs: 0 },
    });
    assert.equal(dispatches, 1);
    assert.equal(result.runId, 99);
    assert.equal(result.success, true);
});

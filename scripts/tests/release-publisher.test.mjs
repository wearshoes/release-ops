import assert from "node:assert/strict";
import { cp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { publishRelease } from "../release-publisher.mjs";
import { collectBuildArtifacts } from "../collect-artifacts.mjs";
import { baseConfig, BUILD_NUMBERS, fixtureRoot, SOURCE_SHA } from "./fixtures.mjs";

function githubFixture({ existing = false } = {}) {
    const releases = new Map();
    const uploads = [];
    const calls = [];
    let nextId = 10;
    if (existing) {
        for (const repository of ["private-owner/private-source", "public-owner/example-releases"]) {
            releases.set(repository, {
                id: nextId++, tag_name: "v1.2.3", name: "Example 1.2.3", body: "Release notes\n", draft: true,
                target_commitish: repository.startsWith("private-owner/") ? SOURCE_SHA : "main",
                assets: [{ id: nextId++, name: "example-v1.2.3.bin" }],
            });
        }
    }
    return {
        uploads,
        calls,
        request: async (path, options = {}) => {
            calls.push({ path, options });
            const repository = /^\/repos\/([^/]+\/[^/]+)/u.exec(path)?.[1];
            if (path.includes("/releases/tags/")) return { data: null };
            if (/\/releases\?per_page=100$/u.test(path)) return { data: releases.has(repository) ? [releases.get(repository)] : [] };
            if (/\/releases$/u.test(path) && options.method === "POST") {
                const release = { id: nextId++, ...options.json, assets: [], html_url: `https://github.com/${repository}/releases/tag/v1.2.3` };
                releases.set(repository, release);
                return { data: release };
            }
            if (path.includes("/releases/assets/") && options.method === "DELETE") return { data: undefined };
            if (path.includes("/assets?name=") && options.method === "POST") {
                uploads.push({ repository, name: decodeURIComponent(path.split("name=")[1]), body: options.body });
                return { data: {} };
            }
            if (path.includes("/contents/") && options.method !== "PUT") return { data: null };
            if (path.includes("/contents/") && options.method === "PUT") return { data: { content: { sha: "new" } } };
            if (/\/releases\/\d+$/u.test(path) && options.method === "PATCH") {
                const release = releases.get(repository);
                release.draft = false;
                release.html_url = `https://github.com/${repository}/releases/tag/v1.2.3`;
                return { data: release };
            }
            throw new Error(`unexpected ${path} ${options.method ?? "GET"}`);
        },
    };
}

test("dual publication uploads identical local bytes and a privacy-safe v2 manifest", async () => {
    const root = await fixtureRoot("release-ops-publish-");
    const github = githubFixture();
    const result = await publishRelease({
        config: baseConfig(), root, version: "1.2.3", buildNumbers: BUILD_NUMBERS, sourceSha: SOURCE_SHA, github,
        publishedAt: "2026-08-20T00:00:00Z",
    });
    const binaries = github.uploads.filter(({ name }) => name.endsWith(".bin"));
    assert.equal(binaries.length, 2);
    assert.strictEqual(binaries[0].body, binaries[1].body);
    assert.equal(result.manifest.schemaVersion, "release-ops-release/v2");
    assert.deepEqual(result.manifest.buildNumbers, BUILD_NUMBERS);
    assert.doesNotMatch(JSON.stringify(result.manifest), /private-owner|private-source|bbbbbbbb|workflow|correlation/iu);
    assert.match(JSON.stringify(result.manifest), /public-owner\/example-releases/u);
    const patches = github.calls.filter(({ options }) => options.method === "PATCH");
    assert.deepEqual(patches.map(({ path }) => path.split("/").slice(1, 4).join("/")), [
        "repos/private-owner/private-source", "repos/public-owner/example-releases",
    ]);
});

test("same-repository mode publishes once and keeps root README project-owned", async () => {
    const root = await fixtureRoot("release-ops-same-");
    const github = githubFixture();
    await publishRelease({ config: baseConfig({ mode: "same-repository" }), root, version: "1.2.3", buildNumbers: BUILD_NUMBERS, sourceSha: SOURCE_SHA, github });
    assert.equal(github.uploads.filter(({ name }) => name.endsWith(".bin")).length, 1);
    assert.match(github.calls.find(({ path, options }) => path.includes("README.md") && options.method === "PUT").path, /docs\/releases\/README.md/u);
});

test("GitHub-disabled publication writes a local checksum manifest", async () => {
    const root = await fixtureRoot("release-ops-local-");
    const result = await publishRelease({
        config: baseConfig({ github: false }), root, version: "1.2.3", buildNumbers: BUILD_NUMBERS, sourceSha: SOURCE_SHA,
        publishedAt: "2026-08-20T00:00:00Z",
    });
    const manifest = JSON.parse(await readFile(join(result.outputRoot, "release-manifest.json"), "utf8"));
    assert.equal(manifest.artifacts[0].sha256.length, 64);
    assert.equal(result.mode, "local");
});

test("publisher consumes checksummed artifacts aggregated from platform build jobs", async () => {
    const root = await fixtureRoot("release-ops-aggregate-");
    const config = baseConfig({ github: false });
    await collectBuildArtifacts(config, { root, unitId: "desktop", output: ".release-ops/upload" });
    await mkdir(join(root, ".release-ops", "collected"), { recursive: true });
    await cp(
        join(root, ".release-ops", "upload", "desktop"),
        join(root, ".release-ops", "collected", "release-ops-desktop"),
        { recursive: true },
    );
    const result = await publishRelease({
        config, root, version: "1.2.3", buildNumbers: BUILD_NUMBERS, sourceSha: SOURCE_SHA,
        artifactRoot: ".release-ops/collected", publishedAt: "2026-08-20T00:00:00Z",
    });
    assert.equal(result.manifest.artifacts[0].sha256, "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a");
});

test("draft retry reuses both releases and replaces only same-named assets", async () => {
    const root = await fixtureRoot("release-ops-retry-");
    const github = githubFixture({ existing: true });
    const result = await publishRelease({
        config: baseConfig(), root, version: "1.2.3", buildNumbers: BUILD_NUMBERS, sourceSha: SOURCE_SHA, github,
        correlation: "11111111-2222-4333-8444-555555555555",
    });
    assert.equal(github.calls.filter(({ path, options }) => /\/releases$/u.test(path) && options.method === "POST").length, 0);
    assert.equal(github.calls.filter(({ options }) => options.method === "DELETE").length, 2);
    assert.equal(result.correlation, "11111111-2222-4333-8444-555555555555");
});

test("draft retry refuses a Release bound to a different source SHA", async () => {
    const root = await fixtureRoot("release-ops-retry-sha-");
    const github = githubFixture({ existing: true });
    const sourceList = github.request;
    github.request = async (path, options = {}) => {
        const response = await sourceList(path, options);
        if (/private-owner\/private-source\/releases\?per_page=100$/u.test(path)) {
            response.data[0].target_commitish = "c".repeat(40);
        }
        return response;
    };
    await assert.rejects(publishRelease({
        config: baseConfig(), root, version: "1.2.3", buildNumbers: BUILD_NUMBERS, sourceSha: SOURCE_SHA, github,
    }), /different target/u);
});

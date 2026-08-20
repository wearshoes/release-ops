import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CONFIG_SCHEMA, RELEASE_SCHEMA, validateConfig } from "../config.mjs";
import { PROVIDERS } from "../provider-registry.mjs";
import { publishRelease } from "../release-publisher.mjs";

const sourceSha = "b".repeat(40);

function config({ mode = "dual-repository", github = true } = {}) {
    const sourceVisibility = mode === "same-repository" ? "public" : "private";
    return validateConfig({
        schemaVersion: CONFIG_SCHEMA,
        project: { name: "Example", adapter: "generic" },
        build: {
            command: "build-once",
            artifacts: [{
                id: "primary",
                path: "build/example.bin",
                nameTemplate: "example-v{version}.bin",
                contentType: "application/octet-stream",
                platform: "windows",
                architecture: "x64",
            }],
            requiredSecretNames: [],
        },
        versioning: {
            file: "version.properties",
            reader: "properties",
            versionKey: "VERSION",
            codeKey: "CODE",
            changelogPattern: "docs/v{version}.md",
            requiresChinese: false,
        },
        hosting: {
            github: github ? {
                enabled: true,
                sourceRepository: "private-owner/private-source",
                sourceVisibility,
                defaultBranch: "main",
                releaseMode: mode,
                publicRepository: mode === "dual-repository" ? "public-owner/example-releases" : null,
            } : {
                enabled: false,
                sourceRepository: null,
                sourceVisibility: "none",
                defaultBranch: "main",
                releaseMode: "local",
                publicRepository: null,
            },
        },
        release: {
            workflowFile: ".github/workflows/publish-release.yml",
            tagTemplate: "v{version}",
            titleTemplate: "Example {version}",
            manifestSchema: RELEASE_SCHEMA,
            publicReadmeSource: "docs/public.md",
            publicReadmeTarget: mode === "dual-repository" ? "README.md" : "docs/releases/README.md",
            latestManifest: "latest.json",
            latestCompatibility: "release-ops",
            localOutputDirectory: "dist/releases",
        },
        providers: {
            sentry: { enabled: false, schemaVersion: PROVIDERS.sentry.schemaVersion },
        },
    });
}

async function fixtureRoot() {
    const root = await mkdtemp(join(tmpdir(), "release-ops-publish-"));
    await mkdir(join(root, "build"));
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "build", "example.bin"), Buffer.from([1, 2, 3, 4]));
    await writeFile(join(root, "version.properties"), "VERSION=1.2.3\nCODE=9\n", "utf8");
    await writeFile(join(root, "docs", "v1.2.3.md"), "Release notes\n", "utf8");
    await writeFile(join(root, "docs", "public.md"), "# Public downloads\n", "utf8");
    return root;
}

function githubFixture({ existing = false } = {}) {
    const releases = new Map();
    const uploads = [];
    const calls = [];
    let nextId = 10;
    if (existing) {
        for (const repository of ["private-owner/private-source", "public-owner/example-releases"]) {
            releases.set(repository, {
                id: nextId++, tag_name: "v1.2.3", name: "Example 1.2.3", body: "Release notes\n", draft: true,
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

test("dual publication uploads identical artifact bytes and a sanitized public manifest", async () => {
    const root = await fixtureRoot();
    const github = githubFixture();
    const result = await publishRelease({
        config: config(),
        root,
        version: "1.2.3",
        versionCode: 9,
        sourceSha,
        github,
        publishedAt: "2026-08-20T00:00:00Z",
    });
    const binaryUploads = github.uploads.filter(({ name }) => name.endsWith(".bin"));
    assert.equal(binaryUploads.length, 2);
    assert.strictEqual(binaryUploads[0].body, binaryUploads[1].body);
    assert.deepEqual(binaryUploads.map(({ repository }) => repository), [
        "private-owner/private-source",
        "public-owner/example-releases",
    ]);
    const publicText = JSON.stringify(result.manifest);
    assert.doesNotMatch(publicText, /private-owner|private-source|bbbbbbbb|workflow|correlation/iu);
    assert.match(publicText, /public-owner\/example-releases/u);
    const patches = github.calls.filter(({ options }) => options.method === "PATCH");
    assert.deepEqual(patches.map(({ path }) => path.split("/").slice(1, 4).join("/")), [
        "repos/private-owner/private-source",
        "repos/public-owner/example-releases",
    ]);
});

test("same-repository mode publishes only once and preserves the root README", async () => {
    const root = await fixtureRoot();
    const github = githubFixture();
    await publishRelease({ config: config({ mode: "same-repository" }), root, version: "1.2.3", versionCode: 9, sourceSha, github });
    assert.equal(github.uploads.filter(({ name }) => name.endsWith(".bin")).length, 1);
    const readmeWrite = github.calls.find(({ path, options }) => path.includes("README.md") && options.method === "PUT");
    assert.match(readmeWrite.path, /contents\/docs\/releases\/README.md/u);
});

test("GitHub-disabled mode emits a local checksum manifest", async () => {
    const root = await fixtureRoot();
    const result = await publishRelease({
        config: config({ github: false }),
        root,
        version: "1.2.3",
        versionCode: 9,
        sourceSha,
        publishedAt: "2026-08-20T00:00:00Z",
    });
    const manifest = JSON.parse(await readFile(join(result.outputRoot, "release-manifest.json"), "utf8"));
    assert.equal(manifest.artifacts[0].sha256.length, 64);
    assert.equal(result.mode, "local");
});

test("draft retry reuses releases and replaces only same-named assets", async () => {
    const root = await fixtureRoot();
    const github = githubFixture({ existing: true });
    await publishRelease({ config: config(), root, version: "1.2.3", versionCode: 9, sourceSha, github });
    assert.equal(github.calls.filter(({ path, options }) => /\/releases$/u.test(path) && options.method === "POST").length, 0);
    assert.equal(github.calls.filter(({ options }) => options.method === "DELETE").length, 2);
});

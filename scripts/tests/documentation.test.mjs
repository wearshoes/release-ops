import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadExtensionCatalog } from "../extension-registry.mjs";
import { renderReadme } from "../generate-readme.mjs";
import { inspectProject } from "../setup-core.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function walk(root) {
    const result = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
        if ([".git", "__pycache__"].includes(entry.name)) continue;
        const path = join(root, entry.name);
        if (entry.isDirectory()) result.push(...await walk(path));
        else result.push(path);
    }
    return result;
}

test("all repository Markdown links resolve and every documentation page is linked", async () => {
    const files = await walk(ROOT);
    const markdown = files.filter((path) => path.endsWith(".md"));
    const incoming = new Set();
    for (const path of markdown) {
        const text = await readFile(path, "utf8");
        assert.doesNotMatch(text, /release-ops-v2/iu, `product name drift in ${relative(ROOT, path)}`);
        for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
            const target = match[1].split("#")[0];
            if (!target || /^(?:https?:|codex:|mailto:)/u.test(target)) continue;
            const resolved = resolve(dirname(path), decodeURIComponent(target));
            await access(resolved);
            if (resolved.startsWith(join(ROOT, "docs"))) incoming.add(resolved);
        }
    }
    for (const page of markdown.filter((path) => path.startsWith(join(ROOT, "docs")))) {
        assert.equal(incoming.has(page), true, `orphan documentation page: ${relative(ROOT, page)}`);
    }
});

test("extension manifests link maintained docs and stack fixtures cover the catalog", async () => {
    const catalog = await loadExtensionCatalog();
    const docs = Object.values(catalog).map(({ docs }) => docs);
    for (const path of new Set(docs)) await access(join(ROOT, path));
    assert.match(await readFile(join(ROOT, "docs/stacks/godot.md"), "utf8"), /windows-latest[\s\S]*macos-latest/u);
    assert.match(await readFile(join(ROOT, "docs/stacks/unity.md"), "utf8"), /credential|凭据/iu);
    assert.match(await readFile(join(ROOT, "docs/stacks/unreal.md"), "utf8"), /unsupported|不支持/iu);
    const fixtures = JSON.parse(await readFile(join(ROOT, "assets/fixtures/stacks.json"), "utf8"));
    const stackIds = Object.values(catalog).filter(({ type }) => type === "stack").map(({ id }) => id).sort();
    assert.deepEqual(fixtures.fixtures.map(({ stack }) => stack).sort(), stackIds);
    for (const fixture of fixtures.fixtures) {
        assert.deepEqual(catalog[fixture.stack].targets, fixture.targets);
        assert.equal(catalog[fixture.stack].status, fixture.status);
        const root = await mkdtemp(join(tmpdir(), `release-ops-detect-${fixture.stack}-`));
        for (const file of fixture.files) {
            const path = join(root, file);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, fixture.contents?.[file] ?? "", "utf8");
        }
        const detected = (await inspectProject(root)).stackCandidates.map(({ extensionId }) => extensionId);
        assert.equal(detected.includes(fixture.stack), fixture.detected ?? true, `detection mismatch for ${fixture.stack}`);
    }
});

test("generated Actions references are immutable", async () => {
    const sources = await Promise.all([
        "scripts/processors/release.mjs", "scripts/processors/sentry.mjs",
    ].map((path) => readFile(join(ROOT, path), "utf8")));
    for (const source of sources) {
        assert.doesNotMatch(source, /uses:\s*[^\s]+@v\d/gu);
        for (const match of source.matchAll(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@([0-9a-f]{40})/gu)) {
            assert.equal(match[1].length, 40);
        }
    }
});

test("machine schemas cover every public v1 contract", async () => {
    const expected = new Map([
        ["config.schema.json", "release-ops/config/v1"],
        ["extension.schema.json", "release-ops/extension/v1"],
        ["processor.schema.json", "release-ops/processor/v1"],
        ["processor-graph.schema.json", "release-ops/processor-graph/v1"],
        ["inspect.schema.json", "release-ops/inspect/v1"],
        ["setup-answers.schema.json", "release-ops/setup-answers/v1"],
        ["setup-plan.schema.json", "release-ops/setup-plan/v1"],
        ["managed-files.schema.json", "release-ops/managed-files/v1"],
        ["audit.schema.json", "release-ops/audit/v1"],
        ["release-manifest.schema.json", "release-ops/release-manifest/v1"],
    ]);
    for (const [name, identifier] of expected) {
        const schema = JSON.parse(await readFile(join(ROOT, "assets", "schemas", name), "utf8"));
        assert.match(JSON.stringify(schema), new RegExp(identifier.replaceAll("/", "\\/"), "u"));
        assert.equal(schema.additionalProperties, false);
    }
});

test("README manifest generation is stable with LF and CRLF checkouts", async () => {
    const readme = await readFile(join(ROOT, "README.md"), "utf8");
    assert.equal(await renderReadme(readme), readme);
    const crlf = readme.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
    assert.equal(await renderReadme(crlf), crlf);
});

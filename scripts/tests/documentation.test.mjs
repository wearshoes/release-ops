import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BUILD_ADAPTERS, PROVIDERS } from "../provider-registry.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function walk(root) {
    const result = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.name === ".git") continue;
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
        assert.doesNotMatch(text, new RegExp(`release-ops${"-v2"}`, "iu"), `product name drift in ${relative(ROOT, path)}`);
        for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
            const target = match[1].split("#")[0];
            if (!target || /^(?:https?:|codex:|mailto:)/u.test(target)) continue;
            const resolved = resolve(dirname(path), decodeURIComponent(target));
            await access(resolved);
            if (resolved.includes(`${join(ROOT, "docs")}\\`) || resolved.includes(`${join(ROOT, "docs")}/`)) incoming.add(resolved);
        }
    }
    for (const page of markdown.filter((path) => path.startsWith(join(ROOT, "docs")))) {
        assert.equal(incoming.has(page), true, `orphan documentation page: ${relative(ROOT, page)}`);
    }
});

test("adapter and provider manifests link unique maintained documentation", async () => {
    const docs = [...BUILD_ADAPTERS.map(({ docs }) => docs), ...Object.values(PROVIDERS).map(({ docs }) => docs)];
    assert.equal(new Set(docs).size, docs.length);
    for (const path of docs) await access(join(ROOT, path));
    assert.match(await readFile(join(ROOT, "docs/stacks/godot.md"), "utf8"), /windows-latest[\s\S]*macos-latest/u);
    assert.match(await readFile(join(ROOT, "docs/stacks/unity.md"), "utf8"), /UNITY_LICENSE[\s\S]*UNITY_SERIAL/u);
    assert.match(await readFile(join(ROOT, "docs/stacks/unreal.md"), "utf8"), /ADAPTER_UNSUPPORTED/u);
});

test("generated Actions references are immutable", async () => {
    const source = await readFile(join(ROOT, "scripts/project-installer.mjs"), "utf8");
    assert.doesNotMatch(source, /uses:\s+[^\s]+@v\d/gu);
    for (const match of source.matchAll(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@([0-9a-f]{40})/gu)) assert.equal(match[1].length, 40);
});

test("machine schemas cover every public v2 contract", async () => {
    const expected = new Map([
        ["config.schema.json", "release-ops/config/v2"],
        ["setup-plan.schema.json", "release-ops/setup-plan/v2"],
        ["audit.schema.json", "release-ops/audit/v2"],
        ["provider.schema.json", "release-ops/provider/v2"],
        ["release-manifest.schema.json", "release-ops-release/v2"],
    ]);
    for (const [name, identifier] of expected) {
        const schema = JSON.parse(await readFile(join(ROOT, "assets", "schemas", name), "utf8"));
        assert.match(JSON.stringify(schema), new RegExp(identifier.replaceAll("/", "\\/"), "u"));
        assert.equal(schema.additionalProperties, false);
    }
    assert.equal(PROVIDERS.sentry.configSchema, "config.schema.json");
    await access(join(PROVIDERS.sentry.manifestDirectory, PROVIDERS.sentry.configSchema));
});

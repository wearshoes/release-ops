import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";

import { applySetupPlan, createSetupPlan } from "../setup-core.mjs";
import { executeNode } from "../execute.mjs";
import { answersFor, baseConfig, fixtureRoot } from "./fixtures.mjs";

function hash(value) {
    return createHash("sha256").update(value).digest("hex");
}

function repositoryDecisions() {
    return [
        { instanceId: "release", role: "source", action: "existing", repository: "private-owner/private-source" },
        { instanceId: "release", role: "distribution", action: "existing", repository: "public-owner/example-releases" },
    ];
}

function fakeGitHub() {
    const repositories = {
        "private-owner/private-source": {
            full_name: "private-owner/private-source", visibility: "private", default_branch: "main", archived: false, disabled: false,
        },
        "public-owner/example-releases": {
            full_name: "public-owner/example-releases", visibility: "public", default_branch: "main", archived: false, disabled: false,
        },
    };
    return { request: async (path) => ({ data: repositories[path.replace("/repos/", "")] }) };
}

test("apply copies only selected extension runtime and writes v1 digests", async () => {
    const root = await fixtureRoot("release-ops-selected-runtime-");
    const plan = await createSetupPlan(root, answersFor(baseConfig()), { token: null });
    const result = await applySetupPlan(plan, plan.planDigest, { token: null });
    assert.equal(result.managedFiles.schemaVersion, "release-ops/managed-files/v1");
    assert.equal(result.managedFiles.configDigest, plan.graph.configDigest);
    assert.equal(result.managedFiles.graphDigest, plan.graph.graphDigest);
    const installed = await readdir(join(root, ".release-ops", "runtime", "extensions"));
    assert.deepEqual(installed.sort(), ["application", "release"]);
    await assert.rejects(access(join(root, ".release-ops", "runtime", "extensions", "sentry")), /ENOENT/u);
    await assert.rejects(access(join(root, ".release-ops", "runtime", "adapters")), /ENOENT/u);
});

test("reconfigure deletes disabled extension runtime without retaining unselected stacks", async () => {
    const root = await fixtureRoot("release-ops-disable-");
    const enabled = baseConfig({ sentry: true });
    enabled.extensions.at(-1).config.issueSync = false;
    const initial = await createSetupPlan(root, answersFor(enabled), { token: null });
    await applySetupPlan(initial, initial.planDigest, { token: null });
    const next = await createSetupPlan(root, answersFor(baseConfig(), "reconfigure"), { token: null });
    assert.equal(next.managedFiles.operations.some(({ path, operation }) =>
        path.includes("runtime/extensions/sentry/") && operation === "delete"), true);
    await applySetupPlan(next, next.planDigest, { token: null });
    await assert.rejects(access(join(root, ".release-ops", "runtime", "extensions", "sentry")), /ENOENT/u);
    assert.deepEqual((await readdir(join(root, ".release-ops", "runtime", "extensions"))).sort(), ["application", "release"]);
});

test("exact workflow adoption preserves bytes and requires matching owner and SHA-256", async () => {
    const root = await fixtureRoot("release-ops-adopt-");
    const path = join(root, ".github", "workflows", "publish-release.yml");
    const bytes = "name: Existing project release\r\n";
    await mkdir(join(root, ".github", "workflows"), { recursive: true });
    await writeFile(path, bytes, "utf8");
    const config = baseConfig({ mode: "dual-repository" });
    const answers = answersFor(config, "initialize", repositoryDecisions());
    answers.managedFileAdoptions = [{
        path: ".github/workflows/publish-release.yml",
        ownerInstanceId: "release",
        sha256: hash(bytes),
    }];
    const github = fakeGitHub();
    const plan = await createSetupPlan(root, answers, { token: "metadata", github });
    assert.equal(plan.managedFiles.operations.find(({ path: candidate }) => candidate.endsWith("publish-release.yml")).operation, "unchanged");
    await applySetupPlan(plan, plan.planDigest, { token: "metadata", github });
    assert.equal(await readFile(path, "utf8"), bytes);

    const wrong = structuredClone(answers);
    wrong.mode = "reconfigure";
    wrong.managedFileAdoptions[0].sha256 = "0".repeat(64);
    await assert.rejects(createSetupPlan(root, wrong, { token: "metadata", github }), /SHA-256 does not match/u);
});

test("apply revalidates current target hashes after confirmation", async () => {
    const root = await fixtureRoot("release-ops-snapshot-");
    const plan = await createSetupPlan(root, answersFor(baseConfig()), { token: null });
    await mkdir(join(root, ".release-ops", "runtime", "kernel"), { recursive: true });
    await writeFile(join(root, ".release-ops", "runtime", "kernel", "execute.mjs"), "changed\n", "utf8");
    await assert.rejects(applySetupPlan(plan, plan.planDigest, { token: null }), /files or workflow model changed/u);
});

test("transaction failure restores the original filesystem", async () => {
    const root = await fixtureRoot("release-ops-rollback-");
    const plan = await createSetupPlan(root, answersFor(baseConfig()), { token: null });
    await assert.rejects(applySetupPlan(plan, plan.planDigest, { token: null, failAfter: 2 }), /Injected transaction failure/u);
    await assert.rejects(access(join(root, ".release-ops", "config.json")), /ENOENT/u);
    await assert.rejects(access(join(root, ".release-ops", "processor-graph.json")), /ENOENT/u);
});

test("installed processor modules execute from the selected instance runtime", async () => {
    const root = await fixtureRoot("release-ops-installed-execute-");
    const plan = await createSetupPlan(root, answersFor(baseConfig()), { token: null });
    await applySetupPlan(plan, plan.planDigest, { token: null });
    const result = await executeNode({
        root,
        nodeId: "release:publish",
        operation: "publish",
        arguments: ["1.2.3", JSON.stringify({ windows: 9 }), "b".repeat(40), "installed-runtime"],
    });
    assert.equal(result.mode, "local");
    assert.equal(JSON.parse(await readFile(
        join(root, "dist", "releases", "v1.2.3", "release-manifest.json"),
        "utf8",
    )).schemaVersion, "release-ops/release-manifest/v1");
});

test("installed local release entry executes the selected graph and writes output", async () => {
    const root = await fixtureRoot("release-ops-local-entry-");
    const plan = await createSetupPlan(root, answersFor(baseConfig()), { token: null });
    await applySetupPlan(plan, plan.planDigest, { token: null });
    execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Release Ops Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"], {
        cwd: root, stdio: "ignore",
    });
    const output = execFileSync(process.execPath, [
        join(root, ".release-ops", "runtime", "kernel", "local-release-entry.mjs"),
        "--root", root,
        "--version", "1.2.3",
    ], { cwd: root, encoding: "utf8" });
    assert.equal(JSON.parse(output).schemaVersion, "release-ops/local-release-result/v1");
    assert.equal(JSON.parse(await readFile(
        join(root, "dist", "releases", "v1.2.3", "release-manifest.json"),
        "utf8",
    )).version, "1.2.3");
});

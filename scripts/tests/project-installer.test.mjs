import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { validateConfig } from "../config.mjs";
import { installProjectFiles, planProjectFiles, renderPublishWorkflow } from "../project-installer.mjs";
import { baseConfig, fixtureRoot } from "./fixtures.mjs";

test("generated workflow scopes build, Sentry, and release Secrets to their steps", async () => {
    const config = structuredClone(baseConfig({ sentry: true }));
    config.build.units[0].requiredSecretNames = ["SIGNING_KEY"];
    const workflow = renderPublishWorkflow(validateConfig(config));
    assert.match(workflow, /runs-on: windows-latest/u);
    assert.match(workflow, /name: Build desktop[\s\S]*env:\n\s+SIGNING_KEY:/u);
    assert.match(workflow, /Upload sentry debug artifacts[\s\S]*SENTRY_ORG_CI_TOKEN:/u);
    assert.match(workflow, /Publish locally built artifacts[\s\S]*RELEASE_REPO_TOKEN:/u);
    assert.doesNotMatch(workflow, /jobs:\n\s+env:/u);
    assert.equal((workflow.match(/run-build\.mjs/gu) ?? []).length, 1);
    assert.match(workflow, /download-artifact@[0-9a-f]{40}/u);
    const parsed = spawnSync("python", ["-c", "import sys, yaml; yaml.safe_load(sys.stdin.read())"], {
        input: workflow,
        encoding: "utf8",
        windowsHide: true,
    });
    assert.equal(parsed.status, 0, parsed.stderr);
});

test("Godot uses target-specific hosted runners and Unity uses credential-gated GameCI", () => {
    const godot = structuredClone(baseConfig());
    godot.project = { name: "Game", adapter: "godot", adapterOptions: { godotVersion: "4.4.1" } };
    godot.build.units[0].target = "windows";
    godot.build.units[0].runner = "windows-latest";
    const godotWorkflow = renderPublishWorkflow(validateConfig(godot));
    assert.match(godotWorkflow, /setup-godot@[0-9a-f]{40}/u);
    assert.match(godotWorkflow, /runs-on: windows-latest/u);

    const selfHostedGodot = structuredClone(godot);
    selfHostedGodot.build.units[0].runner = "self-hosted";
    selfHostedGodot.build.units[0].selfHostedReason = "proprietary console SDK";
    const selfHostedWorkflow = renderPublishWorkflow(validateConfig(selfHostedGodot));
    assert.match(selfHostedWorkflow, /runs-on: self-hosted/u);
    assert.doesNotMatch(selfHostedWorkflow, /setup-godot@/u);

    const unity = structuredClone(baseConfig());
    unity.project = { name: "Unity Game", adapter: "unity", adapterOptions: { license: "personal", projectPath: "." } };
    delete unity.build.units[0].command;
    const workflow = renderPublishWorkflow(validateConfig(unity));
    assert.match(workflow, /unity-builder@[0-9a-f]{40}/u);
    assert.match(workflow, /UNITY_LICENSE: \$\{\{ secrets\.UNITY_LICENSE \}\}/u);
    assert.doesNotMatch(workflow, /UNITY_SERIAL:/u);
});

test("disabling a provider transactionally deletes its unchanged managed workflows", async () => {
    const root = await fixtureRoot("release-ops-delete-");
    await installProjectFiles(root, baseConfig({ sentry: true }));
    const plan = await planProjectFiles(root, baseConfig({ sentry: false }));
    assert.equal(plan.operations.find(({ path }) => path === ".github/workflows/sentry-issues.yml").operation, "delete");
    await installProjectFiles(root, baseConfig({ sentry: false }));
    await assert.rejects(access(join(root, ".github", "workflows", "sentry-issues.yml")), /ENOENT/u);
});

test("changed managed files and unmanaged workflows stop the whole transaction", async () => {
    const root = await fixtureRoot("release-ops-conflict-");
    await installProjectFiles(root, baseConfig({ sentry: true }));
    const managed = join(root, ".github", "workflows", "sentry-issues.yml");
    await writeFile(managed, "project-owned change\n", "utf8");
    await assert.rejects(installProjectFiles(root, baseConfig({ sentry: false })), /Managed file conflicts/u);
    assert.equal(await readFile(managed, "utf8"), "project-owned change\n");

    const other = await fixtureRoot("release-ops-unmanaged-");
    await mkdir(join(other, ".github", "workflows"), { recursive: true });
    await writeFile(join(other, ".github", "workflows", "publish-release.yml"), "project-owned\n", "utf8");
    await assert.rejects(installProjectFiles(other, baseConfig()), /Managed file conflicts/u);
});

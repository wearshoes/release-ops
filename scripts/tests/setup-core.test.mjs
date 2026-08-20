import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateConfig } from "../config.mjs";
import { publishRelease } from "../release-publisher.mjs";
import { applySetupPlan, auditProject, createSetupPlan, inspectProject } from "../setup-core.mjs";
import { installProjectFiles } from "../project-installer.mjs";
import { baseConfig, BUILD_NUMBERS, fixtureRoot, SOURCE_SHA } from "./fixtures.mjs";

function localAnswers(providerSelection = []) {
    const config = baseConfig({ github: false });
    return {
        schemaVersion: "release-ops/setup-answers/v2",
        project: config.project,
        build: config.build,
        versioning: config.versioning,
        github: { enabled: false },
        release: config.release,
        providerSelection,
        providers: providerSelection.includes("sentry") ? {
            sentry: { organization: "owner", project: "example", apiBase: "https://owner.sentry.io/api/0" },
        } : {},
    };
}

function githubAnswers(source, distribution = null) {
    const answers = localAnswers();
    answers.github = { enabled: true, source, ...(distribution ? { distribution } : {}) };
    return answers;
}

test("inspect reports version, signing, workflow, and provider decisions without enabling a provider", async () => {
    const root = await fixtureRoot("release-ops-inspect-facts-");
    await mkdir(join(root, ".github", "workflows"), { recursive: true });
    await writeFile(join(root, ".github", "workflows", "existing.yml"), "name: Existing\n", "utf8");
    await writeFile(join(root, "keystore.properties"), "not-read-by-inspect\n", "utf8");
    const inspection = await inspectProject(root);
    assert.equal(inspection.versionSources.some(({ kind, file, key }) => kind === "canonical" && file === "version.properties" && key === "VERSION"), true);
    assert.equal(inspection.versionSources.some(({ kind, key }) => kind === "build-number" && key === "CODE"), true);
    assert.deepEqual(inspection.signingIndicators, ["keystore.properties"]);
    assert.deepEqual(inspection.workflows, [".github/workflows/existing.yml"]);
    assert.deepEqual(inspection.decisions.providerSelection, { required: true, choices: ["none", "sentry"] });
    assert.equal(Object.hasOwn(inspection, "selectedProviders"), false);
});

test("v1 projects require a confirmed digest before transactional reinitialization", async () => {
    const root = await fixtureRoot("release-ops-reinit-");
    await mkdir(join(root, ".release-ops"));
    await writeFile(join(root, ".release-ops", "config.json"), '{"schemaVersion":"release-ops/config/v1"}\n', "utf8");
    const plan = await createSetupPlan(root, localAnswers());
    assert.equal(plan.inspection.config.status, "incompatible");
    assert.equal(plan.managedFiles.operations.find(({ path }) => path === ".release-ops/config.json").operation, "update");
    await assert.rejects(applySetupPlan(plan, "0".repeat(64)), /exactly match/u);
    assert.match(await readFile(join(root, ".release-ops", "config.json"), "utf8"), /config\/v1/u);
    await applySetupPlan(plan, plan.planDigest);
    assert.equal(JSON.parse(await readFile(join(root, ".release-ops", "config.json"), "utf8")).schemaVersion, "release-ops/config/v2");
    assert.equal(JSON.parse(await readFile(join(root, ".release-ops", "managed-files.json"), "utf8")).schemaVersion, "release-ops-managed-files/v2");
    assert.equal((await auditProject(root, { token: null })).success, true);
});

test("one Sentry selection enables build hooks but not GitHub incident workflows when GitHub is disabled", async () => {
    const root = await fixtureRoot("release-ops-provider-choice-");
    const plan = await createSetupPlan(root, localAnswers(["sentry"]));
    assert.equal(plan.config.providers.sentry.enabled, true);
    assert.equal(plan.config.providers.sentry.issueSync, false);
    assert.equal(plan.requiredSecrets.some(({ name }) => name === "SENTRY_ORG_CI_TOKEN"), true);
    assert.equal(plan.managedFiles.operations.some(({ path }) => path.includes("sentry-issues.yml")), false);
});

test("None cannot be combined with an installed provider", async () => {
    const root = await fixtureRoot("release-ops-provider-none-conflict-");
    await assert.rejects(createSetupPlan(root, localAnswers(["none", "sentry"])), /cannot be combined/u);
});

test("existing GitHub source and distribution identities use independently discovered default branches", async () => {
    const root = await fixtureRoot("release-ops-hosting-");
    const repositories = {
        "owner/source": { full_name: "owner/source", visibility: "private", private: true, default_branch: "trunk", archived: false, disabled: false },
        "owner/releases": { full_name: "owner/releases", visibility: "public", private: false, default_branch: "stable", archived: false, disabled: false },
    };
    const github = { request: async (path) => ({ data: repositories[path.replace("/repos/", "")] }) };
    const plan = await createSetupPlan(root, githubAnswers(
        { action: "existing", repository: "owner/source" },
        { action: "existing", repository: "owner/releases" },
    ), { token: "metadata-only", github });
    assert.equal(plan.config.hosting.github.releaseMode, "dual-repository");
    assert.equal(plan.config.hosting.github.source.owner, "owner");
    assert.equal(plan.config.hosting.github.source.name, "source");
    assert.equal(plan.config.hosting.github.source.defaultBranch, "trunk");
    assert.equal(plan.config.hosting.github.distribution.defaultBranch, "stable");
});

test("Unity credential profiles are part of the confirmed Secret plan", async () => {
    const root = await fixtureRoot("release-ops-unity-secrets-");
    const answers = localAnswers();
    answers.project = { name: "Unity Game", adapter: "unity", adapterOptions: { license: "professional", projectPath: "." } };
    delete answers.build.units[0].command;
    const plan = await createSetupPlan(root, answers);
    const names = plan.requiredSecrets.map(({ name }) => name);
    assert.deepEqual(names, ["UNITY_EMAIL", "UNITY_PASSWORD", "UNITY_SERIAL"]);
    assert.equal(plan.requiredSecrets.every(({ purpose }) => purpose === "build-and-sign"), true);
});

test("public GitHub sources publish in place without a distribution repository", async () => {
    const root = await fixtureRoot("release-ops-public-");
    const github = { request: async () => ({ data: {
        full_name: "owner/public", visibility: "public", private: false, default_branch: "main", archived: false, disabled: false,
    } }) };
    const plan = await createSetupPlan(root, githubAnswers({ action: "existing", repository: "owner/public" }), {
        token: "metadata-only", github,
    });
    assert.equal(plan.config.hosting.github.releaseMode, "same-repository");
    assert.equal(plan.config.hosting.github.distribution, null);
});

test("new GitHub repositories require explicit visibility and verify the owner", async () => {
    const root = await fixtureRoot("release-ops-create-hosting-");
    const calls = [];
    const github = { request: async (path) => {
        calls.push(path);
        if (path === "/repos/owner/new-project") return { data: null };
        if (path === "/user") return { data: { login: "owner" } };
        throw new Error(`unexpected ${path}`);
    } };
    const plan = await createSetupPlan(root, githubAnswers({
        action: "create", repository: "owner/new-project", visibility: "public", defaultBranch: "main",
    }), { token: "metadata-only", github });
    assert.equal(plan.repositories[0].action, "create");
    assert.equal(plan.config.hosting.github.source.visibility, "public");
    assert.deepEqual(calls, ["/repos/owner/new-project", "/user"]);
});

test("audit cannot succeed when configured GitHub remotes were not verified", async () => {
    const root = await fixtureRoot("release-ops-audit-remote-");
    await installProjectFiles(root, baseConfig(), { includeConfig: true });
    const result = await auditProject(root, { token: null });
    assert.equal(result.remoteVerified, false);
    assert.equal(result.success, false);
    assert.equal(result.checks.githubHosting.status, "fail");
    assert.equal(result.checks.localBuild.status, "configured");
});

test("local audit reports build credentials independently", async () => {
    const root = await fixtureRoot("release-ops-audit-local-");
    const config = structuredClone(baseConfig({ github: false }));
    config.build.units[0].requiredSecretNames = ["SIGNING_KEY"];
    await installProjectFiles(root, validateConfig(config), { includeConfig: true });
    const missing = await auditProject(root, { token: null, env: {} });
    assert.equal(missing.success, false);
    assert.deepEqual(missing.checks.localBuild, { status: "fail", missingEnvironmentNames: ["SIGNING_KEY"] });
    const ready = await auditProject(root, { token: null, env: { SIGNING_KEY: "present" } });
    assert.equal(ready.success, true);
    assert.equal(ready.checks.localBuild.status, "configured");
});

test("artifact paths cannot escape through a repository symlink", async (context) => {
    const root = await fixtureRoot("release-ops-symlink-");
    const outside = await mkdtemp(join(tmpdir(), "release-ops-outside-"));
    await writeFile(join(outside, "secret.bin"), "secret", "utf8");
    try {
        await symlink(outside, join(root, "linked"), "junction");
    } catch (error) {
        context.skip(`junction creation unavailable: ${error.code}`);
        return;
    }
    const config = structuredClone(baseConfig({ github: false }));
    config.build.units[0].artifacts[0].path = "linked/secret.bin";
    await assert.rejects(publishRelease({
        config, root, version: "1.2.3", buildNumbers: BUILD_NUMBERS, sourceSha: SOURCE_SHA,
    }), /escapes the repository/u);
});

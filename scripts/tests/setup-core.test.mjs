import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { applySetupPlan, auditProject, createSetupPlan, inspectProject, routeSetup } from "../setup-core.mjs";
import { addAndroidSentrySdk, answersFor, baseConfig, fixtureRoot } from "./fixtures.mjs";

function decisions() {
    return [
        { instanceId: "release", role: "source", action: "existing", repository: "private-owner/private-source" },
        { instanceId: "release", role: "distribution", action: "existing", repository: "public-owner/example-releases" },
    ];
}

function fakeGitHub({ secrets = [] } = {}) {
    const repositories = {
        "private-owner/private-source": {
            full_name: "private-owner/private-source", visibility: "private", default_branch: "main", archived: false, disabled: false,
        },
        "public-owner/example-releases": {
            full_name: "public-owner/example-releases", visibility: "public", default_branch: "main", archived: false, disabled: false,
        },
    };
    return { request: async (path) => {
        if (path.includes("/actions/secrets")) return { data: { secrets: secrets.map((name) => ({ name, updated_at: "2026-01-01" })) } };
        return { data: repositories[path.replace("/repos/", "")] };
    } };
}

test("inspect routes missing, valid v1, invalid, and legacy v2 configs", async () => {
    const missingRoot = await fixtureRoot("release-ops-route-missing-");
    const missing = await inspectProject(missingRoot);
    assert.deepEqual(missing.config, { status: "missing", action: "initialize" });
    assert.deepEqual(missing.route.allowed, ["initialize"]);

    const validRoot = await fixtureRoot("release-ops-route-valid-");
    const plan = await createSetupPlan(validRoot, answersFor(baseConfig()), { token: null });
    await applySetupPlan(plan, plan.planDigest, { token: null });
    const valid = await inspectProject(validRoot);
    assert.equal(valid.config.status, "valid");
    assert.equal(valid.route.defaultCommand, "audit");

    const invalidRoot = await fixtureRoot("release-ops-route-invalid-");
    await mkdir(join(invalidRoot, ".release-ops"));
    await writeFile(join(invalidRoot, ".release-ops", "config.json"), "{broken", "utf8");
    assert.equal((await inspectProject(invalidRoot)).config.action, "reinitialize");

    const legacyRoot = await fixtureRoot("release-ops-route-v2-");
    await mkdir(join(legacyRoot, ".release-ops"));
    await writeFile(join(legacyRoot, ".release-ops", "config.json"), '{"schemaVersion":"release-ops/config/v2"}\n', "utf8");
    const legacy = await inspectProject(legacyRoot);
    assert.deepEqual(legacy.config, {
        status: "incompatible", schemaVersion: "release-ops/config/v2", action: "reinitialize",
    });
});

test("reconfigure inherits valid v1 defaults while reinitialize inherits nothing", async () => {
    const root = await fixtureRoot("release-ops-read-only-routes-");
    const plan = await createSetupPlan(root, answersFor(baseConfig()), { token: null });
    await applySetupPlan(plan, plan.planDigest, { token: null });
    const reconfigure = await routeSetup(root, "reconfigure");
    assert.equal(reconfigure.readOnly, true);
    assert.equal(reconfigure.defaults.project.name, "Example");
    assert.deepEqual(reconfigure.questionOrder, ["stack", "build-unit", "signing", "release", "github-topology", "provider"]);
    assert.deepEqual(reconfigure.selectedExtensions.map(({ extension }) => extension.id), ["generic", "local"]);
    const reinitialize = await routeSetup(root, "reinitialize", { extensionIds: ["android", "github", "sentry"] });
    assert.equal(reinitialize.defaults, null);
    assert.equal(reinitialize.inheritance, "none");
    assert.deepEqual(reinitialize.selectedExtensions.map(({ extension }) => extension.id), ["android", "github", "sentry"]);
});

test("plan digest is deterministic and apply requires the exact digest", async () => {
    const root = await fixtureRoot("release-ops-digest-");
    const answers = answersFor(baseConfig());
    const first = await createSetupPlan(root, answers, { token: null });
    const second = await createSetupPlan(root, structuredClone(answers), { token: null });
    assert.equal(first.planDigest, second.planDigest);
    await assert.rejects(applySetupPlan(first, "0".repeat(64), { token: null }), /exactly match/u);
    await applySetupPlan(first, first.planDigest, { token: null });
    assert.equal(JSON.parse(await readFile(join(root, ".release-ops", "config.json"), "utf8")).schemaVersion, "release-ops/config/v1");
});

test("GitHub and Sentry plan freezes repository identities and Secret roles", async () => {
    const root = await fixtureRoot("release-ops-remote-plan-");
    await addAndroidSentrySdk(root);
    const config = baseConfig({ mode: "dual-repository", sentry: true, signing: true, stack: "android" });
    const plan = await createSetupPlan(root, answersFor(config, "initialize", decisions()), {
        token: "metadata", github: fakeGitHub(),
    });
    assert.deepEqual(plan.repositories.map(({ role, identity }) => [role, identity.visibility, identity.defaultBranch]), [
        ["source", "private", "main"], ["distribution", "public", "main"],
    ]);
    const roles = plan.requiredSecrets.map(({ instanceId, role }) => `${instanceId}:${role}`);
    assert.equal(roles.includes("application-signing:credential"), true);
    assert.equal(roles.includes("release:distribution-release"), true);
    assert.equal(roles.includes("sentry:project-provision"), true);
    assert.equal(roles.includes("sentry:build-upload"), true);
    assert.equal(roles.includes("sentry:incident-read"), true);
    assert.equal(roles.includes("sentry:incident-write"), true);
    assert.equal(plan.extensionChecks[0].status, "configured");
    assert.equal(plan.extensionChecks[0].platform, "android");
});

test("Sentry SDK readiness is a hard plan gate", async () => {
    const root = await fixtureRoot("release-ops-sentry-plan-gate-");
    const config = baseConfig({ sentry: true, stack: "android" });
    config.extensions.at(-1).config.issueSync = false;
    await assert.rejects(
        createSetupPlan(root, answersFor(config), { token: null }),
        /sentry:sentry-sdk is missing; missing sdk, initialization, dsn; https:\/\/docs\.sentry\.io\/platforms\/android\//u,
    );
});

test("apply rejects Sentry SDK evidence drift after digest confirmation", async () => {
    const root = await fixtureRoot("release-ops-sentry-check-drift-");
    await addAndroidSentrySdk(root);
    const config = baseConfig({ sentry: true, stack: "android" });
    config.extensions.at(-1).config.issueSync = false;
    const plan = await createSetupPlan(root, answersFor(config), { token: null });
    await writeFile(join(root, "gradle.properties"), [
        "VERSION=1.2.3",
        "CODE=9",
        "SENTRY_DSN=https://fedcba98@o1.ingest.sentry.io/123",
        "",
    ].join("\n"), "utf8");
    await assert.rejects(
        applySetupPlan(plan, plan.planDigest, { token: null }),
        /Extension check evidence changed after the confirmed plan/u,
    );
});

test("audit fails with official remediation when an installed Sentry SDK loses initialization", async () => {
    const root = await fixtureRoot("release-ops-sentry-audit-sdk-");
    await addAndroidSentrySdk(root);
    const config = baseConfig({ sentry: true, stack: "android" });
    config.extensions.at(-1).config.issueSync = false;
    const plan = await createSetupPlan(root, answersFor(config), { token: null });
    await applySetupPlan(plan, plan.planDigest, { token: null });
    await writeFile(join(root, "app", "src", "main", "AndroidManifest.xml"), "<manifest><application /></manifest>\n", "utf8");
    const audit = await auditProject(root, {
        token: null,
        env: {
            SENTRY_ORG_CI_TOKEN: "configured",
            SENTRY_AUTH_TOKEN: "configured",
            SENTRY_WRITE_TOKEN: "configured",
        },
    });
    assert.equal(audit.success, false);
    assert.equal(audit.extensions.sentry.status, "fail");
    assert.match(audit.extensions.sentry.message, /missing initialization/u);
    assert.match(audit.extensions.sentry.message, /https:\/\/docs\.sentry\.io\/platforms\/android\//u);
});

test("audit reports config, graph, and workflow drift after manual config edits", async () => {
    const root = await fixtureRoot("release-ops-audit-drift-");
    const github = fakeGitHub();
    const plan = await createSetupPlan(root, answersFor(baseConfig({ mode: "dual-repository" }), "initialize", decisions()), {
        token: "metadata", github,
    });
    await applySetupPlan(plan, plan.planDigest, { token: "metadata", github });
    const path = join(root, ".release-ops", "config.json");
    const config = JSON.parse(await readFile(path, "utf8"));
    config.extensions.find(({ instanceId }) => instanceId === "release").config.workflowFile = ".github/workflows/other-release.yml";
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const audit = await auditProject(root, { token: null, env: {} });
    assert.equal(audit.success, false);
    assert.equal(audit.checks.configuration.status, "pass");
    assert.equal(audit.checks.graph.status, "fail");
    assert.equal(audit.checks.workflows.status, "fail");
    assert.match(audit.checks.graph.message, /re-plan\/apply/u);
});

test("audit verifies configured remotes and Secret metadata without reading values", async () => {
    const root = await fixtureRoot("release-ops-audit-remote-");
    const config = baseConfig({ mode: "dual-repository" });
    const plan = await createSetupPlan(root, answersFor(config, "initialize", decisions()), {
        token: "metadata", github: fakeGitHub(),
    });
    await applySetupPlan(plan, plan.planDigest, { token: "metadata", github: fakeGitHub() });
    const audit = await auditProject(root, {
        token: "metadata",
        github: fakeGitHub({ secrets: ["RELEASE_REPO_TOKEN"] }),
        env: {},
    });
    assert.equal(audit.remoteVerified, true);
    assert.equal(audit.checks.repositories.status, "pass");
    assert.equal(audit.success, true);
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installProjectFiles } from "../project-installer.mjs";

function config(enabled = true) {
    return {
        build: { requiredSecretNames: ["SIGNING_KEY"] },
        hosting: {
            github: {
                enabled,
                sourceRepository: "owner/example",
                releaseMode: enabled ? "dual-repository" : "local",
                defaultBranch: "main",
            },
        },
        release: { workflowFile: ".github/workflows/publish-release.yml" },
        providers: { sentry: { enabled: enabled, issueSync: enabled, schedule: "17 * * * *" } },
    };
}

test("installer writes one-build workflow with explicit Secret metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-ops-install-"));
    const manifest = await installProjectFiles(root, config());
    const workflow = await readFile(join(root, ".github", "workflows", "publish-release.yml"), "utf8");
    assert.match(workflow, /group: release-ops-publish/u);
    assert.match(workflow, /ref: \$\{\{ inputs\.sourceSha \}\}/u);
    assert.equal((workflow.match(/name: Build once/gu) ?? []).length, 1);
    assert.match(workflow, /RELEASE_REPO_TOKEN: \$\{\{ secrets\.RELEASE_REPO_TOKEN \}\}/u);
    assert.match(workflow, /SENTRY_ORG_CI_TOKEN: \$\{\{ secrets\.SENTRY_ORG_CI_TOKEN \}\}/u);
    assert.match(workflow, /SIGNING_KEY: \$\{\{ secrets\.SIGNING_KEY \}\}/u);
    assert.ok(manifest.files[".release-ops/runtime/release-publisher.mjs"]);
    const sync = await readFile(join(root, ".github", "workflows", "sentry-issues.yml"), "utf8");
    const resolver = await readFile(join(root, ".github", "workflows", "resolve-issues.yml"), "utf8");
    assert.match(sync, /cron: "17 \* \* \* \*"/u);
    assert.match(sync, /SENTRY_AUTH_TOKEN: \$\{\{ secrets\.SENTRY_AUTH_TOKEN \}\}/u);
    assert.match(resolver, /SENTRY_WRITE_TOKEN: \$\{\{ secrets\.SENTRY_WRITE_TOKEN \}\}/u);
});

test("GitHub-disabled install does not create a workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-ops-local-install-"));
    const manifest = await installProjectFiles(root, config(false));
    assert.equal(Object.keys(manifest.files).some((path) => path.includes(".github")), false);
    assert.ok(manifest.files[".release-ops/runtime/local-release.mjs"]);
});

test("upgrade refuses to overwrite a changed managed file", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-ops-upgrade-"));
    await installProjectFiles(root, config(false));
    await writeFile(join(root, ".release-ops", "runtime", "config.mjs"), "locally changed\n", "utf8");
    await assert.rejects(installProjectFiles(root, config(false), { upgrade: true }), /local changes/u);
});

test("initial install refuses to overwrite an unmanaged workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-ops-existing-"));
    await mkdir(join(root, ".github", "workflows"), { recursive: true });
    await writeFile(join(root, ".github", "workflows", "publish-release.yml"), "project-owned\n", "utf8");
    await assert.rejects(installProjectFiles(root, config()), /unmanaged existing file/u);
});

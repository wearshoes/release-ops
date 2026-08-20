import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { baseConfig, fixtureRoot } from "./fixtures.mjs";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("../release-ops.mjs", import.meta.url));

function answers(providerSelection) {
    const config = baseConfig({ github: false });
    return {
        schemaVersion: "release-ops/setup-answers/v2",
        project: config.project,
        build: config.build,
        versioning: config.versioning,
        github: { enabled: false },
        release: config.release,
        providerSelection,
        providers: {},
    };
}

test("inspect CLI exposes required GitHub and provider decisions", async () => {
    const root = await fixtureRoot("release-ops-inspect-");
    const { stdout } = await execFileAsync(process.execPath, [script, "inspect", "--root", root]);
    const result = JSON.parse(stdout);
    assert.equal(result.schemaVersion, "release-ops/inspect/v2");
    assert.equal(result.decisionCheckpoint.status, "awaiting-user");
    assert.deepEqual(result.decisionCheckpoint.decisions, ["github", "providerSelection"]);
    assert.equal(result.decisions.providerSelection.required, true);
    assert.equal(result.decisions.providerSelection.status, "unresolved");
    assert.equal(result.decisions.providerSelection.source, "current-user");
    assert.equal(result.decisions.providerSelection.inferenceAllowed, false);
    assert.deepEqual(result.decisions.providerSelection.choices, ["none", "sentry"]);
});

test("plan refuses an omitted provider decision and hashes an explicit none selection", async () => {
    const root = await fixtureRoot("release-ops-plan-");
    const omitted = join(root, "omitted.json");
    await writeFile(omitted, JSON.stringify({ ...answers([]), providerSelection: undefined }), "utf8");
    await assert.rejects(execFileAsync(process.execPath, [script, "plan", "--root", root, "--answers", omitted]), /providerSelection is required/u);
    const explicit = join(root, "answers.json");
    await writeFile(explicit, JSON.stringify(answers(["none"])), "utf8");
    const { stdout } = await execFileAsync(process.execPath, [script, "plan", "--root", root, "--answers", explicit]);
    const plan = JSON.parse(stdout);
    assert.equal(plan.schemaVersion, "release-ops/setup-plan/v2");
    assert.match(plan.planDigest, /^[0-9a-f]{64}$/u);
    assert.equal(Object.hasOwn(plan.config.providers, "sentry"), false);
    assert.equal(plan.managedFiles.operations.some(({ path }) => path.toLowerCase().includes("sentry")), false);
});

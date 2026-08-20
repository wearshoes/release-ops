import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import { answersFor, baseConfig, fixtureRoot } from "./fixtures.mjs";

const CLI = resolve("scripts/release-ops.mjs");

function run(args) {
    return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", windowsHide: true });
}

test("CLI inspect and reinitialize expose the v2 incompatibility route read-only", async () => {
    const root = await fixtureRoot("release-ops-cli-v2-");
    await mkdir(join(root, ".release-ops"));
    await writeFile(join(root, ".release-ops", "config.json"), '{"schemaVersion":"release-ops/config/v2"}\n', "utf8");
    const inspected = run(["inspect", "--root", root]);
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.equal(JSON.parse(inspected.stdout).config.status, "incompatible");
    const route = run(["reinitialize", "--root", root, "--extensions", "android,github,sentry"]);
    assert.equal(route.status, 0, route.stderr);
    const parsed = JSON.parse(route.stdout);
    assert.equal(parsed.readOnly, true);
    assert.equal(parsed.inheritance, "none");
});

test("CLI plan requires --mode and emits a stable v1 digest", async () => {
    const root = await fixtureRoot("release-ops-cli-plan-");
    const answersPath = join(root, "answers.json");
    await writeFile(answersPath, JSON.stringify(answersFor(baseConfig())), "utf8");
    const missingMode = run(["plan", "--root", root, "--answers", answersPath]);
    assert.notEqual(missingMode.status, 0);
    assert.match(missingMode.stderr, /--mode is required/u);
    const planned = run(["plan", "--root", root, "--mode", "initialize", "--answers", answersPath]);
    assert.equal(planned.status, 0, planned.stderr);
    const plan = JSON.parse(planned.stdout);
    assert.equal(plan.schemaVersion, "release-ops/setup-plan/v1");
    assert.match(plan.planDigest, /^[0-9a-f]{64}$/u);
    assert.equal(plan.config.schemaVersion, "release-ops/config/v1");
});

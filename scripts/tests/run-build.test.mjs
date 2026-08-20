import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import test from "node:test";

import { runBuild } from "../run-build.mjs";
import { baseConfig } from "./fixtures.mjs";

test("structured Android build runs shell:false and receives only its declared Secret role", async () => {
    const calls = [];
    const root = process.cwd();
    const child = new EventEmitter();
    const config = baseConfig({ stack: "android", signing: true });
    const unit = config.extensions[0].config.buildUnits[0];
    unit.id = "android";
    unit.target = "android";
    unit.command = { executable: "./gradlew", args: ["assembleRelease"] };
    config.extensions[1].config.buildUnitIds = ["android"];
    const result = await runBuild(config, {
        root,
        unitId: "android",
        env: { PATH: "bin", SIGNING_CREDENTIAL: "sign", SENTRY_AUTH_TOKEN: "hidden", RELEASE_REPO_TOKEN: "hidden" },
        platform: "linux",
        chmodImpl: async (path, mode) => calls.push({ operation: "chmod", path, mode }),
        spawnImpl: (command, args, options) => {
            calls.push({ operation: "spawn", command, args, options });
            queueMicrotask(() => child.emit("exit", 0, null));
            return child;
        },
    });
    assert.deepEqual(calls[0], { operation: "chmod", path: resolve(root, "gradlew"), mode: 0o755 });
    assert.equal(calls[1].command, "./gradlew");
    assert.deepEqual(calls[1].args, ["assembleRelease"]);
    assert.equal(calls[1].options.shell, false);
    assert.equal(calls[1].options.env.SIGNING_CREDENTIAL, "sign");
    assert.equal(calls[1].options.env.SENTRY_AUTH_TOKEN, undefined);
    assert.equal(calls[1].options.env.RELEASE_REPO_TOKEN, undefined);
    assert.equal(result.schemaVersion, "release-ops/build/v1");
});

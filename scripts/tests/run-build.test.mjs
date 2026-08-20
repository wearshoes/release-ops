import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import test from "node:test";

import { runBuild } from "../run-build.mjs";

test("structured Android build runs shell:false and receives only its declared Secret", async () => {
    const calls = [];
    const root = process.cwd();
    const child = new EventEmitter();
    const config = {
        project: { adapter: "android-gradle" },
        build: { units: [{
            id: "android", target: "android", runner: "ubuntu-latest",
            command: { executable: "./gradlew", args: ["assembleRelease"] },
            requiredSecretNames: ["SIGNING_KEY"], artifacts: [{}],
        }] },
    };
    const result = await runBuild(config, {
        root,
        unitId: "android",
        env: { PATH: "bin", SIGNING_KEY: "sign", SENTRY_AUTH_TOKEN: "hidden", RELEASE_REPO_TOKEN: "hidden" },
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
    assert.equal(calls[1].options.env.SIGNING_KEY, "sign");
    assert.equal(calls[1].options.env.SENTRY_AUTH_TOKEN, undefined);
    assert.equal(calls[1].options.env.RELEASE_REPO_TOKEN, undefined);
    assert.equal(result.schemaVersion, "release-ops-build/v2");
});

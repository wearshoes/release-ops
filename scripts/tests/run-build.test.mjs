import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import test from "node:test";

import { runBuild } from "../run-build.mjs";

test("Android builds make the Gradle wrapper executable before spawning", async () => {
    const calls = [];
    const root = process.cwd();
    const child = new EventEmitter();
    const result = await runBuild({
        project: { adapter: "android-gradle" },
        build: { command: "./gradlew assembleRelease", requiredSecretNames: [] },
    }, {
        root,
        env: {},
        platform: "linux",
        chmodImpl: async (path, mode) => calls.push({ operation: "chmod", path, mode }),
        spawnImpl: (command) => {
            calls.push({ operation: "spawn", command });
            queueMicrotask(() => child.emit("exit", 0, null));
            return child;
        },
    });

    assert.deepEqual(calls, [
        { operation: "chmod", path: resolve(root, "gradlew"), mode: 0o755 },
        { operation: "spawn", command: "./gradlew assembleRelease" },
    ]);
    assert.equal(result.completed, true);
});

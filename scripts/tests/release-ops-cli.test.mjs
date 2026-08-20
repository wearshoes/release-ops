import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("inspect CLI returns detected project state", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-ops-inspect-"));
    const script = new URL("../release-ops.mjs", import.meta.url);
    const { stdout } = await execFileAsync(process.execPath, [script.pathname.slice(1), "inspect", "--root", root]);
    const result = JSON.parse(stdout);
    assert.equal(result.schemaVersion, "release-ops-inspect/v1");
    assert.deepEqual(result.providerChoices, ["none", "sentry"]);
});

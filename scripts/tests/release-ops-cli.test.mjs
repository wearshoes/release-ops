import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("inspect CLI returns detected project state", async () => {
    const root = await mkdtemp(join(tmpdir(), "release-ops-inspect-"));
    const script = fileURLToPath(new URL("../release-ops.mjs", import.meta.url));
    assert.equal(isAbsolute(script), true);
    const { stdout } = await execFileAsync(process.execPath, [script, "inspect", "--root", root]);
    const result = JSON.parse(stdout);
    assert.equal(result.schemaVersion, "release-ops-inspect/v1");
    assert.deepEqual(result.providerChoices, ["none", "sentry"]);
});

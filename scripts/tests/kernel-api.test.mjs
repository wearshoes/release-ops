import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createKernelApi } from "../kernel-api.mjs";

function node(overrides = {}) {
    return {
        id: "fixture:run",
        instanceId: "fixture",
        permissions: {
            commands: [{ id: "build", executable: "tool", argsPrefix: ["fixed"] }],
            networkOrigins: ["https://api.example.test"],
        },
        secretRoles: [{ role: "credential", required: true, defaultName: "FIXTURE_TOKEN" }],
        ...overrides,
    };
}

test("kernel API is frozen and execFile always uses shell:false with selected secrets", async () => {
    const calls = [];
    const api = createKernelApi({
        root: process.cwd(),
        node: node(),
        secretValues: { credential: "value" },
        execFileImpl: async (...args) => { calls.push(args); return { stdout: "ok" }; },
    });
    assert.equal(Object.isFrozen(api), true);
    await api.execFile("build", ["tail"], { secretRoles: ["credential"] });
    const [executable, args, options] = calls[0];
    assert.equal(executable, "tool");
    assert.deepEqual(args, ["fixed", "tail"]);
    assert.equal(options.shell, false);
    assert.equal(options.env.FIXTURE_TOKEN, "value");
    assert.equal(Object.hasOwn(options.env, "github_token"), false);
    await api.execFile("build", [], {
        secretRoles: ["credential"], secretEnvironment: { credential: "TOOL_AUTH_TOKEN" },
    });
    assert.equal(calls[1][2].env.TOOL_AUTH_TOKEN, "value");
    assert.equal(calls[1][2].env.FIXTURE_TOKEN, undefined);
    await assert.rejects(api.execFile("missing"), /cannot execute/u);
});

test("repository reads reject traversal and symlink escapes", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "release-ops-api-root-"));
    const outside = await mkdtemp(join(tmpdir(), "release-ops-api-outside-"));
    await writeFile(join(root, "inside.txt"), "inside", "utf8");
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    const api = createKernelApi({ root, node: node() });
    assert.equal(await api.readText("inside.txt"), "inside");
    await assert.rejects(api.readText("../secret.txt"), /escapes/u);
    try {
        await symlink(outside, join(root, "linked"), "junction");
    } catch (error) {
        context.skip(`junction creation unavailable: ${error.code}`);
        return;
    }
    await assert.rejects(api.readText("linked/secret.txt"), /symlink boundary/u);
});

test("HTTPS access is exact-origin and credentials can only come from declared roles", async () => {
    const calls = [];
    const api = createKernelApi({
        root: process.cwd(),
        node: node(),
        secretValues: { credential: "value" },
        fetchImpl: async (...args) => { calls.push(args); return new Response("{}", { status: 200 }); },
    });
    await api.request("https://api.example.test", "/v1/items", { secretRole: "credential" });
    const [url, options] = calls[0];
    assert.equal(url.origin, "https://api.example.test");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.get("authorization"), "Bearer value");
    await assert.rejects(api.request("https://other.example.test", "/"), /cannot access/u);
    await assert.rejects(api.request("https://api.example.test", "https://other.example.test/"), /cannot access/u);
    await assert.rejects(api.request("https://api.example.test", "/", { headers: { authorization: "raw" } }), /credential headers/u);
});

test("managed and workflow contributions are frozen and owned by the active instance", () => {
    const managed = [];
    const workflows = [];
    const api = createKernelApi({
        root: process.cwd(),
        node: node(),
        managedFileSink: (value) => managed.push(value),
        workflowSink: (value) => workflows.push(value),
    });
    api.addManagedFile({ path: "generated.json", content: "{}\n" });
    api.addWorkflow({ path: ".github/workflows/test.yml", model: { name: "Test" } });
    assert.equal(managed[0].ownerInstanceId, "fixture");
    assert.equal(workflows[0].ownerInstanceId, "fixture");
    assert.equal(Object.isFrozen(managed[0]), true);
});

test("release output is restricted to declared roots and rejects symlink escapes", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "release-ops-output-root-"));
    const outside = await mkdtemp(join(tmpdir(), "release-ops-output-outside-"));
    await mkdir(join(root, "dist"));
    const api = createKernelApi({
        root,
        node: node({ permissions: { commands: [], networkOrigins: [], outputRoots: ["dist/releases"] } }),
    });
    await api.writeOutput("dist/releases/v1/artifact.bin", new Uint8Array([1, 2, 3]));
    assert.deepEqual(await readFile(join(root, "dist", "releases", "v1", "artifact.bin")), Buffer.from([1, 2, 3]));
    await assert.rejects(api.writeOutput("other/file.txt", "blocked"), /outside its declared output roots/u);
    try {
        await symlink(outside, join(root, "dist", "releases", "linked"), "junction");
    } catch (error) {
        context.skip(`junction creation unavailable: ${error.code}`);
        return;
    }
    await assert.rejects(api.writeOutput("dist/releases/linked/file.txt", "blocked"), /symlink boundary/u);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { BUILD_ADAPTERS, PROVIDERS } from "../provider-registry.mjs";
import { planSentryBuildHook, runSentryBuildHook } from "../sentry-build-hook.mjs";

const sha = "c".repeat(40);

function config(enabled = true) {
    return {
        project: { name: "Example" },
        hosting: { github: { enabled: true, sourceRepository: "owner/example" } },
        providers: {
            sentry: {
                enabled,
                schemaVersion: PROVIDERS.sentry.schemaVersion,
                organization: "owner",
                project: "example",
                releaseTemplate: "application@example-{version}",
                distTemplate: "{versionCode}",
                debugArtifacts: [
                    { type: "proguard", path: "build/mapping.txt" },
                    { type: "source-map", path: "build/web" },
                    { type: "dif", path: "build/symbols" },
                ],
            },
        },
    };
}

test("disabled provider is isolated from the build", () => {
    assert.deepEqual(planSentryBuildHook(config(false), { version: "1.0.0", versionCode: 1, sourceSha: sha }).commands, []);
});

test("Sentry plan uses only fixed sentry-cli operations", () => {
    const plan = planSentryBuildHook(config(), { root: "C:/work", version: "1.0.0", versionCode: 7, sourceSha: sha });
    assert.equal(plan.release, "application@example-1.0.0");
    assert.equal(plan.dist, "7");
    assert.equal(plan.commands.every(({ executable }) => executable === "sentry-cli"), true);
    assert.equal(plan.commands.some(({ args }) => args[0] === "sourcemaps"), true);
    assert.equal(plan.commands.some(({ args }) => args[0] === "debug-files" && args.includes("proguard")), true);
    assert.doesNotMatch(JSON.stringify(plan), /SENTRY_ORG_CI_TOKEN|token-value/u);
});

test("build hook passes the CI token only through the child environment", async () => {
    const plan = planSentryBuildHook(config(), { version: "1.0.0", versionCode: 7, sourceSha: sha });
    const calls = [];
    const result = await runSentryBuildHook(plan, {
        env: { SENTRY_ORG_CI_TOKEN: "token-value" },
        exec: async (executable, args, options) => calls.push({ executable, args, token: options.env.SENTRY_AUTH_TOKEN }),
    });
    assert.equal(result.commandCount, calls.length);
    assert.equal(calls.every(({ args }) => !args.includes("token-value")), true);
    assert.equal(calls.every(({ token }) => token === "token-value"), true);
    assert.doesNotMatch(JSON.stringify(result), /token-value/u);
});

test("fixtures cover every shipped adapter without inventing a provider", async () => {
    const fixturePath = new URL("../../assets/fixtures/adapters.json", import.meta.url);
    const fixtures = JSON.parse(await readFile(fixturePath, "utf8"));
    assert.deepEqual(fixtures.fixtures.map(({ adapter }) => adapter), BUILD_ADAPTERS.map(({ id }) => id));
    assert.deepEqual(Object.keys(PROVIDERS), ["sentry"]);
    for (const name of ["performance", "vulnerability"]) {
        const fixture = JSON.parse(await readFile(new URL(`../../assets/fixtures/providers/${name}.example.json`, import.meta.url), "utf8"));
        assert.equal(fixture.installed, false);
        assert.equal(fixture.category, name);
    }
});

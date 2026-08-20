import assert from "node:assert/strict";
import test from "node:test";

import { renderWorkflow } from "../workflow-renderer.mjs";

function workflow(step) {
    return {
        name: "Fixture",
        on: { workflow_dispatch: {} },
        permissions: { contents: "read" },
        jobs: { test: { "runs-on": "ubuntu-latest", steps: [step] } },
    };
}

test("renderer accepts pinned actions and emits the fixed processor trampoline", () => {
    const action = renderWorkflow(workflow({ uses: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262" }));
    assert.match(action, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/u);
    const processor = renderWorkflow(workflow({
        name: "Run processor",
        processor: "fixture:build",
        operation: "build",
        arguments: ["desktop"],
        secretRoles: { credential: "SIGNING_CREDENTIAL" },
    }));
    assert.match(processor, /run: "node \.release-ops\/runtime\/kernel\/execute\.mjs"/u);
    assert.match(processor, /RELEASE_OPS_SECRET_CREDENTIAL: "\$\{\{ secrets\.SIGNING_CREDENTIAL \}\}"/u);
    assert.equal((processor.match(/run:/gu) ?? []).length, 1);
});

test("renderer rejects mutable actions, raw run steps, and Secret expression smuggling", () => {
    assert.throws(() => renderWorkflow(workflow({ uses: "actions/checkout@v4" })), /immutable SHA/u);
    assert.throws(() => renderWorkflow(workflow({ run: "echo unsafe" })), /run is not supported/u);
    assert.throws(() => renderWorkflow(workflow({
        processor: "fixture:build",
        operation: "build",
        environment: { TOKEN: "${{ secrets.RAW_TOKEN }}" },
    })), /cannot reference Secrets directly/u);
    assert.throws(() => renderWorkflow(workflow({
        uses: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
        with: { token: "${{ secrets.RAW_TOKEN }}" },
    })), /cannot reference Secrets directly/u);
});

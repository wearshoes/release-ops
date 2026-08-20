const MAX_DISCOVERY_PAGES = 10;

function isAmbiguousDispatchFailure(error) {
    const status = Number(/ returned HTTP (\d{3})\b/u.exec(String(error?.message ?? ""))?.[1]);
    return !(status >= 400 && status < 500 && status !== 408);
}

function validateRun(run, { expectedId, title, label, branch, allowPendingTitle = false }) {
    if (!Number.isSafeInteger(run?.id) || run.id <= 0) throw new Error(`${label} workflow returned an invalid run id`);
    if (expectedId !== null && run.id !== expectedId) throw new Error(`${label} workflow returned a mismatched run id`);
    if (run.event !== "workflow_dispatch" || run.head_branch !== branch) {
        throw new Error(`${label} workflow returned a mismatched correlated run`);
    }
    if (!/^https:\/\/github\.com\//u.test(run.html_url ?? "")) throw new Error(`${label} workflow returned an invalid run URL`);
    if (run.display_title !== title) {
        if (allowPendingTitle && run.status !== "completed") return null;
        throw new Error(`${label} workflow returned a mismatched correlated run`);
    }
    return run;
}

async function discoverCorrelatedRun(github, workflowPath, title, label, branch) {
    const matches = [];
    for (let page = 1; page <= MAX_DISCOVERY_PAGES; page += 1) {
        const response = await github.request(
            `${workflowPath}/runs?event=workflow_dispatch&branch=${encodeURIComponent(branch)}&per_page=100&page=${page}`,
        );
        const runs = response.data?.workflow_runs;
        if (!Array.isArray(runs)) throw new Error(`${label} workflow run list is invalid`);
        matches.push(...runs.filter((candidate) =>
            candidate?.display_title === title
            && candidate?.event === "workflow_dispatch"
            && candidate?.head_branch === branch));
        if (runs.length < 100) break;
    }
    if (matches.length > 1) throw new Error(`${label} workflow correlation matched multiple runs`);
    return matches.length === 1 ? validateRun(matches[0], { expectedId: null, title, label, branch }) : null;
}

export async function dispatchWorkflowAndWait({
    github,
    repository,
    workflow,
    branch,
    title,
    inputs,
    label,
    now = () => Date.now(),
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    timeoutMs = 120 * 60 * 1000,
    pollIntervalMs = 5_000,
}) {
    const workflowPath = `/repos/${repository}/actions/workflows/${workflow}`;
    const deadline = now() + timeoutMs;
    let runId = null;
    let run = null;
    let ambiguousDispatchError = null;
    try {
        const response = await github.request(`${workflowPath}/dispatches`, {
            method: "POST",
            json: { ref: branch, inputs, return_run_details: true },
        });
        const returnedId = response.data?.workflow_run_id;
        if (Number.isSafeInteger(returnedId) && returnedId > 0) runId = returnedId;
    } catch (error) {
        if (!isAmbiguousDispatchFailure(error)) throw error;
        ambiguousDispatchError = error;
    }
    while (now() <= deadline) {
        if (runId === null) {
            run = await discoverCorrelatedRun(github, workflowPath, title, label, branch);
            if (run) runId = run.id;
        } else if (!run) {
            const response = await github.request(`/repos/${repository}/actions/runs/${runId}`);
            run = validateRun(response.data, { expectedId: runId, title, label, branch, allowPendingTitle: true });
        }
        if (!run || run.status !== "completed") {
            run = null;
            await sleep(pollIntervalMs);
            continue;
        }
        if (run.conclusion !== "success") throw new Error(`${label} workflow completed with ${run.conclusion ?? "unknown"}: ${run.html_url}`);
        return run;
    }
    throw new Error(`Timed out waiting for the ${label.toLowerCase()} workflow`, { cause: ambiguousDispatchError });
}

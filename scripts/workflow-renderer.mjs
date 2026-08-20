const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/u;
const RESERVED_KEYS = new Set(["on", "yes", "no", "true", "false", "null"]);
const NODE_ID = /^[a-z0-9-]+:[a-z0-9-]+$/u;
const OPERATION = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,99}$/u;
const KERNEL_RUN = "node .release-ops/runtime/kernel/execute.mjs";

function scalar(value) {
    if (value === null) return "null";
    if (typeof value === "boolean" || typeof value === "number") return String(value);
    if (typeof value !== "string") throw new Error("Workflow scalar is invalid");
    return JSON.stringify(value);
}

function key(value) {
    return SAFE_KEY.test(value) && !RESERVED_KEYS.has(value.toLowerCase()) ? value : JSON.stringify(value);
}

function emit(value, indent) {
    const prefix = " ".repeat(indent);
    if (Array.isArray(value)) {
        if (!value.length) return `${prefix}[]\n`;
        return value.map((item) => {
            if (item && typeof item === "object") return `${prefix}-\n${emit(item, indent + 2)}`;
            return `${prefix}- ${scalar(item)}\n`;
        }).join("");
    }
    if (value && typeof value === "object") {
        const entries = Object.entries(value);
        if (!entries.length) return `${prefix}{}\n`;
        return entries.map(([name, item]) => {
            if (item && typeof item === "object") return `${prefix}${key(name)}:\n${emit(item, indent + 2)}`;
            return `${prefix}${key(name)}: ${scalar(item)}\n`;
        }).join("");
    }
    return `${prefix}${scalar(value)}\n`;
}

function exactKeys(value, name, allowed) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} is invalid`);
    for (const field of Object.keys(value)) if (!allowed.has(field)) throw new Error(`${name}.${field} is not supported`);
}

function rejectDirectSecrets(value, path = "Workflow model") {
    if (typeof value === "string" && /\$\{\{\s*secrets\./u.test(value)) {
        throw new Error(`${path} cannot reference Secrets directly; use a processor Secret role`);
    }
    if (Array.isArray(value)) return value.forEach((item, index) => rejectDirectSecrets(item, `${path}[${index}]`));
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) rejectDirectSecrets(item, `${path}.${key}`);
}

function normalizeStep(step, jobId, index) {
    exactKeys(step, `Workflow ${jobId} step ${index}`, new Set([
        "name", "uses", "with", "if", "processor", "operation", "arguments", "environment", "secretRoles", "id",
    ]));
    if (Boolean(step.uses) === Boolean(step.processor)) {
        throw new Error(`Workflow ${jobId} step ${index} must use exactly one pinned action or processor`);
    }
    if (step.uses) {
        if (!/^[^@\s]+@[0-9a-f]{40}$/u.test(step.uses)) throw new Error(`Workflow ${jobId} action must use an immutable SHA`);
        return step;
    }
    if (!NODE_ID.test(step.processor ?? "") || !OPERATION.test(step.operation ?? "")) {
        throw new Error(`Workflow ${jobId} processor invocation is invalid`);
    }
    if (!Array.isArray(step.arguments ?? []) || (step.arguments ?? []).some((item) => typeof item !== "string")) {
        throw new Error(`Workflow ${jobId} processor arguments are invalid`);
    }
    for (const [name, value] of Object.entries(step.environment ?? {})) {
        if (!ENV_NAME.test(name) || typeof value !== "string" || /\$\{\{\s*secrets\./u.test(value)) {
            throw new Error(`Workflow ${jobId} processor environment is invalid`);
        }
    }
    for (const [role, name] of Object.entries(step.secretRoles ?? {})) {
        if (!OPERATION.test(role) || !ENV_NAME.test(name)) throw new Error(`Workflow ${jobId} Secret role mapping is invalid`);
    }
    const env = {
        RELEASE_OPS_NODE: step.processor,
        RELEASE_OPS_OPERATION: step.operation,
        RELEASE_OPS_ARGUMENTS: JSON.stringify(step.arguments ?? []),
        ...step.environment,
        ...Object.fromEntries(Object.entries(step.secretRoles ?? {}).map(([role, name]) => [
            `RELEASE_OPS_SECRET_${role.toUpperCase().replaceAll("-", "_")}`,
            `\${{ secrets.${name} }}`,
        ])),
    };
    return {
        ...(step.id ? { id: step.id } : {}),
        ...(step.name ? { name: step.name } : {}),
        ...(step.if ? { if: step.if } : {}),
        env,
        run: KERNEL_RUN,
    };
}

export function normalizeWorkflowModel(model) {
    rejectDirectSecrets(model);
    exactKeys(model, "Workflow model", new Set(["name", "run-name", "on", "permissions", "concurrency", "jobs"]));
    if (typeof model.name !== "string" || !model.on || !model.jobs || typeof model.jobs !== "object") {
        throw new Error("Workflow model is invalid");
    }
    const jobs = {};
    for (const [jobId, job] of Object.entries(model.jobs)) {
        if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(jobId)) throw new Error(`Workflow job id is invalid: ${jobId}`);
        exactKeys(job, `Workflow job ${jobId}`, new Set([
            "name", "if", "needs", "runs-on", "permissions", "timeout-minutes", "environment", "strategy", "steps",
        ]));
        if (!Array.isArray(job.steps) || !job["runs-on"]) throw new Error(`Workflow job is invalid: ${jobId}`);
        jobs[jobId] = { ...job, steps: job.steps.map((step, index) => normalizeStep(step, jobId, index)) };
    }
    return { ...model, jobs };
}

export function validateWorkflowModel(model) {
    normalizeWorkflowModel(model);
    return model;
}

export function renderWorkflow(model) {
    return emit(normalizeWorkflowModel(model), 0).replaceAll("\r\n", "\n");
}

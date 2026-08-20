const ACTIONS = Object.freeze({
    checkout: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    node: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
});

import { resolveIssues, syncIncidents } from "./sentry-lifecycle.mjs";

export function planSentryProcessor({ api, instance, config }) {
    if (!instance.config.issueSync) return { enabled: true, issueSync: false, managedFiles: [] };
    const release = config.extensions.find((candidate) => candidate.config.source?.repository);
    const branch = release?.config.source?.defaultBranch ?? "main";
    const repository = release?.config.source?.repository;
    if (!repository) throw new Error("Sentry issue sync requires a GitHub release extension");
    const secrets = instance.config.secretNames;
    const issueModel = {
        name: "Sentry hourly issue sync",
        on: { schedule: [{ cron: instance.config.schedule }], workflow_dispatch: { inputs: { dry_run: { required: false, default: false, type: "boolean" } } } },
        permissions: { contents: "read", issues: "write" },
        concurrency: { group: "sentry-state-${{ github.repository }}", "cancel-in-progress": false },
        jobs: {
            sync: {
                if: "github.event.repository.private == true",
                "runs-on": "ubuntu-latest",
                steps: [
                    { uses: ACTIONS.checkout, with: { "persist-credentials": false } },
                    { uses: ACTIONS.node, with: { "node-version": "22" } },
                    {
                        name: "Synchronize Sentry issues",
                        processor: `${instance.instanceId}:ingest`,
                        operation: "scheduled-ingest",
                        secretRoles: {
                            "github-token": "GITHUB_TOKEN",
                            "incident-read": secrets["incident-read"],
                        },
                    },
                ],
            },
        },
    };
    const resolveModel = {
        name: "Resolve commit issues",
        on: { push: { branches: [branch] } },
        permissions: { contents: "read", issues: "write" },
        concurrency: { group: "sentry-state-${{ github.repository }}", "cancel-in-progress": false },
        jobs: {
            resolve: {
                if: "github.event.repository.private == true",
                "runs-on": "ubuntu-latest",
                steps: [
                    { uses: ACTIONS.checkout, with: { ref: "${{ github.sha }}", "fetch-depth": 0, "persist-credentials": false } },
                    { uses: ACTIONS.node, with: { "node-version": "22" } },
                    {
                        name: "Resolve referenced Issues",
                        processor: `${instance.instanceId}:resolve`,
                        operation: "resolve",
                        arguments: ["${{ github.event.before }}", "${{ github.sha }}"],
                        secretRoles: {
                            "github-token": "GITHUB_TOKEN",
                            "incident-read": secrets["incident-read"],
                            "incident-write": secrets["incident-write"],
                        },
                    },
                ],
            },
        },
    };
    api.addWorkflow({ path: instance.config.workflows.issueFile, model: issueModel });
    api.addWorkflow({ path: instance.config.workflows.resolveFile, model: resolveModel });
    return { enabled: true, issueSync: true, repository, managedFiles: [instance.config.workflows.issueFile, instance.config.workflows.resolveFile] };
}

function applyTemplate(template, values) {
    return template.replaceAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (match, key) => {
        if (values[key] === undefined || values[key] === null) throw new Error(`Sentry template value ${key} is unavailable`);
        return String(values[key]);
    });
}

function parseReleaseArguments(args, { unit = false } = {}) {
    const offset = unit ? 1 : 0;
    const unitId = unit ? args[0] : null;
    const version = args[offset];
    const sourceSha = args[offset + 2];
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version ?? "") || !/^[0-9a-f]{40}$/u.test(sourceSha ?? "")) {
        throw new Error("Sentry release inputs are invalid");
    }
    let buildNumbers;
    try {
        buildNumbers = JSON.parse(args[offset + 1]);
    } catch (error) {
        throw new Error("Sentry build numbers must be JSON", { cause: error });
    }
    if (!buildNumbers || typeof buildNumbers !== "object" || Array.isArray(buildNumbers)) {
        throw new Error("Sentry build numbers must be an object");
    }
    return { unitId, version, buildNumbers, sourceSha };
}

function releaseValues(config, input) {
    const application = Object.assign({}, ...config.extensions.map((candidate) => candidate.config.application ?? {}));
    return { ...application, ...input.buildNumbers, version: input.version, sourceSha: input.sourceSha, project: config.project.name };
}

function sentryEnvironment(instance) {
    return { SENTRY_URL: instance.config.apiBase.replace(/\/api\/0\/?$/u, "") };
}

async function sentryCli(api, instance, args) {
    return api.execFile("sentry-cli", args, {
        secretRoles: ["build-upload"],
        secretEnvironment: { "build-upload": "SENTRY_AUTH_TOKEN" },
        environment: sentryEnvironment(instance),
    });
}

export async function debugArtifactsProcessor({ api, config, instance, arguments: args = [], execute = false }) {
    if (!execute) {
        return { releaseTemplate: instance.config.releaseTemplate, distTemplate: instance.config.distTemplate, debugArtifacts: instance.config.debugArtifacts };
    }
    const input = parseReleaseArguments(args, { unit: true });
    const values = releaseValues(config, input);
    const release = applyTemplate(instance.config.releaseTemplate, values);
    const dist = applyTemplate(instance.config.distTemplate, values);
    const shared = ["--org", instance.config.organization, "--project", instance.config.project];
    let commandCount = 0;
    for (const artifact of instance.config.debugArtifacts.filter(({ buildUnitId }) => buildUnitId === input.unitId)) {
        const path = applyTemplate(artifact.path, values);
        await api.readBytes(path);
        if (artifact.type === "source-map") {
            await sentryCli(api, instance, ["sourcemaps", "inject", path]);
            await sentryCli(api, instance, ["sourcemaps", "upload", "--release", release, "--dist", dist, ...shared, path]);
            commandCount += 2;
        } else if (artifact.type === "proguard") {
            await sentryCli(api, instance, ["upload-proguard", ...shared, "--require-one", path]);
            commandCount += 1;
        } else {
            const type = artifact.type === "dart-symbol" ? "breakpad" : artifact.type === "dif" ? null : artifact.type;
            await sentryCli(api, instance, ["debug-files", "upload", ...shared, ...(type ? ["--type", type] : []), path]);
            commandCount += 1;
        }
    }
    return { release, dist, unitId: input.unitId, commandCount, completed: true };
}

export async function releaseProcessor({ api, config, instance, arguments: args = [], execute = false }) {
    if (!execute) return { releaseTemplate: instance.config.releaseTemplate, completed: false };
    const input = parseReleaseArguments(args);
    const release = applyTemplate(instance.config.releaseTemplate, releaseValues(config, input));
    const shared = ["--org", instance.config.organization, "--project", instance.config.project];
    await sentryCli(api, instance, ["releases", "new", release, ...shared]);
    const source = config.extensions.find((candidate) => candidate.config.source?.repository)?.config.source;
    if (source) {
        await sentryCli(api, instance, ["releases", "set-commits", release, "--commit", `${source.repository}@${input.sourceSha}`, ...shared]);
    }
    await sentryCli(api, instance, ["releases", "finalize", release, ...shared]);
    return { release, commandCount: source ? 3 : 2, completed: true };
}

export async function scheduledIngestProcessor({ api, config, instance, execute = false }) {
    if (!execute) return { schedule: instance.config.schedule, lookbackMinutes: instance.config.lookbackMinutes };
    return syncIncidents({ api, config, instance });
}

export async function resolveProcessor({ api, config, instance, arguments: args = [], execute = false }) {
    if (!execute) return { explicitTrailersRequired: true, replayUncertainWrites: false };
    return resolveIssues({ api, config, instance, before: args[0], after: args[1] });
}

export function auditProcessor({ instance }) {
    return { status: instance.config.lookbackMinutes >= 75 ? "configured" : "fail" };
}

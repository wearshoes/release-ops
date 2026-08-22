const ACTIONS = Object.freeze({
    checkout: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
    node: "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
    upload: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    download: "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
});

const GITHUB_API = "https://api.github.com";
const GITHUB_UPLOADS = "https://uploads.github.com";
const RELEASE_STAGES = new Set(["preflight", "prepare", "build", "sign", "debug-artifacts", "collect", "publish-stage", "publish-finalize"]);

function allBuildUnits(config) {
    return config.extensions.flatMap((candidate) => candidate.config.buildUnits ?? []);
}

function instanceById(config, instanceId) {
    return config.extensions.find((candidate) => candidate.instanceId === instanceId);
}

function secretMappings(node, instance, selectedRoles = null) {
    return Object.fromEntries(node.secretRoles.flatMap(({ role, defaultName }) => {
        if (selectedRoles && !selectedRoles.includes(role)) return [];
        if (!Object.hasOwn(instance.config.secretNames ?? {}, role)
            && !node.secretRoles.find((candidate) => candidate.role === role)?.required) return [];
        const declaration = node.secretRoles.find((candidate) => candidate.role === role);
        const name = declaration.configuredName ?? instance.config.secretNames?.[role] ?? defaultName;
        return name ? [[role, name]] : [];
    }));
}

function unitStageSteps(config, graph, unit, stage) {
    return graph.order.map((id) => graph.nodes.find((node) => node.id === id))
        .filter((node) => node.stage === stage)
        .flatMap((node) => {
            const owner = instanceById(config, node.instanceId);
            if (stage === "sign" && !owner.config.buildUnitIds?.includes(unit.id)) return [];
            if (stage === "debug-artifacts" && !owner.config.debugArtifacts?.some(({ buildUnitId }) => buildUnitId === unit.id)) return [];
            return [{
                name: `${stage} ${unit.id}`,
                processor: node.id,
                operation: stage,
                arguments: stage === "debug-artifacts"
                    ? [unit.id, "${{ inputs.version }}", "${{ inputs.buildNumbers }}", "${{ inputs.sourceSha }}"]
                    : [unit.id],
                secretRoles: secretMappings(node, owner),
            }];
        });
}

function publishStageSteps(config, graph) {
    return graph.order.map((id) => graph.nodes.find((node) => node.id === id))
        .filter((node) => node.stage === "publish-stage")
        .map((node) => {
            const owner = instanceById(config, node.instanceId);
            return {
                name: `Prepare ${node.instanceId}`,
                processor: node.id,
                operation: "publish-stage",
                arguments: ["${{ inputs.version }}", "${{ inputs.buildNumbers }}", "${{ inputs.sourceSha }}"],
                secretRoles: secretMappings(node, owner),
            };
        });
}

function buildJob(config, graph, unit, ownerInstanceId) {
    const buildNode = graph.nodes.find((node) => node.id === `${ownerInstanceId}:build`);
    return {
        name: `Build ${unit.id}`,
        "runs-on": unit.runner,
        "timeout-minutes": 60,
        steps: [
            { uses: ACTIONS.checkout, with: { ref: "${{ inputs.sourceSha }}", "fetch-depth": 0, "persist-credentials": false } },
            { uses: ACTIONS.node, with: { "node-version": "22" } },
            {
                name: `Build ${unit.id}`,
                processor: `${ownerInstanceId}:build`,
                operation: "build",
                arguments: [unit.id],
                secretRoles: secretMappings(buildNode, instanceById(config, ownerInstanceId), unit.requiredSecretRoles),
            },
            ...unitStageSteps(config, graph, unit, "sign"),
            ...unitStageSteps(config, graph, unit, "debug-artifacts"),
            {
                uses: ACTIONS.upload,
                with: {
                    name: `release-ops-${unit.id}`,
                    path: unit.artifacts.map(({ path }) => path).join("\n"),
                    "if-no-files-found": "error",
                    "retention-days": 1,
                },
            },
        ],
    };
}

function publishJob(config, graph, instance, buildJobs, units) {
    const publishNode = graph.nodes.find((node) => node.instanceId === instance.instanceId && node.stage === "publish-finalize");
    return {
        name: "Publish verified artifacts",
        needs: buildJobs,
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 30,
        permissions: { contents: "write" },
        steps: [
            { uses: ACTIONS.checkout, with: { ref: "${{ inputs.sourceSha }}", "fetch-depth": 0, "persist-credentials": false } },
            { uses: ACTIONS.node, with: { "node-version": "22" } },
            ...units.map((unit) => ({
                uses: ACTIONS.download,
                with: { name: `release-ops-${unit.id}`, path: "." },
            })),
            ...publishStageSteps(config, graph),
            {
                name: "Publish verified artifacts",
                processor: publishNode.id,
                operation: "publish",
                arguments: [
                    "${{ inputs.version }}",
                    "${{ inputs.buildNumbers }}",
                    "${{ inputs.sourceSha }}",
                    "${{ inputs.correlation }}",
                ],
                secretRoles: secretMappings(publishNode, instance),
            },
        ],
    };
}

function singleUnitPublishJob(config, graph, instance, unit, ownerInstanceId) {
    const build = buildJob(config, graph, unit, ownerInstanceId);
    const publish = publishJob(config, graph, instance, [], [unit]);
    const { needs: _needs, ...singleJob } = publish;
    return {
        ...singleJob,
        name: `Build ${unit.id} and publish verified artifacts`,
        "runs-on": unit.runner,
        "timeout-minutes": 60,
        steps: [
            ...build.steps.slice(0, -1),
            ...publish.steps.slice(2 + 1),
        ],
    };
}

export function planReleaseProcessor({ api, config, graph, instance }) {
    if (instance.config.mode === "local") return { mode: "local", managedFiles: [] };
    const units = allBuildUnits(config);
    const jobs = units.length === 1
        ? { publish: singleUnitPublishJob(config, graph, instance, units[0], graph.buildUnitOwners[units[0].id]) }
        : Object.fromEntries(units.map((unit) => [
            `build_${unit.id.replaceAll("-", "_")}`,
            buildJob(config, graph, unit, graph.buildUnitOwners[unit.id]),
        ]));
    if (units.length > 1) {
        const buildJobs = Object.keys(jobs);
        jobs.publish = publishJob(config, graph, instance, buildJobs, units);
    }
    api.addWorkflow({
        path: instance.config.workflowFile,
        model: {
            name: "Publish Release",
            "run-name": "Release v${{ inputs.version }} from ${{ inputs.sourceSha }} [${{ inputs.correlation }}]",
            on: {
                workflow_dispatch: {
                    inputs: {
                        version: { required: true, type: "string" },
                        buildNumbers: { required: true, type: "string" },
                        sourceSha: { required: true, type: "string" },
                        correlation: { required: true, type: "string" },
                    },
                },
            },
            permissions: { contents: "read" },
            concurrency: { group: "release-ops-publish", "cancel-in-progress": false },
            jobs,
        },
    });
    return { mode: instance.config.mode, managedFiles: [instance.config.workflowFile] };
}

function applyTemplate(template, values) {
    return template.replaceAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (match, key) => {
        if (values[key] === undefined || values[key] === null) throw new Error(`Template value ${key} is unavailable`);
        return String(values[key]);
    });
}

function scalar(value) {
    const text = String(value ?? "").trim().replace(/^['"]|['"]$/gu, "");
    return /^(?:0|[1-9]\d*)$/u.test(text) ? Number(text) : text;
}

async function readVersionSource(api, source) {
    const text = await api.readText(source.file);
    if (["properties", "gradle-properties"].includes(source.reader)) {
        const values = new Map(text.split(/\r?\n/u).map((line) => {
            const index = line.indexOf("=");
            return index < 0 ? [line.trim(), ""] : [line.slice(0, index).trim(), line.slice(index + 1).trim()];
        }));
        return scalar(values.get(source.key));
    }
    if (["json", "package-json"].includes(source.reader)) {
        return scalar(source.key.split(".").reduce((value, key) => value?.[key], JSON.parse(text)));
    }
    if (source.reader === "text") return scalar(text);
    const escaped = source.key.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const separator = source.reader === "unity" ? ":" : "=";
    const match = text.match(new RegExp(`^\\s*${escaped}\\s*${separator}\\s*(.+)$`, "mu"));
    return scalar(match?.[1]);
}

async function canonicalRelease(api, config, version, buildNumbers) {
    const stacks = config.extensions.filter((candidate) => candidate.config.versioning);
    const versions = [];
    const actualBuildNumbers = {};
    for (const stack of stacks) {
        versions.push(String(await readVersionSource(api, stack.config.versioning.canonical)));
        for (const entry of stack.config.versioning.buildNumbers) {
            if (Object.hasOwn(actualBuildNumbers, entry.id)) throw new Error(`Duplicate build number id: ${entry.id}`);
            actualBuildNumbers[entry.id] = await readVersionSource(api, entry.source);
        }
    }
    if (new Set(versions).size !== 1 || versions[0] !== version) throw new Error("Canonical version does not match release inputs");
    if (JSON.stringify(actualBuildNumbers) !== JSON.stringify(buildNumbers)) throw new Error("Build numbers do not match release inputs");
    const versioning = stacks[0].config.versioning;
    if (stacks.some((stack) => stack.config.versioning.changelogPattern !== versioning.changelogPattern)) {
        throw new Error("Stack changelog contracts do not match");
    }
    const notes = await api.readText(applyTemplate(versioning.changelogPattern, { version, ...buildNumbers }));
    if (!notes.trim() || (versioning.requiresChinese && !/[\u3400-\u9fff]/u.test(notes))) throw new Error("Release changelog is invalid");
    return { notes, versioning };
}

async function sha256(bytes) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function utf8(text) {
    return new TextEncoder().encode(text);
}

function base64(bytes) {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
}

async function jsonRequest(api, origin, path, role, options = {}, allowNotFound = false) {
    const response = await api.request(origin, path, { ...options, secretRole: role });
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${options.method ?? "GET"} request returned HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
}

async function findRelease(api, repository, tag, role) {
    const published = await jsonRequest(api, GITHUB_API, `/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, role, {}, true);
    if (published) return published;
    const releases = await jsonRequest(api, GITHUB_API, `/repos/${repository}/releases?per_page=100`, role);
    if (!Array.isArray(releases)) throw new Error("GitHub returned an invalid Release list");
    return releases.find((release) => release?.tag_name === tag) ?? null;
}

async function ensureDraft(api, repository, prepared, target, role) {
    const existing = await findRelease(api, repository, prepared.tag, role);
    if (existing) {
        if (existing.name !== prepared.title || existing.body !== prepared.notes
            || (existing.target_commitish && existing.target_commitish !== target)) {
            throw new Error(`Existing ${repository} Release is bound to different inputs`);
        }
        return existing;
    }
    return jsonRequest(api, GITHUB_API, `/repos/${repository}/releases`, role, {
        method: "POST",
        json: {
            tag_name: prepared.tag,
            target_commitish: target,
            name: prepared.title,
            body: prepared.notes,
            draft: true,
            prerelease: false,
        },
    });
}

async function replaceAssets(api, repository, release, assets, role) {
    if (release.draft === false) return;
    for (const asset of assets) {
        for (const existing of release.assets ?? []) {
            if (existing.name === asset.name) {
                await jsonRequest(api, GITHUB_API, `/repos/${repository}/releases/assets/${existing.id}`, role, { method: "DELETE" });
            }
        }
        await jsonRequest(
            api,
            GITHUB_UPLOADS,
            `/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`,
            role,
            { method: "POST", body: asset.bytes, contentType: asset.contentType },
        );
    }
}

async function putFile(api, identity, path, text, role, message) {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const apiPath = `/repos/${identity.repository}/contents/${encoded}`;
    const current = await jsonRequest(api, GITHUB_API, `${apiPath}?ref=${encodeURIComponent(identity.defaultBranch)}`, role, {}, true);
    await jsonRequest(api, GITHUB_API, apiPath, role, {
        method: "PUT",
        json: {
            message,
            content: base64(utf8(text)),
            branch: identity.defaultBranch,
            ...(current?.sha ? { sha: current.sha } : {}),
        },
    });
}

async function publishDraft(api, repository, release, role) {
    if (!release.draft) return release;
    return jsonRequest(api, GITHUB_API, `/repos/${repository}/releases/${release.id}`, role, {
        method: "PATCH",
        json: { draft: false, prerelease: false },
    });
}

function jsonAsset(name, value) {
    return { name, bytes: utf8(`${JSON.stringify(value, null, 2)}\n`), contentType: "application/json; charset=utf-8" };
}

function latestProjection(instance, prepared, manifest) {
    if (instance.config.manifest.compatibility !== "android-version-code-v1") return manifest;
    const primary = manifest.artifacts[0];
    const versionCode = prepared.buildNumbers[instance.config.manifest.latestBuildNumberId];
    if (!Number.isSafeInteger(versionCode) || !primary) throw new Error("Android latest projection inputs are invalid");
    return {
        versionCode,
        versionName: prepared.version,
        minimumSupportedVersionCode: instance.config.manifest.minimumSupportedBuildNumber,
        apkUrl: primary.downloadUrl,
        releaseUrl: manifest.releaseUrl,
        sha256: primary.sha256,
        releaseNotes: prepared.notes,
        publishedAt: prepared.publishedAt,
    };
}

function dispatchTitle(version, sourceSha, correlation) {
    return `Release v${version} from ${sourceSha} [${correlation}]`;
}

function requiredReleaseSecrets(config, graph) {
    const names = new Set();
    for (const node of graph.nodes.filter((candidate) => RELEASE_STAGES.has(candidate.stage))) {
        const owner = instanceById(config, node.instanceId);
        for (const declaration of node.secretRoles) {
            const name = declaration.configuredName ?? owner.config.secretNames?.[declaration.role] ?? declaration.defaultName;
            if (name && name !== "GITHUB_TOKEN") names.add(name);
        }
    }
    return [...names].sort();
}

async function repositorySecrets(api, repository) {
    const names = new Set();
    for (let page = 1; page <= 100; page += 1) {
        const data = await jsonRequest(
            api,
            GITHUB_API,
            `/repos/${repository}/actions/secrets?per_page=100&page=${page}`,
            "source-release",
        );
        if (!Array.isArray(data?.secrets)) throw new Error("GitHub returned invalid Actions Secret metadata");
        for (const secret of data.secrets) if (typeof secret?.name === "string") names.add(secret.name);
        if (data.secrets.length < 100) break;
    }
    return names;
}

function validateRun(run, expected) {
    if (!Number.isSafeInteger(run?.id) || run.id <= 0 || run.event !== "workflow_dispatch"
        || run.head_branch !== expected.branch || !/^https:\/\/github\.com\//u.test(run.html_url ?? "")) {
        throw new Error("GitHub returned an invalid correlated workflow run");
    }
    if (run.display_title !== expected.title) return null;
    return run;
}

async function discoverRun(api, repository, workflow, expected) {
    const matches = [];
    for (let page = 1; page <= 10; page += 1) {
        const data = await jsonRequest(
            api,
            GITHUB_API,
            `/repos/${repository}/actions/workflows/${workflow}/runs?event=workflow_dispatch&branch=${encodeURIComponent(expected.branch)}&per_page=100&page=${page}`,
            "source-release",
        );
        if (!Array.isArray(data?.workflow_runs)) throw new Error("GitHub returned an invalid workflow run list");
        matches.push(...data.workflow_runs.map((run) => validateRun(run, expected)).filter(Boolean));
        if (data.workflow_runs.length < 100) break;
    }
    if (matches.length > 1) throw new Error("Release correlation matched multiple workflow runs");
    return matches[0] ?? null;
}

function ambiguousDispatch(error) {
    const match = String(error?.message ?? "").match(/HTTP (\d{3})/u);
    const status = Number(match?.[1]);
    return !(status >= 400 && status < 500 && status !== 408);
}

async function dispatchAndWait(api, instance, inputs, {
    now = () => Date.now(),
    sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
    timeoutMs = 120 * 60 * 1000,
    pollIntervalMs = 5_000,
} = {}) {
    const repository = instance.config.source.repository;
    const workflow = instance.config.workflowFile.split("/").at(-1);
    const expected = {
        branch: instance.config.source.defaultBranch,
        title: dispatchTitle(inputs.version, inputs.sourceSha, inputs.correlation),
    };
    let runId = null;
    let ambiguousError = null;
    try {
        const data = await jsonRequest(
            api,
            GITHUB_API,
            `/repos/${repository}/actions/workflows/${workflow}/dispatches`,
            "source-release",
            { method: "POST", json: { ref: expected.branch, inputs } },
        );
        if (Number.isSafeInteger(data?.workflow_run_id) && data.workflow_run_id > 0) runId = data.workflow_run_id;
    } catch (error) {
        if (!ambiguousDispatch(error)) throw error;
        ambiguousError = error;
    }
    const deadline = now() + timeoutMs;
    while (now() <= deadline) {
        let run = runId === null
            ? await discoverRun(api, repository, workflow, expected)
            : validateRun(await jsonRequest(api, GITHUB_API, `/repos/${repository}/actions/runs/${runId}`, "source-release"), expected);
        if (run) runId = run.id;
        if (run?.status === "completed") {
            if (run.conclusion !== "success") throw new Error(`Release workflow completed with ${run.conclusion ?? "unknown"}: ${run.html_url}`);
            return run;
        }
        await sleep(pollIntervalMs);
    }
    throw new Error("Timed out waiting for the release workflow", { cause: ambiguousError });
}

export async function preflightProcessor({ api, config, graph, instance, operation, arguments: args = [], execute = false, timing = {} }) {
    if (!execute || operation !== "dispatch") return { mode: instance.config.mode, source: instance.config.source ?? null };
    const [version, buildNumbersJson, sourceSha, correlation] = args;
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version ?? "") || !/^[0-9a-f]{40}$/u.test(sourceSha ?? "")
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(correlation ?? "")) {
        throw new Error("Release dispatch inputs are invalid");
    }
    let buildNumbers;
    try {
        buildNumbers = JSON.parse(buildNumbersJson);
    } catch (error) {
        throw new Error("Release build numbers must be JSON", { cause: error });
    }
    const available = await repositorySecrets(api, instance.config.source.repository);
    const missing = requiredReleaseSecrets(config, graph).filter((name) => !available.has(name));
    if (missing.length) throw new Error(`Required Actions Secret metadata is missing: ${missing.join(", ")}`);
    const run = await dispatchAndWait(api, instance, { version, buildNumbers: JSON.stringify(buildNumbers), sourceSha, correlation }, timing);
    return {
        schemaVersion: "release-ops/release-dispatch/v1",
        repository: instance.config.source.repository,
        version,
        buildNumbers,
        sourceSha,
        correlation,
        runId: run.id,
        runUrl: run.html_url,
        success: true,
    };
}

export function collectProcessor() {
    return { collected: false };
}

export async function publishProcessor({ api, config, instance, arguments: args, execute }) {
    if (!execute) return { mode: instance.config.mode, published: false, resumable: true };
    const [version, buildNumbersJson, sourceSha, correlation] = args;
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version ?? "") || !/^[0-9a-f]{40}$/u.test(sourceSha ?? "")) {
        throw new Error("Release inputs are invalid");
    }
    let buildNumbers;
    try {
        buildNumbers = JSON.parse(buildNumbersJson);
    } catch (error) {
        throw new Error("Build numbers must be JSON", { cause: error });
    }
    const canonical = await canonicalRelease(api, config, version, buildNumbers);
    const values = { version, ...buildNumbers };
    const artifacts = [];
    for (const unit of allBuildUnits(config)) {
        for (const declared of unit.artifacts) {
            const bytes = await api.readBytes(applyTemplate(declared.path, values));
            artifacts.push({
                ...declared,
                name: applyTemplate(declared.nameTemplate, values),
                bytes,
                size: bytes.length,
                sha256: await sha256(bytes),
            });
        }
    }
    if (new Set(artifacts.map(({ name }) => name)).size !== artifacts.length) throw new Error("Release artifact names are duplicated");
    if (artifacts.some(({ name }) => !name || name.includes("/") || name.includes("\\"))) {
        throw new Error("Release artifact names must not contain paths");
    }
    const prepared = {
        version,
        buildNumbers,
        sourceSha,
        correlation,
        notes: canonical.notes,
        tag: applyTemplate(instance.config.tagTemplate, values),
        title: applyTemplate(instance.config.titleTemplate, values),
        publishedAt: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
    };
    if (instance.config.mode === "local") {
        const manifest = {
            schemaVersion: "release-ops/release-manifest/v1",
            version,
            buildNumbers,
            publishedAt: prepared.publishedAt,
            artifacts: artifacts.map(({ name, platform, architecture, size, sha256: digest }) => ({
                name, platform, architecture, size, sha256: digest,
            })),
        };
        const outputRoot = `${instance.config.localOutputDirectory}/${prepared.tag}`;
        for (const artifact of artifacts) await api.writeOutput(`${outputRoot}/${artifact.name}`, artifact.bytes);
        await api.writeOutput(
            `${outputRoot}/${instance.config.manifest.assetName}`,
            `${JSON.stringify(manifest, null, 2)}\n`,
        );
        await api.writeOutput(`${outputRoot}/CHANGELOG.md`, prepared.notes);
        return {
            schemaVersion: "release-ops/publish-result/v1",
            mode: "local",
            version,
            manifest,
            outputRoot,
            correlation,
        };
    }
    const source = instance.config.source;
    const distribution = instance.config.mode === "dual-repository" ? instance.config.distribution : source;
    const manifest = {
        schemaVersion: "release-ops/release-manifest/v1",
        version,
        buildNumbers,
        publishedAt: prepared.publishedAt,
        releaseUrl: `https://github.com/${distribution.repository}/releases/tag/${prepared.tag}`,
        artifacts: artifacts.map(({ name, platform, architecture, size, sha256: digest }) => ({
            name,
            downloadUrl: `https://github.com/${distribution.repository}/releases/download/${prepared.tag}/${encodeURIComponent(name)}`,
            platform,
            architecture,
            size,
            sha256: digest,
        })),
    };
    const latest = latestProjection(instance, prepared, manifest);
    const shared = [
        ...artifacts,
        jsonAsset(instance.config.manifest.assetName, manifest),
        jsonAsset(instance.config.manifest.latestPath.split("/").at(-1), latest),
    ];
    const sourceRole = "source-release";
    const distributionRole = instance.config.mode === "dual-repository" ? "distribution-release" : sourceRole;
    const sourceRelease = await ensureDraft(api, source.repository, prepared, sourceSha, sourceRole);
    const publicRelease = distribution.repository === source.repository
        ? sourceRelease
        : await ensureDraft(api, distribution.repository, prepared, distribution.defaultBranch, distributionRole);
    await replaceAssets(api, source.repository, sourceRelease, shared, sourceRole);
    if (distribution.repository !== source.repository) {
        await replaceAssets(api, distribution.repository, publicRelease, shared, distributionRole);
    }
    await putFile(
        api,
        distribution,
        instance.config.manifest.latestPath,
        `${JSON.stringify(latest, null, 2)}\n`,
        distributionRole,
        `release: ${prepared.tag}`,
    );
    if (instance.config.publicReadmeSource && instance.config.publicReadmeTarget) {
        await putFile(
            api,
            distribution,
            instance.config.publicReadmeTarget,
            await api.readText(instance.config.publicReadmeSource),
            distributionRole,
            `docs: synchronize release README for ${prepared.tag}`,
        );
    }
    const publishedSource = await publishDraft(api, source.repository, sourceRelease, sourceRole);
    const publishedPublic = distribution.repository === source.repository
        ? publishedSource
        : await publishDraft(api, distribution.repository, publicRelease, distributionRole);
    return {
        schemaVersion: "release-ops/publish-result/v1",
        mode: instance.config.mode,
        version,
        tag: prepared.tag,
        manifest,
        sourceReleaseUrl: publishedSource.html_url,
        publicReleaseUrl: publishedPublic.html_url,
        correlation,
    };
}

export function auditProcessor({ instance }) {
    return { status: instance.config.mode ? "configured" : "fail" };
}

const GITHUB_ORIGIN = "https://api.github.com";
const INCIDENT_SCHEMA = "release-ops-sentry-incident/v2";
const MARKER_PATTERN = /<!-- release-ops-sentry:v2 project=([A-Za-z0-9_-]+) issue_id=(\d+) -->/u;
const RECORD_PATTERN = /<!-- release-ops-sentry-record:v2 ([A-Za-z0-9_-]{10,20000}) -->/u;

function releaseConfig(config) {
    const matches = config.extensions.filter((candidate) => candidate.config?.source?.repository);
    if (matches.length !== 1) throw new Error("Sentry requires exactly one GitHub release instance");
    return matches[0].config;
}

function apiIdentity(instance) {
    const base = new URL(instance.config.apiBase.endsWith("/") ? instance.config.apiBase : `${instance.config.apiBase}/`);
    return { origin: base.origin, basePath: base.pathname };
}

function sentryPath(instance, relativePath) {
    const { basePath } = apiIdentity(instance);
    return `${basePath}${String(relativePath).replace(/^\/+/, "")}`;
}

async function responseJson(response, label, allowNotFound = false) {
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
}

async function requestJson(api, origin, path, role, options = {}, allowNotFound = false) {
    const response = await api.request(origin, path, { ...options, secretRole: role });
    return responseJson(response, `${origin === GITHUB_ORIGIN ? "GitHub" : "Sentry"} ${options.method ?? "GET"}`, allowNotFound);
}

function nextLink(header, { requireResults = false } = {}) {
    if (!header) return null;
    for (const part of header.split(",")) {
        const match = part.match(/^\s*<([^>]+)>\s*;(.*)$/u);
        if (!match) continue;
        const parameters = new Map(match[2].split(";").map((entry) => {
            const [key, ...rest] = entry.trim().split("=");
            return [key, rest.join("=").replace(/^"|"$/gu, "")];
        }));
        if (parameters.get("rel") === "next"
            && (!requireResults || parameters.get("results") === "true")) return match[1];
    }
    return null;
}

async function paginate(api, origin, firstPath, role, { requireResults = false } = {}) {
    const values = [];
    let next = firstPath;
    for (let page = 0; next; page += 1) {
        if (page >= 100) throw new Error("Incident pagination exceeded 100 pages");
        const response = await api.request(origin, next, { secretRole: role });
        const data = await responseJson(response, origin === GITHUB_ORIGIN ? "GitHub GET" : "Sentry GET");
        if (!Array.isArray(data)) throw new Error("Paginated incident response must be an array");
        values.push(...data);
        const candidate = nextLink(response.headers.get("link"), { requireResults });
        if (candidate) {
            const parsed = new URL(candidate, origin);
            if (parsed.origin !== origin) throw new Error("Incident pagination escaped its configured origin");
        }
        next = candidate;
    }
    return values;
}

function bounded(value, length = 160) {
    const normalized = String(value ?? "").replaceAll(/[\u0000-\u001f\u007f]/gu, " ").replaceAll(/\s+/gu, " ").trim();
    return normalized ? normalized.slice(0, length) : "unknown";
}

function safeIdentifier(value, fallback = "unknown") {
    const text = bounded(value, 160);
    return /^[A-Za-z0-9_.$+:-]+$/u.test(text) ? text : fallback;
}

function basename(value) {
    return String(value ?? "unknown").replaceAll("\\", "/").split("/").at(-1);
}

function exceptionValues(event) {
    const values = event?.exception?.values ?? event?.entries?.find((entry) => entry?.type === "exception")?.data?.values;
    return Array.isArray(values) ? values : [];
}

function framesFor(value) {
    const frames = value?.stacktrace?.frames;
    if (!Array.isArray(frames)) return [];
    return frames.filter((frame) => frame?.inApp === true).slice(-30).map((frame) => ({
        module: safeIdentifier(frame?.module),
        function: safeIdentifier(frame?.function),
        filename: bounded(basename(frame?.filename), 120),
        line: Number.isSafeInteger(frame?.lineNo) && frame.lineNo > 0 ? frame.lineNo : null,
    }));
}

function safePrivateUrl(value, expectedHost) {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "https:" || url.hostname !== expectedHost || !/^\/issues\/\d+\/?$/u.test(url.pathname)) {
        throw new Error("Sentry returned an invalid private Issue URL");
    }
    return `${url.origin}${url.pathname}`;
}

export function sanitizeIncident(group, event, { project, host }) {
    const issueId = String(group?.id ?? "");
    if (!/^\d+$/u.test(issueId)) throw new Error("Sentry Issue id is invalid");
    const eventId = String(event?.eventID ?? event?.event_id ?? event?.id ?? "");
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(eventId)) throw new Error("Sentry event id is invalid");
    const values = exceptionValues(event);
    const exception = values.at(-1) ?? {};
    const frames = framesFor(exception);
    const primary = frames.at(-1);
    return {
        schemaVersion: INCIDENT_SCHEMA,
        project,
        issueId,
        eventId,
        shortId: safeIdentifier(group?.shortId, `SENTRY-${issueId}`),
        privateUrl: safePrivateUrl(group?.permalink, host),
        status: ["unresolved", "resolved", "ignored"].includes(group?.status) ? group.status : "unresolved",
        level: ["fatal", "error", "warning", "info"].includes(group?.level) ? group.level : "error",
        firstSeen: bounded(group?.firstSeen, 40),
        lastSeen: bounded(group?.lastSeen, 40),
        eventCount: Number.isSafeInteger(Number(group?.count)) ? Math.max(0, Number(group.count)) : 0,
        exceptionType: safeIdentifier(exception?.type ?? group?.metadata?.type, "UnknownError"),
        culprit: primary ? `${primary.module}.${primary.function}` : safeIdentifier(group?.culprit),
        release: bounded(event?.release?.version ?? event?.release ?? group?.lastRelease?.version, 120),
        environment: safeIdentifier(event?.environment, "unknown"),
        frames,
    };
}

function base64UrlEncode(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value) {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function incidentMarker(project, issueId) {
    return `<!-- release-ops-sentry:v2 project=${project} issue_id=${issueId} -->`;
}

function recordMarker(incident) {
    return `<!-- release-ops-sentry-record:v2 ${base64UrlEncode(JSON.stringify(incident))} -->`;
}

export function parseIncidentBody(body) {
    const text = String(body ?? "");
    const marker = text.match(MARKER_PATTERN);
    const record = text.match(RECORD_PATTERN);
    if (!marker || !record || (text.match(new RegExp(MARKER_PATTERN.source, "gu")) ?? []).length !== 1) {
        throw new Error("GitHub Issue does not contain one valid Sentry marker and record");
    }
    let data;
    try {
        data = JSON.parse(base64UrlDecode(record[1]));
    } catch {
        throw new Error("GitHub Issue contains an invalid Sentry record");
    }
    if (data.schemaVersion !== INCIDENT_SCHEMA || data.project !== marker[1] || data.issueId !== marker[2]) {
        throw new Error("GitHub Issue Sentry identity is inconsistent");
    }
    return data;
}

export function renderIncident(incident) {
    const title = `[Sentry][${incident.level}][${incident.release}] ${incident.exceptionType}: ${incident.culprit}`.slice(0, 240);
    const stack = incident.frames.length
        ? incident.frames.map((frame) => `- \`${frame.module}.${frame.function} (${frame.filename}${frame.line ? `:${frame.line}` : ""})\``).join("\n")
        : "- `No in-app frame was provided`";
    const body = `${incidentMarker(incident.project, incident.issueId)}
${recordMarker(incident)}

## Sentry incident

- Private group: ${incident.privateUrl}
- Short ID: \`${incident.shortId}\`
- Level: \`${incident.level}\`
- Status: \`${incident.status}\`
- Release: \`${incident.release}\`
- Environment: \`${incident.environment}\`
- First seen: \`${incident.firstSeen}\`
- Last seen: \`${incident.lastSeen}\`
- Event count: \`${incident.eventCount}\`
- Exception: \`${incident.exceptionType}\`
- Culprit: \`${incident.culprit}\`

## In-app frames

${stack}
`;
    return { title, body };
}

async function ensureLabels(api, repository) {
    const labels = await paginate(api, GITHUB_ORIGIN, `/repos/${repository}/labels?per_page=100`, "github-token");
    const names = new Set(labels.map(({ name }) => name));
    for (const label of [
        { name: "sentry", color: "B60205", description: "Managed Sentry incident" },
        { name: "automated-error", color: "D93F0B", description: "Automated error intake" },
    ]) {
        if (!names.has(label.name)) {
            await requestJson(api, GITHUB_ORIGIN, `/repos/${repository}/labels`, "github-token", { method: "POST", json: label });
        }
    }
}

async function allManagedIssues(api, repository) {
    const issues = await paginate(api, GITHUB_ORIGIN, `/repos/${repository}/issues?state=all&labels=sentry&per_page=100`, "github-token");
    const result = new Map();
    for (const issue of issues) {
        if (issue?.pull_request) continue;
        const match = String(issue.body ?? "").match(MARKER_PATTERN);
        if (match) result.set(`${match[1]}:${match[2]}`, issue);
    }
    return result;
}

export async function syncIncidents({ api, config, instance }) {
    if (!instance.config.issueSync || instance.config.lookbackMinutes < 75) throw new Error("Sentry incident synchronization is disabled or unsafe");
    const release = releaseConfig(config);
    if (release.source.visibility !== "private") throw new Error("Sentry incidents require a private GitHub source repository");
    const repository = release.source.repository;
    const { origin, basePath } = apiIdentity(instance);
    await ensureLabels(api, repository);
    const issuePath = `${basePath}organizations/${instance.config.organization}/issues/?project=${encodeURIComponent(instance.config.project)}&query=is%3Aunresolved&sort=date&statsPeriod=${instance.config.lookbackMinutes}m`;
    const groups = await paginate(api, origin, issuePath, "incident-read", { requireResults: true });
    const existing = await allManagedIssues(api, repository);
    const seen = new Set();
    let created = 0;
    let updated = 0;
    let closed = 0;
    for (const group of groups) {
        const event = await requestJson(api, origin, sentryPath(instance, `/issues/${group.id}/events/latest/`), "incident-read");
        const incident = sanitizeIncident(group, event, { project: instance.config.project, host: new URL(instance.config.apiBase).hostname });
        const key = `${incident.project}:${incident.issueId}`;
        seen.add(key);
        const rendered = renderIncident(incident);
        const issue = existing.get(key);
        if (!issue) {
            await requestJson(api, GITHUB_ORIGIN, `/repos/${repository}/issues`, "github-token", {
                method: "POST", json: { ...rendered, labels: ["sentry", "automated-error"] },
            });
            created += 1;
        } else {
            const ignored = issue.labels?.some(({ name }) => name === "sentry-ignore");
            await requestJson(api, GITHUB_ORIGIN, `/repos/${repository}/issues/${issue.number}`, "github-token", {
                method: "PATCH", json: { ...rendered, ...(issue.state === "closed" && !ignored ? { state: "open" } : {}) },
            });
            updated += 1;
        }
    }
    for (const [key, issue] of existing) {
        if (seen.has(key) || issue.state === "closed") continue;
        const incident = parseIncidentBody(issue.body);
        const group = await requestJson(
            api,
            origin,
            sentryPath(instance, `/organizations/${instance.config.organization}/issues/${incident.issueId}/`),
            "incident-read",
        );
        if (["resolved", "ignored"].includes(group?.status)) {
            await requestJson(api, GITHUB_ORIGIN, `/repos/${repository}/issues/${issue.number}`, "github-token", {
                method: "PATCH", json: { state: "closed" },
            });
            closed += 1;
        }
    }
    return {
        schemaVersion: "release-ops/sentry-sync/v1",
        repository,
        lookbackMinutes: instance.config.lookbackMinutes,
        created,
        updated,
        closed,
    };
}

function trailers(message) {
    const issueLines = [...String(message).matchAll(/^Issues:\s*(.+)$/gmu)];
    const commitLines = [...String(message).matchAll(/^Commit-ID:\s*(\S+)\s*$/gmu)];
    if (!issueLines.length && !commitLines.length) return null;
    if (issueLines.length !== 1 || commitLines.length !== 1) throw new Error("Resolution commit must contain one Issues and one Commit-ID trailer");
    const tokens = issueLines[0][1].trim().split(/\s+/u);
    if (!tokens.length || tokens.some((token) => !/^#[1-9]\d*$/u.test(token))) throw new Error("Issues trailer is invalid");
    const issues = tokens.map((token) => Number(token.slice(1)));
    if (new Set(issues).size !== issues.length) throw new Error("Issues trailer contains duplicates");
    return { issues, commit: commitLines[0][1] };
}

async function pushedCommits(api, before, after) {
    if (!/^[0-9a-f]{40}$/u.test(after)) throw new Error("Push after SHA is invalid");
    const range = /^0{40}$/u.test(before) || !/^[0-9a-f]{40}$/u.test(before) ? after : `${before}..${after}`;
    const listed = await api.execFile("git", ["rev-list", "--reverse", range]);
    const shas = String(listed.stdout ?? "").trim().split(/\r?\n/u).filter(Boolean);
    const commits = [];
    for (const id of shas) {
        const shown = await api.execFile("git", ["show", "-s", "--format=%B", id]);
        commits.push({ id, message: String(shown.stdout ?? "").trimEnd() });
    }
    return commits;
}

async function resolutionBindings(api, before, after) {
    const commits = await pushedCommits(api, before, after);
    const bindings = [];
    const seen = new Set();
    for (const commit of commits) {
        const parsed = trailers(commit.message);
        if (!parsed) continue;
        const commitSha = parsed.commit === "HEAD" ? commit.id : parsed.commit;
        if (!/^[0-9a-f]{40}$/u.test(commitSha)) throw new Error("Commit-ID must be HEAD or a full lowercase SHA");
        try {
            await api.execFile("git", ["merge-base", "--is-ancestor", commitSha, after]);
        } catch (error) {
            throw new Error("Commit-ID is not an ancestor of the pushed default-branch head", { cause: error });
        }
        for (const issueNumber of parsed.issues) {
            if (seen.has(issueNumber)) throw new Error("An Issue may appear only once in one push");
            seen.add(issueNumber);
            bindings.push({ issueNumber, commitSha, subject: commit.message.split(/\r?\n/u)[0].slice(0, 200) });
        }
    }
    return bindings.sort((left, right) => left.issueNumber - right.issueNumber);
}

async function resolveSentryIncident({ api, config, instance, issue, commitSha }) {
    const incident = parseIncidentBody(issue.body);
    if (incident.project !== instance.config.project) throw new Error("Sentry project identity does not match configuration");
    if (!issue.labels?.some(({ name }) => name === "sentry")
        || !issue.labels?.some(({ name }) => name === "automated-error")) {
        throw new Error("GitHub Issue is missing managed Sentry labels");
    }
    const release = releaseConfig(config);
    const repository = release.source.repository;
    const { origin } = apiIdentity(instance);
    const path = sentryPath(instance, `/organizations/${instance.config.organization}/issues/${incident.issueId}/`);
    const group = await requestJson(api, origin, path, "incident-read");
    if (String(group?.id) !== incident.issueId || group?.project?.slug !== instance.config.project) {
        throw new Error("Sentry group identity does not match the GitHub Issue");
    }
    const event = await requestJson(api, origin, sentryPath(instance, `/issues/${incident.issueId}/events/latest/`), "incident-read");
    if (String(event?.eventID ?? event?.event_id ?? event?.id) !== incident.eventId) {
        throw new Error("Sentry occurrence changed after GitHub intake");
    }
    const markerBase = `release-ops-sentry-resolve:v2 issue_id=${incident.issueId} commit=${commitSha}`;
    const comments = await paginate(
        api,
        GITHUB_ORIGIN,
        `/repos/${repository}/issues/${issue.number}/comments?per_page=100`,
        "github-token",
    );
    const hasStart = comments.some(({ body }) => String(body).includes(`<!-- ${markerBase} state=start -->`));
    const hasApplied = comments.some(({ body }) => String(body).includes(`<!-- ${markerBase} state=applied -->`));
    if (!hasStart) {
        await requestJson(api, GITHUB_ORIGIN, `/repos/${repository}/issues/${issue.number}/comments`, "github-token", {
            method: "POST",
            json: { body: `<!-- ${markerBase} state=start -->\nResolution started for the explicitly bound commit.` },
        });
    }
    if (hasStart && !hasApplied && group?.status !== "resolved") {
        throw new Error("SENTRY_WRITE_UNCERTAIN: an earlier write may have been accepted; manual reconciliation is required");
    }
    if (!hasApplied && group?.status !== "resolved") {
        await requestJson(api, origin, path, "incident-write", { method: "PUT", json: { status: "resolved" } });
    }
    if (!hasApplied) {
        await requestJson(api, GITHUB_ORIGIN, `/repos/${repository}/issues/${issue.number}/comments`, "github-token", {
            method: "POST",
            json: { body: `<!-- ${markerBase} state=applied -->\nSentry accepted the resolved transition.` },
        });
    }
}

export async function resolveIssues({ api, config, instance, before, after }) {
    const release = releaseConfig(config);
    if (release.source.visibility !== "private") throw new Error("Issue resolution requires a private GitHub source repository");
    const repository = release.source.repository;
    const bindings = await resolutionBindings(api, before, after);
    const results = [];
    for (const binding of bindings) {
        let kind = "github";
        try {
            const issue = await requestJson(api, GITHUB_ORIGIN, `/repos/${repository}/issues/${binding.issueNumber}`, "github-token");
            try {
                parseIncidentBody(issue.body);
                kind = "sentry";
            } catch (error) {
                if (String(issue.body ?? "").includes("release-ops-sentry:")) throw error;
            }
            if (kind === "sentry") await resolveSentryIncident({ api, config, instance, issue, commitSha: binding.commitSha });
            await requestJson(api, GITHUB_ORIGIN, `/repos/${repository}/issues/${issue.number}/comments`, "github-token", {
                method: "POST",
                json: { body: `Resolved by commit https://github.com/${repository}/commit/${binding.commitSha}\n\n${binding.subject}` },
            });
            await requestJson(api, GITHUB_ORIGIN, `/repos/${repository}/issues/${issue.number}`, "github-token", {
                method: "PATCH", json: { state: "closed" },
            });
            results.push({ issueNumber: binding.issueNumber, kind, result: "resolved" });
        } catch {
            results.push({ issueNumber: binding.issueNumber, kind, result: "failed", errorCategory: "RESOLUTION_FAILED" });
        }
    }
    const result = {
        schemaVersion: "release-ops/issue-resolution-batch/v1",
        results,
        success: results.every(({ result: status }) => status === "resolved"),
    };
    if (!result.success) {
        const failed = results.filter(({ result: status }) => status === "failed").map(({ issueNumber }) => issueNumber);
        throw new Error(`Issue resolution failed for: ${failed.join(", ")}`);
    }
    return result;
}

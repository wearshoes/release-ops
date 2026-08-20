import { basename } from "node:path";

import { incidentProviderConfig, releaseConfig } from "./config-query.mjs";

export const INCIDENT_SCHEMA = "release-ops-sentry-incident/v2";
const MARKER_PATTERN = /<!-- release-ops-sentry:v2 project=([A-Za-z0-9_-]+) issue_id=(\d+) -->/u;
const RECORD_PATTERN = /<!-- release-ops-sentry-record:v2 ([A-Za-z0-9_-]{10,20000}) -->/u;

function bounded(value, length = 160) {
    const normalized = String(value ?? "").replaceAll(/[\u0000-\u001f\u007f]/gu, " ").replaceAll(/\s+/gu, " ").trim();
    return normalized ? normalized.slice(0, length) : "unknown";
}

function safeIdentifier(value, fallback = "unknown") {
    const text = bounded(value, 160);
    return /^[A-Za-z0-9_.$+:-]+$/u.test(text) ? text : fallback;
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
        filename: bounded(basename(String(frame?.filename ?? "unknown")), 120),
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

export function sanitizeSentryIncident(group, event, { project, host }) {
    const issueId = String(group?.id ?? "");
    if (!/^\d+$/u.test(issueId)) throw new Error("Sentry Issue id is invalid");
    const eventId = String(event?.eventID ?? event?.event_id ?? event?.id ?? "");
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(eventId)) throw new Error("Sentry event id is invalid");
    const values = exceptionValues(event);
    const exception = values.at(-1) ?? {};
    const frames = framesFor(exception);
    const primary = frames.at(-1);
    const status = ["unresolved", "resolved", "ignored"].includes(group?.status) ? group.status : "unresolved";
    return {
        schemaVersion: INCIDENT_SCHEMA,
        project,
        issueId,
        eventId,
        shortId: safeIdentifier(group?.shortId, `SENTRY-${issueId}`),
        privateUrl: safePrivateUrl(group?.permalink, host),
        status,
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

export function incidentMarker(project, issueId) {
    if (!/^[A-Za-z0-9_-]+$/u.test(project) || !/^\d+$/u.test(String(issueId))) throw new Error("Incident marker identity is invalid");
    return `<!-- release-ops-sentry:v2 project=${project} issue_id=${issueId} -->`;
}

export function recordMarker(incident) {
    return `<!-- release-ops-sentry-record:v2 ${Buffer.from(JSON.stringify(incident), "utf8").toString("base64url")} -->`;
}

export function parseIncidentBody(body) {
    const marker = MARKER_PATTERN.exec(String(body ?? ""));
    const record = RECORD_PATTERN.exec(String(body ?? ""));
    if (!marker || !record || (String(body).match(new RegExp(MARKER_PATTERN.source, "gu")) ?? []).length !== 1) {
        throw new Error("GitHub Issue does not contain one valid Sentry marker and record");
    }
    let data;
    try {
        data = JSON.parse(Buffer.from(record[1], "base64url").toString("utf8"));
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

async function ensureLabels(github, repository) {
    const labels = (await github.request(`/repos/${repository}/labels?per_page=100`)).data;
    const names = new Set(Array.isArray(labels) ? labels.map(({ name }) => name) : []);
    for (const label of [
        { name: "sentry", color: "B60205", description: "Managed Sentry incident" },
        { name: "automated-error", color: "D93F0B", description: "Automated error intake" },
    ]) {
        if (!names.has(label.name)) await github.request(`/repos/${repository}/labels`, { method: "POST", json: label });
    }
}

async function allManagedIssues(github, repository) {
    const issues = (await github.request(`/repos/${repository}/issues?state=all&labels=sentry&per_page=100`)).data;
    if (!Array.isArray(issues)) throw new Error("GitHub returned an invalid Issue list");
    const result = new Map();
    for (const issue of issues) {
        if (issue?.pull_request) continue;
        const match = MARKER_PATTERN.exec(String(issue.body ?? ""));
        if (match) result.set(`${match[1]}:${match[2]}`, issue);
    }
    return result;
}

export async function syncSentryIncidents({ config, sentry, github }) {
    const provider = incidentProviderConfig(config);
    const release = releaseConfig(config);
    if (!provider.issueSync || release.mode === "local") {
        throw new Error("Sentry-to-GitHub synchronization is disabled");
    }
    const repository = release.source.repository;
    await ensureLabels(github, repository);
    const issuePath = `/organizations/${provider.organization}/issues/?project=${encodeURIComponent(provider.project)}&query=is%3Aunresolved&sort=date&statsPeriod=${provider.lookbackMinutes}m`;
    const groups = sentry.paginate ? await sentry.paginate(issuePath) : (await sentry.request(issuePath)).data;
    if (!Array.isArray(groups)) throw new Error("Sentry returned an invalid Issue list");
    const existing = await allManagedIssues(github, repository);
    const seen = new Set();
    let created = 0;
    let updated = 0;
    for (const group of groups) {
        const event = (await sentry.request(`/issues/${group.id}/events/latest/`)).data;
        const incident = sanitizeSentryIncident(group, event, { project: provider.project, host: new URL(provider.apiBase).hostname });
        const key = `${incident.project}:${incident.issueId}`;
        seen.add(key);
        const rendered = renderIncident(incident);
        const issue = existing.get(key);
        if (!issue) {
            await github.request(`/repos/${repository}/issues`, { method: "POST", json: { ...rendered, labels: ["sentry", "automated-error"] } });
            created += 1;
        } else {
            const ignored = issue.labels?.some(({ name }) => name === "sentry-ignore");
            await github.request(`/repos/${repository}/issues/${issue.number}`, {
                method: "PATCH",
                json: { ...rendered, ...(issue.state === "closed" && !ignored ? { state: "open" } : {}) },
            });
            updated += 1;
        }
    }
    for (const [key, issue] of existing) {
        if (seen.has(key) || issue.state === "closed") continue;
        const incident = parseIncidentBody(issue.body);
        const group = (await sentry.request(`/organizations/${provider.organization}/issues/${incident.issueId}/`)).data;
        if (["resolved", "ignored"].includes(group?.status)) {
            await github.request(`/repos/${repository}/issues/${issue.number}`, { method: "PATCH", json: { state: "closed" } });
        }
    }
    return { schemaVersion: "release-ops-sentry-sync/v2", repository, lookbackMinutes: provider.lookbackMinutes, created, updated };
}

export async function resolveSentryIncident({ config, issue, commitSha, sentryRead, sentryWrite, github }) {
    if (!/^[0-9a-f]{40}$/u.test(commitSha)) throw new Error("Resolution requires a full lowercase commit SHA");
    const incident = parseIncidentBody(issue.body);
    const provider = incidentProviderConfig(config);
    if (incident.project !== provider.project) throw new Error("Sentry project identity does not match configuration");
    const path = `/organizations/${provider.organization}/issues/${incident.issueId}/`;
    const group = (await sentryRead.request(path)).data;
    if (String(group?.id) !== incident.issueId || group?.project?.slug !== provider.project) throw new Error("Sentry group identity does not match the GitHub Issue");
    const event = (await sentryRead.request(`/issues/${incident.issueId}/events/latest/`)).data;
    if (String(event?.eventID ?? event?.event_id ?? event?.id) !== incident.eventId) throw new Error("Sentry occurrence changed after GitHub intake");
    const repository = releaseConfig(config).source.repository;
    const markerBase = `release-ops-sentry-resolve:v2 issue_id=${incident.issueId} commit=${commitSha}`;
    const commentsResponse = await github.request(`/repos/${repository}/issues/${issue.number}/comments?per_page=100`);
    const comments = Array.isArray(commentsResponse.data) ? commentsResponse.data : [];
    const hasStart = comments.some(({ body }) => String(body).includes(`<!-- ${markerBase} state=start -->`));
    const hasApplied = comments.some(({ body }) => String(body).includes(`<!-- ${markerBase} state=applied -->`));
    if (!hasStart) {
        await github.request(`/repos/${repository}/issues/${issue.number}/comments`, {
            method: "POST",
            json: { body: `<!-- ${markerBase} state=start -->\nResolution started for the explicitly bound commit.` },
        });
    }
    if (hasStart && !hasApplied && group?.status !== "resolved") {
        throw new Error("SENTRY_WRITE_UNCERTAIN: an earlier write may have been accepted; manual reconciliation is required");
    }
    if (!hasApplied && group?.status !== "resolved") {
        await sentryWrite.request(path, { method: "PUT", json: { status: "resolved" } });
    }
    if (!hasApplied) {
        await github.request(`/repos/${repository}/issues/${issue.number}/comments`, {
            method: "POST",
            json: { body: `<!-- ${markerBase} state=applied -->\nSentry accepted the resolved transition.` },
        });
    }
    return { schemaVersion: "release-ops-sentry-resolution/v2", issueNumber: issue.number, issueId: incident.issueId, resolved: true };
}

#!/usr/bin/env node

import { isMainModule } from "./cli-entry.mjs";

const API_BASE = "https://sentry.io/api/0/";
const OUTPUT_SCHEMA = "sentry-project-provisioner/v1";
const RETRIES = 3;

function usage() {
    return `Usage:
  node scripts/sentry-project.mjs inspect --org <slug> --team <slug> --slug <project-slug> [--api-base <https-url>]
  node scripts/sentry-project.mjs create --org <slug> --team <slug> --name <name> --slug <project-slug> --platform <platform> [--api-base <https-url>] [--dry-run | --confirm-slug <project-slug>]

Credential:
  SENTRY_PROJECT_ADMIN_TOKEN`;
}

function parsePairs(values) {
    const result = new Map();
    for (let index = 0; index < values.length; index += 1) {
        const key = values[index];
        if (key === "--dry-run") {
            if (result.has(key)) throw new Error(`Duplicate argument: ${key}`);
            result.set(key, true);
            continue;
        }
        if (!key.startsWith("--") || !values[index + 1] || values[index + 1].startsWith("--")) {
            throw new Error(`Argument requires a value: ${key}`);
        }
        if (result.has(key)) throw new Error(`Duplicate argument: ${key}`);
        result.set(key, values[index + 1]);
        index += 1;
    }
    return result;
}

function requireValue(args, key) {
    const value = args.get(key);
    if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} is required`);
    return value.trim();
}

function validateSlug(value, label) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value)) {
        throw new Error(`${label} must use lowercase letters, digits, hyphens, or underscores`);
    }
    return value;
}

function validateName(value) {
    if (value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new Error("--name is invalid");
    }
    return value;
}

function validatePlatform(value) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(value)) throw new Error("--platform is invalid");
    return value;
}

function validateApiBase(value) {
    const url = new URL(value ?? API_BASE);
    if (url.protocol !== "https:" || !url.pathname.replace(/\/$/u, "").endsWith("/api/0") || url.search || url.hash) {
        throw new Error("--api-base must be an HTTPS /api/0 endpoint");
    }
    return url.toString();
}

export function parseArguments(values) {
    if (values.length === 0 || values.includes("--help") || values.includes("-h")) return { help: true };
    const command = values[0];
    if (!["inspect", "create"].includes(command)) throw new Error(`Unknown command: ${command}`);
    const args = parsePairs(values.slice(1));
    const allowed = command === "inspect"
        ? new Set(["--org", "--team", "--slug", "--api-base"])
        : new Set(["--org", "--team", "--name", "--slug", "--platform", "--api-base", "--dry-run", "--confirm-slug"]);
    for (const key of args.keys()) {
        if (!allowed.has(key)) throw new Error(`Unknown argument: ${key}`);
    }
    const org = validateSlug(requireValue(args, "--org"), "--org");
    const team = validateSlug(requireValue(args, "--team"), "--team");
    const slug = validateSlug(requireValue(args, "--slug"), "--slug");
    const apiBase = validateApiBase(args.get("--api-base"));
    if (command === "inspect") return { command, org, team, slug, apiBase };

    const dryRun = args.get("--dry-run") === true;
    const name = validateName(requireValue(args, "--name"));
    const platform = validatePlatform(requireValue(args, "--platform"));
    const confirmSlug = args.get("--confirm-slug") ?? "";
    if (!dryRun && confirmSlug !== slug) {
        throw new Error("Creation requires --confirm-slug to exactly match --slug");
    }
    return { command, org, team, name, slug, platform, dryRun, apiBase };
}

function apiPath(parts) {
    return parts.map((part) => encodeURIComponent(part)).join("/");
}

function retryDelay(attempt) {
    return Math.min(500 * 2 ** attempt, 4_000);
}

async function requestJson({ fetchImpl, token, baseUrl, path, method = "GET", body, allowNotFound = false }) {
    const base = new URL(baseUrl);
    const url = new URL(path.replace(/^\/+/, ""), base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error("Sentry API path escaped its origin");
    const retries = method === "GET" ? RETRIES : 0;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        let response;
        try {
            response = await fetchImpl(url, {
                method,
                redirect: "error",
                headers: {
                    Accept: "application/json",
                    Authorization: `Bearer ${token}`,
                    "User-Agent": "codex-sentry-project-provisioner/1",
                    ...(body === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" }),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        } catch (error) {
            if (attempt === retries) throw new Error(`Sentry ${method} ${url.pathname} failed after retries`, { cause: error });
            await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt)));
            continue;
        }
        if (allowNotFound && response.status === 404) return null;
        if ([408, 429].includes(response.status) || response.status >= 500) {
            if (attempt < retries) {
                await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt)));
                continue;
            }
        }
        if (!response.ok) throw new Error(`Sentry ${method} ${url.pathname} returned HTTP ${response.status}`);
        if (response.status === 204) return undefined;
        try {
            return await response.json();
        } catch (error) {
            throw new Error(`Sentry ${method} ${url.pathname} returned invalid JSON`, { cause: error });
        }
    }
    throw new Error("Sentry request exhausted retries");
}

function publicDsn(keys) {
    const candidate = Array.isArray(keys)
        ? keys.map((key) => key?.dsn?.public).find((value) => typeof value === "string" && value !== "")
        : undefined;
    if (!candidate) return null;
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.password || url.search || url.hash || !url.username) {
        throw new Error("Sentry returned an invalid public DSN");
    }
    return url.toString();
}

function sanitizedProject(project, fallback) {
    return {
        org: project?.organization?.slug ?? fallback.org,
        team: project?.team?.slug ?? fallback.team,
        project: project?.slug ?? fallback.slug,
        name: project?.name ?? fallback.name ?? null,
        platform: project?.platform ?? fallback.platform ?? null,
    };
}

export async function provisionProject(options, dependencies = {}) {
    const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
    const baseUrl = dependencies.baseUrl ?? options.apiBase ?? API_BASE;
    const token = dependencies.token;
    if (typeof token !== "string" || token.trim() === "") throw new Error("SENTRY_PROJECT_ADMIN_TOKEN is required");
    const teamPath = `teams/${apiPath([options.org, options.team])}/`;
    const projectPath = `projects/${apiPath([options.org, options.slug])}/`;
    await requestJson({ fetchImpl, token, baseUrl, path: teamPath });
    let project = await requestJson({ fetchImpl, token, baseUrl, path: projectPath, allowNotFound: true });

    if (options.command === "inspect") {
        if (!project) {
            return { schemaVersion: OUTPUT_SCHEMA, exists: false, org: options.org, team: options.team, project: options.slug };
        }
        const keys = await requestJson({ fetchImpl, token, baseUrl, path: `${projectPath}keys/` });
        return { schemaVersion: OUTPUT_SCHEMA, exists: true, ...sanitizedProject(project, options), publicDsn: publicDsn(keys) };
    }

    if (!project && options.dryRun) {
        return {
            schemaVersion: OUTPUT_SCHEMA,
            dryRun: true,
            wouldCreate: true,
            org: options.org,
            team: options.team,
            project: options.slug,
            name: options.name,
            platform: options.platform,
        };
    }

    let created = false;
    if (!project) {
        project = await requestJson({
            fetchImpl,
            token,
            baseUrl,
            path: `${teamPath}projects/`,
            method: "POST",
            body: { name: options.name, slug: options.slug, platform: options.platform, default_rules: true },
        });
        if (project?.slug !== options.slug) throw new Error("Sentry created an unexpected project slug");
        created = true;
    }
    const keys = await requestJson({ fetchImpl, token, baseUrl, path: `${projectPath}keys/` });
    return {
        schemaVersion: OUTPUT_SCHEMA,
        dryRun: Boolean(options.dryRun),
        created,
        existed: !created,
        ...sanitizedProject(project, options),
        publicDsn: publicDsn(keys),
    };
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(`${usage()}\n`);
        return;
    }
    const result = await provisionProject(options, { token: process.env.SENTRY_PROJECT_ADMIN_TOKEN });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (isMainModule(import.meta.url)) {
    main().catch((error) => {
        process.stderr.write(`Sentry project provisioning failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

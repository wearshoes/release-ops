#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig, RELEASE_SCHEMA } from "./config.mjs";
import { createGitHubClient } from "./github-client.mjs";
import { resolveRepositoryPath } from "./path-safety.mjs";

function applyTemplate(template, values) {
    return template.replaceAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (match, key) => {
        if (values[key] === undefined || values[key] === null) throw new Error(`Template value ${key} is unavailable`);
        return String(values[key]);
    });
}

function jsonPath(value, path) {
    return path.split(".").reduce((current, key) => current?.[key], value);
}

function parseProperties(text) {
    return new Map(text.split(/\r?\n/u).map((line) => {
        const index = line.indexOf("=");
        return index < 0 ? [line.trim(), ""] : [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }));
}

function scalar(value) {
    const text = String(value ?? "").trim().replace(/^['"]|['"]$/gu, "");
    if (/^(?:0|[1-9]\d*)$/u.test(text)) return Number(text);
    return text;
}

async function readVersionSource(root, source) {
    const path = await resolveRepositoryPath(root, source.file, { name: `version source ${source.file}`, mustExist: true });
    const text = await readUtf8(path);
    if (["properties", "gradle-properties"].includes(source.reader)) return scalar(parseProperties(text).get(source.key));
    if (["json", "package-json"].includes(source.reader)) return scalar(jsonPath(JSON.parse(text), source.key));
    if (source.reader === "text") return scalar(text);
    if (source.reader === "pubspec") {
        const match = text.match(new RegExp(`^${source.key.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}:\\s*(.+)$`, "mu"));
        if (!match) return "";
        const value = scalar(match[1]);
        if (source.key === "version" && typeof value === "string") return value.split("+")[0];
        if (source.key === "build" && typeof value === "string") return scalar(value.split("+")[1]);
        return value;
    }
    if (source.reader === "godot") {
        const match = text.match(new RegExp(`^${source.key.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}=([^\\r\\n]+)$`, "mu"));
        return scalar(match?.[1]);
    }
    if (source.reader === "unity") {
        const match = text.match(new RegExp(`^\\s*${source.key.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}:\\s*(.+)$`, "mu"));
        return scalar(match?.[1]);
    }
    throw new Error(`Unsupported version reader: ${source.reader}`);
}

export async function readCanonicalVersion(config, root) {
    const version = String(await readVersionSource(root, config.versioning.canonical)).trim();
    const buildNumbers = {};
    for (const entry of config.versioning.buildNumbers ?? []) buildNumbers[entry.id] = await readVersionSource(root, entry.source);
    return { version, buildNumbers };
}

async function readUtf8(path) {
    const bytes = await readFile(path);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
}

function assertVersion(version) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) throw new Error("Version must use semantic version format");
}

function sameBuildNumbers(actual, expected) {
    return JSON.stringify(actual) === JSON.stringify(expected);
}

async function directArtifacts(config, root, values) {
    const artifacts = [];
    for (const unit of config.build.units) {
        for (const declared of unit.artifacts) {
            const path = await resolveRepositoryPath(root, applyTemplate(declared.path, values), {
                name: `release artifact ${unit.id}/${declared.id}`,
                mustExist: true,
            });
            if (!(await stat(path)).isFile()) throw new Error(`Release artifact is not a file: ${unit.id}/${declared.id}`);
            const bytes = await readFile(path);
            artifacts.push({
                ...declared,
                unit: unit.id,
                sourcePath: path,
                name: applyTemplate(declared.nameTemplate, values),
                bytes,
                size: bytes.length,
                sha256: createHash("sha256").update(bytes).digest("hex"),
            });
        }
    }
    return artifacts;
}

async function aggregatedArtifacts(config, root, artifactRoot, canonical) {
    const base = await resolveRepositoryPath(root, artifactRoot, { name: "aggregated artifact root", mustExist: true });
    const artifacts = [];
    for (const unit of config.build.units) {
        const unitRoot = join(base, `release-ops-${unit.id}`);
        const manifestPath = join(unitRoot, "manifest.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        if (manifest.schemaVersion !== "release-ops-build-artifacts/v2" || manifest.unit !== unit.id
            || manifest.version !== canonical.version || !sameBuildNumbers(manifest.buildNumbers, canonical.buildNumbers)) {
            throw new Error(`Aggregated artifact manifest does not match build unit ${unit.id}`);
        }
        if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== unit.artifacts.length) {
            throw new Error(`Aggregated artifact count does not match build unit ${unit.id}`);
        }
        for (const declared of unit.artifacts) {
            const record = manifest.artifacts.find(({ id }) => id === declared.id);
            if (!record || record.unit !== unit.id || record.contentType !== declared.contentType
                || record.platform !== declared.platform || record.architecture !== declared.architecture
                || basename(record.name ?? "") !== record.name) {
                throw new Error(`Aggregated artifact metadata does not match ${unit.id}/${declared.id}`);
            }
            const sourcePath = join(unitRoot, record.name);
            const bytes = await readFile(sourcePath);
            const sha256 = createHash("sha256").update(bytes).digest("hex");
            if (bytes.length !== record.size || sha256 !== record.sha256) throw new Error(`Aggregated artifact checksum failed: ${record.name}`);
            artifacts.push({ ...declared, ...record, sourcePath, bytes });
        }
    }
    return artifacts;
}

async function prepare(config, root, { version, buildNumbers, sourceSha, publishedAt, artifactRoot }) {
    assertVersion(version);
    if (!/^[0-9a-f]{40}$/u.test(sourceSha)) throw new Error("Source SHA must be a full lowercase commit SHA");
    const canonical = await readCanonicalVersion(config, root);
    if (canonical.version !== version) throw new Error("Canonical version does not match the release version");
    if (!sameBuildNumbers(canonical.buildNumbers, buildNumbers)) throw new Error("Canonical build numbers do not match the release inputs");
    const values = { version, ...buildNumbers };
    const notesPath = await resolveRepositoryPath(root, applyTemplate(config.versioning.changelogPattern, values), {
        name: "release changelog",
        mustExist: true,
    });
    const notes = await readUtf8(notesPath);
    if (!notes.trim()) throw new Error("Release changelog is empty");
    if (config.versioning.requiresChinese && !/[\u3400-\u9fff]/u.test(notes)) throw new Error("Release changelog must contain Chinese");
    if (/\uFFFD|\?{2,}/u.test(notes)) throw new Error("Release changelog contains corrupted text");
    const artifacts = artifactRoot
        ? await aggregatedArtifacts(config, root, artifactRoot, canonical)
        : await directArtifacts(config, root, values);
    const names = artifacts.map(({ name }) => name);
    if (new Set(names).size !== names.length) throw new Error("Release artifact names must be globally unique");
    return {
        version,
        buildNumbers,
        sourceSha,
        notesPath,
        notes,
        artifacts,
        tag: applyTemplate(config.release.tagTemplate, values),
        title: applyTemplate(config.release.titleTemplate, values),
        publishedAt,
    };
}

function publicArtifact(artifact, repository, tag) {
    return {
        name: artifact.name,
        downloadUrl: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(artifact.name)}`,
        platform: artifact.platform,
        architecture: artifact.architecture,
        size: artifact.size,
        sha256: artifact.sha256,
    };
}

export function createPublicManifest(config, prepared, repository) {
    return {
        schemaVersion: RELEASE_SCHEMA,
        version: prepared.version,
        buildNumbers: prepared.buildNumbers,
        publishedAt: prepared.publishedAt,
        releaseUrl: `https://github.com/${repository}/releases/tag/${prepared.tag}`,
        artifacts: prepared.artifacts.map((artifact) => publicArtifact(artifact, repository, prepared.tag)),
    };
}

function createLatest(config, prepared, manifest) {
    if (config.release.latestCompatibility === "android-version-code-v1") {
        const primary = manifest.artifacts[0];
        const code = prepared.buildNumbers[config.release.latestBuildNumberId];
        if (!Number.isSafeInteger(code) || !primary) throw new Error("Android latest manifest requires an integer build number and primary artifact");
        return {
            versionCode: code,
            versionName: prepared.version,
            minimumSupportedVersionCode: config.release.minimumSupportedVersionCode ?? 1,
            apkUrl: primary.downloadUrl,
            releaseUrl: manifest.releaseUrl,
            sha256: primary.sha256,
            releaseNotes: prepared.notes,
            publishedAt: prepared.publishedAt,
        };
    }
    return manifest;
}

async function findRelease(github, repository, tag) {
    const published = await github.request(`/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, { allowNotFound: true });
    if (published.data) return published.data;
    const releases = (await github.request(`/repos/${repository}/releases?per_page=100`)).data;
    if (!Array.isArray(releases)) throw new Error("GitHub returned an invalid Release list");
    return releases.find((release) => release?.tag_name === tag) ?? null;
}

async function ensureDraft(github, repository, prepared, targetCommitish) {
    const existing = await findRelease(github, repository, prepared.tag);
    if (existing) {
        if (existing.body !== prepared.notes || existing.name !== prepared.title) {
            throw new Error(`Existing ${repository} Release does not match the changelog and title`);
        }
        if (existing.target_commitish && existing.target_commitish !== targetCommitish) {
            throw new Error(`Existing ${repository} Release is bound to a different target`);
        }
        return existing;
    }
    return (await github.request(`/repos/${repository}/releases`, {
        method: "POST",
        json: {
            tag_name: prepared.tag,
            target_commitish: targetCommitish,
            name: prepared.title,
            body: prepared.notes,
            draft: true,
            prerelease: false,
        },
    })).data;
}

async function replaceAsset(github, repository, release, asset) {
    for (const existing of release.assets ?? []) {
        if (existing?.name === asset.name) await github.request(`/repos/${repository}/releases/assets/${existing.id}`, { method: "DELETE" });
    }
    await github.request(`/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`, {
        method: "POST",
        body: asset.bytes,
        contentType: asset.contentType,
        upload: true,
    });
}

async function putRepositoryFile(github, repository, branch, path, content, message) {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const apiPath = `/repos/${repository}/contents/${encodedPath}`;
    const existing = await github.request(`${apiPath}?ref=${encodeURIComponent(branch)}`, { allowNotFound: true });
    await github.request(apiPath, {
        method: "PUT",
        json: {
            message,
            content: Buffer.from(content, "utf8").toString("base64"),
            branch,
            ...(existing.data?.sha ? { sha: existing.data.sha } : {}),
        },
    });
}

async function publishDraft(github, repository, release) {
    if (!release.draft) return release;
    return (await github.request(`/repos/${repository}/releases/${release.id}`, {
        method: "PATCH",
        json: { draft: false, prerelease: false },
    })).data;
}

function jsonAsset(name, value) {
    return { name, bytes: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"), contentType: "application/json; charset=utf-8" };
}

async function publishLocal(config, root, prepared) {
    const relative = join(config.release.localOutputDirectory, prepared.tag).replaceAll("\\", "/");
    const outputRoot = await resolveRepositoryPath(root, relative, { name: "local release output" });
    await mkdir(outputRoot, { recursive: true });
    const manifest = {
        schemaVersion: RELEASE_SCHEMA,
        version: prepared.version,
        buildNumbers: prepared.buildNumbers,
        publishedAt: prepared.publishedAt,
        artifacts: prepared.artifacts.map(({ name, platform, architecture, size, sha256 }) => ({ name, platform, architecture, size, sha256 })),
    };
    for (const artifact of prepared.artifacts) await copyFile(artifact.sourcePath, join(outputRoot, artifact.name));
    await writeFile(join(outputRoot, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(join(outputRoot, "CHANGELOG.md"), prepared.notes, "utf8");
    return { schemaVersion: "release-ops-publish-result/v2", mode: "local", version: prepared.version, outputRoot, manifest };
}

export async function publishRelease({
    config,
    root = process.cwd(),
    version,
    buildNumbers = {},
    sourceSha,
    github,
    artifactRoot = null,
    correlation = null,
    publishedAt = new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
}) {
    if (correlation !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(correlation)) {
        throw new Error("Release correlation must be a UUID v4");
    }
    const prepared = await prepare(config, root, { version, buildNumbers, sourceSha, publishedAt, artifactRoot });
    if (!config.hosting.github.enabled) return publishLocal(config, root, prepared);
    if (!github) throw new Error("A GitHub client is required for GitHub publication");
    const source = config.hosting.github.source;
    const distribution = config.hosting.github.releaseMode === "dual-repository"
        ? config.hosting.github.distribution
        : source;
    const publicManifest = createPublicManifest(config, prepared, distribution.repository);
    const latest = createLatest(config, prepared, publicManifest);
    const sharedAssets = [...prepared.artifacts, jsonAsset("release-manifest.json", publicManifest), jsonAsset("latest.json", latest)];
    const sourceRelease = await ensureDraft(github, source.repository, prepared, sourceSha);
    const publicRelease = distribution.repository === source.repository
        ? sourceRelease
        : await ensureDraft(github, distribution.repository, prepared, distribution.defaultBranch);
    for (const asset of sharedAssets) await replaceAsset(github, source.repository, sourceRelease, asset);
    if (distribution.repository !== source.repository) {
        for (const asset of sharedAssets) await replaceAsset(github, distribution.repository, publicRelease, asset);
    }
    await putRepositoryFile(
        github,
        distribution.repository,
        distribution.defaultBranch,
        config.release.latestManifest,
        `${JSON.stringify(latest, null, 2)}\n`,
        `release: ${prepared.tag}`,
    );
    if (config.release.publicReadmeSource && config.release.publicReadmeTarget) {
        const readmePath = await resolveRepositoryPath(root, config.release.publicReadmeSource, { name: "public README", mustExist: true });
        await putRepositoryFile(
            github,
            distribution.repository,
            distribution.defaultBranch,
            config.release.publicReadmeTarget,
            await readUtf8(readmePath),
            `docs: synchronize release README for ${prepared.tag}`,
        );
    }
    const publishedSource = await publishDraft(github, source.repository, sourceRelease);
    const publishedPublic = distribution.repository === source.repository
        ? publishedSource
        : await publishDraft(github, distribution.repository, publicRelease);
    return {
        schemaVersion: "release-ops-publish-result/v2",
        mode: config.hosting.github.releaseMode,
        version: prepared.version,
        tag: prepared.tag,
        manifest: publicManifest,
        sourceReleaseUrl: publishedSource.html_url,
        publicReleaseUrl: publishedPublic.html_url,
        correlation,
    };
}

function parseJsonArgument(value, name) {
    try {
        const parsed = JSON.parse(value ?? "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        return parsed;
    } catch (error) {
        throw new Error(`${name} must be a JSON object`, { cause: error });
    }
}

async function main() {
    const args = new Map();
    for (let index = 2; index < process.argv.length; index += 2) {
        const key = process.argv[index];
        const value = process.argv[index + 1];
        if (!key?.startsWith("--") || value === undefined || args.has(key)) throw new Error("Arguments must use unique --name value pairs");
        args.set(key, value);
    }
    const root = resolve(args.get("--root") ?? process.cwd());
    const config = await loadConfig(root);
    let github = null;
    if (config.hosting.github.enabled) {
        const sourceToken = process.env.GITHUB_TOKEN ?? process.env.github_token;
        const publicToken = config.hosting.github.releaseMode === "dual-repository" ? process.env.RELEASE_REPO_TOKEN : sourceToken;
        github = createGitHubClient({
            sourceRepository: config.hosting.github.source.repository,
            publicRepository: config.hosting.github.distribution?.repository,
            sourceToken,
            publicToken,
        });
    }
    const result = await publishRelease({
        config,
        root,
        version: args.get("--version") ?? "",
        buildNumbers: parseJsonArgument(args.get("--build-numbers"), "--build-numbers"),
        sourceSha: args.get("--sha") ?? "",
        artifactRoot: args.get("--artifact-root") ?? null,
        correlation: args.get("--correlation") ?? null,
        github,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        process.stderr.write(`Release publication failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

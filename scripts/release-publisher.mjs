#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig, RELEASE_SCHEMA } from "./config.mjs";
import { createGitHubClient } from "./github-client.mjs";

function applyTemplate(template, values) {
    return template.replaceAll(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (match, key) => {
        if (values[key] === undefined || values[key] === null) throw new Error(`Template value ${key} is unavailable`);
        return String(values[key]);
    });
}

function jsonPath(value, path) {
    return path.split(".").reduce((current, key) => current?.[key], value);
}

export async function readCanonicalVersion(config, root) {
    const path = resolve(root, config.versioning.file);
    const text = await readFile(path, "utf8");
    const reader = config.versioning.reader ?? "properties";
    if (reader === "json") {
        const parsed = JSON.parse(text);
        return {
            version: String(jsonPath(parsed, config.versioning.versionKey) ?? "").trim(),
            versionCode: config.versioning.codeKey ? Number(jsonPath(parsed, config.versioning.codeKey)) : null,
        };
    }
    const properties = new Map(text.split(/\r?\n/u).map((line) => {
        const index = line.indexOf("=");
        return index < 0 ? [line.trim(), ""] : [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }));
    return {
        version: properties.get(config.versioning.versionKey) ?? "",
        versionCode: config.versioning.codeKey ? Number(properties.get(config.versioning.codeKey)) : null,
    };
}

async function readUtf8(path) {
    const bytes = await readFile(path);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
}

async function prepare(config, root, { version, versionCode, sourceSha, publishedAt }) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) throw new Error("Version must use semantic version format");
    if (!/^[0-9a-f]{40}$/u.test(sourceSha)) throw new Error("Source SHA must be a full lowercase commit SHA");
    const canonical = await readCanonicalVersion(config, root);
    if (canonical.version !== version) throw new Error("Canonical version does not match the release version");
    if (config.versioning.codeKey && canonical.versionCode !== versionCode) throw new Error("Canonical version code does not match the release code");
    const values = { version, versionCode };
    const notesPath = resolve(root, applyTemplate(config.versioning.changelogPattern, values));
    const notes = await readUtf8(notesPath);
    if (!notes.trim()) throw new Error("Release changelog is empty");
    if (config.versioning.requiresChinese && !/[\u3400-\u9fff]/u.test(notes)) throw new Error("Release changelog must contain Chinese");
    if (/\uFFFD|\?{2,}/u.test(notes)) throw new Error("Release changelog contains corrupted text");
    const artifacts = [];
    for (const declared of config.build.artifacts) {
        const path = resolve(root, applyTemplate(declared.path, values));
        const metadata = await stat(path);
        if (!metadata.isFile()) throw new Error(`Release artifact is not a file: ${declared.id}`);
        const bytes = await readFile(path);
        artifacts.push({
            ...declared,
            sourcePath: path,
            name: applyTemplate(declared.nameTemplate, values),
            bytes,
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
        });
    }
    const tag = applyTemplate(config.release.tagTemplate, values);
    const title = applyTemplate(config.release.titleTemplate, values);
    return { version, versionCode, sourceSha, notesPath, notes, artifacts, tag, title, publishedAt, values };
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
        publishedAt: prepared.publishedAt,
        releaseUrl: `https://github.com/${repository}/releases/tag/${prepared.tag}`,
        artifacts: prepared.artifacts.map((artifact) => publicArtifact(artifact, repository, prepared.tag)),
    };
}

function createLatest(config, prepared, manifest) {
    if (config.release.latestCompatibility === "android-version-code-v1") {
        const primary = manifest.artifacts[0];
        if (!Number.isSafeInteger(prepared.versionCode) || !primary) throw new Error("Android latest manifest requires a version code and primary artifact");
        return {
            versionCode: prepared.versionCode,
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
        return existing;
    }
    const response = await github.request(`/repos/${repository}/releases`, {
        method: "POST",
        json: {
            tag_name: prepared.tag,
            target_commitish: targetCommitish,
            name: prepared.title,
            body: prepared.notes,
            draft: true,
            prerelease: false,
        },
    });
    return response.data;
}

async function replaceAsset(github, repository, release, asset) {
    for (const existing of release.assets ?? []) {
        if (existing?.name === asset.name) {
            await github.request(`/repos/${repository}/releases/assets/${existing.id}`, { method: "DELETE" });
        }
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
    return {
        name,
        bytes: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
        contentType: "application/json; charset=utf-8",
    };
}

async function publishLocal(config, root, prepared) {
    const outputRoot = resolve(root, config.release.localOutputDirectory ?? "dist/release-ops", prepared.tag);
    await mkdir(outputRoot, { recursive: true });
    const manifest = {
        schemaVersion: RELEASE_SCHEMA,
        version: prepared.version,
        publishedAt: prepared.publishedAt,
        artifacts: prepared.artifacts.map(({ name, platform, architecture, size, sha256 }) => ({ name, platform, architecture, size, sha256 })),
    };
    for (const artifact of prepared.artifacts) await copyFile(artifact.sourcePath, join(outputRoot, artifact.name));
    await writeFile(join(outputRoot, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(join(outputRoot, "CHANGELOG.md"), prepared.notes, "utf8");
    return { schemaVersion: "release-ops-publish-result/v1", mode: "local", version: prepared.version, outputRoot, manifest };
}

export async function publishRelease({ config, root = process.cwd(), version, versionCode = null, sourceSha, github, publishedAt = new Date().toISOString().replace(/\.\d{3}Z$/u, "Z") }) {
    for (const name of config.build.requiredSecretNames ?? []) {
        if (!process.env[name]) throw new Error(`Required build Secret metadata is missing from the environment: ${name}`);
    }
    const prepared = await prepare(config, root, { version, versionCode, sourceSha, publishedAt });
    if (!config.hosting.github.enabled) return publishLocal(config, root, prepared);
    if (!github) throw new Error("A GitHub client is required for GitHub publication");
    const sourceRepository = config.hosting.github.sourceRepository;
    const publicRepository = config.hosting.github.releaseMode === "dual-repository"
        ? config.hosting.github.publicRepository
        : sourceRepository;
    const publicManifest = createPublicManifest(config, prepared, publicRepository);
    const latest = createLatest(config, prepared, publicManifest);
    const sharedAssets = [
        ...prepared.artifacts,
        jsonAsset("release-manifest.json", publicManifest),
        jsonAsset("latest.json", latest),
    ];
    const sourceRelease = await ensureDraft(github, sourceRepository, prepared, sourceSha);
    const publicRelease = publicRepository === sourceRepository
        ? sourceRelease
        : await ensureDraft(github, publicRepository, prepared, config.hosting.github.defaultBranch);
    for (const asset of sharedAssets) await replaceAsset(github, sourceRepository, sourceRelease, asset);
    if (publicRepository !== sourceRepository) {
        for (const asset of sharedAssets) await replaceAsset(github, publicRepository, publicRelease, asset);
    }
    const branch = config.hosting.github.defaultBranch;
    await putRepositoryFile(
        github,
        publicRepository,
        branch,
        config.release.latestManifest,
        `${JSON.stringify(latest, null, 2)}\n`,
        `release: ${prepared.tag}`,
    );
    if (config.release.publicReadmeSource && config.release.publicReadmeTarget) {
        const readme = await readUtf8(resolve(root, config.release.publicReadmeSource));
        await putRepositoryFile(github, publicRepository, branch, config.release.publicReadmeTarget, readme, `docs: synchronize release README for ${prepared.tag}`);
    }
    const publishedSource = await publishDraft(github, sourceRepository, sourceRelease);
    const publishedPublic = publicRepository === sourceRepository
        ? publishedSource
        : await publishDraft(github, publicRepository, publicRelease);
    return {
        schemaVersion: "release-ops-publish-result/v1",
        mode: config.hosting.github.releaseMode,
        version: prepared.version,
        tag: prepared.tag,
        manifest: publicManifest,
        sourceReleaseUrl: publishedSource.html_url,
        publicReleaseUrl: publishedPublic.html_url,
    };
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
            sourceRepository: config.hosting.github.sourceRepository,
            publicRepository: config.hosting.github.publicRepository,
            sourceToken,
            publicToken,
        });
    }
    const result = await publishRelease({
        config,
        root,
        version: args.get("--version") ?? "",
        versionCode: args.has("--code") && args.get("--code") !== "" ? Number(args.get("--code")) : null,
        sourceSha: args.get("--sha") ?? "",
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

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_FILES = [
    "config.mjs",
    "provider-registry.mjs",
    "github-client.mjs",
    "release-publisher.mjs",
    "preflight-release.mjs",
    "run-build.mjs",
    "local-release.mjs",
    "release-entry.mjs",
    "dispatch-release.mjs",
    "workflow-dispatch.mjs",
    "github-admin.mjs",
    "sentry-build-hook.mjs",
    "sentry-client.mjs",
    "sentry-incidents.mjs",
    "sentry-sync.mjs",
    "sentry-intake.mjs",
    "sentry-resolver.mjs",
];

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function secretEnvironment(config) {
    const names = new Set(config.build.requiredSecretNames ?? []);
    if (config.hosting.github.releaseMode === "dual-repository") names.add("RELEASE_REPO_TOKEN");
    if (config.providers.sentry?.enabled) names.add("SENTRY_ORG_CI_TOKEN");
    return [...names].sort().map((name) => `      ${name}: \${{ secrets.${name} }}`).join("\n") || "      # No additional repository Secrets are required.";
}

function sentryStep(config) {
    if (!config.providers.sentry?.enabled) return "      # Sentry provider is disabled.";
    return `      - name: Upload Sentry release artifacts
        run: >-
          node .release-ops/runtime/sentry-build-hook.mjs
          --root . --version "\${{ inputs.versionName }}"
          --code "\${{ inputs.versionCode }}" --sha "\${{ inputs.sourceSha }}"`;
}

async function verifyManagedFile(root, relativePath, expectedHash) {
    try {
        const current = await readFile(resolve(root, relativePath));
        if (sha256(current) !== expectedHash) throw new Error(`Managed file has local changes: ${relativePath}`);
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
    }
}

async function writeManagedFile(root, relativePath, bytes, previousFiles, upgrade) {
    const target = resolve(root, relativePath);
    let existing = null;
    try {
        existing = await readFile(target);
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
    }
    if (existing && !upgrade && !previousFiles?.[relativePath] && sha256(existing) !== sha256(bytes)) {
        throw new Error(`Refusing to overwrite an unmanaged existing file: ${relativePath}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    return sha256(bytes);
}

export async function installProjectFiles(root, config, { upgrade = false } = {}) {
    const manifestPath = resolve(root, ".release-ops", "managed-files.json");
    let previous = null;
    try {
        previous = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
    }
    if (upgrade && previous) {
        for (const [path, hash] of Object.entries(previous.files ?? {})) await verifyManagedFile(root, path, hash);
    }
    const written = new Map();
    const previousFiles = previous?.files ?? {};
    for (const name of RUNTIME_FILES) {
        const source = resolve(PLUGIN_ROOT, "scripts", name);
        const relativePath = `.release-ops/runtime/${name}`;
        written.set(relativePath, await writeManagedFile(root, relativePath, await readFile(source), previousFiles, upgrade));
    }
    if (config.hosting.github.enabled) {
        const template = await readFile(resolve(PLUGIN_ROOT, "assets", "templates", "publish-release.yml"), "utf8");
        const workflow = template
            .replaceAll("__SOURCE_REPOSITORY__", config.hosting.github.sourceRepository)
            .replace("__SECRET_ENV__", secretEnvironment(config))
            .replace("__SENTRY_STEP__", sentryStep(config));
        const relativePath = config.release.workflowFile.replaceAll("\\", "/");
        written.set(relativePath, await writeManagedFile(root, relativePath, Buffer.from(workflow, "utf8"), previousFiles, upgrade));
    }
    if (config.providers.sentry?.enabled && config.providers.sentry.issueSync && config.hosting.github.enabled) {
        const templates = [
            ["sentry-issues.yml", ".github/workflows/sentry-issues.yml"],
            ["resolve-issues.yml", ".github/workflows/resolve-issues.yml"],
        ];
        for (const [templateName, relativePath] of templates) {
            const text = (await readFile(resolve(PLUGIN_ROOT, "assets", "templates", templateName), "utf8"))
                .replaceAll("__SOURCE_REPOSITORY__", config.hosting.github.sourceRepository)
                .replaceAll("__DEFAULT_BRANCH__", config.hosting.github.defaultBranch)
                .replaceAll("__SCHEDULE__", config.providers.sentry.schedule ?? "17 * * * *");
            written.set(relativePath, await writeManagedFile(root, relativePath, Buffer.from(text, "utf8"), previousFiles, upgrade));
        }
        const testRelative = ".release-ops/runtime/tests/sentry-lifecycle.test.mjs";
        const testSource = resolve(PLUGIN_ROOT, "scripts", "tests", "sentry-lifecycle.test.mjs");
        written.set(testRelative, await writeManagedFile(root, testRelative, await readFile(testSource), previousFiles, upgrade));
    }
    const manifest = { schemaVersion: "release-ops-managed-files/v1", files: Object.fromEntries([...written].sort()) };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
}

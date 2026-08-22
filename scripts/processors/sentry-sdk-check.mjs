export const SENTRY_SDK_CHECK_SCHEMA = "release-ops/internal/sentry-sdk-check/v1";

const PLATFORM_CATALOG = "https://docs.sentry.io/platforms/";
const SOURCE_EXTENSIONS = new Set([
    ".asset", ".c", ".cc", ".cfg", ".cjs", ".cpp", ".cs", ".csproj", ".dart", ".env", ".gd",
    ".gradle", ".h", ".hpp", ".java", ".js", ".json", ".jsx", ".kt", ".kts", ".m", ".mjs", ".mm",
    ".plist", ".properties", ".props", ".svelte", ".swift", ".targets", ".toml", ".ts", ".tscn",
    ".tres", ".tsx", ".xcconfig", ".xml", ".yaml", ".yml",
]);
const SOURCE_NAMES = new Set([
    "androidmanifest.xml", "cmakelists.txt", "info.plist", "manifest.json", "package.resolved", "package.swift",
    "package.json", "podfile", "project.godot", "pubspec.yaml",
]);
const NON_RUNTIME_PARTS = new Set([".github", "__tests__", "docs", "documentation", "fixtures", "test", "tests"]);
const DSN = /https:\/\/[A-Za-z0-9_-]{6,}(?::[A-Za-z0-9_-]*)?@[A-Za-z0-9.-]+(?::[0-9]+)?\/(?:[A-Za-z0-9_.-]+\/)*[0-9]+/gu;

export const SENTRY_PLATFORM_ROUTES = Object.freeze({
    android: Object.freeze({
        platform: "android", docsUrl: "https://docs.sentry.io/platforms/android/",
        installer: Object.freeze({ method: "wizard", integration: "android" }),
    }),
    apple: Object.freeze({
        platform: "apple", docsUrl: "https://docs.sentry.io/platforms/apple/",
        installer: Object.freeze({ method: "wizard", integration: "ios" }),
    }),
    dotnet: Object.freeze({
        platform: "dotnet", docsUrl: "https://docs.sentry.io/platforms/dotnet/",
        installer: Object.freeze({ method: "agent", integration: "dotnet" }),
    }),
    flutter: Object.freeze({
        platform: "flutter", docsUrl: "https://docs.sentry.io/platforms/dart/guides/flutter/",
        installer: Object.freeze({ method: "wizard", integration: "flutter" }),
    }),
    generic: Object.freeze({
        platform: "generic", docsUrl: PLATFORM_CATALOG,
        installer: Object.freeze({ method: "none", integration: null }), unsupported: true,
    }),
    godot: Object.freeze({
        platform: "godot", docsUrl: "https://docs.sentry.io/platforms/godot/",
        installer: Object.freeze({ method: "manual", integration: null }),
    }),
    javascript: Object.freeze({
        platform: "javascript", docsUrl: "https://docs.sentry.io/platforms/javascript/",
        installer: Object.freeze({ method: "agent", integration: "browser" }),
    }),
    native: Object.freeze({
        platform: "native", docsUrl: "https://docs.sentry.io/platforms/native/",
        installer: Object.freeze({ method: "manual", integration: null }),
    }),
    "react-native": Object.freeze({
        platform: "react-native", docsUrl: "https://docs.sentry.io/platforms/react-native/",
        installer: Object.freeze({ method: "wizard", integration: "reactNative" }),
    }),
    unity: Object.freeze({
        platform: "unity", docsUrl: "https://docs.sentry.io/platforms/unity/",
        installer: Object.freeze({ method: "manual", integration: null }),
    }),
    unreal: Object.freeze({
        platform: "unreal", docsUrl: "https://docs.sentry.io/platforms/unreal/",
        installer: Object.freeze({ method: "none", integration: null }), unsupported: true,
    }),
});

const JAVASCRIPT_ROUTES = Object.freeze([
    {
        platform: "javascript-nextjs", packages: ["@sentry/nextjs", "next"],
        docsUrl: "https://docs.sentry.io/platforms/javascript/guides/nextjs/", method: "wizard", integration: "nextjs",
    },
    {
        platform: "javascript-nestjs", packages: ["@sentry/nestjs", "@nestjs/core"],
        docsUrl: "https://docs.sentry.io/platforms/javascript/guides/nestjs/", method: "agent", integration: "nestjs",
    },
    {
        platform: "javascript-react-router", packages: ["@sentry/react-router", "react-router", "react-router-dom", "@react-router/node"],
        docsUrl: "https://docs.sentry.io/platforms/javascript/guides/react-router/", method: "agent", integration: "react-router-framework",
    },
    {
        platform: "javascript-tanstack", packages: ["@sentry/tanstackstart-react", "@tanstack/react-start"],
        docsUrl: "https://docs.sentry.io/platforms/javascript/guides/tanstackstart-react/", method: "agent", integration: "tanstack-start",
    },
    {
        platform: "javascript-react", packages: ["@sentry/react", "react"],
        docsUrl: "https://docs.sentry.io/platforms/javascript/guides/react/", method: "agent", integration: "react",
    },
    {
        platform: "javascript-sveltekit", packages: ["@sentry/sveltekit", "@sveltejs/kit"],
        docsUrl: "https://docs.sentry.io/platforms/javascript/guides/svelte/", method: "wizard", integration: "sveltekit",
    },
    {
        platform: "javascript-svelte", packages: ["@sentry/svelte", "svelte"],
        docsUrl: "https://docs.sentry.io/platforms/javascript/guides/svelte/", method: "agent", integration: "svelte",
    },
    {
        platform: "javascript-node", packages: ["@sentry/node", "express", "fastify", "koa", "@hapi/hapi"],
        docsUrl: "https://docs.sentry.io/platforms/javascript/guides/node/", method: "agent", integration: "node",
    },
]);

function compare(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function extension(path) {
    const name = path.split("/").at(-1).toLowerCase();
    const index = name.lastIndexOf(".");
    return index >= 0 ? name.slice(index) : "";
}

function scannable(path, root) {
    const normalizedRoot = root === "." ? "" : `${root.replaceAll("\\", "/").replace(/\/$/u, "")}/`;
    if (normalizedRoot && !path.startsWith(normalizedRoot)) return false;
    const relativePath = normalizedRoot ? path.slice(normalizedRoot.length) : path;
    const parts = relativePath.toLowerCase().split("/");
    if (parts.slice(0, -1).some((part) => NON_RUNTIME_PARTS.has(part))) return false;
    const name = parts.at(-1);
    return SOURCE_NAMES.has(name) || name.startsWith(".env") || SOURCE_EXTENSIONS.has(extension(name));
}

function hasPublicDsn(text) {
    for (const match of text.matchAll(DSN)) {
        const value = match[0].toLowerCase();
        if (!["example", "placeholder", "changeme", "your_", "your-", "000000"].some((item) => value.includes(item))) return true;
    }
    return false;
}

function runtimeDsnPath(stackId, path) {
    const suffix = extension(path);
    const name = path.split("/").at(-1).toLowerCase();
    const extensions = {
        android: new Set([".gradle", ".java", ".kt", ".kts", ".properties", ".xml"]),
        apple: new Set([".m", ".mm", ".plist", ".swift", ".xcconfig"]),
        dotnet: new Set([".cs", ".json", ".props", ".targets", ".xml"]),
        flutter: new Set([".dart", ".yaml", ".yml"]),
        godot: new Set([".cfg", ".gd", ".tres", ".tscn"]),
        javascript: new Set([".cjs", ".env", ".js", ".json", ".jsx", ".mjs", ".ts", ".tsx"]),
        native: new Set([".c", ".cc", ".cfg", ".cpp", ".h", ".hpp", ".toml"]),
        "react-native": new Set([".cjs", ".env", ".js", ".json", ".jsx", ".mjs", ".ts", ".tsx"]),
        unity: new Set([".asset", ".cs", ".json"]),
    }[stackId] ?? new Set();
    return extensions.has(suffix) || (stackId === "godot" && name === "project.godot") || name.startsWith(".env");
}

function dependencyPattern(stackId) {
    const patterns = {
        android: /(?:io\.sentry:sentry-android|id\s*\(?["']io\.sentry\.android\.gradle["']|classpath\s*\(?["']io\.sentry:sentry-android-gradle-plugin)/u,
        apple: /(?:github\.com\/getsentry\/sentry-cocoa|\bpod\s+["']Sentry["']|\bpackage\s*:\s*["']Sentry["'])/iu,
        dotnet: /<PackageReference\s+Include=["']Sentry(?:\.[A-Za-z0-9.-]+)?["']/iu,
        flutter: /(?:^|\n)\s*sentry_flutter\s*:/u,
        godot: /(?:addons\/sentry|sentry-godot|SentryGodot)/iu,
        native: /(?:find_package\s*\(\s*sentry|sentry-native|libsentry)/iu,
        "react-native": /["']@sentry\/react-native["']\s*:/u,
        unity: /(?:["']io\.sentry\.unity["']|com\.getsentry\.sentry-unity|Sentry\.Unity)/iu,
    };
    return patterns[stackId] ?? null;
}

function initializationPattern(stackId) {
    const patterns = {
        android: /(?:\bSentryAndroid\s*\.\s*init\s*\(|android:name\s*=\s*["']io\.sentry\.(?:dsn|auto-init)["'])/iu,
        apple: /\bSentrySDK\s*\.\s*start(?:WithConfigureOptions)?\s*[({]/u,
        dotnet: /(?:\bSentrySdk\s*\.\s*Init\s*\(|\.UseSentry\s*\(|\.AddSentry\s*\()/u,
        flutter: /\bSentryFlutter\s*\.\s*init\s*\(/u,
        godot: /(?:\b(?:Sentry|SentrySDK)\s*\.\s*init\s*\(|res:\/\/addons\/sentry\/plugin\.cfg|sentry\/(?:options|dsn))/iu,
        native: /\bsentry_init\s*\(/u,
        "react-native": /\bSentry\s*\.\s*init\s*\(/u,
        unity: /(?:\bSentryUnity\s*\.\s*Init\s*\(|\bSentryOptions\b)/u,
    };
    return patterns[stackId] ?? null;
}

function javascriptPackages(documents) {
    const packages = new Set();
    for (const document of documents.filter(({ path }) => path.toLowerCase().endsWith("package.json"))) {
        try {
            const parsed = JSON.parse(document.text);
            for (const source of [parsed.dependencies, parsed.devDependencies, parsed.peerDependencies, parsed.optionalDependencies]) {
                for (const name of Object.keys(source ?? {})) packages.add(name);
            }
        } catch {
            // Invalid package.json is not evidence of an SDK installation.
        }
    }
    return packages;
}

function javascriptRoute(packages) {
    const route = JAVASCRIPT_ROUTES.find((candidate) => candidate.packages.some((name) => packages.has(name)));
    return route ? {
        platform: route.platform,
        docsUrl: route.docsUrl,
        installer: { method: route.method, integration: route.integration },
    } : SENTRY_PLATFORM_ROUTES.javascript;
}

function baseResult(instance, candidates, route, status, missing = [], evidence = []) {
    return {
        schemaVersion: SENTRY_SDK_CHECK_SCHEMA,
        instanceId: instance.instanceId,
        checkId: "sentry-sdk",
        status,
        candidates,
        platform: route.platform,
        docsUrl: route.docsUrl,
        installer: route.installer,
        missing,
        evidence,
    };
}

async function evidenceRecord(api, type, path) {
    return { type, path, sha256: await api.hashFile(path) };
}

export async function checkSentrySdk({ api, config, graph, instance }) {
    const ownerIds = [...new Set(Object.values(graph.buildUnitOwners ?? {}))].sort(compare);
    const candidates = ownerIds.map((instanceId) => {
        const owner = config.extensions.find((candidate) => candidate.instanceId === instanceId);
        return { instanceId, extensionId: owner?.extensionId ?? "unknown" };
    });
    if (candidates.length !== 1 || candidates[0].extensionId === "unknown") {
        return baseResult(instance, candidates, {
            platform: "ambiguous", docsUrl: PLATFORM_CATALOG, installer: { method: "none", integration: null },
        }, "ambiguous", ["target-owner"]);
    }
    const target = candidates[0];
    const baseRoute = SENTRY_PLATFORM_ROUTES[target.extensionId] ?? {
        platform: target.extensionId, docsUrl: PLATFORM_CATALOG,
        installer: { method: "none", integration: null }, unsupported: true,
    };
    if (baseRoute.unsupported) return baseResult(instance, candidates, baseRoute, "unsupported", ["supported-platform"]);

    const stack = config.extensions.find((candidate) => candidate.instanceId === target.instanceId);
    const files = (await api.listFiles()).filter(({ path }) => scannable(path, stack.config.root));
    const documents = [];
    for (const file of files) {
        const text = await api.readText(file.path);
        if (!text.includes("\uFFFD")) documents.push({ path: file.path, text });
    }

    const packages = target.extensionId === "javascript" ? javascriptPackages(documents) : null;
    const route = packages ? javascriptRoute(packages) : baseRoute;
    const dependency = target.extensionId === "javascript"
        ? (document) => /["']@sentry\/(?:browser|nestjs|nextjs|node|react|react-native|react-router|svelte|sveltekit|tanstackstart-react)["']\s*:/u.test(document.text)
        : target.extensionId === "godot"
            ? (document) => /(?:^|\/)addons\/sentry(?:\/|$)/iu.test(document.path) || dependencyPattern("godot").test(document.text)
        : (document) => dependencyPattern(target.extensionId)?.test(document.text) ?? false;
    const initialized = target.extensionId === "javascript"
        ? (document) => /\bSentry\s*\.\s*init\s*\(/u.test(document.text)
        : (document) => initializationPattern(target.extensionId)?.test(document.text) ?? false;
    const matches = {
        sdk: documents.filter(dependency).map(({ path }) => path),
        initialization: documents.filter(initialized).map(({ path }) => path),
        dsn: documents.filter(({ path, text }) => runtimeDsnPath(target.extensionId, path) && hasPublicDsn(text)).map(({ path }) => path),
    };
    const evidence = [];
    for (const type of ["sdk", "initialization", "dsn"]) {
        for (const path of [...new Set(matches[type])].sort(compare)) evidence.push(await evidenceRecord(api, type, path));
    }
    const missing = ["sdk", "initialization", "dsn"].filter((type) => !matches[type].length);
    return baseResult(instance, candidates, route, missing.length === 3 ? "missing" : missing.length ? "partial" : "configured", missing, evidence);
}

export function sentrySdkCheckMessage(check) {
    if (check.status === "configured") return `Sentry SDK is configured for ${check.platform}`;
    if (check.status === "ambiguous") return `Sentry SDK target is ambiguous; select one final artifact owner. ${check.docsUrl}`;
    if (check.status === "unsupported") return `Sentry SDK setup is unsupported for ${check.platform}. ${check.docsUrl}`;
    return `Sentry SDK is ${check.status}; missing ${check.missing.join(", ")}. ${check.docsUrl}`;
}

const API_VERSION = "2022-11-28";

function repositoryFromPath(path) {
    const match = /^\/repos\/([^/?]+\/[^/?]+)/u.exec(path);
    return match?.[1] ?? null;
}

function boundedPath(path) {
    const value = String(path).split("?")[0];
    return value.length <= 240 ? value : `${value.slice(0, 237)}...`;
}

export function createGitHubClient({
    sourceRepository,
    publicRepository = null,
    sourceToken,
    publicToken = sourceToken,
    fetchImpl = globalThis.fetch,
    apiBase = "https://api.github.com",
    uploadsBase = "https://uploads.github.com",
}) {
    if (!sourceToken) throw new Error("A source GitHub token is required");
    return {
        async request(path, {
            method = "GET",
            json,
            body,
            contentType,
            allowNotFound = false,
            upload = false,
        } = {}) {
            if (typeof path !== "string" || !path.startsWith("/")) throw new Error("GitHub API path is invalid");
            const base = new URL(upload ? uploadsBase : apiBase);
            const url = new URL(path, base);
            if (url.origin !== base.origin) throw new Error("GitHub API path escaped its origin");
            const repository = repositoryFromPath(path);
            const token = publicRepository && repository === publicRepository ? publicToken : sourceToken;
            if (!token) throw new Error(`GitHub token is unavailable for ${repository ?? "the requested resource"}`);
            let response;
            try {
                response = await fetchImpl(url, {
                    method,
                    redirect: "error",
                    headers: {
                        Accept: "application/vnd.github+json",
                        Authorization: `Bearer ${token}`,
                        "X-GitHub-Api-Version": API_VERSION,
                        ...(json === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" }),
                        ...(contentType ? { "Content-Type": contentType } : {}),
                    },
                    body: json === undefined ? body : Buffer.from(JSON.stringify(json), "utf8"),
                });
            } catch (error) {
                throw new Error(`GitHub ${method} ${boundedPath(path)} request failed`, { cause: error });
            }
            if (allowNotFound && response.status === 404) return { status: 404, data: null };
            if (!response.ok) throw new Error(`GitHub ${method} ${boundedPath(path)} returned HTTP ${response.status}`);
            const data = response.status === 204 ? undefined : await response.json();
            return { status: response.status, data, headers: response.headers };
        },
    };
}

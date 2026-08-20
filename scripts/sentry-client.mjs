export function createSentryClient({ token, fetchImpl = globalThis.fetch, apiBase = "https://sentry.io/api/0" }) {
    if (!token) throw new Error("A Sentry credential is required");
    const base = new URL(apiBase.endsWith("/") ? apiBase : `${apiBase}/`);
    if (base.protocol !== "https:") throw new Error("Sentry API must use HTTPS");
    const client = {
        async request(path, { method = "GET", json, allowNotFound = false } = {}) {
            const url = new URL(path.replace(/^\/+/, ""), base);
            if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new Error("Sentry API path escaped its origin");
            let response;
            try {
                response = await fetchImpl(url, {
                    method,
                    redirect: "error",
                    headers: {
                        Accept: "application/json",
                        Authorization: `Bearer ${token}`,
                        ...(json === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" }),
                    },
                    body: json === undefined ? undefined : Buffer.from(JSON.stringify(json), "utf8"),
                });
            } catch (error) {
                throw new Error(`Sentry ${method} ${url.pathname} request failed`, { cause: error });
            }
            if (allowNotFound && response.status === 404) return { status: 404, data: null, headers: response.headers };
            if (!response.ok) throw new Error(`Sentry ${method} ${url.pathname} returned HTTP ${response.status}`);
            return { status: response.status, data: response.status === 204 ? undefined : await response.json(), headers: response.headers };
        },
        async paginate(path, { maxPages = 100 } = {}) {
            const values = [];
            let next = path;
            for (let page = 0; next; page += 1) {
                if (page >= maxPages) throw new Error("Sentry pagination exceeded its configured page limit");
                const response = await client.request(next);
                if (!Array.isArray(response.data)) throw new Error("Sentry paginated response must be an array");
                values.push(...response.data);
                next = nextLink(response.headers?.get?.("link"));
            }
            return values;
        },
    };
    return client;
}

function nextLink(header) {
    if (!header) return null;
    for (const part of header.split(",")) {
        const match = part.match(/^\s*<([^>]+)>\s*;(.*)$/u);
        if (!match) continue;
        const parameters = new Map(match[2].split(";").map((entry) => {
            const [key, ...rest] = entry.trim().split("=");
            return [key, rest.join("=").replace(/^"|"$/gu, "")];
        }));
        if (parameters.get("rel") === "next" && parameters.get("results") === "true") return match[1];
    }
    return null;
}

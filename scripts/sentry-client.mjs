export function createSentryClient({ token, fetchImpl = globalThis.fetch, apiBase = "https://sentry.io/api/0" }) {
    if (!token) throw new Error("A Sentry credential is required");
    const base = new URL(apiBase.endsWith("/") ? apiBase : `${apiBase}/`);
    if (base.protocol !== "https:") throw new Error("Sentry API must use HTTPS");
    return {
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
    };
}

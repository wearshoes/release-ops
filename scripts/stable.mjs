import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function stableJson(value) {
    return JSON.stringify(stable(value));
}

export function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

export async function sha256Files(paths) {
    const hash = createHash("sha256");
    for (const path of [...paths].sort()) {
        hash.update(path.replaceAll("\\", "/"));
        hash.update("\0");
        hash.update(await readFile(path));
        hash.update("\0");
    }
    return hash.digest("hex");
}

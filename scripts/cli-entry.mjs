import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function canonicalPath(path) {
    const absolute = resolve(path);
    try {
        return realpathSync.native(absolute);
    } catch {
        return absolute;
    }
}

export function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
    return Boolean(argv1) && canonicalPath(fileURLToPath(importMetaUrl)) === canonicalPath(argv1);
}

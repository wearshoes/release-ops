import { access, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export function assertRelativeRepositoryPath(value, name = "path") {
    if (typeof value !== "string" || !value || isAbsolute(value)) throw new Error(`${name} must be repository-relative`);
    const segments = value.replaceAll("\\", "/").split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
        throw new Error(`${name} contains an unsafe path segment`);
    }
    return value;
}

function isInside(root, target) {
    const result = relative(root, target);
    return result === "" || (!result.startsWith("..") && !isAbsolute(result));
}

async function nearestExisting(path) {
    let current = path;
    while (true) {
        try {
            await access(current);
            return current;
        } catch (error) {
            if (error?.code !== "ENOENT") throw error;
        }
        const parent = dirname(current);
        if (parent === current) throw new Error(`No existing ancestor for ${path}`);
        current = parent;
    }
}

export async function resolveRepositoryPath(root, value, { name = "path", mustExist = false } = {}) {
    assertRelativeRepositoryPath(value, name);
    const rootReal = await realpath(resolve(root));
    const lexical = resolve(rootReal, value);
    const existing = await nearestExisting(lexical);
    const existingReal = await realpath(existing);
    if (!isInside(rootReal, existingReal)) throw new Error(`${name} escapes the repository through a symlink`);
    if (mustExist && existing !== lexical) throw new Error(`${name} does not exist`);
    if (existing === lexical) {
        const targetReal = await realpath(lexical);
        if (!isInside(rootReal, targetReal)) throw new Error(`${name} escapes the repository`);
        return targetReal;
    }
    return lexical;
}

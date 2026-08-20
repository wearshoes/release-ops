#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEXT_EXTENSIONS = new Set([".json", ".md", ".mjs", ".py", ".yml", ".yaml", ".ps1", ".txt"]);
const PATTERNS = [
    [/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}/u, "GitHub token"],
    [/sntrys_[A-Za-z0-9_-]{20,}/u, "Sentry token"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/u, "private key"],
];

async function files() {
    const result = await execFile("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
        cwd: ROOT, encoding: "utf8",
    });
    return result.stdout.split("\0").filter(Boolean).sort();
}

async function main() {
    const findings = [];
    for (const relative of await files()) {
        if (!TEXT_EXTENSIONS.has(extname(relative).toLowerCase())) continue;
        let text;
        try {
            text = await readFile(resolve(ROOT, relative), "utf8");
        } catch (error) {
            if (error?.code === "ENOENT") continue;
            throw error;
        }
        for (const [pattern, category] of PATTERNS) {
            if (pattern.test(text)) findings.push(`${relative}: ${category}`);
        }
    }
    if (findings.length) throw new Error(`credential-like material found in ${findings.join(", ")}`);
    process.stdout.write("Release Ops credential scan is clean\n");
}

main().catch((error) => {
    process.stderr.write(`Release Ops credential scan failed: ${error.message}\n`);
    process.exitCode = 1;
});

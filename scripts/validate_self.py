#!/usr/bin/env python3
"""Portable structural checks for the Release Ops plugin repository."""

from __future__ import annotations

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
EXPECTED_SKILLS = {
    "release-ops-setup",
    "github-release-pipeline",
    "sentry-project-provisioner",
    "sentry-issue-repair",
}


def fail(message: str) -> None:
    raise ValueError(message)


def validate_manifest() -> None:
    path = ROOT / ".codex-plugin" / "plugin.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("name") != "release-ops":
        fail("plugin name must be release-ops")
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", data.get("version", "")):
        fail("plugin version must use semantic versioning")
    if data.get("skills") != "./skills/":
        fail("plugin must expose ./skills/")
    if data.get("repository") != "https://github.com/wearshoes/release-ops":
        fail("plugin repository metadata is invalid")


def frontmatter(text: str) -> dict[str, str]:
    match = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
    if not match:
        fail("SKILL.md is missing YAML frontmatter")
    result: dict[str, str] = {}
    for line in match.group(1).splitlines():
        key, separator, value = line.partition(":")
        if separator:
            result[key.strip()] = value.strip()
    return result


def validate_skills() -> None:
    skills_root = ROOT / "skills"
    actual = {path.name for path in skills_root.iterdir() if path.is_dir()}
    if actual != EXPECTED_SKILLS:
        fail(f"unexpected skill set: {sorted(actual)}")
    for name in sorted(actual):
        skill = skills_root / name
        metadata = frontmatter((skill / "SKILL.md").read_text(encoding="utf-8"))
        if metadata.get("name") != name or not metadata.get("description"):
            fail(f"{name} frontmatter is invalid")
        yaml = (skill / "agents" / "openai.yaml").read_text(encoding="utf-8")
        if f"${name}" not in yaml:
            fail(f"{name} UI default prompt must mention the skill")


def validate_files() -> None:
    required = [
        "scripts/release-ops.mjs",
        "scripts/release-entry.mjs",
        "scripts/release-publisher.mjs",
        "scripts/github_secret.py",
        "scripts/sentry-project.mjs",
        "scripts/sentry-intake.mjs",
        "scripts/sentry-resolver.mjs",
        "assets/templates/publish-release.yml",
        "assets/templates/sentry-issues.yml",
        "assets/templates/resolve-issues.yml",
        "assets/fixtures/adapters.json",
        "assets/schemas/provider.schema.json",
        "assets/fixtures/providers/performance.example.json",
        "assets/fixtures/providers/vulnerability.example.json",
    ]
    for relative in required:
        if not (ROOT / relative).is_file():
            fail(f"required plugin file is missing: {relative}")
    for path in ROOT.rglob("*"):
        if path.is_file() and path.suffix.lower() in {".md", ".json", ".mjs", ".py", ".yml", ".yaml"}:
            text = path.read_text(encoding="utf-8")
            if "[TO" + "DO:" in text:
                fail(f"unfinished scaffold placeholder in {path.relative_to(ROOT)}")


def main() -> int:
    validate_manifest()
    validate_skills()
    validate_files()
    print("Release Ops plugin structure is valid")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Release Ops validation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from None

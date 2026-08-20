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
    if data.get("version") != "1.0.0":
        fail("public plugin version must be 1.0.0")
    if data.get("skills") != "./skills/":
        fail("plugin must expose ./skills/")
    if data.get("repository") != "https://github.com/wearshoes/release-ops":
        fail("plugin repository metadata is invalid")
    if data.get("homepage") != "https://github.com/wearshoes/release-ops#readme":
        fail("plugin homepage metadata is invalid")
    if data.get("license") != "MIT":
        fail("plugin license metadata must be MIT")


def validate_marketplace() -> None:
    path = ROOT / ".agents" / "plugins" / "marketplace.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("name") != "release-ops":
        fail("marketplace name must be release-ops")
    if data.get("interface", {}).get("displayName") != "Release Ops":
        fail("marketplace display name must be Release Ops")
    plugins = data.get("plugins")
    if not isinstance(plugins, list) or len(plugins) != 1:
        fail("marketplace must expose exactly one plugin")
    plugin = plugins[0]
    if plugin.get("name") != "release-ops":
        fail("marketplace plugin name must be release-ops")
    if plugin.get("source") != {
        "source": "url",
        "url": "https://github.com/wearshoes/release-ops.git",
        "ref": "v1.0.0",
    }:
        fail("marketplace must install the immutable v1.0.0 plugin")
    if plugin.get("policy") != {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL",
    }:
        fail("marketplace policy is invalid")
    if plugin.get("category") != "Developer Tools":
        fail("marketplace category is invalid")


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
        "README.md",
        "LICENSE",
        ".agents/plugins/marketplace.json",
        "scripts/release-ops.mjs",
        "scripts/setup-core.mjs",
        "scripts/path-safety.mjs",
        "scripts/collect-artifacts.mjs",
        "scripts/release-entry.mjs",
        "scripts/release-publisher.mjs",
        "scripts/github_secret.py",
        "scripts/sentry-project.mjs",
        "scripts/sentry-intake.mjs",
        "scripts/sentry-resolver.mjs",
        "assets/fixtures/adapters.json",
        "assets/schemas/provider.schema.json",
        "assets/schemas/config.schema.json",
        "assets/schemas/adapter.schema.json",
        "assets/schemas/setup-plan.schema.json",
        "assets/schemas/audit.schema.json",
        "assets/schemas/release-manifest.schema.json",
        "assets/fixtures/providers/performance.example.json",
        "assets/fixtures/providers/vulnerability.example.json",
        "providers/sentry/provider.json",
        "providers/sentry/config.schema.json",
        "docs/getting-started.md",
        "docs/providers/README.md",
        "docs/providers/sentry.md",
        "docs/stacks/README.md",
        "docs/workflows/github-release.md",
        "docs/migrations/config-v1.md",
    ]
    for relative in required:
        if not (ROOT / relative).is_file():
            fail(f"required plugin file is missing: {relative}")
    for path in ROOT.rglob("*"):
        if path.is_file() and path.suffix.lower() in {".md", ".json", ".mjs", ".py", ".yml", ".yaml"}:
            text = path.read_text(encoding="utf-8")
            if "[TO" + "DO:" in text:
                fail(f"unfinished scaffold placeholder in {path.relative_to(ROOT)}")
            if "release-ops" + "-v2" in text.lower():
                fail(f"product name must remain release-ops in {path.relative_to(ROOT)}")


def validate_catalogs() -> None:
    adapter_root = ROOT / "adapters"
    adapter_docs: set[str] = set()
    statuses: dict[str, str] = {}
    for directory in sorted(path for path in adapter_root.iterdir() if path.is_dir()):
        data = json.loads((directory / "adapter.json").read_text(encoding="utf-8"))
        if data.get("schemaVersion") != "release-ops/adapter/v2" or data.get("id") != directory.name:
            fail(f"invalid adapter manifest: {directory.name}")
        doc = data.get("docs")
        if not isinstance(doc, str) or not (ROOT / doc).is_file() or doc in adapter_docs:
            fail(f"invalid adapter documentation link: {directory.name}")
        adapter_docs.add(doc)
        statuses[directory.name] = data.get("status")
    if statuses.get("unreal") != "unsupported" or statuses.get("unity") != "credential-gated":
        fail("Unreal and Unity support statuses are invalid")
    unity = json.loads((adapter_root / "unity" / "adapter.json").read_text(encoding="utf-8"))
    if unity.get("credentialProfiles") != {
        "personal": ["UNITY_LICENSE", "UNITY_EMAIL", "UNITY_PASSWORD"],
        "professional": ["UNITY_SERIAL", "UNITY_EMAIL", "UNITY_PASSWORD"],
    }:
        fail("Unity credential profiles are invalid")

    providers = [path for path in (ROOT / "providers").iterdir() if path.is_dir()]
    if [path.name for path in providers] != ["sentry"]:
        fail("only the Sentry provider may be installed")
    provider = json.loads((providers[0] / "provider.json").read_text(encoding="utf-8"))
    if provider.get("schemaVersion") != "release-ops/provider/v2" or provider.get("installed") is not True:
        fail("Sentry provider manifest is invalid")
    config_schema = providers[0] / provider.get("configSchema", "")
    if not config_schema.is_file() or provider.get("configSchemaVersion") not in config_schema.read_text(encoding="utf-8"):
        fail("Sentry provider config schema is invalid")


def main() -> int:
    validate_manifest()
    validate_marketplace()
    validate_skills()
    validate_files()
    validate_catalogs()
    print("Release Ops plugin structure is valid")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Release Ops validation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from None

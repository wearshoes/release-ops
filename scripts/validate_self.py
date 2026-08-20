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
EXPECTED_EXTENSIONS = {
    "stack": {"android", "apple", "javascript", "dotnet", "native", "flutter", "react-native", "godot", "unity", "generic", "unreal"},
    "signing": {"android-keystore", "apple-codesign", "generic-command"},
    "release": {"local", "github"},
    "provider": {"sentry"},
}
PUBLIC_SCHEMAS = {
    "config.schema.json": "release-ops/config/v1",
    "extension.schema.json": "release-ops/extension/v1",
    "processor.schema.json": "release-ops/processor/v1",
    "processor-graph.schema.json": "release-ops/processor-graph/v1",
    "inspect.schema.json": "release-ops/inspect/v1",
    "setup-answers.schema.json": "release-ops/setup-answers/v1",
    "setup-plan.schema.json": "release-ops/setup-plan/v1",
    "managed-files.schema.json": "release-ops/managed-files/v1",
    "audit.schema.json": "release-ops/audit/v1",
    "release-manifest.schema.json": "release-ops/release-manifest/v1",
}


def fail(message: str) -> None:
    raise ValueError(message)


def load(path: pathlib.Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def validate_manifest() -> str:
    data = load(ROOT / ".codex-plugin" / "plugin.json")
    if data.get("name") != "release-ops":
        fail("plugin name must be release-ops")
    version = data.get("version", "")
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", version):
        fail("plugin version must use semantic versioning")
    if data.get("skills") != "./skills/":
        fail("plugin must expose ./skills/")
    if data.get("repository") != "https://github.com/wearshoes/release-ops":
        fail("plugin repository metadata is invalid")
    return version


def validate_marketplace(version: str) -> None:
    data = load(ROOT / ".agents" / "plugins" / "marketplace.json")
    plugins = data.get("plugins")
    if data.get("name") != "release-ops" or not isinstance(plugins, list) or len(plugins) != 1:
        fail("marketplace must expose exactly one release-ops plugin")
    plugin = plugins[0]
    if plugin.get("source") != {
        "source": "url",
        "url": "https://github.com/wearshoes/release-ops.git",
        "ref": f"v{version}",
    }:
        fail(f"marketplace must install immutable v{version}")


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
    root = ROOT / "skills"
    actual = {path.name for path in root.iterdir() if path.is_dir()}
    if actual != EXPECTED_SKILLS:
        fail(f"unexpected skill set: {sorted(actual)}")
    for name in sorted(actual):
        metadata = frontmatter((root / name / "SKILL.md").read_text(encoding="utf-8"))
        if metadata.get("name") != name or not metadata.get("description"):
            fail(f"{name} frontmatter is invalid")
        if f"${name}" not in (root / name / "agents" / "openai.yaml").read_text(encoding="utf-8"):
            fail(f"{name} UI default prompt must mention the skill")


def validate_extensions(version: str) -> None:
    found: dict[str, set[str]] = {kind: set() for kind in EXPECTED_EXTENSIONS}
    for manifest_path in sorted((ROOT / "extensions").glob("*/*/extension.json")):
        data = load(manifest_path)
        kind = manifest_path.parents[1].name
        identifier = manifest_path.parent.name
        if data.get("schemaVersion") != "release-ops/extension/v1" or data.get("id") != identifier or data.get("type") != kind:
            fail(f"invalid extension identity: {manifest_path.relative_to(ROOT)}")
        if data.get("version") != version:
            fail(f"extension version differs from plugin: {identifier}")
        found[kind].add(identifier)
        for field in ("configSchema", "docs"):
            path = ROOT / data.get(field, "")
            if not path.is_file():
                fail(f"extension {identifier} has missing {field}")
        for processor in data.get("processors", []):
            if processor.get("schemaVersion") != "release-ops/processor/v1":
                fail(f"extension {identifier} has invalid processor")
            if not (ROOT / processor.get("module", "")).is_file():
                fail(f"extension {identifier} processor module is missing")
        for runtime in data.get("runtimeFiles", []):
            if not (ROOT / runtime).is_file():
                fail(f"extension {identifier} runtime file is missing")
    if found != EXPECTED_EXTENSIONS:
        fail(f"unexpected extension catalog: {found}")
    if (ROOT / "adapters").exists() or (ROOT / "providers").exists():
        fail("legacy adapter/provider registries must not exist")


def validate_files() -> None:
    required = [
        "README.md", "README.en.md", "LICENSE", ".agents/plugins/marketplace.json",
        "scripts/release-ops.mjs", "scripts/setup-core.mjs", "scripts/extension-registry.mjs",
        "scripts/processor-graph.mjs", "scripts/kernel-api.mjs", "scripts/workflow-renderer.mjs",
        "scripts/project-installer.mjs", "scripts/execute.mjs", "scripts/validate-boundaries.mjs",
        "docs/getting-started.md", "docs/getting-started.en.md", "docs/extensions/developing.md",
    ]
    for relative in required:
        if not (ROOT / relative).is_file():
            fail(f"required plugin file is missing: {relative}")
    for name, identifier in PUBLIC_SCHEMAS.items():
        schema = load(ROOT / "assets" / "schemas" / name)
        if identifier not in json.dumps(schema, ensure_ascii=False) or schema.get("additionalProperties") is not False:
            fail(f"public schema is invalid: {name}")
    for path in ROOT.rglob("*"):
        if path.is_file() and path.suffix.lower() in {".md", ".json", ".mjs", ".py", ".yml", ".yaml"}:
            text = path.read_text(encoding="utf-8")
            if "[TO" + "DO:" in text:
                fail(f"unfinished placeholder in {path.relative_to(ROOT)}")


def validate_fixtures() -> None:
    for name in ("performance", "vulnerability"):
        data = load(ROOT / "assets" / "fixtures" / "providers" / f"{name}.example.json")
        if data != {
            **data,
            "schemaVersion": "release-ops/extension-fixture/v1",
            "id": name,
            "type": "provider",
            "registered": False,
            "installed": False,
        }:
            fail(f"{name} fixture registration boundary is invalid")


def main() -> int:
    version = validate_manifest()
    validate_marketplace(version)
    validate_skills()
    validate_extensions(version)
    validate_files()
    validate_fixtures()
    print("Release Ops plugin structure is valid")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Release Ops validation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from None

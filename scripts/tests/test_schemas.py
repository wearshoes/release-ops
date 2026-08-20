from __future__ import annotations

import json
import pathlib
import subprocess
import unittest

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError
from referencing import Registry, Resource


ROOT = pathlib.Path(__file__).resolve().parents[2]
SCHEMAS = ROOT / "assets" / "schemas"
EXTENSION_SCHEMAS = ROOT / "assets" / "extension-schemas"
SCHEMA_BASE = "https://github.com/wearshoes/release-ops/schemas/"


def load(path: pathlib.Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def registry() -> Registry:
    result = Registry()
    for path in [*SCHEMAS.glob("*.json"), *EXTENSION_SCHEMAS.glob("*.json")]:
        schema = load(path)
        resource = Resource.from_contents(schema)
        result = result.with_resource(schema["$id"], resource)
        result = result.with_resource(f"{SCHEMA_BASE}{path.name}", resource)
    return result


def validator(path: pathlib.Path) -> Draft202012Validator:
    return Draft202012Validator(load(path), registry=registry())


class PublicSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        script = """
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { applySetupPlan, auditProject, createSetupPlan, inspectProject } from "./scripts/setup-core.mjs";
import { answersFor, baseConfig, fixtureRoot } from "./scripts/tests/fixtures.mjs";
const root = await fixtureRoot("release-ops-public-schema-");
const answers = answersFor(baseConfig());
const inspection = await inspectProject(root);
const plan = await createSetupPlan(root, answers, { token: null });
await applySetupPlan(plan, plan.planDigest, { token: null });
const installedInspection = await inspectProject(root);
const audit = await auditProject(root, { token: null, env: {} });
const state = {};
for (const name of ["config", "processor-graph", "managed-files"]) {
    state[name] = JSON.parse(await readFile(join(root, ".release-ops", `${name}.json`), "utf8"));
}
process.stdout.write(JSON.stringify({ answers, inspection, plan, installedInspection, audit, state }));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "--eval", script],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        cls.contracts = json.loads(result.stdout)

    def test_all_public_and_extension_schemas_are_valid_draft_2020_12(self) -> None:
        for path in sorted([*SCHEMAS.glob("*.json"), *EXTENSION_SCHEMAS.glob("*.json")]):
            with self.subTest(schema=path.name):
                Draft202012Validator.check_schema(load(path))

    def test_extension_manifests_validate(self) -> None:
        extension_validator = validator(SCHEMAS / "extension.schema.json")
        paths = sorted((ROOT / "extensions").glob("*/*/extension.json"))
        self.assertEqual(len(paths), 17)
        for path in paths:
            with self.subTest(extension=path.parent.name):
                extension_validator.validate(load(path))

    def test_runtime_outputs_validate_against_public_contracts(self) -> None:
        mappings = {
            "config.schema.json": self.contracts["state"]["config"],
            "inspect.schema.json": self.contracts["inspection"],
            "setup-answers.schema.json": self.contracts["answers"],
            "setup-plan.schema.json": self.contracts["plan"],
            "processor-graph.schema.json": self.contracts["state"]["processor-graph"],
            "managed-files.schema.json": self.contracts["state"]["managed-files"],
            "audit.schema.json": self.contracts["audit"],
        }
        for name, value in mappings.items():
            with self.subTest(schema=name):
                validator(SCHEMAS / name).validate(value)
        validator(SCHEMAS / "inspect.schema.json").validate(self.contracts["installedInspection"])

    def test_nested_public_contracts_reject_unknown_fields(self) -> None:
        plan = json.loads(json.dumps(self.contracts["plan"]))
        plan["managedFiles"]["operations"][0]["credentialValue"] = "forbidden"
        with self.assertRaises(ValidationError):
            validator(SCHEMAS / "setup-plan.schema.json").validate(plan)

    def test_public_release_manifest_and_audit_validate(self) -> None:
        release = validator(SCHEMAS / "release-manifest.schema.json")
        release.validate({
            "schemaVersion": "release-ops/release-manifest/v1",
            "version": "1.2.3",
            "buildNumbers": {"android": 9},
            "publishedAt": "2026-08-20T00:00:00Z",
            "releaseUrl": "https://github.com/owner/releases/releases/tag/v1.2.3",
            "artifacts": [{
                "name": "app.apk",
                "downloadUrl": "https://github.com/owner/releases/releases/download/v1.2.3/app.apk",
                "platform": "android",
                "architecture": "universal",
                "size": 4,
                "sha256": "a" * 64,
            }],
        })

        audit = validator(SCHEMAS / "audit.schema.json")
        audit.validate({
            "schemaVersion": "release-ops/audit/v1",
            "success": False,
            "remoteVerified": False,
            "checks": {
                "configuration": {"status": "pass"},
                "graph": {"status": "fail", "message": "drift"},
            },
            "extensions": {"android-app": {"status": "configured"}},
        })

    def test_unregistered_provider_fixtures_remain_non_runtime_contracts(self) -> None:
        extension_ids = {path.parent.name for path in (ROOT / "extensions").glob("*/*/extension.json")}
        for name in ("performance", "vulnerability"):
            fixture = load(ROOT / "assets" / "fixtures" / "providers" / f"{name}.example.json")
            self.assertFalse(fixture["installed"])
            self.assertNotIn(name, extension_ids)


if __name__ == "__main__":
    unittest.main()

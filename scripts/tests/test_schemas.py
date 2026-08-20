from __future__ import annotations

import json
import pathlib
import unittest

from jsonschema import Draft202012Validator


ROOT = pathlib.Path(__file__).resolve().parents[2]
SCHEMAS = ROOT / "assets" / "schemas"


def load(path: pathlib.Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


class PublicSchemaTests(unittest.TestCase):
    def test_all_public_schemas_are_valid_draft_2020_12(self) -> None:
        for path in sorted(SCHEMAS.glob("*.json")):
            with self.subTest(schema=path.name):
                Draft202012Validator.check_schema(load(path))

    def test_adapter_and_provider_manifests_validate(self) -> None:
        adapter_validator = Draft202012Validator(load(SCHEMAS / "adapter.schema.json"))
        for path in sorted((ROOT / "adapters").glob("*/adapter.json")):
            with self.subTest(adapter=path.parent.name):
                adapter_validator.validate(load(path))

        provider_validator = Draft202012Validator(load(SCHEMAS / "provider.schema.json"))
        manifests = list((ROOT / "providers").glob("*/provider.json"))
        manifests += list((ROOT / "assets" / "fixtures" / "providers").glob("*.json"))
        for path in sorted(manifests):
            with self.subTest(provider=path.name):
                provider_validator.validate(load(path))

    def test_sentry_config_and_public_results_validate(self) -> None:
        sentry = Draft202012Validator(load(ROOT / "providers" / "sentry" / "config.schema.json"))
        sentry.validate({"schemaVersion": "release-ops/provider-config/sentry/v1", "enabled": False})
        sentry.validate({
            "schemaVersion": "release-ops/provider-config/sentry/v1",
            "enabled": True,
            "organization": "owner",
            "project": "example",
            "apiBase": "https://owner.sentry.io/api/0",
            "issueSync": True,
            "lookbackMinutes": 75,
            "schedule": "17 * * * *",
            "releaseTemplate": "{project}@{version}",
            "distTemplate": "{version}",
            "debugArtifacts": [],
        })

        release = Draft202012Validator(load(SCHEMAS / "release-manifest.schema.json"))
        release.validate({
            "schemaVersion": "release-ops-release/v2",
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

        audit = Draft202012Validator(load(SCHEMAS / "audit.schema.json"))
        audit.validate({
            "schemaVersion": "release-ops/audit/v2",
            "success": False,
            "remoteVerified": False,
            "checks": {
                "configuration": {"status": "pass"},
                "managedFiles": {"status": "pass"},
                "localBuild": {"status": "configured"},
                "githubHosting": {"status": "fail", "reason": "credential-unavailable"},
                "releasePublication": {"status": "configured"},
                "providers": {"sentry": {"status": "disabled"}},
                "incidentResolution": {"status": "not-applicable"},
            },
        })


if __name__ == "__main__":
    unittest.main()

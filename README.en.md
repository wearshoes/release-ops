# Release Ops

[![Verify Release Ops](https://github.com/wearshoes/release-ops/actions/workflows/ci.yml/badge.svg)](https://github.com/wearshoes/release-ops/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[中文](README.md) | **English**

Release Ops is a reproducible release plugin for Codex. The kernel is limited to extension registration, processor graphs, permissions, transactions, structured workflows, auditing, and execution. Built-in extensions own stack, signing, publication, and Sentry behavior.

Project configuration lives at `.release-ops/config.json` and uses `release-ops/config/v1`. It stores only the project name and extension instances. Derived paths, processor graphs, generated state, and credential values are never hand-maintained configuration.

## Quick Start

```powershell
codex.cmd plugin marketplace add wearshoes/release-ops --ref v1.1.0
codex.cmd plugin add release-ops@release-ops
node scripts/release-ops.mjs inspect --root <repository>
```

The setup flow is `inspect -> plan --mode initialize -> apply --confirm <digest> -> audit`. A valid configuration defaults to `audit`; explicit `reconfigure` uses current values as defaults, while `reinitialize` inherits neither GitHub nor provider decisions. Setup authorization is not release authorization.

See [Setup, reconfiguration, and audit](docs/getting-started.md).

## Processor Data Flow

Each processor node is identified by `<instanceId>:<processorId>`. The kernel orders nodes by fixed stages, explicit `before/after` constraints, and the full node ID. Capabilities are the only way to create cross-instance edges.

```text
inspect/configure/plan
        |
preflight -> prepare -> build -> sign -> debug-artifacts -> collect -> publish-stage -> publish-finalize

scheduled-ingest     resolve     audit
      (independent entrypoints outside the release lane)
```

Capabilities support `one/many` consumption and `exclusive/append/keyed` merging. Missing or ambiguous capabilities, duplicate keys, duplicate build-unit owners, and cycles fail during planning.

## Built-in Extensions

This matrix is generated deterministically from `extensions/**/extension.json`:

<!-- EXTENSION_MATRIX_START -->
| Type | Extension | Status | Targets |
| --- | --- | --- | --- |
| provider | [sentry](docs/providers/sentry.md) | supported | - |
| release | [github](docs/workflows/github-release.md) | supported | - |
| release | [local](docs/workflows/local-release.md) | supported | - |
| signing | [android-keystore](docs/signing/android-keystore.md) | supported | - |
| signing | [apple-codesign](docs/signing/apple-codesign.md) | supported | - |
| signing | [generic-command](docs/signing/generic-command.md) | supported | - |
| stack | [android](docs/stacks/android.md) | supported | android: ubuntu-latest |
| stack | [apple](docs/stacks/apple.md) | supported | macos: macos-latest<br>ios: macos-latest |
| stack | [dotnet](docs/stacks/dotnet.md) | supported | linux: ubuntu-latest<br>windows: windows-latest<br>macos: macos-latest |
| stack | [flutter](docs/stacks/flutter.md) | supported | android: ubuntu-latest<br>windows: windows-latest<br>ios: macos-latest |
| stack | [generic](docs/stacks/generic.md) | supported | - |
| stack | [godot](docs/stacks/godot.md) | supported | linux: ubuntu-latest<br>web: ubuntu-latest<br>android: ubuntu-latest<br>windows: windows-latest<br>macos: macos-latest<br>ios: macos-latest |
| stack | [javascript](docs/stacks/javascript.md) | supported | web: ubuntu-latest<br>windows: windows-latest<br>macos: macos-latest |
| stack | [native](docs/stacks/native.md) | supported | linux: ubuntu-latest<br>windows: windows-latest<br>macos: macos-latest |
| stack | [react-native](docs/stacks/react-native.md) | supported | android: ubuntu-latest<br>ios: macos-latest |
| stack | [unity](docs/stacks/unity.md) | credential-gated | linux: ubuntu-latest<br>windows: windows-latest<br>macos: macos-latest |
| stack | [unreal](docs/stacks/unreal.md) | diagnostic only | - |
<!-- EXTENSION_MATRIX_END -->

`performance` and `vulnerability` remain unregistered contract fixtures. They never appear in setup choices, deployed runtime, workflows, Secret roles, or network permissions.

## Release Guarantees

- Extension modules receive only the frozen kernel API. Commands always use `shell:false`, and HTTPS is restricted to exact manifest-declared origins.
- Workflow extensions contribute only SHA-pinned actions or processor invocations. Only the kernel renderer emits YAML and the fixed trampoline command.
- Plans snapshot configuration, graph, extension code SHA-256, workflow model, current file bytes, repository identity, and Secret roles.
- Apply rechecks the digest, extension code, and file snapshots before idempotent remote operations and journaled local replacement. Local failures roll back in reverse order.
- GitHub dual-repository publication builds once and uploads the same local bytes to private and public Releases. The standard release manifest remains separate from the project-specific `latest.json` projection.
- Publication success and incident resolution are independent states. Neither can stand in for the other.

## Documentation

- [Setup, reconfiguration, reinitialization, and audit](docs/getting-started.md)
- [Local publication](docs/workflows/local-release.md)
- [GitHub Release](docs/workflows/github-release.md)
- [Private-to-public distribution](docs/workflows/private-to-public.md)
- [Audit and upgrades](docs/workflows/audit-and-upgrade.md)
- [Stack extensions](docs/stacks/README.md)
- [Signing extensions](docs/signing/README.md)
- [Provider extensions](docs/providers/README.md)
- [Extension development contract](docs/extensions/developing.md)

## Development Validation

```bash
node --test scripts/tests/*.test.mjs
python -m unittest discover -s scripts/tests -p "test_*.py"
python scripts/validate_self.py
node scripts/validate-boundaries.mjs
node scripts/validate-credentials.mjs
node scripts/generate-readme.mjs --check
git diff --check
```

[MIT](LICENSE)

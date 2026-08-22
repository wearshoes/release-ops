# Release Ops

[![Verify Release Ops](https://github.com/wearshoes/release-ops/actions/workflows/ci.yml/badge.svg)](https://github.com/wearshoes/release-ops/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[中文](README.md) | **English**

Release Ops is a release workflow plugin for Codex. It asks about the project stack, build artifacts, signing, publication target, and optional services, then creates an auditable and reproducible release configuration and workflow.

## Quick Start

### 1. Install the Plugin

Run these commands in a terminal:

```powershell
codex.cmd plugin marketplace add wearshoes/release-ops --ref v1.1.0
codex.cmd plugin add release-ops@release-ops
```

If the marketplace is already installed, update it and reinstall the Plugin:

```powershell
codex.cmd plugin marketplace upgrade release-ops --json
codex.cmd plugin add release-ops@release-ops --json
```

### 2. Open Codex in the Target Project

```powershell
cd <repository>
codex
```

### 3. Start Initialization in the Codex Conversation

Either prompt works. These are requests to Codex, not terminal commands:

```text
Use the Release Ops plugin to initialize this project
```

or:

```text
release-ops init
```

The Plugin inspects the project and asks, in order, about stacks and build units, signing, publication, GitHub repository layout, and optional services. It then presents the complete plan: managed file additions, updates and deletions, the processor graph, Secret names, repository operations, and the SHA-256 digest.

The current initialization request authorizes that plan. After displaying it, Codex immediately supplies the plan digest as an internal confirmation value, applies it, and audits the configuration, workflows, runtime, and remote repository identity. You do not need to copy or reply with the digest. If file drift or a processor fix changes the plan without changing any user selection or remote target, Codex displays the replacement plan and continues automatically; it asks again only when a selection or target changes. Initialization creates release capability; it does not change the application version or create a Release.

Common follow-up prompts:

```text
release-ops audit
release-ops reconfigure
release-ops reinitialize
```

See [Installation, initialization, and audit](docs/getting-started.en.md) for the complete workflow.

## Sentry Onboarding

When Sentry is selected, Release Ops first checks the application SDK for the stack that owns the final published artifacts in the processor graph. Planning requires dependency, official initialization, and non-placeholder public DSN evidence. It never chooses arbitrarily when final artifact ownership is ambiguous.

If SDK setup is incomplete, Codex verifies the Sentry project and uses the Chrome control plugin to read the public DSN from the user's signed-in Sentry project page; the user does not have to locate or paste it. Codex then uses the supported official Wizard, a constrained Sentry Agent flow, or the matching official platform guide. Release/dist, source maps, mappings, and other debug artifact uploads remain owned by Release Ops to prevent duplicate configuration. See [Sentry onboarding](docs/providers/sentry.en.md) for the full procedure.

## Generated State

- `.release-ops/config.json`: the project name and selected extension instances;
- `.release-ops/processor-graph.json`: the build, signing, publication, and optional service data flow;
- `.release-ops/managed-files.json`: managed file ownership and digests;
- `.release-ops/runtime/`: the kernel and only the extension runtimes selected for this project;
- structurally generated or explicitly adopted CI workflows.

Configuration never stores credential values. Secrets appear only as roles and names; their values remain in the local environment or CI Secret store.

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
| provider | [sentry](docs/providers/sentry.en.md) | supported | - |
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

- [Installation, initialization, and audit](docs/getting-started.en.md)
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

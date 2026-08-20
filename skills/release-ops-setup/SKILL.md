---
name: release-ops-setup
description: Configure, adopt, audit, or upgrade a reproducible release pipeline for a local project, including optional GitHub hosting and installed quality providers. Use for new or existing projects; do not use to publish an already-configured release.
---

# Release Ops Setup

Treat release publication as the core workflow. Quality systems such as Sentry are optional providers.

## Start

1. Inspect the repository, build system, canonical version source, signing requirements, current remotes, visibility, workflows, and release artifacts.
2. Run `node ../../scripts/release-ops.mjs inspect --root <repo>` from this skill directory.
3. If `.release-ops/config.json` exists, use `audit` or `upgrade`; otherwise use `init` or `adopt-github`.
4. Read [references/adapters.md](references/adapters.md) for the detected build adapter and [references/provider-contract.md](references/provider-contract.md) before enabling a provider.

When implementing a new provider rather than configuring an installed one, also read [references/developing-providers.md](references/developing-providers.md).

## Required Decisions

Ask only decisions that cannot be discovered:

- Whether the project should use GitHub at all.
- Whether to use an existing repository or create one; verify existing visibility through GitHub.
- The requested visibility for a new repository.
- For a private source repository, the public distribution repository name.
- Whether to enable one of the installed providers. In v1, offer only `None` and `Sentry`.

Do not present performance, vulnerability, or custom-command providers until an actual provider implementation is installed.

## Apply

- Default to a dry-run plan. Apply only after repository identity and hosting decisions are explicit.
- Public GitHub repositories use `same-repository` releases.
- Private GitHub repositories use `dual-repository`: retain a private source Release and publish identical locally-built bytes to a dedicated public repository.
- GitHub-disabled projects receive local build, signing, hashing, and packaging support only.
- Never write credentials to configuration, tracked files, command arguments, or output.
- Do not overwrite a managed file that differs from its recorded hash. Stop and merge deliberately.

## Finish

Run `audit`, the generated repository tests, and checks proportional to the selected build adapter. Report local build, GitHub hosting, publication, and provider status independently.

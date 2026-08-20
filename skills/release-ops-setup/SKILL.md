---
name: release-ops-setup
description: Inspect, plan, apply, or audit a reproducible release pipeline for a new or existing project, including explicit GitHub and optional provider decisions. Use for setup and migration; do not use to publish a release.
---

# Release Ops Setup

Release publication is the core workflow. Sentry and future quality systems are optional providers and are never enabled from detection or defaults.

## Route

1. Read the target repository's root instructions and [the setup SOP](../../docs/getting-started.md).
2. Run `node ../../scripts/release-ops.mjs inspect --root <repo>` from this skill directory.
3. Read only the detected or selected adapter page linked by the inspect result. If detection is ambiguous, ask which build root/adapter is authoritative. If Unreal is detected, report it as unsupported and stop workflow generation.
4. Ask whether to use GitHub. For GitHub, ask existing versus create; ask visibility only for create. Verify existing repository visibility and default branch through GitHub. A private source also requires a public distribution repository decision.
5. Always ask for one explicit provider selection, including when the repository already has a provider SDK, workflow, config, or Secret metadata. Offer only `None` and providers listed by inspect. Do not preselect Sentry.
6. Read a provider page under [the provider index](../../docs/providers/README.md) only after the user selects it. One provider selection authorizes its implemented setup capabilities; do not ask capability-by-capability questions.

## Plan And Apply

- Build commands use `executable + args`; never convert a project command into a shell string.
- Keep canonical version separate from platform build numbers. Use a platform build unit and the adapter-declared runner for each target.
- Write `release-ops/setup-answers/v2` without credential values, then run `plan`. Present repository identities, required Secret names, managed add/update/delete operations, conflicts, residual risks, and the exact SHA-256 digest.
- Apply only after the user confirms that exact plan. Run `apply --plan <file> --confirm <digest>`; do not substitute another plan or bypass digest validation.
- `release-ops/config/v1` is incompatible. Reinitialize it through the same explicit decisions; do not translate it silently.
- A changed managed file is a stop condition. Preserve the project edit and merge deliberately before generating a new plan.

## Finish

Run `audit` and adapter-specific checks. `remoteVerified:false` is not success. Report configuration, local build, GitHub hosting, publication readiness, provider upload, and incident resolution independently.

Setup never authorizes a Release, version bump, push, or incident closure.

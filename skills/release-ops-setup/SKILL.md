---
name: release-ops-setup
description: Inspect, initialize, migrate, upgrade, reconfigure, or audit a reproducible release pipeline for a new or existing project. Use when revisiting an old Release Ops config, including requests to check a newer Plugin version. Missing or config/v1 projects require fresh GitHub and provider choices; do not use to publish a release.
---

# Release Ops Setup

Release publication is the core workflow. Sentry and future quality systems are optional providers and are never enabled from detection or defaults.

## Route

1. Read the target repository's root instructions and [the setup SOP](../../docs/getting-started.md).
2. Run `node ../../scripts/release-ops.mjs inspect --root <repo>` from this skill directory.
3. Inspect `decisionCheckpoint` before doing migration analysis. When its status is `awaiting-user`, stop the current turn and ask for both unresolved current-user decisions: whether to use GitHub, and one provider selection from `None` plus the installed providers listed by inspect. Ask the provider question even when another adapter, workflow, Artifact, credential, or repository constraint is already visible.
4. Never inherit those decisions from config/v1, a previous task, an SDK, a workflow, existing runtime, Secret metadata, or a prior enabled/disabled state. They are evidence only. A request to check a newer Plugin version against config/v1 is a reinitialization request and must pass this decision checkpoint before compatibility recommendations or a plan.
5. After the current user answers, read only the detected or selected adapter page linked by inspect. If detection is ambiguous, ask which build root/adapter is authoritative. If Unreal is detected, report it as unsupported and stop workflow generation.
6. For GitHub, ask existing versus create; ask visibility only for create. Verify existing repository visibility and default branch through GitHub. A private source also requires a public distribution repository decision.
7. Read a provider page under [the provider index](../../docs/providers/README.md) only after the user selects it. One provider selection authorizes its implemented setup capabilities; do not ask capability-by-capability questions.

## Plan And Apply

- Build commands use `executable + args`; never convert a project command into a shell string.
- Keep canonical version separate from platform build numbers. Use a platform build unit and the adapter-declared runner for each target.
- Write `release-ops/setup-answers/v2` without credential values, then run `plan`. Present repository identities, required Secret names, managed add/update/delete operations, conflicts, residual risks, and the exact SHA-256 digest.
- Apply only after the user confirms that exact plan. Run `apply --plan <file> --confirm <digest>`; do not substitute another plan or bypass digest validation.
- `release-ops/config/v1` is incompatible. Reinitialize it through the same explicit decisions; do not translate it silently.
- Mature projects may preserve an existing equivalent managed workflow only through `managedFileAdoptions` with its exact current SHA-256 and matching `release` or `provider:<id>` owner. Never adopt runtime, configuration, or a path Release Ops would not generate for that owner.
- A changed managed file is a stop condition. Preserve the project edit and merge deliberately before generating a new plan.

## Finish

Run `audit` and adapter-specific checks. `remoteVerified:false` is not success. Report configuration, local build, GitHub hosting, publication readiness, provider upload, and incident resolution independently.

Setup never authorizes a Release, version bump, push, or incident closure.

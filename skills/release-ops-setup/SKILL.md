---
name: release-ops-setup
description: Inspect, initialize, reinitialize, upgrade, reconfigure, or audit a reproducible release pipeline. Missing config initializes; invalid or config/v2 reinitializes; valid config/v1 audits or explicitly reconfigures. Do not use to publish a release.
---

# Release Ops Setup

Release publication is the core workflow. Sentry and future quality systems are optional providers and are never enabled from detection or defaults.

## Route

1. Read the target repository's root instructions and [the setup SOP](../../docs/getting-started.md).
2. Run `node ../../scripts/release-ops.mjs inspect --root <repo>` from this skill directory and obey its route.
3. Missing config uses initialize. Invalid or `config/v2` uses reinitialize. Valid `config/v1` defaults to audit; run read-only reconfigure only when explicit, using current values as defaults.
4. Reinitialize never inherits GitHub topology or provider selection from old config, SDKs, workflows, runtime, Secret metadata, or previous tasks.
5. Ask in fixed order: stack/build-unit, signing, release, GitHub topology, provider. Hydrate only selected extension schema/questions/docs. Unreal is diagnostic-only and stops graph generation.
6. For GitHub, ask existing versus create; ask visibility only for create. Verify existing repository visibility and default branch through GitHub. A private source also requires a public distribution repository decision.
7. Read a provider page under [the provider index](../../docs/providers/README.md) only after the user selects it. One provider selection authorizes its implemented setup capabilities; do not ask capability-by-capability questions.

## Plan And Apply

- Build commands use `executable + args`; never convert a project command into a shell string.
- Keep canonical version separate from platform build numbers. Use a platform build unit and the stack extension's declared runner for each target.
- Write `release-ops/setup-answers/v1` without credential values, then run `plan --mode initialize|reconfigure|reinitialize`. Present config preview, processor graph, repository identities, Secret roles, managed add/update/delete operations, conflicts, residual risks, and the exact SHA-256 digest.
- Apply only after the user confirms that exact plan. Run `apply --plan <file> --confirm <digest>`; do not substitute another plan or bypass digest validation.
- `release-ops/config/v2` is incompatible. Reinitialize it through the same explicit decisions; never translate it.
- Mature projects may preserve an existing equivalent workflow only through `managedFileAdoptions` with its exact SHA-256 and matching extension instance owner. Never adopt runtime or configuration.
- A changed managed file is a stop condition. Preserve the project edit and merge deliberately before generating a new plan.

## Finish

Run `audit` and selected stack checks. Locate instances and entrypoints through config plus graph capabilities, never concrete IDs. `remoteVerified:false` is not success.

Setup never authorizes a Release, version bump, push, or incident closure.

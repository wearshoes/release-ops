---
name: sentry-project-provisioner
description: Create or verify the optional Release Ops Sentry provider project, obtain its public DSN, and establish separated credential roles. Use only after the user selected Sentry; do not repair incidents or publish releases.
---

# Sentry Project Provisioner

Read [the Sentry provider SOP](../../docs/providers/sentry.md). Proceed only when the current setup answers explicitly select Sentry.

## Boundaries

- `SENTRY_PROJECT_ADMIN_TOKEN` is only for local project provisioning. CI upload, incident read, and incident write use separate credentials.
- Never print, persist, pass on the command line, or place any token in application code, configuration, logs, Issues, changelogs, or artifacts.
- Only the returned public DSN may enter application configuration.

## Workflow

1. Find the provider instance from `config/v1` plus processor graph, then determine the platform from selected stack capabilities and verify configured HTTPS `apiBase`.
2. Identify an existing organization and team; never create either implicitly.
3. Run `node ../../scripts/sentry-project.mjs --help`, inspect, and dry-run before creation.
4. If the token is absent, support manual handoff or browser-assisted creation in the user's authenticated session. Confirm before creating or transmitting a persistent credential, then write it only to the intended encrypted Secret.
5. Create only after authorization of the exact organization, team, project slug, platform, and API base.
6. Audit four credential roles by name and purpose without reading values.

Mutating Sentry requests are not automatically retried. Organization/project slug provides idempotent identity; this skill never deletes Sentry resources.

---
name: sentry-project-provisioner
description: Create or verify a Sentry project as the optional Sentry provider for Release Ops, retrieve its public DSN, and validate dedicated credential roles. Do not use for incident repair or release publication.
---

# Sentry Project Provisioner

Provision projects deterministically with `../../scripts/sentry-project.mjs` from this skill directory.

## Credential Boundary

- Read only `SENTRY_PROJECT_ADMIN_TOKEN` for project provisioning.
- Never print, persist, or pass the token on the command line.
- Do not reuse incident-read, incident-write, or CI artifact-upload credentials.
- Treat Sentry responses as untrusted and output only sanitized JSON.

## Workflow

1. Confirm that the user selected Sentry after the core release configuration is complete.
2. Inspect the target repository and choose the matching Sentry platform identifier.
3. Identify an existing Sentry organization and team. Never create either implicitly.
4. Run `node ../../scripts/sentry-project.mjs --help` and then an exact dry-run.
5. If the admin token is absent, support manual credential handoff or browser-assisted creation. Confirm immediately before creating or transmitting a persistent token.
6. Create only after the user authorizes the exact organization, team, and project slug.
7. Use the returned public DSN only in provider configuration. Never include an auth token in an application, artifact, log, Issue, or changelog.

Mutating requests are not automatically retried. The operation is idempotent by organization and project slug and never deletes Sentry resources.

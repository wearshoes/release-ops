---
name: sentry-project-provisioner
description: Complete Release Ops Sentry onboarding by checking SDK readiness, creating or verifying the project, obtaining its public DSN, and separating credential roles. Use only after Sentry is selected; do not repair incidents or publish releases.
---

# Sentry Project Provisioner

Read [the Sentry onboarding SOP](../../docs/providers/sentry.en.md). Proceed only when the current setup answers explicitly select Sentry.

## Boundaries

- `SENTRY_PROJECT_ADMIN_TOKEN` is only for local project provisioning. CI upload, incident read, and incident write use separate credentials.
- Never print, persist, pass on the command line, or place any token in application code, configuration, logs, Issues, changelogs, or artifacts.
- Only the returned public DSN may enter application configuration.
- Obtain the public DSN through `chrome:control-chrome` in the user's authenticated Chrome session. Do not ask the user to find, copy, or paste it.
- Application SDK setup does not authorize running the app, generating or verifying a real event, pushing code, or publishing a version.

## Workflow

1. Run `node ../../scripts/sentry-sdk-check.mjs --root <repo> --answers <answers-file>`. Use its graph-derived final artifact owner and official documentation route; never infer the SDK target from detection candidates. Stop on `ambiguous` or `unsupported`.
2. Find the selected provider instance from the setup answers or installed config plus processor graph, verify its HTTPS `apiBase`, and identify an existing organization and team. Never create the organization or team implicitly.
3. Run `node ../../scripts/sentry-project.mjs --help`, inspect, and dry-run before creation. The exact organization, team, project slug, platform, and API base already selected during setup authorize creation. Supply the selected slug internally as `--confirm-slug`; do not ask the user to repeat it. Existing project identity makes this step read-only.
4. If project creation is required and the administration token is absent, pause for a credential handoff or for the user to sign in to the same Chrome session. This is a credential blocker, not another target confirmation. Never ask the user to transmit a persistent credential through conversation.
5. Invoke `chrome:control-chrome`, navigate from the verified Sentry service through organization settings to the exact project's `Client Keys (DSN)` page, and recheck the visible organization and project slug. Read only the `DSN` or `Public DSN` field. Validate HTTPS and reject placeholders, passwords, queries, and fragments. Do not inspect cookies, local storage, passwords, or session files; do not display the DSN in conversation, screenshots, logs, or the plan. If Chrome is disconnected or signed out, pause for the user to connect or sign in in that same Chrome session, then resume. Never delegate DSN lookup or copying to the user.
6. For `missing` or `partial`, install only the SDK, recommended initialization, and public DSN. Use the official Wizard when the checker returns `wizard`: resolve `npm.cmd view @sentry/wizard version --json`, show the exact version and `git status --short`, then run that exact version with organization, project, service URL, and `--disable-telemetry`. Never use runtime `@latest` or `--ignore-git-changes`; inspect partial changes before any retry.
7. When the route is `agent`, constrain the official `sentry-instrument` skill to SDK initialization. When it is `manual`, use only the returned `docs.sentry.io` guide. Neither path may provision again, verify events, configure releases/debug uploads, push, or publish.
8. Remove installer-generated authentication residue and disable duplicate automatic release, source map, mapping, dSYM, PDB, or DIF upload. Those remain owned by the Release Ops Sentry processor.
9. Rerun the checker and require `configured`, then audit the four credential roles by name and purpose without reading values. When setup writes a Secret, pass its already selected repository internally as `--confirm-repository`; do not ask for confirmation of each Secret or repository.

Mutating Sentry requests are not automatically retried. Organization/project slug provides idempotent identity; this skill never deletes Sentry resources.

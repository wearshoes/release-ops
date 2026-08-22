# Sentry Onboarding

[中文](sentry.md) | **English**

The Release Ops Sentry extension owns release/dist metadata, debug artifact uploads, scheduled incident intake, and the explicit resolver. The application SDK and public DSN must be present in application source first. Release Ops never stores a DSN, token, or scan state in its configuration.

## 1. Select Sentry and Resolve the Target Stack

Explicitly select Sentry during initialization or reconfiguration. Release Ops resolves the stack that owns the final published artifacts from the processor graph. It does not substitute project detection candidates for the configured owner.

When all published artifacts have one stack owner, that stack determines the SDK platform. If distinct final artifact owners remain and no unique SDK target exists, planning stops until the target is split or made explicit.

## 2. Run the Read-only SDK Check

Codex runs the internal checker before planning. This is an agent-facing internal command; regular users do not need to run it manually:

```powershell
node <release-ops-plugin>/scripts/sentry-sdk-check.mjs --root <repository> --answers <setup-answers.json>
```

For an applied Release Ops project, omit the answers file:

```powershell
node <release-ops-plugin>/scripts/sentry-sdk-check.mjs --root <repository>
```

The checker returns only the platform, [official Sentry platform documentation](https://docs.sentry.io/platforms/), recommended installer, missing evidence, and paths plus SHA-256 hashes for dependency, initialization, and DSN evidence. It never returns a DSN, token, or matched source text.

- `configured`: all three evidence classes exist; skip installation;
- `missing` or `partial`: complete SDK onboarding before planning;
- `ambiguous`: final artifact ownership is not unique;
- `unsupported`: the stack has no safe static onboarding route and remains diagnostic.

## 3. Create or Verify the Sentry Project

Use `$sentry-project-provisioner` to verify the exact organization, team, and project slug. The organization, team, project slug, and Sentry service selected during setup authorize creation; Codex supplies that slug internally as `--confirm-slug` without asking again. Existing projects are identity-checked only. If those values have not been selected, ask for them before creating anything.

## 4. Have Codex Obtain the Public DSN Through Chrome

Codex obtains the public DSN itself instead of handing console instructions to the user:

1. Codex invokes `chrome:control-chrome` and connects to the user's existing signed-in Chrome session. It must not switch to another browser or inspect cookies, local storage, passwords, or browser session files.
2. Starting from the verified Sentry service, it opens the organization settings, then the exact organization, project, and `Client Keys (DSN)` page. It must not guess from search results or similar project names.
3. It reads only the public client DSN explicitly labelled `DSN` or `Public DSN`, after rechecking the visible organization and project slug. The DSN must use HTTPS, must not be a placeholder, and must not contain a password, query, or fragment.
4. It does not display the DSN in conversation, progress updates, screenshots, logs, or the plan. It uses the value directly in application SDK configuration, never reads or reuses an authentication token from the page, and never writes the DSN to Release Ops `config/v1`.

If the Chrome control plugin is disconnected, Codex pauses and asks the user to connect it. If Sentry is signed out, Codex pauses and asks the user to sign in in that same Chrome session, then resumes this step. It never asks the user to locate, copy, or paste the DSN.

## 5. Install and Initialize the Application SDK

Follow the route returned by the checker.

### Official Wizard

When the platform is supported by the [Sentry Wizard](https://github.com/getsentry/sentry-wizard), resolve its current version and execute that exact version:

```powershell
npm.cmd view @sentry/wizard version --json
npx.cmd @sentry/wizard@<exact-version> -i <integration> --org <organization> --project <project> --url <service-url> --disable-telemetry
```

Show the exact version and `git status --short` first. Do not use runtime `@latest` or pass `--ignore-git-changes`. If the Wizard fails or is interrupted, inspect its existing changes before deciding how to continue; do not blindly rerun it.

### Sentry Agent

If the Wizard does not support the platform but the [Sentry Agent Plugin](https://docs.sentry.io/ai/agent-plugin/) has a matching SDK reference, use its official `sentry-instrument` skill. Limit that work to the selected stack's SDK dependency, recommended initialization, and public DSN. The Agent must not provision projects, generate or verify real events, configure release/source map/mapping/dSYM/DIF uploads, push code, or publish a version.

### Official Platform Guide

If the Agent has no matching reference, Codex reads only the `docs.sentry.io` platform page returned by the checker and implements the minimum SDK dependency, official initialization, and public DSN. Unreal remains an unsupported diagnostic; do not invent an onboarding path.

## 6. Remove Installer Side Effects

Review the complete worktree diff after installation:

- keep the runtime SDK, initialization, and public DSN;
- remove local authentication files or token lines generated by this run without printing their values;
- disable automatic release, source map, Proguard mapping, dSYM, or DIF uploads added by the installer;
- preserve unrelated project changes.

Release/dist and debug artifact upload remain exclusively owned by the Release Ops Sentry processor and its Secret roles, preventing duplicate releases or uploads.

## 7. Recheck Until `configured`

Run the read-only checker again. Missing dependency, official initialization, or non-placeholder public DSN evidence blocks planning. The plan snapshots redacted evidence and file SHA-256 hashes, and apply rejects evidence drift. When the Sentry project and all other selections remain unchanged, Codex displays a replacement plan and continues automatically. Audit fails with the missing items and official documentation URL if evidence is later removed.

## 8. Configure Four Credential Roles

| Secret | Responsibility | Scope |
| --- | --- | --- |
| `SENTRY_PROJECT_ADMIN_TOKEN` | Create or verify the project | local provision only |
| `SENTRY_ORG_CI_TOKEN` | Upload mappings, source maps, dSYMs, PDBs, and DIFs | build/provider step |
| `SENTRY_AUTH_TOKEN` | Read issue groups and allowlisted event fields | private source scheduled Action |
| `SENTRY_WRITE_TOKEN` | Write resolved state after explicit commit trailers | private source resolver Action |

Never reuse these roles. Tokens must not enter conversations, source, application packages, logs, Issues, release notes, or artifacts. Only the public DSN may be embedded in the application. When writing a GitHub Secret, Codex supplies the selected repository internally as `--confirm-repository`; it does not ask the user to reconfirm each Secret or repository.

## 9. Plan, Apply Automatically, and Audit

Release Ops generates a plan only after SDK readiness passes. Codex first displays the configuration, processor graph, `extensionChecks`, managed files, Secret names, repository operations, and SHA-256 digest. It then immediately supplies `plan.planDigest` as the internal confirmation value and applies the plan without asking the user to copy or reply with the digest. A same-target replan is also displayed and then applied automatically.

Run audit immediately after apply. Success requires configuration, graph, workflow, and SDK evidence consistency, plus verified Secret metadata and remote repository identity.

## 10. Optional Real-event Verification

Initialization does not run the application, inject a crash, generate a test event, call Sentry MCP, push code, or publish a version. Real-event verification requires separate explicit authorization and its own runtime and data boundaries.

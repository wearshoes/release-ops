---
name: github-release-pipeline
description: Audit or explicitly publish a configured GitHub release from a fixed full commit SHA, including same-repository or private-to-public dual releases. Use only when a project already has `.release-ops/config.json`; do not configure Sentry incidents or infer publication authorization.
---

# GitHub Release Pipeline

Read [references/release-contract.md](references/release-contract.md) before changing or invoking publication.

## Audit

1. Run the repository's configured Release Ops audit.
2. Verify the canonical version and changelog, a clean working tree, the default branch, the full source SHA, local checks, signing secret metadata, and the configured artifact contract.
3. For public sources, require `same-repository`. For private sources, require `dual-repository`, a public distribution repository, and a separate `RELEASE_REPO_TOKEN`.

## Publish

- Publication requires an explicit current user request.
- Prefer the repository-owned fixed entrypoint when configured. Do not bypass it with direct publisher calls.
- Dispatch exactly once with version, optional build code, full source SHA, and UUID correlation. If the POST response is uncertain, reconcile the accepted run by correlation; never resend blindly.
- Build once in the selected Action. Upload the exact local bytes and locally computed SHA-256 to every destination.
- Use the same UTF-8 changelog for all Release bodies.
- Never download remote assets for republishing or perform post-publication readback as proof.

Report source Release, public Release, provider upload, and incident-resolution state independently.

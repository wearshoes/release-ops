---
name: github-release-pipeline
description: Audit or explicitly publish a configured Release Ops GitHub release from a fixed full commit SHA, including same-repository and private-to-public publication. Do not use for setup or incident closure.
---

# GitHub Release Pipeline

Read the target repository instructions, `release-ops/config/v1`, `.release-ops/processor-graph.json`, [GitHub Release SOP](../../docs/workflows/github-release.md), and [private-to-public SOP](../../docs/workflows/private-to-public.md) when configured. Find the release instance by graph type and its `release-context`/`release-artifacts` capabilities; never assume an instance ID or rebuild a legacy nested config view.

## Gate

- Publication requires an explicit current user request. Setup, merge, version change, issue repair, or provider resolution is not authorization.
- Prefer the repository-owned fixed entrypoint over the generic runtime whenever the repository defines a stricter entrypoint.
- Require a clean working tree, source default branch, local/remote identical full SHA, canonical version/build numbers, UTF-8 changelog, prior risk-proportional checks, and required Secret metadata.
- Public source must use `same-repository`; private source must use `dual-repository` and a public distribution identity with its own default branch.

## Publish

Run the fixed entry once. Dispatch with version, build-number object, full source SHA, and UUID correlation. Fix the returned run ID; if the POST outcome is uncertain, reconcile only the uniquely correlated accepted run and never resend blindly.

Each platform builds once on its declared runner. Short-lived Actions Artifacts aggregate local bytes and SHA-256; those same bytes go to every destination. Dual publication uses drafts, publishes private first and public last, and resumes partial success without rollback.

Do not download a remote Release for redistribution, compare remote hashes, or read back Release/README/latest as proof. Report source/public Release and provider hooks independently. Never close an incident as part of publication.

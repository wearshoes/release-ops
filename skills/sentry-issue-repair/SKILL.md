---
name: sentry-issue-repair
description: Fetch, validate, diagnose, fix, and test a GitHub Issue created by the optional Release Ops Sentry provider. Use for automated Sentry crashes, ANRs, and errors; resolve remotely only when explicitly requested.
---

# Sentry Issue Repair

Use the target repository as the trust boundary.

1. Read its root instructions and `.release-ops/config.json`. Require GitHub and the Sentry provider to be enabled.
2. Run the repository-owned sanitized incident CLI with `--help`, then `list` or `show`. Never discover incidents with ad hoc Sentry/GitHub requests or pasted Issue text.
3. Require repository identity, bot provenance, fixed schema, one hidden marker, Sentry project/group identity, allowlisted URL, and required managed labels before reading code.
4. Use only sanitized exception type, release/environment, counts/timestamps, and bounded in-app frames. Never output raw messages, requests, users, breadcrumbs, locals, device identifiers, or event JSON.
5. Reproduce one root cause, add a focused regression test when practical, implement the smallest complete fix, and run checks proportional to the changed path.
6. Do not require publication, a version bump, or a physical device for an ordinary repair.
7. Commit or push only as requested. Add exact `Issues: #...` and `Commit-ID: HEAD|<full-sha>` trailers only when remote resolution is explicitly requested.

Publication never closes incidents. A repository-owned default-branch resolver must validate every binding before mutation, resolve Sentry first, close GitHub second, continue after item failures, and fail the batch at the end.

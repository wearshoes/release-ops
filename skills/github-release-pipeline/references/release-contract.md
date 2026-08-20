# Release Contract

- `release-ops/config/v1` is the only repository configuration schema.
- A release is bound to one full lowercase commit SHA and one canonical version.
- The changelog is a checked-in UTF-8 file. Every destination uses its exact content as the Release body.
- All versions share one repository-level concurrency group.
- Public sources publish in place. Private sources retain a private Release and publish the same bytes to a dedicated public repository.
- Public manifests use `release-ops-release/v1` and omit private repository names, commits, workflow IDs, and internal URLs.
- Dual publication stages drafts, uploads local assets, updates the public README and manifests, publishes the private Release, then publishes the public Release.
- A partial success is not rolled back. Retry the same version, source SHA, and correlation idempotently.

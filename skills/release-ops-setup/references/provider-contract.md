# Provider Contract

Providers extend a release without owning it. The release core is authoritative for repository identity, version, commit SHA, artifacts, destinations, and publication state.

Each provider manifest uses `release-ops/provider/v1` and may declare only these capabilities:

- `configure`: create provider-specific application and CI configuration.
- `audit`: validate provider configuration without mutation.
- `requiredSecrets`: declare secret names and their narrow purpose.
- `buildHooks`: consume trusted release, dist, commit, and local artifact metadata.
- `scheduledIngest`: poll a provider and create sanitized repository records.
- `incidentIntake`: expose a fixed, sanitized incident schema to an agent.
- `resolve`: update provider state only through an explicit repository-owned workflow.

Omitted capabilities are unsupported. A provider cannot change the canonical version, artifact list, release destination, or GitHub Issue state outside its declared resolution workflow.

## Sentry v1

Sentry is the only implemented quality provider. Keep project provisioning, CI artifact upload, incident reads, and incident writes in separate credentials. GitHub issue synchronization and commit-based resolution require both GitHub and Sentry to be enabled.

Performance and vulnerability categories are reserved extension namespaces. They do not accept arbitrary shell commands or opaque webhooks in v1.

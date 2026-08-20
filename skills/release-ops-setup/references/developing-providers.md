# Developing Providers

Use this reference only when implementing a new Release Ops provider.

A provider manifest must validate against `assets/schemas/provider.schema.json`. Declare only implemented capabilities. Omitted capabilities are unavailable, and the release core must not infer substitutes.

Provider code receives a trusted release context containing the configured provider identity, full source commit SHA, canonical release and dist, local artifact paths, platform/architecture metadata, and a bounded environment containing only declared credentials. It cannot replace the version source, build command, artifact list, hosting topology, or publication order.

`buildHooks` must use a fixed argument builder or SDK. Do not expose configuration fields that execute arbitrary shell fragments, arbitrary URLs, or opaque request bodies. `scheduledIngest`, `incidentIntake`, and `resolve` must each define a sanitized record schema and validate remote identity before mutation.

The performance and vulnerability fixtures under `assets/fixtures/providers/` are contract tests, not installed providers. Keep `installed` false and do not add them to `providerChoices()` until working runtime code, credential boundaries, setup, audit, and end-to-end tests exist.

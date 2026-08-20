export function inspectProcessor({ manifest, inspection }) {
    return {
        extensionId: manifest.id,
        status: manifest.status,
        docs: manifest.docs,
        detected: inspection.detectedExtensionIds.includes(manifest.id),
    };
}

export async function buildProcessor({ api, instance, arguments: args = [], execute = false }) {
    const requested = args[0] ?? null;
    const units = requested
        ? instance.config.buildUnits.filter((unit) => unit.id === requested)
        : instance.config.buildUnits;
    if (requested && !units.length) throw new Error(`Build unit is not owned by ${instance.instanceId}: ${requested}`);
    if (execute) {
        for (const unit of units) {
            await api.execFile("build", [], { configuredCommand: unit.command, secretRoles: unit.requiredSecretRoles });
        }
    }
    return {
        buildUnits: units,
        versioning: instance.config.versioning,
        artifacts: units.flatMap((unit) => unit.artifacts.map((artifact) => ({ ...artifact, buildUnitId: unit.id }))),
        debugArtifacts: units.flatMap((unit) => unit.debugArtifacts.map((artifact) => ({ ...artifact, buildUnitId: unit.id }))),
        completed: execute,
    };
}

export function auditProcessor({ instance }) {
    return { status: instance.config.buildUnits.length ? "configured" : "fail" };
}

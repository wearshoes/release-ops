export async function signProcessor({ api, instance, arguments: args = [], execute = false }) {
    const requested = args[0] ?? null;
    if (requested && !instance.config.buildUnitIds.includes(requested)) {
        throw new Error(`Signing instance does not own build unit: ${requested}`);
    }
    if (execute && instance.config.command) {
        await api.execFile("sign", [], {
            configuredCommand: instance.config.command,
            secretRoles: Object.keys(instance.config.secretNames),
        });
    }
    return {
        buildUnitIds: instance.config.buildUnitIds,
        secretRoles: Object.entries(instance.config.secretNames).map(([role, name]) => ({ role, name })),
        completed: execute,
    };
}

export function auditProcessor({ instance }) {
    return { status: instance.config.buildUnitIds.length ? "configured" : "fail" };
}

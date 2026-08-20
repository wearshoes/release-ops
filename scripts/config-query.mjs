function matchesType(config, graph, instance, type) {
    const record = graph?.extensions?.find((candidate) => candidate.instanceId === instance.instanceId);
    if (record) return record.type === type;
    if (type === "stack") return Array.isArray(instance.config?.buildUnits) && instance.config?.versioning;
    if (type === "signing") return Array.isArray(instance.config?.buildUnitIds) && instance.config?.secretNames;
    if (type === "release") return typeof instance.config?.mode === "string" && instance.config?.manifest;
    if (type === "provider") return typeof instance.config?.incidentNamespace === "string";
    return false;
}

export function instancesByType(config, type, graph = null) {
    return config.extensions.filter((instance) => matchesType(config, graph, instance, type));
}

export function oneInstanceByType(config, type, graph = null) {
    const matches = instancesByType(config, type, graph);
    if (matches.length !== 1) throw new Error(`Expected one ${type} extension instance, found ${matches.length}`);
    return matches[0];
}

export function stackConfigs(config, graph = null) {
    return instancesByType(config, "stack", graph).map((instance) => instance.config);
}

export function allBuildUnits(config, graph = null) {
    return stackConfigs(config, graph).flatMap(({ buildUnits }) => buildUnits);
}

export function releaseConfig(config, graph = null) {
    return oneInstanceByType(config, "release", graph).config;
}

export function providerConfigs(config, graph = null) {
    return instancesByType(config, "provider", graph).map((instance) => instance.config);
}

export function secretNamesForBuildUnit(config, unitId, graph = null) {
    const names = {};
    for (const instance of instancesByType(config, "signing", graph)) {
        if (instance.config.buildUnitIds.includes(unitId)) Object.assign(names, instance.config.secretNames);
    }
    return names;
}

export function incidentProviderConfig(config, graph = null) {
    const matches = providerConfigs(config, graph).filter(({ issueSync, organization, project }) =>
        typeof issueSync === "boolean" && organization && project);
    if (matches.length !== 1) throw new Error(`Expected one incident provider extension instance, found ${matches.length}`);
    return matches[0];
}

export function nodeIdsForCapability(graph, capability) {
    const record = graph.capabilities[capability];
    if (!record) return [];
    if (record.merge === "exclusive") return [record.producer];
    if (record.merge === "append") return record.producers;
    return Object.values(record.producers);
}

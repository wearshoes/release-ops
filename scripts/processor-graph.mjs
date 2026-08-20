import { configDigest, validateConfig } from "./config.mjs";
import { stableJson, sha256 } from "./stable.mjs";

export const GRAPH_SCHEMA = "release-ops/processor-graph/v1";
export const STAGES = [
    "inspect", "configure", "plan", "preflight", "prepare", "build", "sign", "debug-artifacts",
    "collect", "publish-stage", "publish-finalize", "scheduled-ingest", "resolve", "audit",
];

const RELEASE_STAGES = new Set(["preflight", "prepare", "build", "sign", "debug-artifacts", "collect", "publish-stage", "publish-finalize"]);
const SETUP_STAGES = new Set(["inspect", "configure", "plan"]);

function lane(stage) {
    if (SETUP_STAGES.has(stage)) return "setup";
    if (RELEASE_STAGES.has(stage)) return "release";
    return stage;
}

function configuredValue(config, reference) {
    const value = reference.slice("config:".length).split(".").reduce((current, key) => current?.[key], config);
    if (typeof value !== "string" || !value || /^(?:[A-Za-z]:|\/)/u.test(value)
        || value.replaceAll("\\", "/").split("/").includes("..")) {
        throw new Error(`Processor output root is not a safe configured path: ${reference}`);
    }
    const normalized = value.replaceAll("\\", "/").replace(/\/$/u, "");
    if (normalized === ".") throw new Error(`Processor output root cannot be the repository root: ${reference}`);
    return normalized;
}

function configuredOrigin(config, reference) {
    if (!reference.startsWith("config-origin:")) return reference;
    const value = reference.slice("config-origin:".length).split(".").reduce((current, key) => current?.[key], config);
    const parsed = new URL(String(value ?? ""));
    if (parsed.protocol !== "https:") throw new Error(`Processor network origin is not HTTPS: ${reference}`);
    return parsed.origin;
}

function processorNode(instance, manifest, processor) {
    return {
        id: `${instance.instanceId}:${processor.id}`,
        instanceId: instance.instanceId,
        extensionId: instance.extensionId,
        extensionType: manifest.type,
        processorId: processor.id,
        stage: processor.stage,
        module: `extensions/${instance.instanceId}/${processor.module}`,
        entrypoint: processor.entrypoint,
        requires: processor.requires,
        provides: processor.provides,
        before: processor.before.map((id) => `${instance.instanceId}:${id}`),
        after: processor.after.map((id) => `${instance.instanceId}:${id}`),
        secretRoles: processor.secretRoles,
        permissions: {
            ...processor.permissions,
            networkOrigins: processor.permissions.networkOrigins.map((reference) => configuredOrigin(instance.config, reference)),
            outputRoots: (processor.permissions.outputRoots ?? []).map((reference) => configuredValue(instance.config, reference)),
        },
    };
}

function buildUnitOwners(config, registry) {
    const owners = {};
    for (const instance of config.extensions) {
        if (registry[instance.extensionId].type !== "stack") continue;
        for (const unit of instance.config.buildUnits ?? []) {
            if (owners[unit.id]) throw new Error(`Build unit has multiple stack owners: ${unit.id}`);
            owners[unit.id] = instance.instanceId;
        }
    }
    for (const instance of config.extensions) {
        if (registry[instance.extensionId].type !== "signing") continue;
        for (const unitId of instance.config.buildUnitIds ?? []) {
            if (!owners[unitId]) throw new Error(`Signing instance references an unowned build unit: ${unitId}`);
        }
    }
    for (const instance of config.extensions) {
        if (registry[instance.extensionId].type !== "stack") continue;
        for (const unit of instance.config.buildUnits ?? []) {
            for (const role of unit.requiredSecretRoles ?? []) {
                const signers = config.extensions.filter((candidate) => registry[candidate.extensionId].type === "signing"
                    && candidate.config.buildUnitIds.includes(unit.id));
                const declarations = [
                    ...registry[instance.extensionId].processors.flatMap((processor) => processor.secretRoles
                        .filter((entry) => entry.role === role)
                        .map((entry) => ({ instance, entry }))),
                    ...signers.flatMap((candidate) => registry[candidate.extensionId].processors
                        .flatMap((processor) => processor.secretRoles
                            .filter((entry) => entry.role === role)
                            .map((entry) => ({ instance: candidate, entry })))),
                ];
                if (declarations.length !== 1) throw new Error(`Build unit ${unit.id} Secret role must have one signing owner: ${role}`);
                if (!declarations[0].instance.config.secretNames?.[role]) {
                    throw new Error(`Build unit ${unit.id} Secret role has no configured name: ${role}`);
                }
            }
        }
    }
    return owners;
}

function bindBuildSecrets(config, registry, nodes) {
    for (const stack of config.extensions.filter((instance) => registry[instance.extensionId].type === "stack")) {
        const buildNode = nodes.find((node) => node.instanceId === stack.instanceId && node.stage === "build");
        if (!buildNode) continue;
        const resolved = new Map(buildNode.secretRoles.map((declaration) => [declaration.role, declaration]));
        for (const unit of stack.config.buildUnits) {
            for (const role of unit.requiredSecretRoles ?? []) {
                const candidates = [
                    ...registry[stack.extensionId].processors.flatMap((processor) => processor.secretRoles
                        .filter((declaration) => declaration.role === role)
                        .map((declaration) => ({ instance: stack, declaration }))),
                    ...config.extensions.filter((candidate) => registry[candidate.extensionId].type === "signing"
                        && candidate.config.buildUnitIds.includes(unit.id))
                        .flatMap((candidate) => registry[candidate.extensionId].processors
                            .flatMap((processor) => processor.secretRoles
                                .filter((declaration) => declaration.role === role)
                                .map((declaration) => ({ instance: candidate, declaration })))),
                ];
                if (candidates.length !== 1) throw new Error(`Build unit ${unit.id} Secret role must have one signing owner: ${role}`);
                const candidate = candidates[0];
                const configuredName = candidate.instance.config.secretNames[role];
                if (!configuredName) throw new Error(`Build unit ${unit.id} Secret role has no configured name: ${role}`);
                const previous = resolved.get(role);
                if (previous?.configuredName && previous.configuredName !== configuredName) {
                    throw new Error(`Build node has incompatible Secret names for role ${role}`);
                }
                resolved.set(role, {
                    ...candidate.declaration,
                    required: true,
                    configuredName,
                    sourceInstanceId: candidate.instance.instanceId,
                });
            }
        }
        buildNode.secretRoles = [...resolved.values()].sort((left, right) => left.role.localeCompare(right.role));
    }
}

function validateExtensionDependencies(registry, nodes) {
    const providers = capabilityProviders(nodes);
    for (const manifest of Object.values(registry)) {
        for (const dependency of manifest.dependencies) {
            const matches = providers.get(dependency.capability) ?? [];
            if (!matches.length && !dependency.optional) throw new Error(`Extension ${manifest.id} is missing capability ${dependency.capability}`);
            if (dependency.cardinality === "one" && matches.length > 1) {
                throw new Error(`Extension ${manifest.id} has ambiguous capability ${dependency.capability}`);
            }
        }
    }
}

function capabilityProviders(nodes) {
    const result = new Map();
    for (const node of nodes) {
        for (const provided of node.provides) {
            const list = result.get(provided.capability) ?? [];
            list.push({ node, declaration: provided });
            result.set(provided.capability, list);
        }
    }
    for (const [capability, providers] of result) {
        const merges = new Set(providers.map(({ declaration }) => declaration.merge));
        if (merges.size !== 1) throw new Error(`Capability has incompatible merge modes: ${capability}`);
        const merge = providers[0].declaration.merge;
        if (merge === "exclusive" && providers.length !== 1) throw new Error(`Capability must have one provider: ${capability}`);
        if (merge === "keyed") {
            const keys = providers.map(({ declaration }) => declaration.key);
            if (new Set(keys).size !== keys.length) throw new Error(`Capability has duplicate keyed output: ${capability}`);
        }
    }
    return result;
}

function addEdge(edges, from, to) {
    if (from === to) throw new Error(`Processor cannot order itself: ${from}`);
    edges.get(from).add(to);
}

function orderedNodes(nodes, providers) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const edges = new Map(nodes.map((node) => [node.id, new Set()]));
    for (const left of nodes) {
        for (const right of nodes) {
            if (left.id === right.id || lane(left.stage) !== lane(right.stage)) continue;
            if (STAGES.indexOf(left.stage) < STAGES.indexOf(right.stage)) addEdge(edges, left.id, right.id);
        }
    }
    for (const node of nodes) {
        for (const requirement of node.requires) {
            const matches = providers.get(requirement.capability) ?? [];
            if (!matches.length && !requirement.optional) throw new Error(`Missing capability ${requirement.capability} for ${node.id}`);
            if (requirement.cardinality === "one" && matches.length > 1) throw new Error(`Capability ${requirement.capability} is ambiguous for ${node.id}`);
            for (const provider of matches) addEdge(edges, provider.node.id, node.id);
        }
        for (const target of node.before) {
            if (!byId.has(target)) throw new Error(`Unknown before processor ${target}`);
            addEdge(edges, node.id, target);
        }
        for (const target of node.after) {
            if (!byId.has(target)) throw new Error(`Unknown after processor ${target}`);
            addEdge(edges, target, node.id);
        }
    }
    const indegree = new Map(nodes.map((node) => [node.id, 0]));
    for (const targets of edges.values()) for (const target of targets) indegree.set(target, indegree.get(target) + 1);
    const compare = (left, right) => STAGES.indexOf(byId.get(left).stage) - STAGES.indexOf(byId.get(right).stage) || left.localeCompare(right);
    const ready = [...indegree].filter(([, value]) => value === 0).map(([id]) => id).sort(compare);
    const order = [];
    while (ready.length) {
        const id = ready.shift();
        order.push(id);
        for (const target of [...edges.get(id)].sort(compare)) {
            indegree.set(target, indegree.get(target) - 1);
            if (indegree.get(target) === 0) {
                ready.push(target);
                ready.sort(compare);
            }
        }
    }
    if (order.length !== nodes.length) throw new Error("Processor graph contains a cycle");
    return order;
}

export async function createProcessorGraph(config, registry) {
    await validateConfig(config, { extensions: registry });
    const nodes = config.extensions.flatMap((instance) => {
        const manifest = registry[instance.extensionId];
        return manifest.processors.map((processor) => processorNode(instance, manifest, processor));
    }).sort((left, right) => left.id.localeCompare(right.id));
    const owners = buildUnitOwners(config, registry);
    bindBuildSecrets(config, registry, nodes);
    validateExtensionDependencies(registry, nodes);
    const providers = capabilityProviders(nodes);
    const order = orderedNodes(nodes, providers);
    const orderIndex = new Map(order.map((id, index) => [id, index]));
    const capabilities = Object.fromEntries([...providers].sort(([left], [right]) => left.localeCompare(right))
        .map(([capability, entries]) => {
            const sorted = [...entries].sort((left, right) => orderIndex.get(left.node.id) - orderIndex.get(right.node.id));
            const merge = sorted[0].declaration.merge;
            const value = merge === "exclusive"
                ? { merge, producer: sorted[0].node.id }
                : merge === "append"
                    ? { merge, producers: sorted.map(({ node }) => node.id) }
                    : {
                        merge,
                        producers: Object.fromEntries(sorted.map(({ node, declaration }) => [declaration.key, node.id])),
                    };
            return [capability, value];
        }));
    const graph = {
        schemaVersion: GRAPH_SCHEMA,
        configDigest: configDigest(config),
        extensions: config.extensions.map((instance) => {
            const manifest = registry[instance.extensionId];
            return {
                instanceId: instance.instanceId,
                extensionId: instance.extensionId,
                type: manifest.type,
                version: manifest.version,
                codeSha256: manifest.codeSha256,
            };
        }).sort((left, right) => left.instanceId.localeCompare(right.instanceId)),
        nodes,
        order,
        capabilities,
        buildUnitOwners: owners,
    };
    graph.graphDigest = sha256(stableJson(graph));
    return graph;
}

export function capabilityProducerIds(graph, capability) {
    const record = graph.capabilities[capability];
    if (!record) return [];
    if (record.merge === "exclusive") return [record.producer];
    if (record.merge === "append") return record.producers;
    return Object.values(record.producers);
}

export function nodesForEntrypoint(graph, entrypoint) {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const stages = entrypoint === "setup" ? SETUP_STAGES
        : entrypoint === "release" ? RELEASE_STAGES
            : new Set([entrypoint]);
    return graph.order.map((id) => byId.get(id)).filter((node) => stages.has(node.stage));
}

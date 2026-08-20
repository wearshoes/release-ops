function typeMatches(value, expected) {
    if (expected === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    if (expected === "array") return Array.isArray(value);
    if (expected === "integer") return Number.isSafeInteger(value);
    if (expected === "number") return typeof value === "number" && Number.isFinite(value);
    if (expected === "null") return value === null;
    return typeof value === expected;
}

function localPointer(root, reference) {
    if (!reference.startsWith("#/")) return null;
    return reference.slice(2).split("/").reduce((value, token) =>
        value?.[token.replaceAll("~1", "/").replaceAll("~0", "~")], root);
}

export function validateSchema(value, schema, name = "value", root = schema) {
    if (!schema || typeof schema !== "object") throw new Error(`${name} schema is invalid`);
    if (schema.$ref) {
        const target = localPointer(root, schema.$ref);
        if (!target) throw new Error(`${name} uses an unresolved external schema reference`);
        return validateSchema(value, target, name, root);
    }
    if (schema.const !== undefined && value !== schema.const) throw new Error(`${name} must equal ${JSON.stringify(schema.const)}`);
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`${name} is not an allowed value`);
    if (schema.oneOf) {
        const matches = schema.oneOf.filter((candidate) => {
            try { validateSchema(value, candidate, name, root); return true; } catch { return false; }
        });
        if (matches.length !== 1) throw new Error(`${name} must match exactly one schema`);
        return value;
    }
    if (schema.type) {
        const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (!expected.some((type) => typeMatches(value, type))) throw new Error(`${name} has an invalid type`);
    }
    if (typeof value === "string") {
        if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${name} is too short`);
        if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new Error(`${name} is too long`);
        if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) throw new Error(`${name} has an invalid format`);
    }
    if (typeof value === "number") {
        if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${name} is too small`);
        if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${name} is too large`);
    }
    if (Array.isArray(value)) {
        if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${name} has too few items`);
        if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${name} has too many items`);
        if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {
            throw new Error(`${name} contains duplicates`);
        }
        if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items, `${name}[${index}]`, root));
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const required of schema.required ?? []) {
            if (!Object.hasOwn(value, required)) throw new Error(`${name}.${required} is required`);
        }
        if (schema.propertyNames) for (const key of Object.keys(value)) validateSchema(key, schema.propertyNames, `${name} property`, root);
        for (const [key, item] of Object.entries(value)) {
            if (schema.properties?.[key]) validateSchema(item, schema.properties[key], `${name}.${key}`, root);
            else if (schema.additionalProperties === false) throw new Error(`${name}.${key} is not supported`);
            else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
                validateSchema(item, schema.additionalProperties, `${name}.${key}`, root);
            }
        }
    }
    return value;
}

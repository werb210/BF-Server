import { readFileSync } from "fs";
import { resolve } from "path";
function loadJson(path) {
    return JSON.parse(readFileSync(path, "utf-8"));
}
export function loadOpenApiV1() {
    const root = resolve(process.cwd(), "contracts/v1");
    const doc = loadJson(resolve(root, "openapi.json"));
    const schemas = doc.components?.schemas ?? {};
    Object.entries(schemas).forEach(([key, value]) => {
        if (value &&
            typeof value === "object" &&
            "$ref" in value) {
            const ref = String(value.$ref);
            if (ref.startsWith("./schemas/")) {
                schemas[key] = loadJson(resolve(root, ref.replace("./", "")));
            }
        }
    });
    return doc;
}
export function openApiPathToExpress(path) {
    return path.replace(/\{([^}]+)\}/g, ":$1");
}
export function resolveSchemaRefs(schema, doc) {
    if (!schema || typeof schema !== "object") {
        return schema;
    }
    if (Array.isArray(schema)) {
        return schema.map((entry) => resolveSchemaRefs(entry, doc));
    }
    const record = schema;
    const ref = typeof record.$ref === "string" ? record.$ref : null;
    if (ref && ref.startsWith("#/components/schemas/")) {
        const key = ref.replace("#/components/schemas/", "");
        const target = doc.components?.schemas?.[key];
        return resolveSchemaRefs(target, doc);
    }
    const next = {};
    Object.entries(record).forEach(([k, v]) => {
        if (k === "$schema" || k === "$id") {
            return;
        }
        next[k] = resolveSchemaRefs(v, doc);
    });
    return next;
}

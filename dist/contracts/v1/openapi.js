"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadOpenApiV1 = loadOpenApiV1;
exports.openApiPathToExpress = openApiPathToExpress;
exports.resolveSchemaRefs = resolveSchemaRefs;
const fs_1 = require("fs");
const path_1 = require("path");
function loadJson(path) {
    return JSON.parse((0, fs_1.readFileSync)(path, "utf-8"));
}
function loadOpenApiV1() {
    const root = (0, path_1.resolve)(process.cwd(), "contracts/v1");
    const doc = loadJson((0, path_1.resolve)(root, "openapi.json"));
    const schemas = doc.components?.schemas ?? {};
    Object.entries(schemas).forEach(([key, value]) => {
        if (value &&
            typeof value === "object" &&
            "$ref" in value) {
            const ref = String(value.$ref);
            if (ref.startsWith("./schemas/")) {
                schemas[key] = loadJson((0, path_1.resolve)(root, ref.replace("./", "")));
            }
        }
    });
    return doc;
}
function openApiPathToExpress(path) {
    return path.replace(/\{([^}]+)\}/g, ":$1");
}
function resolveSchemaRefs(schema, doc) {
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

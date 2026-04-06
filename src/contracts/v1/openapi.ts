import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type OpenApiDoc = {
  paths: Record<string, Record<string, { responses?: Record<string, { content?: { "application/json"?: { schema?: unknown } } }> }>>;
  components?: { schemas?: Record<string, unknown> };
};

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function loadOpenApiV1(): OpenApiDoc {
  const root = resolve(process.cwd(), "contracts/v1");
  const doc = loadJson(resolve(root, "openapi.json")) as OpenApiDoc;
  const schemas = doc.components?.schemas ?? {};
  Object.entries(schemas).forEach(([key, value]) => {
    if (
      value &&
      typeof value === "object" &&
      "$ref" in (value as Record<string, unknown>)
    ) {
      const ref = String((value as { $ref: string }).$ref);
      if (ref.startsWith("./schemas/")) {
        schemas[key] = loadJson(resolve(root, ref.replace("./", "")));
      }
    }
  });
  return doc;
}

export function openApiPathToExpress(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}


export function resolveSchemaRefs(schema: unknown, doc: OpenApiDoc): unknown {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map((entry) => resolveSchemaRefs(entry, doc));
  }
  const record = schema as Record<string, unknown>;
  const ref = typeof record.$ref === "string" ? record.$ref : null;
  if (ref && ref.startsWith("#/components/schemas/")) {
    const key = ref.replace("#/components/schemas/", "");
    const target = doc.components?.schemas?.[key];
    return resolveSchemaRefs(target, doc);
  }
  const next: Record<string, unknown> = {};
  Object.entries(record).forEach(([k, v]) => {
    if (k === "$schema" || k === "$id") {
      return;
    }
    next[k] = resolveSchemaRefs(v, doc);
  });
  return next;
}

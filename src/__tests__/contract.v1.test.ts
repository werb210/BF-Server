import { describe, it, expect } from 'vitest';
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";
import request from "supertest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { buildAppWithApiRoutes } from "../app";
import { listRoutes } from "../debug/printRoutes";
import { loadOpenApiV1, openApiPathToExpress, resolveSchemaRefs } from "../contracts/v1/openapi";

const EXPECTED_OPENAPI_SHA256 =
  "65c33b662324dbbcdc45c53f2e3e5ac93b12b90f9db15223b76b38794f9b846d";

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

describe("V1 contract lock", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test";
    process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? "test";
  });

  it("fails on OpenAPI drift via hash snapshot", () => {
    const source = readFileSync(resolve(process.cwd(), "contracts/v1/openapi.json"), "utf-8");
    const digest = createHash("sha256").update(source).digest("hex");
    expect(digest).toBe(EXPECTED_OPENAPI_SHA256);
  });

  it("keeps /api/client and /api/portal routes exactly in contract", () => {
    const app = buildAppWithApiRoutes();
    const expressRoutes = new Set(
      listRoutes(app)
        .filter((route) => route.path.startsWith("/api/client") || route.path.startsWith("/api/portal"))
        .map((route) => routeKey(route.method, route.path))
    );

    const doc = loadOpenApiV1();
    const contractRoutes = new Set<string>();
    Object.entries(doc.paths).forEach(([path, operations]) => {
      if (!path.startsWith("/api/client") && !path.startsWith("/api/portal")) {
        return;
      }
      Object.keys(operations).forEach((method) => {
        contractRoutes.add(routeKey(method, openApiPathToExpress(path)));
      });
    });

    expect(expressRoutes).toEqual(contractRoutes);
  });

  it("validates live response bodies against OpenAPI schemas", async () => {
    const doc = loadOpenApiV1();
    const app = buildAppWithApiRoutes();
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);

    const operation = doc.paths["/api/portal/offers"]?.get;
    const schema = operation?.responses?.["200"]?.content?.["application/json"]?.schema;
    if (!schema) {
      throw new Error("Missing /api/portal/offers 200 response schema");
    }
    const validate = ajv.compile(resolveSchemaRefs(schema, doc) as object);

    const res = await request(app).get("/api/portal/offers");
    expect(res.status).toBe(200);
    expect(validate(res.body)).toBe(true);
  });
});

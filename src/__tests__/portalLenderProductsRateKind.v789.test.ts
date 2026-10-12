// BF_SERVER_v789_RATE_KIND - rate_kind is lowercased and limited to apr|monthly|factor|null.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createMock, updateMock, fetchByIdMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  updateMock: vi.fn(),
  fetchByIdMock: vi.fn(),
}));

vi.mock("../db.js", () => ({
  pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  runQuery: vi.fn(async () => ({ rows: [], rowCount: 0 })),
}));
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireAuthorization: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../repositories/lenderProducts.repo.js", () => ({
  listLenderProducts: vi.fn(async () => []),
  listLenderProductsByLenderId: vi.fn(async () => []),
  fetchLenderProductById: fetchByIdMock,
  createLenderProduct: createMock,
  updateLenderProduct: updateMock,
}));

import router, { parseRateKind } from "../routes/portalLenderProducts.js";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/portal", router);
  a.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err?.status ?? 500).json({ error: err?.code ?? "internal" });
  });
  return a;
}

const product = { id: "p1", lender_id: "l1", name: "P", silo: "BF", required_documents: [] };

beforeEach(() => {
  createMock.mockReset().mockImplementation(async (p: any) => ({ ...product, rate_kind: p.rateKind }));
  updateMock.mockReset().mockImplementation(async (p: any) => ({ ...product, rate_kind: p.rateKind }));
  fetchByIdMock.mockReset().mockImplementation(async () => product);
});

describe("parseRateKind", () => {
  it("lowercases the allowed values", () => {
    expect(parseRateKind("APR")).toBe("apr");
    expect(parseRateKind(" Monthly ")).toBe("monthly");
    expect(parseRateKind("factor")).toBe("factor");
  });

  it("maps absent/empty to null", () => {
    expect(parseRateKind(undefined)).toBeNull();
    expect(parseRateKind(null)).toBeNull();
    expect(parseRateKind("")).toBeNull();
  });

  it("rejects anything else with invalid_rate_kind", () => {
    for (const bad of ["weekly", "annual", "1", "apr ;drop"]) {
      expect(() => parseRateKind(bad)).toThrow(expect.objectContaining({ code: "invalid_rate_kind", status: 400 }));
    }
  });
});

describe("POST /api/portal/lender-products", () => {
  const base = { lenderId: "l1", name: "P", category: "LOC", requiredDocuments: [] };

  it("stores a lowercased rate_kind", async () => {
    const res = await request(app()).post("/api/portal/lender-products").send({ ...base, rate_kind: "FACTOR" });
    expect(res.status).toBe(201);
    expect(createMock.mock.calls[0]?.[0]?.rateKind).toBe("factor");
  });

  it("returns 400 invalid_rate_kind for an unknown value and writes nothing", async () => {
    const res = await request(app()).post("/api/portal/lender-products").send({ ...base, rateKind: "weekly" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_rate_kind");
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("PUT /api/portal/lender-products/:id", () => {
  it("stores a lowercased rate_kind", async () => {
    const res = await request(app()).put("/api/portal/lender-products/p1").send({ name: "P", requiredDocuments: [], rate_kind: "Apr" });
    expect(res.status).toBe(200);
    expect(updateMock.mock.calls[0]?.[0]?.rateKind).toBe("apr");
  });

  it("accepts null", async () => {
    const res = await request(app()).put("/api/portal/lender-products/p1").send({ name: "P", requiredDocuments: [], rate_kind: null });
    expect(res.status).toBe(200);
    expect(updateMock.mock.calls[0]?.[0]?.rateKind).toBeNull();
  });

  it("returns 400 invalid_rate_kind for an unknown value and writes nothing", async () => {
    const res = await request(app()).put("/api/portal/lender-products/p1").send({ name: "P", requiredDocuments: [], rate_kind: "daily" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_rate_kind");
    expect(updateMock).not.toHaveBeenCalled();
  });
});

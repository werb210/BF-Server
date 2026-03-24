import request from "supertest";
import type { Express } from "express";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/middleware/auth", () => ({
  requireAuth: (req: { user?: { id: string; role: string } }, _res: unknown, next: () => void) => {
    req.user = { id: "test", role: "admin" };
    next();
  },
}));

vi.mock("../src/modules/lead/lead.service", () => ({
  createLead: vi.fn(async () => ({ id: "lead_test_1" })),
  getLeads: vi.fn(async () => []),
}));

import * as leadService from "../src/modules/lead/lead.service";
import { getTestApp } from "./setup";

describe("Core domains", () => {
  let app: Express;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  beforeAll(async () => {
    app = await getTestApp();
  });

  it("creates lead", async () => {
    const res = await request(app)
      .post("/api/leads")
      .set("Authorization", "Bearer test-token")
      .send({ source: "integration-test", name: "Test" });

    expect(res.status).toBe(201);
  });

  it("rejects invalid lead body", async () => {
    const res = await request(app)
      .post("/api/leads")
      .set("Authorization", "Bearer test-token")
      .send({});

    expect(res.status).toBe(400);
  });

  it("handles lead service failure", async () => {
    vi.spyOn(leadService, "createLead").mockRejectedValueOnce(new Error("fail"));

    const res = await request(app)
      .post("/api/leads")
      .set("Authorization", "Bearer test-token")
      .send({ source: "integration-test" });

    expect(res.status).toBe(500);
  });

  it("lists leads", async () => {
    const res = await request(app)
      .get("/api/leads")
      .set("Authorization", "Bearer test-token");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("sends package", async () => {
    const res = await request(app)
      .post("/api/lenders/send")
      .set("Authorization", "Bearer test-token")
      .send({ application: { id: "app-1" }, documents: [], creditSummary: { score: 700 } });

    expect([200, 202]).toContain(res.status);
  });

  it("rejects invalid lender package body", async () => {
    const res = await request(app)
      .post("/api/lenders/send")
      .set("Authorization", "Bearer test-token")
      .send({ application: { id: "app-1" } });

    expect(res.status).toBe(400);
  });

  it("lists lender products", async () => {
    const res = await request(app)
      .get("/api/lenders/products")
      .set("Authorization", "Bearer test-token");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("returns duplicate response when idempotency-key is reused", async () => {
    const key = "lead-create-dup-test";
    const first = await request(app)
      .post("/api/leads")
      .set("Authorization", "Bearer test-token")
      .set("idempotency-key", key)
      .send({ source: "integration-test" });

    const second = await request(app)
      .post("/api/leads")
      .set("Authorization", "Bearer test-token")
      .set("idempotency-key", key)
      .send({ source: "integration-test" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("duplicate");
  });
});

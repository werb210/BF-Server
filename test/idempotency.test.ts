import request from "supertest";
import type { Express } from "express";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getTestApp } from "./setup";

vi.mock("../src/middleware/auth", () => ({
  requireAuth: (req: { user?: { id: string; role: string } }, _res: unknown, next: () => void) => {
    req.user = { id: "idempotency-user", role: "admin" };
    next();
  },
}));

vi.mock("../src/modules/lead/lead.service", () => ({
  createLead: vi.fn(async () => ({ id: "lead_test_1" })),
  getLeads: vi.fn(async () => []),
}));

describe.skip("Idempotency", () => {
  let app: Express;

  beforeAll(async () => {
    app = await getTestApp();
  });

  it("returns duplicate for same idempotency key and payload", async () => {
    const key = "test-key-12345";

    const first = await request(app)
      .post("/api/leads")
      .set("Authorization", "Bearer test-token")
      .set("idempotency-key", key)
      .send({ source: "unit-test" });

    const second = await request(app)
      .post("/api/leads")
      .set("Authorization", "Bearer test-token")
      .set("idempotency-key", key)
      .send({ source: "unit-test" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("duplicate");
  });
});

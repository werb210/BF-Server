// BF_BANKING_ANALYSIS_API_v52 — regression test for Bug 5 server-side.
// BF_BANKING_ANALYSIS_API_v52_TESTFIX_v3 — match the working pattern in
// src/__tests__/crm-cors-telephony.integration.test.ts: drop the .js from the
// vi.mock spec and call vi.resetModules() in beforeEach so the hoisted db.js
// mock binds across the dynamic import boundary inside the auth middleware.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../../../db", async () => {
  const actual = await vi.importActual<typeof import("../../../db.js")>("../../../db");
  return { ...actual, pool: { query: queryMock } };
});

const USER_ID = "00000000-0000-0000-0000-000000000001";

function authToken(): string {
  const secret = process.env.JWT_SECRET as string;
  return jwt.sign(
    { sub: USER_ID, id: USER_ID, role: "Staff", capabilities: ["application:read"] },
    secret,
    { expiresIn: "1h" }
  );
}

function queueAuthUserLookup() {
  queryMock.mockResolvedValueOnce({
    rows: [{ id: USER_ID, email: null, role: "Staff", silo: "BF", silos: ["BF"] }],
  });
}

async function buildApp() {
  const router = (await import("../applications.routes.js")).default;
  const { errorHandler } = await import("../../../middleware/errors.js");
  const a = express();
  a.use(express.json());
  a.use("/api/applications", router);
  a.use(errorHandler);
  return a;
}

describe("BF_BANKING_ANALYSIS_API_v52 GET /api/applications/:id/banking-analysis", () => {
  beforeEach(() => {
    vi.resetModules();
    queryMock.mockReset();
    process.env.JWT_SECRET = "test-jwt-secret-minimum-10-chars";
  });

  it("returns BankingAnalysis shape with bank counts on success", async () => {
    queueAuthUserLookup();
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: "app-1", banking_completed_at: new Date("2026-04-20T12:00:00Z") }] })
      .mockResolvedValueOnce({ rows: [{ bank_total: "3", bank_completed: "2", any_completed: "2" }] });

    const a = await buildApp();
    const res = await request(a)
      .get("/api/applications/app-1/banking-analysis")
      .set("Authorization", `Bearer ${authToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      applicationId: "app-1",
      bankingCompletedAt: "2026-04-20T12:00:00.000Z",
      bankCount: 3,
      documentsAnalyzed: 2,
      status: "analysis_in_progress",
    });
  });

  it("404s when the application is not found", async () => {
    queueAuthUserLookup();
    queryMock.mockResolvedValueOnce({ rows: [] });
    const a = await buildApp();
    const res = await request(a)
      .get("/api/applications/missing/banking-analysis")
      .set("Authorization", `Bearer ${authToken()}`);
    expect(res.status).toBe(404);
  });

  it("rejects requests without a valid token (401)", async () => {
    const a = await buildApp();
    const res = await request(a).get("/api/applications/app-x/banking-analysis");
    expect(res.status).toBe(401);
  });
});

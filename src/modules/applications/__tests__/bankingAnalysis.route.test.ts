// BF_BANKING_ANALYSIS_API_v52 — regression test for Bug 5 server-side.
// BF_BANKING_ANALYSIS_API_v52_TESTFIX — drop the auth-module mock; mint a JWT
// with capabilities baked in (mirroring the repo's working pattern in
// src/__tests__/crm-cors-telephony.integration.test.ts). Account for the
// auth middleware's own pool.query for the user lookup that runs before
// the route handler.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("../../../db.js", async () => {
  const actual = await vi.importActual<typeof import("../../../db.js")>("../../../db.js");
  return { ...actual, pool: { query: queryMock } };
});

const USER_ID = "00000000-0000-0000-0000-000000000001";

function authToken(): string {
  const secret = process.env.JWT_SECRET as string;
  return jwt.sign(
    {
      sub: USER_ID,
      id: USER_ID,
      role: "admin",
      capabilities: ["application:read"],
    },
    secret,
    { expiresIn: "1h" }
  );
}

// auth() hits the users table once before the route handler runs. Queue
// this resolution first; route's queries follow.
function queueAuthUserLookup() {
  queryMock.mockResolvedValueOnce({
    rows: [{ id: USER_ID, email: null, role: "admin", silo: "BF", silos: ["BF"] }],
  });
}

async function buildApp() {
  const router = (await import("../applications.routes.js")).default;
  const a = express();
  a.use(express.json());
  a.use("/api/applications", router);
  return a;
}

describe("BF_BANKING_ANALYSIS_API_v52 GET /api/applications/:id/banking-analysis", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret";
    queryMock.mockReset();
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
      banking_completed_at: "2026-04-20T12:00:00.000Z",
      bankCount: 3,
      documentsAnalyzed: 2,
      status: "analysis_in_progress",
    });
    expect(res.body.monthGroups).toEqual([]);
    expect(res.body.inflows).toBeNull();
  });

  it("404s when the application is not found", async () => {
    queueAuthUserLookup();
    queryMock.mockResolvedValueOnce({ rows: [] });

    const a = await buildApp();
    const res = await request(a)
      .get("/api/applications/missing/banking-analysis")
      .set("Authorization", `Bearer ${authToken()}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not_found");
  });

  it("reports no_bank_statements when bankCount is zero", async () => {
    queueAuthUserLookup();
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: "app-2", banking_completed_at: null }] })
      .mockResolvedValueOnce({ rows: [{ bank_total: "0", bank_completed: "0", any_completed: "0" }] });

    const a = await buildApp();
    const res = await request(a)
      .get("/api/applications/app-2/banking-analysis")
      .set("Authorization", `Bearer ${authToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("no_bank_statements");
    expect(res.body.bankingCompletedAt).toBeNull();
  });

  it("rejects requests without a valid token (401)", async () => {
    const a = await buildApp();
    const res = await request(a).get("/api/applications/app-x/banking-analysis");
    expect(res.status).toBe(401);
  });
});

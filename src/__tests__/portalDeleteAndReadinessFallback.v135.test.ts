// BF_SERVER_BLOCK_v135_PORTAL_DELETE_AND_READINESS_FALLBACK_v1
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return {
    ...actual,
    pool: { query: queryMock, connect: vi.fn(async () => ({ query: queryMock, release: vi.fn() })) },
    runQuery: queryMock, dbQuery: queryMock, query: queryMock,
  };
});
vi.mock("../startupState.js", () => ({
  isReady: () => true,
  fetchStatus: () => ({ reason: null }),
  markReady: () => undefined,
  markNotReady: () => undefined,
  resetStartupState: () => undefined,
}));

const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ADMIN_ID = "00000000-0000-4000-8000-0000000000a1";
const STAFF_ID = "00000000-0000-4000-8000-0000000000b1";
const sign = (sub: string, role: string) => jwt.sign({ sub, role, tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

async function buildApp() {
  const portal = (await import("../routes/portal.js")).default;
  const apps = (await import("../modules/applications/applications.routes.js")).default;
  const { errorHandler } = await import("../middleware/errors.js");
  const app = express();
  app.use(express.json());
  app.use("/api/portal", portal);
  app.use("/api/applications", apps);
  app.use(errorHandler);
  return app;
}

beforeEach(() => { queryMock.mockReset(); });

describe("(A) the portal's trash button has a route to call", () => {
  it("an Admin can DELETE /api/portal/applications/:id", async () => {
    queryMock.mockImplementation(answerBySql([
      [/SELECT silo FROM applications/, { rows: [{ silo: "BF" }] }],
      [/^\s*DELETE FROM applications WHERE id::text/, { rows: [], rowCount: 1 }],
    ]));
    const res = await request(await buildApp()).delete(`/api/portal/applications/${APP_ID}`).set("Authorization", `Bearer ${sign(ADMIN_ID, "Admin")}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const [, params] = callsMatching(queryMock, /^\s*DELETE FROM applications WHERE id::text/)[0]!;
    expect(params).toEqual([APP_ID]);
  });

  it("is admin-only", async () => {
    queryMock.mockImplementation(answerBySql([[/SELECT silo FROM applications/, { rows: [{ silo: "BF" }] }]]));
    const res = await request(await buildApp()).delete(`/api/portal/applications/${APP_ID}`).set("Authorization", `Bearer ${sign(STAFF_ID, "Staff")}`);
    expect(res.status).toBe(403);
    expect(callsMatching(queryMock, /DELETE FROM applications/)).toHaveLength(0);
  });

  it("a non-uuid id is a 400, not a database error", async () => {
    queryMock.mockImplementation(answerBySql([]));
    const res = await request(await buildApp()).delete("/api/portal/applications/not-a-uuid").set("Authorization", `Bearer ${sign(ADMIN_ID, "Admin")}`);
    expect(res.status).toBe(400);
    expect(callsMatching(queryMock, /FROM applications/)).toHaveLength(0);
  });

  it("an application in another silo reads as not found", async () => {
    queryMock.mockImplementation(answerBySql([[/SELECT silo FROM applications/, { rows: [{ silo: "BI" }] }]]));
    const res = await request(await buildApp()).delete(`/api/portal/applications/${APP_ID}`).set("Authorization", `Bearer ${sign(ADMIN_ID, "Admin")}`);
    expect(res.status).toBe(404);
    expect(callsMatching(queryMock, /DELETE FROM applications/)).toHaveLength(0);
  });
});

describe("(B) readiness drafts fill the staff drawer", () => {
  const readiness = { fullName: "Jane Roe", email: "jane@example.com", phone: "4035550111", industry: "Retail", requestedAmount: 50000 };
  const details = async (metadata: Record<string, unknown>) => {
    queryMock.mockImplementation(answerBySql([
      [/FROM applications a WHERE a\.id::text/, { rows: [{ id: APP_ID, name: "Draft", silo: "BF", metadata, finalized_lenders: 0, contact_phone: null }] }],
    ]));
    const res = await request(await buildApp()).get(`/api/applications/${APP_ID}/details`).set("Authorization", `Bearer ${sign(STAFF_ID, "Staff")}`);
    expect(res.status).toBe(200);
    return res.body.data;
  };

  it("uses metadata.readiness when nothing else is there", async () => {
    const d = await details({ readiness });
    expect(d.kyc).toEqual(readiness);
    expect(d.applicantDetails).toEqual(readiness);
    expect(d.businessDetails).toEqual(readiness);
    expect(d.financialProfile).toEqual(readiness);
    expect(d.callPhone).toBe("4035550111");
  });

  it("existing sources still win", async () => {
    const d = await details({ readiness, kyc: { industry: "Construction" }, applicant: { firstName: "Janet" }, business: { name: "Acme" } });
    expect(d.kyc).toEqual({ industry: "Construction" });
    expect(d.applicantDetails).toEqual({ firstName: "Janet" });
    expect(d.businessDetails).toEqual({ name: "Acme" });
  });
});

// BF_SERVER_v938_CARD_HEADER - the application card header shows the assigned broker and how many offers came in.
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
vi.mock("../startupState.js", () => ({ isReady: () => true, fetchStatus: () => ({ reason: null }), markReady: () => undefined, markNotReady: () => undefined, resetStartupState: () => undefined }));

const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STAFF_ID = "00000000-0000-4000-8000-0000000000b1";
const sign = (sub: string, role: string) => jwt.sign({ sub, role, tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

async function buildApp() {
  const apps = (await import("../modules/applications/applications.routes.js")).default;
  const { errorHandler } = await import("../middleware/errors.js");
  const app = express(); app.use(express.json()); app.use("/api/applications", apps); app.use(errorHandler);
  return app;
}
beforeEach(() => { queryMock.mockReset(); });

async function details(row: Record<string, unknown>) {
  queryMock.mockImplementation(answerBySql([[/FROM applications a WHERE a\.id::text/, { rows: [{ id: APP_ID, name: "Maple Ridge Ltd.", silo: "BF", metadata: {}, finalized_lenders: 0, contact_phone: null, ...row }] }]]));
  const res = await request(await buildApp()).get(`/api/applications/${APP_ID}/details`).set("Authorization", `Bearer ${sign(STAFF_ID, "Staff")}`);
  expect(res.status).toBe(200);
  return res.body.data;
}

describe("card header fields on GET /api/applications/:id/details", () => {
  it("returns the assigned broker and the number of live offers", async () => {
    const d = await details({ owner_user_id: "U9", owner_name: "Andrew P", offer_count: "2" });
    expect(d.assignedTo).toEqual({ id: "U9", name: "Andrew P" });
    expect(d.offerCount).toBe(2);
    const sql = String(callsMatching(queryMock, /FROM applications a WHERE a\.id::text/)[0]?.[0] ?? "");
    expect(sql).toContain("COALESCE(o.is_archived, false) = false");
  });

  it("has no broker when nobody is assigned", async () => {
    const d = await details({ owner_user_id: null, owner_name: null, offer_count: 0 });
    expect(d.assignedTo).toBeNull();
    expect(d.offerCount).toBe(0);
  });
});

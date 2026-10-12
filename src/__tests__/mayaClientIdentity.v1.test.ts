// BF_SERVER_MAYA_CLIENT_IDENTITY_v1 / BF_SERVER_MAYA_PROFILE_ENRICH_v1
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callsMatching, sqlText } from "./helpers/answerBySql.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-min-10-chars";
const SECRET = process.env.JWT_SECRET as string;

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  return { ...real, pool: { query: queryMock }, runQuery: queryMock };
});
vi.mock("../modules/ai/chat.repo.js", () => ({ addMessage: async () => undefined }));

import mayaRoutes from "../routes/maya.js";
import mayaStaff from "../routes/mayaStaff.js";

const proxy = express(); proxy.use(express.json()); proxy.use("/api/maya", mayaRoutes);
const staffApp = express(); staffApp.use(express.json()); staffApp.use("/api/maya", mayaStaff);
const clientTok = "Bearer " + jwt.sign({ sub: "client:+17805550100", role: "client", isClient: true, phone: "+17805550100" }, SECRET, { algorithm: "HS256" });
const svc = "Bearer " + jwt.sign({ kind: "service", source: "agent" }, SECRET);

const APP_ROW = {
  id: "11111111-2222-4333-8444-555555555555", name: "Lee Haulage", pipeline_state: "In Review", status: null, requested_amount: 250000, product_type: "LOC",
  updated_at: "2026-10-08", contact_name: "Jordan Lee", first_name: "Jordan", company_name: "Lee Haulage Ltd", dob: "1980-02-03", email: "j@lee.test",
  contact_phone: "+17805550100", contact_city: "Edmonton", contact_region: "AB", industry: "Trucking", years_in_business: "6", annual_revenue: "1200000",
  created_at: null, submitted_at: null, business_md: null, applicant_md: null, metadata_full: {}, signnow_app_signed_at: null, funded_at: null,
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  process.env.MAYA_URL = "http://maya.test";
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ reply: "hi" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: unknown) => {
    const s = sqlText(sql);
    if (s.includes("FROM applications a") && s.includes("JOIN contacts c")) return { rows: [APP_ROW] };
    return { rows: [], rowCount: 0 };
  });
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.MAYA_URL; });

describe("maya client identity", () => {
  // BF_SERVER_v784_MAYA_IDENTITY - the client phone travels in the signed X-Maya-Context
  // derived from the verified token, not in the body.
  it("proxy derives identity from the verified token and forwards the stripped body", async () => {
    const r = await request(proxy).post("/api/maya/message").set("Authorization", clientTok)
      .send({ message: "what do you have on me", phone: "+19999999999", audience: "staff", staff: { id: "x" } });
    expect(r.status).toBe(200);
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, any];
    expect(url).toBe("http://maya.test/api/maya/message");
    const ctx = jwt.verify(init.headers["X-Maya-Context"], SECRET, { algorithms: ["HS256"] }) as any;
    expect(ctx).toMatchObject({ kind: "maya_context", audience: "client", phone: "+17805550100" });
    expect(init.headers["X-Maya-Audience"]).toBe("client");
    expect(JSON.parse(init.body)).toEqual({ message: "what do you have on me" });
  });

  it("applications-by-phone returns contact profile and business details", async () => {
    const r = await request(staffApp).post("/api/maya/staff/applications-by-phone").set("Authorization", svc).send({ phone: "+1 (780) 555-0100" });
    expect(r.status).toBe(200);
    expect(r.body.contactName).toBe("Jordan Lee");
    expect(r.body.contact).toMatchObject({ contactName: "Jordan Lee", firstName: "Jordan", companyName: "Lee Haulage", dob: "1980-02-03", email: "j@lee.test" });
    expect(r.body.applications[0]).toMatchObject({ industry: "Trucking", yearsInBusiness: "6", annualRevenue: "1200000" });
    const [q] = callsMatching(queryMock, /FROM applications a\s+JOIN contacts c/);
    const sql = sqlText(q![0]);
    for (const col of ["c.name AS contact_name", "c.first_name", "c.company_name", "c.dob"]) expect(sql).toContain(col);
    expect(q![1]).toEqual(["7805550100"]);
  });

  it("with no application yet, the contact profile still comes back", async () => {
    queryMock.mockImplementation(async (sql: unknown) => {
      const s = sqlText(sql);
      if (/FROM contacts\s+WHERE right/.test(s)) return { rows: [{ contact_name: "Jordan Lee", first_name: "Jordan", company_name: "Lee Haulage Ltd", dob: null, email: null, contact_phone: "+17805550100" }] };
      return { rows: [], rowCount: 0 };
    });
    const r = await request(staffApp).post("/api/maya/staff/applications-by-phone").set("Authorization", svc).send({ phone: "+17805550100" });
    expect(r.body.contactName).toBe("Jordan Lee");
    expect(r.body.contact.companyName).toBe("Lee Haulage Ltd");
    expect(r.body.applications).toEqual([]);
  });
});

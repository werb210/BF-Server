// BF_SERVER_v791_LEAD_SCHEMA - POST /api/public/lead could never succeed: the route
// required companyName and the strict LeadSchema rejected it.
import { beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, pool, db: pool, default: pool, dbQuery: q, runQuery: q, query: q };
});

import publicRoutes from "../routes/public.js";

const app = express();
app.use(express.json());
app.use("/api/public", publicRoutes);

// The shape BF-Website's contact form sends (ContactForm.tsx), with CASL fields.
const websiteLead = {
  companyName: "Acme Fabrication",
  fullName: "Jane Doe",
  firstName: "Jane",
  lastName: "Doe",
  email: "jane@acme.example",
  phone: "+14035550100",
  message: "Looking for a line of credit",
  casl_consent: true,
  casl_consent_text: "I agree to receive messages.",
  casl_consent_at: "2026-10-12T00:00:00.000Z",
};

beforeEach(() => {
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([[/insert into crm_leads/i, (_s: string, p?: unknown[]) => ({ rows: [{ id: p?.[0] }] })]]));
});

describe("BF_SERVER_v791_LEAD_SCHEMA POST /api/public/lead", () => {
  it("a valid website lead returns 2xx and creates the lead", async () => {
    const r = await request(app).post("/api/public/lead").timeout(3000).send(websiteLead);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
    const [insert] = callsMatching(h.query, /insert into crm_leads/i);
    expect(insert).toBeDefined();
    const params = insert![1] as unknown[];
    expect(r.body.data.leadId).toBe(params[0]);
    expect(params[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(params.slice(1)).toEqual([
      "jane@acme.example", "+14035550100", "Acme Fabrication", null, null, "Jane Doe", "Looking for a line of credit",
    ]);
  });

  it("a lead with only companyName and email is enough", async () => {
    const r = await request(app).post("/api/public/lead").timeout(3000).send({ companyName: "Acme", email: "a@acme.example" });
    expect(r.status).toBe(200);
    expect(callsMatching(h.query, /insert into crm_leads/i)).toHaveLength(1);
  });

  it("a missing companyName returns 400 and creates nothing", async () => {
    const { companyName: _omit, ...rest } = websiteLead;
    const r = await request(app).post("/api/public/lead").timeout(3000).send(rest);
    expect(r.status).toBe(400);
    expect(callsMatching(h.query, /insert into crm_leads/i)).toHaveLength(0);
  });

  it("a blank companyName or an unknown field is still a 400", async () => {
    const blank = await request(app).post("/api/public/lead").timeout(3000).send({ ...websiteLead, companyName: "  " });
    expect(blank.status).toBe(400);
    const extra = await request(app).post("/api/public/lead").timeout(3000).send({ ...websiteLead, isAdmin: true });
    expect(extra.status).toBe(400);
    expect(callsMatching(h.query, /insert into crm_leads/i)).toHaveLength(0);
  });
});

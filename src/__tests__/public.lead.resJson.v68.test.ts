// BF_SERVER_v68_LEAD_RES_JSON - every /lead branch must send its response
// (res.status(N).json(envelope)); a bare `return ok(...)` left the client hanging.
import { beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn(), acceptAll: false }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, pool, db: pool, default: pool, dbQuery: q, runQuery: q, query: q };
});
// The lead schema is strict; the success branch is exercised with a permissive stand-in.
vi.mock("../validation.js", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    LeadSchema: {
      safeParse: (v: any) => (h.acceptAll ? { success: true, data: { ...v, phone: v.phone ?? "4035230100" } } : real.LeadSchema.safeParse(v)),
    },
  };
});

import publicRoutes from "../routes/public.js";

const app = express();
app.use(express.json());
app.use("/api/public", publicRoutes);

beforeEach(() => {
  h.acceptAll = false;
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([[/insert into crm_leads/i, { rows: [{ id: "lead-1" }] }]]));
});

describe("BF_SERVER_v68_LEAD_RES_JSON", () => {
  it("/lead success branch sends 200 with the ok() envelope", async () => {
    h.acceptAll = true;
    const r = await request(app).post("/api/public/lead").timeout(3000)
      .send({ companyName: "Acme", email: "a@acme.example", productType: "LOC" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "ok", data: { leadId: "lead-1" } });
    const [insert] = callsMatching(h.query, /insert into crm_leads/i);
    expect((insert![1] as unknown[]).slice(0, 3)).toEqual(["a@acme.example", "4035230100", "Acme"]);
  });

  it("/lead invalid-input branch sends 400 with the fail() envelope", async () => {
    const r = await request(app).post("/api/public/lead").timeout(3000)
      .send({ companyName: "Acme", email: "not-an-email" });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ status: "error", error: "INVALID_INPUT" });
    expect(callsMatching(h.query, /insert into crm_leads/i)).toHaveLength(0);
  });

  it("/lead with no insert result is also a 400, not a hang", async () => {
    h.acceptAll = true;
    h.query.mockImplementation(answerBySql([[/insert into crm_leads/i, { rows: [] }]]));
    const r = await request(app).post("/api/public/lead").timeout(3000)
      .send({ companyName: "Acme", email: "a@acme.example", productType: "LOC" });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ status: "error", error: "INVALID_INPUT" });
  });

  it("/lead method-not-allowed catch-all sends 405 with the fail() envelope", async () => {
    for (const method of ["get", "put", "delete"] as const) {
      const r = await request(app)[method]("/api/public/lead").timeout(3000);
      expect(r.status).toBe(405);
      expect(r.body).toEqual({ status: "error", error: "METHOD_NOT_ALLOWED" });
    }
  });
});

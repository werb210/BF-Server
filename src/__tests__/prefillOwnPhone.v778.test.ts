// BF_SERVER_PREFILL_OWN_PHONE_v778
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-min-10-chars";
const sqls: string[] = [];
let mode: "app" | "contact" | "none" = "app";
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const dbQuery = async (sql: string) => {
    sqls.push(sql);
    if (sql.includes("from readiness_sessions")) return { rows: [] };
    if (sql.includes("FROM applications a") && sql.includes("JOIN contacts c")) return { rows: mode === "app" ? [{ full_name: "Todd Werboweski", company_name: "Boreal", email: "todd@x.com", phone: "+17805550100", business: { businessName: "Boreal Financial", legalName: "2630108 Alberta Ltd.", city: "Edmonton", businessNumber: "762010221" }, applicant: { firstName: "Todd", dob: "1970-01-01", street: "450 Sparling Crt SW", ssn: "123-456-789", bankAccount: "999" } }] : [] };
    if (sql.includes("FROM contacts")) return { rows: mode === "contact" ? [{ name: "Jane Doe", company_name: "Acme", email: "j@acme.com", phone: "+17805550100" }] : [] };
    return { rows: [] };
  };
  return { ...real, dbQuery, pool: { query: dbQuery } };
});
import clientRouter, { safePrefillFields } from "../routes/client/index.js";

const app = express();
app.use(express.json());
app.use("/api/client", clientRouter);
const token = (phone: string) => "Bearer " + jwt.sign({ sub: "client:" + phone, role: "client", phone }, process.env.JWT_SECRET as string);

beforeEach(() => { sqls.length = 0; mode = "app"; });

describe("readiness pre-fill answers only the signed-in client about their own number", () => {
  it("refuses a phone lookup with no sign-in, without touching the database", async () => {
    const r = await request(app).get("/api/client/readiness-prefill?phone=%2B17805550100");
    expect(r.body).toEqual({ found: false });
    expect(sqls.length).toBe(0);
  });
  it("refuses someone else's number", async () => {
    const r = await request(app).get("/api/client/readiness-prefill?phone=%2B17805550100").set("Authorization", token("+14035559999"));
    expect(r.body).toEqual({ found: false });
  });
  it("returns the client's own details, business and owner fields, without ID numbers or banking", async () => {
    const r = await request(app).get("/api/client/readiness-prefill?phone=%2B17805550100").set("Authorization", token("+17805550100"));
    expect(r.body.found).toBe(true);
    expect(r.body.prefill.fullName).toBe("Todd Werboweski");
    expect(r.body.prefill.business).toEqual({ businessName: "Boreal Financial", legalName: "2630108 Alberta Ltd.", city: "Edmonton" });
    expect(r.body.prefill.applicant).toEqual({ firstName: "Todd", dob: "1970-01-01", street: "450 Sparling Crt SW" });
    const readiness = sqls.find((s) => s.includes("from readiness_sessions"))!;
    expect(readiness).toContain("regexp_replace(coalesce(phone, ''), '\\D', '', 'g')"); // digits only, not the letter D
  });
  it("falls back to the CRM contact when there is no application", async () => {
    mode = "contact";
    const r = await request(app).get("/api/client/readiness-prefill?phone=%2B17805550100").set("Authorization", token("+17805550100"));
    expect(r.body).toMatchObject({ found: true, source: "contact", prefill: { fullName: "Jane Doe", companyName: "Acme", email: "j@acme.com" } });
  });
  it("keeps business fields whose names merely contain 'sin'", () => {
    expect(safePrefillFields({ businessName: "A", businessStructure: "Corp", sin: "1", SINNumber: "2", partnerSsn: "4", routingNumber: "3", bank_account: "5", accountNumber: "6", businessNumber: "7", accountantEmail: "a@b.c" }))
      .toEqual({ businessName: "A", businessStructure: "Corp", accountantEmail: "a@b.c" });
  });
});
